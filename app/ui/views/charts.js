/* Bayesian Chef · ui/views/charts.js
 *
 * Draws the Insights charts with Plotly.
 *
 * Plotly is a 3.5 MB library, so it's loaded only the first time Insights
 * opens (ensurePlotly). Chart colours come from the CSS variables in
 * index.html, so charts follow light and dark mode.
 */
(function () {
  "use strict";
  const Chef = (window.Chef = window.Chef || {});
  // Helpers from earlier files, unpacked for readability.
  const { esc, nice, unitOf, axisLabel, pct, valid, state } = Chef;

  /** Read a colour or other value from the page's CSS variables. */
  function tok(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  const PLOTLY_CONFIG = { responsive: true, displayModeBar: false };

  /** Plotly axis settings in the app's style. */
  function axis(title, extra = {}) {
    return { title: title ? { text: title, font: { size: 12, color: tok("--ink-2") } } : undefined, gridcolor: tok("--line"), zerolinecolor: tok("--line-strong"), linecolor: tok("--line-strong"), tickfont: { color: tok("--ink-3"), size: 11 }, automargin: true, ...extra };
  }

  /** Plotly layout settings in the app's style. */
  function layout(extra = {}) {
    return {
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "Nunito, system-ui, sans-serif", color: tok("--ink-2"), size: 12 },
      margin: { l: 52, r: 16, t: 12, b: 44 }, showlegend: false,
      hoverlabel: { bgcolor: tok("--surface"), bordercolor: tok("--line-strong"), font: { color: tok("--ink"), family: "Nunito, system-ui, sans-serif" } },
      ...extra,
    };
  }

  /** Turn "#rrggbb" into an rgba() colour with transparency. */
  function alpha(hex, a) {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  /** Light-to-dark colour scale for scores. */
  function seqScale() { return [[0, tok("--seq-0")], [0.25, tok("--seq-1")], [0.5, tok("--seq-2")], [0.75, tok("--seq-3")], [1, tok("--seq-4")]]; }

  /** Blue–grey–orange colour scale for correlations (−1 to 1). */
  function divScale() { return [[0, tok("--div-neg")], [0.5, tok("--div-mid")], [1, tok("--div-pos")]]; }

  const PHASE_SERIES = (ph) => (ph === "doe" ? "--series-1" : ph === "bo" ? "--series-2" : "--series-3");

  const PHASE_GROUP = (ph) => (ph === "doe" ? "Initial design" : ph === "bo" ? "Model pick" : "Baseline, repeat or edited");

  /** Draw (or redraw) one chart into the element with this id. */
  function plot(id, data, lay) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!window.Plotly) { el.innerHTML = `<p class="muted small">Charts couldn't load: app/vendor/plotly.min.js is missing or failed to run. See docs/debugging.md.</p>`; return; }
    window.Plotly.react(el, data, lay, PLOTLY_CONFIG);
  }

  // Plotly is loaded on demand. `plotlyState` is "idle", "loading", "ready" or "failed".
  let plotlyState = window.Plotly ? "ready" : "idle";
  const plotlyWaiting = [];

  /**
   * Run `then` once Plotly is available, loading vendor/plotly.min.js the
   * first time. If loading fails, `then` still runs; plot() then shows a
   * message in each chart's place instead of a chart.
   */
  function ensurePlotly(then) {
    if (plotlyState === "ready" || plotlyState === "failed") { then(); return; }
    plotlyWaiting.push(then);
    if (plotlyState === "loading") return;
    plotlyState = "loading";
    const tag = document.createElement("script");
    tag.src = "vendor/plotly.min.js";
    tag.charset = "utf-8";
    const finish = (ok) => {
      plotlyState = ok && window.Plotly ? "ready" : "failed";
      if (plotlyState === "failed") console.error("Could not load vendor/plotly.min.js; charts are disabled.");
      plotlyWaiting.splice(0).forEach((fn) => fn());
    };
    tag.onload = () => finish(true);
    tag.onerror = () => finish(false);
    document.head.appendChild(tag);
  }

  /** Draw the summary charts and the selected Explore view. */
  function drawInsights(p) {
    let v;
    try { v = Chef.analyticsFor(p); } catch (e) { console.error(e); return; }
    const I = state.insights;
    const ink2 = tok("--ink-2"), ink3 = tok("--ink-3"), surface = tok("--surface");
    const s = v.s;
    const done = v.done;
    const view = I.view;

    // Progress
    const groups = ["doe", "bo", "other"];
    const pts = v.progress.filter((r) => r.score !== null);
    const data = groups.map((g) => {
      const rs = pts.filter((r) => (g === "other" ? r.phase !== "doe" && r.phase !== "bo" : r.phase === g));
      return { type: "scatter", mode: "markers", name: PHASE_GROUP(g === "other" ? "x" : g), x: rs.map((r) => r.i), y: rs.map((r) => r.score), text: rs.map((r) => r.id),
        marker: { size: 10, color: tok(PHASE_SERIES(g === "other" ? "x" : g)), line: { color: surface, width: 2 } }, hovertemplate: "%{text}<br>score %{y:.2f}<extra>%{fullData.name}</extra>" };
    }).filter((t) => t.x.length);
    data.push({ type: "scatter", mode: "lines", name: "Best so far", x: v.progress.map((r) => r.i), y: v.progress.map((r) => r.best), line: { color: ink2, width: 2, shape: "hv" }, hovertemplate: "best %{y:.2f}<extra></extra>" });
    plot("ch-progress", data, layout({ showlegend: true, legend: { orientation: "h", y: 1.16, x: 0, font: { size: 11 } }, margin: { l: 44, r: 12, t: 30, b: 40 },
      xaxis: axis("Recorded run", { dtick: v.progress.length > 20 ? 5 : 1 }), yaxis: axis("Overall score", { range: [0, 1.05] }) }));

    if (!v.fitted) return;

    // Importance
    const eff = v.effects.slice().sort((a, b) => a.importance - b.importance);
    plot("ch-importance", [{ type: "bar", orientation: "h", y: eff.map((e) => nice(e.factor)), x: eff.map((e) => e.importance), marker: { color: tok("--marm-bright") },
      text: eff.map((e) => pct(e.importance)), textposition: "outside", cliponaxis: false, textfont: { color: ink2 }, hovertemplate: "%{y}: %{x:.0%}<extra></extra>" }],
      layout({ margin: { l: 110, r: 40, t: 8, b: 36 }, xaxis: axis("Share of explained variation", { tickformat: ".0%", range: [0, Math.max(...eff.map((e) => e.importance)) * 1.25 || 1] }), yaxis: axis("", { automargin: true }) }));

    if (view === "effects") {
    const all = v.effects.flatMap((e) => e.curve.flatMap((c) => [c.mean - (c.sd || 0), c.mean + (c.sd || 0)]));
    const yr = [Math.min(...all), Math.max(...all)];
    const pad = (yr[1] - yr[0]) * 0.08 || 0.1;
    const ylab = v.target === "__score" ? "score" : nice(v.target);
    v.effects.forEach((e, i) => {
      const f = p.factors.find((q) => q.name === e.factor);
      const xs = e.curve.map((c) => (f.type === "categorical" ? nice(c.x) : c.x));
      const tr = [];
      if (f.type === "categorical") {
        tr.push({ type: "bar", x: xs, y: e.curve.map((c) => c.mean), marker: { color: tok("--honey") }, error_y: e.curve[0].sd !== null ? { type: "data", array: e.curve.map((c) => c.sd), color: ink2, thickness: 1.5, width: 4 } : undefined, hovertemplate: "%{x}: %{y:.2f}<extra></extra>" });
      } else {
        if (e.curve[0].sd !== null) {
          tr.push({ type: "scatter", mode: "lines", x: xs, y: e.curve.map((c) => c.mean + c.sd), line: { width: 0 }, hoverinfo: "skip" });
          tr.push({ type: "scatter", mode: "lines", x: xs, y: e.curve.map((c) => c.mean - c.sd), fill: "tonexty", fillcolor: alpha(tok("--honey"), 0.35), line: { width: 0 }, hoverinfo: "skip" });
        }
        tr.push({ type: "scatter", mode: "lines", x: xs, y: e.curve.map((c) => c.mean), line: { color: tok("--marm-bright"), width: 2.5 }, hovertemplate: `%{x:.3g}${esc(unitOf(f))}: %{y:.2f}<extra></extra>` });
      }
      plot(`ch-me-${i}`, tr, layout({ margin: { l: 40, r: 8, t: 6, b: 32 }, xaxis: axis(f.unit || ""), yaxis: axis(i === 0 ? ylab : "", { range: [yr[0] - pad, yr[1] + pad] }) }));
    });

    }
    if (view === "surface") {
    const bestRun = done.slice().sort((a, b) => (BC.runScore(p, b, s) ?? -1) - (BC.runScore(p, a, s) ?? -1))[0];
    let surfTarget = v.target;
    if (I.sz === "sd" && surfTarget === "__score") surfTarget = p.outputs.find((o) => v.fitted.models[o.name]).name;
    if (I.sx && I.sy && bestRun) {
      const sf = BC.surface(p, s, v.fitted, surfTarget, I.sx, I.sy, bestRun.x, 28);
      const fx = p.factors.find((f) => f.name === I.sx), fy = p.factors.find((f) => f.name === I.sy);
      const cat = fx.type === "categorical" || fy.type === "categorical";
      const z = I.sz === "sd" && sf.zsd ? sf.zsd : sf.z;
      const lab = I.sz === "sd" ? `± ${nice(surfTarget)}` : surfTarget === "__score" ? "score" : nice(surfTarget);
      const base = { x: sf.x.map((q) => (fx.type === "categorical" ? nice(q) : q)), y: sf.y.map((q) => (fy.type === "categorical" ? nice(q) : q)), z, colorscale: seqScale(),
        colorbar: { thickness: 10, outlinewidth: 0, tickfont: { color: ink3, size: 10 }, title: { text: lab, side: "right", font: { size: 11, color: ink2 } } },
        hovertemplate: `${nice(I.sx)} %{x}<br>${nice(I.sy)} %{y}<br>${lab} %{z:.2f}<extra></extra>` };
      const tr = [cat ? { ...base, type: "heatmap" } : { ...base, type: "contour", contours: { coloring: "heatmap", showlines: true }, line: { color: alpha(surface, 0.6), width: 1 }, ncontours: 14 }];
      tr.push({ type: "scatter", mode: "markers", x: done.map((r) => (fx.type === "categorical" ? nice(r.x[I.sx]) : r.x[I.sx])), y: done.map((r) => (fy.type === "categorical" ? nice(r.x[I.sy]) : r.x[I.sy])), text: done.map((r) => r.id),
        marker: { size: 8, color: tok("--ink"), line: { color: surface, width: 2 } }, hovertemplate: "%{text}<extra>recorded run</extra>" });
      plot("ch-surface", tr, layout({ xaxis: axis(axisLabel(fx)), yaxis: axis(axisLabel(fy)) }));
    }

    }
    if (view === "check") {
    const d = v.diag.find((x) => x.output === I.diagOut);
    if (d) {
      const lo = Math.min(...d.obs, ...d.lo), hi = Math.max(...d.obs, ...d.hi);
      plot("ch-loo", [
        { type: "scatter", mode: "lines", x: [lo, hi], y: [lo, hi], line: { color: ink3, dash: "dot", width: 1.5 }, hoverinfo: "skip" },
        { type: "scatter", mode: "markers", x: d.obs, y: d.pred, text: d.ids, error_y: { type: "data", symmetric: false, array: d.hi.map((h, i) => h - d.pred[i]), arrayminus: d.pred.map((m, i) => m - d.lo[i]), color: alpha(tok("--marm-bright"), 0.45), thickness: 1.5, width: 0 },
          marker: { size: 9, color: tok("--marm-bright"), line: { color: surface, width: 2 } }, hovertemplate: "%{text}<br>measured %{x:.3g}<br>predicted %{y:.3g}<extra></extra>" },
      ], layout({ xaxis: axis(`Measured ${nice(d.output)}`), yaxis: axis("Predicted without that run") }));
      plot("ch-resid", [{ type: "histogram", x: d.zres, xbins: { start: -4, end: 4, size: 0.5 }, marker: { color: tok("--honey"), line: { color: surface, width: 2 } }, hovertemplate: "%{x}: %{y} runs<extra></extra>" }],
        layout({ xaxis: axis("Error ÷ predicted uncertainty", { range: [-4, 4], dtick: 1 }), yaxis: axis("Runs"), bargap: 0.04,
          shapes: [-2, 2].map((x0) => ({ type: "line", x0, x1: x0, yref: "paper", y0: 0, y1: 1, line: { color: ink3, dash: "dot", width: 1 } })) }));
    }

    }
    if (view === "map") {
    if (v.pca) {
      const sc = v.pca.scores;
      const doneIdx = sc.map((_, i) => i).filter((i) => v.pca.score[i] !== null);
      const other = sc.map((_, i) => i).filter((i) => v.pca.score[i] === null);
      plot("ch-pca", [
        { type: "scatter", mode: "markers", x: other.map((i) => sc[i][0]), y: other.map((i) => sc[i][1] || 0), text: other.map((i) => v.pca.ids[i]), marker: { size: 9, color: "rgba(0,0,0,0)", line: { color: ink3, width: 1.5 } }, hovertemplate: "%{text}<extra>not scored</extra>" },
        { type: "scatter", mode: "markers", x: doneIdx.map((i) => sc[i][0]), y: doneIdx.map((i) => sc[i][1] || 0), text: doneIdx.map((i) => v.pca.ids[i]),
          marker: { size: 11, color: doneIdx.map((i) => v.pca.score[i]), colorscale: seqScale(), cmin: 0, cmax: 1, line: { color: surface, width: 2 }, colorbar: { thickness: 10, outlinewidth: 0, tickfont: { color: ink3, size: 10 }, title: { text: "score", side: "right", font: { size: 11 } } } },
          hovertemplate: "%{text}<br>score %{marker.color:.2f}<extra></extra>" },
      ], layout({ xaxis: axis(`PC1 (${pct(v.pca.ratio[0])})`), yaxis: axis(`PC2 (${pct(v.pca.ratio[1] || 0)})`) }));
      let cum = 0;
      const labels = v.pca.ratio.map((_, i) => `PC${i + 1}`);
      plot("ch-scree", [{ type: "bar", x: labels, y: v.pca.ratio, marker: { color: v.pca.ratio.map((_, i) => (v.pca.keep && i < v.pca.keep ? tok("--marm-bright") : tok("--honey"))) },
        text: v.pca.ratio.map((r) => { cum += r; return pct(cum); }), textposition: "outside", cliponaxis: false, textfont: { size: 10, color: ink3 }, hovertemplate: "%{x}: %{y:.0%} (cumulative %{text})<extra></extra>" }],
        layout({ margin: { l: 52, r: 16, t: 18, b: 44 }, xaxis: axis("Component"), yaxis: axis("Share of variance", { tickformat: ".0%" }), bargap: 0.25,
          shapes: v.pca.keep ? [{ type: "line", x0: v.pca.keep - 0.5, x1: v.pca.keep - 0.5, yref: "paper", y0: 0, y1: 1, line: { color: ink2, dash: "dash", width: 1.5 } }] : [] }));
    }

    }
    if (view === "parallel") {
    const rg = BC.ranges(p);
    const scored = done.filter((r) => BC.runScore(p, r, s, rg) !== null);
    if (scored.length) {
      const dims = p.factors.map((f) => (f.type === "categorical"
        ? { label: nice(f.name), values: scored.map((r) => f.levels.indexOf(r.x[f.name])), tickvals: f.levels.map((_, i) => i), ticktext: f.levels.map(nice), range: [0, f.levels.length - 1] }
        : { label: nice(f.name), values: scored.map((r) => Number(r.x[f.name])), range: [f.low, f.high] }));
      p.outputs.forEach((o) => { const vals = scored.map((r) => (valid(r.y[o.name]) ? Number(r.y[o.name]) : NaN)); if (vals.some(isFinite)) dims.push({ label: nice(o.name), values: vals }); });
      const scs = scored.map((r) => BC.runScore(p, r, s, rg));
      dims.push({ label: "score", values: scs, range: [0, 1] });
      plot("ch-parcoords", [{ type: "parcoords", dimensions: dims, line: { color: scs, colorscale: seqScale(), cmin: 0, cmax: 1, showscale: false },
        labelfont: { color: tok("--ink"), size: 12 }, tickfont: { color: ink3, size: 10 }, rangefont: { color: ink3, size: 9 } }],
        layout({ margin: { l: 60, r: 60, t: 44, b: 24 } }));
    }

    }
    if (view === "corr") {
    const c = v.corr;
    plot("ch-corr", [{ type: "heatmap", x: c.names.map(nice), y: c.names.map(nice), z: c.matrix, zmin: -1, zmax: 1, colorscale: divScale(),
      text: c.matrix.map((r) => r.map((x) => (isFinite(x) ? x.toFixed(2) : ""))), texttemplate: "%{text}", textfont: { size: 10, color: tok("--ink") },
      colorbar: { thickness: 10, outlinewidth: 0, tickfont: { color: ink3, size: 10 } }, hovertemplate: "%{y} vs %{x}: %{z:.2f}<extra></extra>", xgap: 2, ygap: 2 }],
      layout({ margin: { l: 110, r: 16, t: 8, b: 100 }, xaxis: axis("", { tickangle: -40 }), yaxis: axis("", { autorange: "reversed" }) }));

    }
    if (view === "tradeoffs") {
    if (I.pa && I.pb && p.outputs.length > 1) {
      const pr = BC.pareto(p, I.pa, I.pb);
      const oa = p.outputs.find((o) => o.name === I.pa), ob = p.outputs.find((o) => o.name === I.pb);
      const arrow = (o) => (o.goal === "maximize" ? " (higher is better)" : o.goal === "minimize" ? " (lower is better)" : ` (target ${o.target})`);
      const frontIds = new Set(pr.front.map((q) => q.id));
      const rest = pr.points.filter((q) => !frontIds.has(q.id));
      plot("ch-pareto", [
        { type: "scatter", mode: "markers", x: rest.map((q) => q.a), y: rest.map((q) => q.b), text: rest.map((q) => q.id), marker: { size: 9, color: ink3, opacity: 0.6, line: { color: surface, width: 2 } }, hovertemplate: "%{text}<extra></extra>" },
        { type: "scatter", mode: "lines+markers+text", x: pr.front.map((q) => q.a), y: pr.front.map((q) => q.b), text: pr.front.map((q) => q.id), textposition: "top center", textfont: { size: 10, color: ink2 },
          line: { color: tok("--marm-bright"), width: 2, shape: "hv" }, marker: { size: 11, color: tok("--marm-bright"), line: { color: surface, width: 2 } }, hovertemplate: "%{text} (on the front)<extra></extra>" },
      ], layout({ xaxis: axis(`${nice(I.pa)}${arrow(oa)}`), yaxis: axis(`${nice(I.pb)}${arrow(ob)}`) }));
    }
    }
  }

  Object.assign(Chef, { ensurePlotly, tok, PLOTLY_CONFIG, axis, layout, alpha, seqScale, divScale, PHASE_SERIES, PHASE_GROUP, plot, drawInsights });
})();
