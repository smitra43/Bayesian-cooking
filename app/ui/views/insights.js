/* Bayesian Chef · ui/views/insights.js
 *
 * The Insights tab: summary stats, best recipe, the model's best guess,
 * and the "Explore" views.
 *
 * This file builds the HTML and the numbers (analyticsFor). The charts
 * themselves are drawn afterwards by views/charts.js.
 */
(function () {
  "use strict";
  const Chef = (window.Chef = window.Chef || {});
  // Helpers from earlier files, unpacked for readability.
  const { esc, nice, cap, fmtNum, pct, state, settings } = Chef;

  const cache = { key: null, value: null };

  /** Compute (and cache) everything Insights needs: fitted models, effects, diagnostics, best guess. */
  function analyticsFor(p) {
    const s = settings(p);
    const key = `${p.id}|${p.updatedAt}|${JSON.stringify(s)}|${JSON.stringify(p.outputs)}|${JSON.stringify(p.factors)}|${state.insights.target}`;
    if (cache.key === key) return cache.value;
    const done = BC.doneRuns(p);
    const v = { s, done, progress: BC.progress(p, s) };
    const doe = p.runs.filter((r) => r.status !== "rejected" && (r.phase === "doe" || r.phase === "baseline")).map((r) => r.x);
    v.dq = BC.designQuality(p, doe);
    v.dqAll = BC.designQuality(p, p.runs.filter((r) => r.status !== "rejected").map((r) => r.x));
    v.reps = BC.replicates(p);
    v.corr = BC.correlations(p);
    v.pca = BC.runPCA(p, s);
    if (done.length >= 3) {
      v.fitted = BC.fitAll(p, s);
      const target = state.insights.target === "__score" || v.fitted.models[state.insights.target] ? state.insights.target : "__score";
      v.effects = BC.mainEffects(p, s, v.fitted, target);
      v.diag = BC.diagnostics(p, v.fitted);
      v.target = target;
      const pool = BC.candidatePool(p, s, BC.Rng(7));
      const pr = BC.predictor(p, s, v.fitted, "__score")(pool);
      let bi = 0; pr.mean.forEach((m, i) => { if (m > pr.mean[bi]) bi = i; });
      v.guess = { x: pool[bi], score: pr.mean[bi] };
    }
    cache.key = key; cache.value = v;
    return v;
  }

  const EXPLORE = [
    ["effects", "Effects"], ["surface", "Surface"], ["check", "Model check"], ["map", "PCA map"],
    ["parallel", "All runs"], ["corr", "Correlations"], ["tradeoffs", "Trade-offs"], ["details", "Model details"],
  ];

  /** The Insights tab's HTML. */
  function insightsView(p) {
    const v = analyticsFor(p);
    const I = state.insights;
    if (!I.sx || !p.factors.some((f) => f.name === I.sx)) I.sx = p.factors[0] && p.factors[0].name;
    if (!I.sy || !p.factors.some((f) => f.name === I.sy) || I.sy === I.sx) I.sy = (p.factors.find((f) => f.name !== I.sx) || {}).name;
    if (!I.diagOut || !p.outputs.some((o) => o.name === I.diagOut)) I.diagOut = p.outputs[0] && p.outputs[0].name;
    if (!I.pa || !p.outputs.some((o) => o.name === I.pa)) I.pa = p.outputs[0] && p.outputs[0].name;
    if (!I.pb || !p.outputs.some((o) => o.name === I.pb) || I.pb === I.pa) I.pb = (p.outputs.find((o) => o.name !== I.pa) || {}).name;

    const bestIdx = v.progress.reduce((bi, r, i) => (r.score !== null && (bi < 0 || r.score > v.progress[bi].score) ? i : bi), -1);
    const first = v.diag && v.diag[0];
    const repOut = p.outputs.find((o) => v.reps.pooled[o.name]);
    const stat = (label, val, sub) => `<div class="stat"><span class="eyebrow">${label}</span><span class="v">${val}</span><span class="s">${sub}</span></div>`;
    const head = `<header class="page-head"><h1>Insights</h1><p class="sub">${v.done.length} tasted recipes over ${p.sessions} session${p.sessions === 1 ? "" : "s"}. Scores run from 0 to 1, where 1 means every output hit its ideal.</p></header>
      <div class="stats">
        ${stat("Best score", bestIdx >= 0 ? v.progress[bestIdx].score.toFixed(2) : "–", bestIdx >= 0 ? `run ${esc(v.progress[bestIdx].id)}` : "no results yet")}
        ${stat("Tasted", v.done.length, `${p.runs.filter((r) => r.status === "rejected").length} rejected`)}
        ${stat("Model fit", first && isFinite(first.r2) ? first.r2.toFixed(2) : "–", first ? `R² on unseen runs, ${esc(nice(first.output))}` : "needs 3 results")}
        ${stat("Palate noise", repOut ? "±" + fmtNum(v.reps.pooled[repOut.name].sd) : first ? "±" + fmtNum(first.noise) : "–", repOut ? `from repeats, ${esc(nice(repOut.name))}` : first ? `model estimate, ${esc(nice(first.output))}` : "repeat a recipe to measure")}
      </div>`;

    if (v.done.length < 3) {
      return `${head}<div class="notice info">Taste at least 3 recipes and the model's view of what matters will appear here.</div>
        <section class="card"><div class="card-head"><h3>Progress</h3></div><div class="chart short" id="ch-progress"></div></section>`;
    }

    const best = bestIdx >= 0 ? BC.doneRuns(p).find((r) => r.id === v.progress[bestIdx].id) : null;
    const sel = (id, bind, val, opts) => `<select id="${id}" data-ins="${bind}">${opts.map(([k, l]) => `<option value="${esc(k)}"${k === val ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const targetOpts = [["__score", "Overall score"], ...p.outputs.map((o) => [o.name, cap(nice(o.name))])];

    return `${head}
      <div class="grid2">
        <section class="card"><div class="card-head"><div><span class="eyebrow">Best so far</span><h3>${esc(best ? best.id : "")}</h3></div><span class="score">${bestIdx >= 0 ? v.progress[bestIdx].score.toFixed(2) : "–"}</span></div>${best ? Chef.factorKv(p, best.x) : ""}</section>
        <section class="card"><div class="card-head"><div><span class="eyebrow">Model's best guess</span><h3>Not tasted yet</h3></div><span class="score" title="Expected score">${v.guess.score.toFixed(2)}</span></div>${Chef.factorKv(p, v.guess.x)}
          <p class="small muted" style="margin-top:12px">The recipe the model currently expects to score highest. Its uncertainty can still be large.</p></section>
      </div>
      <div class="grid2">
        <section class="card"><div class="card-head"><h3>What matters</h3><div style="width:170px">${sel("ins-target", "target", v.target, targetOpts)}</div>
          <p>How much ${v.target === "__score" ? "the overall score" : esc(nice(v.target))} changes as each factor moves across its range.</p></div><div class="chart short" id="ch-importance"></div></section>
        <section class="card"><div class="card-head"><h3>Progress</h3><p>Each dot is a tasted recipe. The line is the best so far.</p></div><div class="chart short" id="ch-progress"></div></section>
      </div>
      <section class="card">
        <div class="card-head"><h3>Explore</h3></div>
        <div class="chips" role="group" aria-label="Choose a view">${EXPLORE.map(([k, l]) => `<button type="button" data-act="ins-view" data-v="${k}" aria-pressed="${I.view === k}">${l}</button>`).join("")}</div>
        <div style="margin-top:16px">${exploreBody(p, v, sel)}</div>
      </section>`;
  }

  /** The HTML for whichever Explore view is selected. */
  function exploreBody(p, v, sel) {
    const I = state.insights;
    const fOpts = p.factors.map((f) => [f.name, cap(nice(f.name))]);
    const oOpts = p.outputs.map((o) => [o.name, cap(nice(o.name))]);
    const caption = (t) => `<p class="small muted" style="margin-bottom:10px">${t}</p>`;
    const what = v.target === "__score" ? "the overall score" : esc(nice(v.target));
    switch (I.view) {
      case "surface":
        return `<div class="ctrls"><label class="field"><span>Across</span>${sel("ins-sx", "sx", I.sx, fOpts)}</label><label class="field"><span>Up</span>${sel("ins-sy", "sy", I.sy, fOpts.filter(([k]) => k !== I.sx))}</label>
          <label class="field"><span>Show</span>${sel("ins-sz", "sz", I.sz, [["mean", "Prediction"], ["sd", "Uncertainty"]])}</label></div>
          ${caption(`Predicted ${what} over two factors, with everything else held at your best recipe. Dots are recipes you've tasted.`)}<div class="chart tall" id="ch-surface"></div>`;
      case "check": {
        const d = v.diag.find((x) => x.output === I.diagOut);
        return `<div class="ctrls"><label class="field"><span>Output</span>${sel("ins-diag", "diagOut", I.diagOut, oOpts)}</label></div>
          ${d ? `<div class="statline"><span>R² <b>${isFinite(d.r2) ? d.r2.toFixed(2) : "–"}</b></span><span>Typical error <b>${fmtNum(d.rmse)}</b></span><span>Inside 95% band <b>${pct(d.coverage)}</b></span><span>Noise <b>±${fmtNum(d.noise)}</b></span></div>` : ""}
          ${caption("Left: each recipe predicted by a model that never saw it. Near the diagonal is good. Right: those errors divided by the model's own uncertainty; about 95% should fall between −2 and 2.")}
          <div class="grid2"><div class="chart" id="ch-loo"></div><div class="chart" id="ch-resid"></div></div>`;
      }
      case "map":
        return `${caption(`Left: your recipes projected onto their two main directions of variation, coloured by score. Right: how much variation each direction carries.${v.s.pca.enabled ? " The dashed line marks where the model's input PCA cuts off." : ""}`)}<div class="grid2"><div class="chart" id="ch-pca"></div><div class="chart" id="ch-scree"></div></div>`;
      case "parallel":
        return `${caption("Every tasted recipe as one line across all factors and outputs, coloured by score. Drag along an axis to filter.")}<div class="chart tall" id="ch-parcoords"></div>`;
      case "corr":
        return `${caption("How pairs of factors and outputs move together across tasted recipes. With few recipes, anything between −0.5 and 0.5 is probably noise.")}<div class="chart tall" id="ch-corr"></div>`;
      case "tradeoffs":
        if (p.outputs.length < 2) return `<p class="muted">Add a second output in Setup to see trade-offs.</p>`;
        return `<div class="ctrls"><label class="field"><span>Across</span>${sel("ins-pa", "pa", I.pa, oOpts)}</label><label class="field"><span>Up</span>${sel("ins-pb", "pb", I.pb, oOpts.filter(([k]) => k !== I.pa))}</label></div>
          ${caption("Highlighted recipes can't improve on one output without getting worse on the other (the Pareto front).")}<div class="chart tall" id="ch-pareto"></div>`;
      case "details":
        return modelTables(p, v) + designTable(p, v);
      default:
        return `${caption(`Average predicted ${what} as one factor changes while the others vary.${v.target === "__score" ? " Pick a single output under What matters to see the model's uncertainty band." : " Shaded band: the model's uncertainty."}`)}
          <div class="multiples">${p.factors.map((f, i) => `<div><div class="eyebrow">${esc(nice(f.name))}</div><div class="chart" id="ch-me-${i}"></div></div>`).join("")}</div>`;
    }
  }

  /** Table of fitted model settings, one row per output. */
  function modelTables(p, v) {
    const rows = (v.diag || []).map((d) => {
      const hs = d.info.hypers.map((h) => `${esc(h.name)} <b>${fmtNum(h.value)}</b>`).join(" · ");
      return `<tr><td><b>${esc(cap(nice(d.output)))}</b></td><td>${esc(d.info.model)}${d.info.kernel ? ` · ${esc(d.info.kernel)}${d.info.ard ? " ARD" : ""}` : ""}${d.info.degree ? ` · degree ${d.info.degree}` : ""}</td><td class="n">${d.info.logML !== undefined ? d.info.logML.toFixed(1) : "–"}</td><td style="white-space:normal;min-width:260px">${hs}${d.info.fitted ? "" : ` <span class="pill">prior values</span>`}</td></tr>`;
    }).join("");
    return `<h4 style="margin-bottom:6px">Fitted models</h4><p class="small muted" style="margin-bottom:8px">Lengthscales are on the 0–1 scale of each factor's range; short means the output changes quickly with that factor.</p>
      <div class="table-wrap"><table><thead><tr><th>Output</th><th>Model</th><th class="n">Log evidence</th><th>Hyperparameters</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  /** Table of how well spread the recipes are. */
  function designTable(p, v) {
    const row = (label, q) => q ? `<tr><td>${label}</td><td class="n">${fmtNum(q.minDistance)}</td><td class="n">${q.worstGap === null ? "–" : fmtNum(q.worstGap)}${q.worstGapFactor ? ` <span class="faint">${esc(nice(q.worstGapFactor))}</span>` : ""}</td><td class="n">${q.maxCorr === null ? "–" : fmtNum(q.maxCorr, 2)}${q.maxCorrPair ? ` <span class="faint">${esc(q.maxCorrPair.map(nice).join(" & "))}</span>` : ""}</td></tr>` : "";
    const reps = v.reps.groups.length ? v.reps.groups.map((g) => g.join(", ")).join("; ") : "none yet";
    return `<h4 style="margin:22px 0 6px">Design quality</h4><p class="small muted" style="margin-bottom:8px">Closest pair (higher is better), largest uncovered stretch of a factor's range (lower is better), and strongest correlation between two factors (lower is better).</p>
      <div class="table-wrap"><table><thead><tr><th>Recipes</th><th class="n">Closest pair</th><th class="n">Worst gap</th><th class="n">Max |r|</th></tr></thead><tbody>${row("Initial design", v.dq)}${row("All", v.dqAll)}</tbody></table></div>
      <p class="small muted" style="margin-top:10px">Repeated recipes: ${esc(reps)}.</p>`;
  }

  Object.assign(Chef, { cache, analyticsFor, EXPLORE, insightsView, exploreBody, modelTables, designTable });
})();
