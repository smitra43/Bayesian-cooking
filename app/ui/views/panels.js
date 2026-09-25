/* Bayesian Chef · ui/views/panels.js
 *
 * Slide-over panels opened from the header: Advanced settings, the Guide,
 * and a single run from the Log. Also the presets (Balanced / Explore /
 * Refine) and the settings preview.
 */
(function () {
  "use strict";
  const Chef = (window.Chef = window.Chef || {});
  // Helpers from earlier files, unpacked for readability.
  const { $, esc, nice, cap, pct, PHASE_LABEL, phaseClass, icon, state, cur, settings } = Chef;

  /** Draw the open slide-over panel, keeping its scroll position when it redraws. */
  function renderSheet() {
    const root = $("#sheet-root");
    const p = cur();
    if (!state.sheet || !p) { root.innerHTML = ""; return; }
    let title = "", body = "";
    if (state.sheet === "settings") { title = "Advanced settings"; body = settingsSheet(p); }
    else if (state.sheet === "help") { title = "Guide"; body = helpSheet(p); }
    else if (state.sheet.startsWith("run:")) {
      const r = p.runs.find((q) => q.id === state.sheet.slice(4));
      if (!r) { state.sheet = null; root.innerHTML = ""; return; }
      title = `Run ${r.id}`; body = Chef.runSheet(p, r);
    }
    const prev = root.querySelector(".sheet-body");
    const top = prev ? prev.scrollTop : 0;
    const fresh = !prev;
    root.innerHTML = `<div class="scrim" data-act="close-sheet"></div>
      <aside class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" type="button" data-act="close-sheet" aria-label="Close">${icon("x")}</button></div>
        <div class="sheet-body">${body}</div></aside>`;
    const b = root.querySelector(".sheet-body");
    if (!fresh) b.scrollTop = top;
    if (fresh) { root.querySelector(".sheet").style.animation = ""; const c = root.querySelector('[data-act="close-sheet"].icon-btn'); if (c) c.focus(); }
    else { root.querySelector(".sheet").style.animation = "none"; root.querySelector(".scrim").style.animation = "none"; }
  }

  /** Open a slide-over panel: "settings", "help" or "run:<id>". */
  function openSheet(name) { state.sheet = name; renderSheet(); }

  /** Close the slide-over panel. */
  function closeSheet() { state.sheet = null; state.preview = null; renderSheet(); }

  const PRESETS = {
    balanced: { label: "Balanced", desc: "Default. Mixes new ideas with refining good ones.", set: { acquisition: "thompson", localFraction: 0.3, localRadius: 0.08 } },
    explore: { label: "Explore", desc: "Casts a wider net. Good early on.", set: { acquisition: "ucb", ucbBeta: 3.5, localFraction: 0.1, localRadius: 0.15 } },
    refine: { label: "Refine", desc: "Fine-tunes around your best recipes.", set: { acquisition: "ei", xi: 0, localFraction: 0.6, localRadius: 0.05 } },
  };

  /** Which preset (if any) the current settings match. */
  function activePreset(s) {
    for (const [k, pr] of Object.entries(PRESETS)) if (Object.entries(pr.set).every(([key, val]) => s[key] === val)) return k;
    return null;
  }

  /** The Advanced settings panel: presets, warnings, preview and every setting. */
  function settingsSheet(p) {
    const s = settings(p);
    const warn = BC.adviseSettings(p, s);
    const n = BC.doneRuns(p).length;
    const preset = activePreset(s);
    const sel = (path, val, opts, id) => `<select id="${id || "k-" + path.replace(/\./g, "-")}" data-k="${path}" data-t="str">${opts.map(([k, l]) => `<option value="${esc(k)}"${String(val) === String(k) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const num = (path, val, attrs = "", t = "num") => `<input type="number" step="any" id="k-${path.replace(/\./g, "-")}" data-k="${path}" data-t="${t}" value="${esc(val === null || val === undefined ? "" : val)}" ${attrs}>`;
    const chk = (path, val, label) => `<label class="check small"><input type="checkbox" id="k-${path.replace(/\./g, "-")}" data-k="${path}" data-t="bool" ${val ? "checked" : ""}> ${label}</label>`;
    const slide = (path, val, min, max, step) => `<input type="range" id="k-${path.replace(/\./g, "-")}" data-k="${path}" data-t="num" min="${min}" max="${max}" step="${step}" value="${esc(val)}">`;
    const F = (label, control, help, value) => `<label class="field"><span class="knob-head"><span>${label}</span>${value !== undefined ? `<span class="v">${esc(value)}</span>` : ""}</span>${control}${help ? `<span class="help">${help}</span>` : ""}</label>`;
    const acc = (key, title, inner) => `<details class="acc" data-acc="${key}" ${state.accOpen[key] ? "open" : ""}><summary>${title}</summary><div>${inner}</div></details>`;
    const gp = s.gp, blr = s.blr;
    return `
      <div class="stack" style="gap:8px"><h3>How adventurous?</h3>
        <div class="presets" role="group" aria-label="Preset">${Object.entries(PRESETS).map(([k, pr]) => `<button type="button" data-act="preset" data-k="${k}" aria-pressed="${preset === k}"><b>${pr.label}</b><span>${pr.desc}</span></button>`).join("")}</div>
        ${preset ? "" : `<p class="help">Custom settings. Pick a preset to reset the planner's style.</p>`}</div>
      ${warn.length ? `<div class="notice">With ${n} results:<ul>${warn.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
      <div class="row"><button class="btn sm" data-act="preview">Preview next session</button><span class="spacer"></span><button class="btn ghost sm danger" data-act="reset-knobs">Reset everything</button></div>
      ${state.preview ? previewTable(p) : ""}
      ${acc("design", "Initial design", `
        ${F("Method", sel("doeMethod", s.doeMethod, [["maxpro", "MaxPro Latin hypercube"], ["maximin", "Maximin Latin hypercube"], ["lhs", "Plain Latin hypercube"], ["halton", "Halton sequence"], ["random", "Random"]]), "MaxPro keeps every factor and every pair evenly covered, which per-factor lengthscales (ARD) need. Maximin pushes the closest recipes apart.")}
        ${F("Initial recipes", num("initialRuns", s.initialRuns, `min="1" placeholder="auto: ${Math.max(6, 2 * p.factors.length)}"`, "numOrNull"), "Recipes before the model takes over. Blank means max(6, 2 × factors).")}
        ${F("Optimisation swaps", num("doeIters", s.doeIters, `min="0" step="100"`), "More is slower and slightly better.")}`)}
      ${acc("sessions", "Sessions", `
        ${F("Samples per session", num("batchSize", s.batchSize, `min="1" max="12"`))}
        ${F("Repeat best recipe every", num("replicateEvery", s.replicateEvery, `min="0"`), "Sessions between repeats of your best recipe, to measure scoring noise. 0 turns repeats off.")}
        ${F("Random seed", num("seed", s.seed, `placeholder="random"`, "numOrNull"), "Fix it to make proposals reproducible.")}`)}
      ${acc("model", "Model", `
        ${F("Model family", sel("model", s.model, [["gp", "Gaussian process"], ["blr", "Bayesian polynomial regression"]]), "Gaussian processes bend to any smooth shape. Polynomial regression assumes a bowl or ridge and needs fewer results.")}
        ${s.model === "gp" ? `
        ${F("Kernel", sel("gp.kernel", gp.kernel, [["matern52", "Matérn 5/2"], ["matern32", "Matérn 3/2"], ["rbf", "RBF (squared exponential)"], ["rq", "Rational quadratic"], ["exponential", "Exponential (Matérn 1/2)"]]), "How smooth the response is assumed to be. Matérn 5/2 is the usual default.")}
        ${chk("gp.ard", gp.ard, "ARD: one lengthscale per factor")}
        <span class="help" style="margin-top:-8px">Learns which factors matter. Needs roughly 3+ results per numeric factor.</span>
        ${F("Choice lengthscales", sel("gp.catLengthscales", gp.catLengthscales, [["shared", "Shared across choice factors"], ["per-factor", "One per choice factor"]]))}
        ${F("Noise", sel("gp.noise", gp.noise, [["fit", "Learn from data"], ["fixed", "Fixed value"]]))}
        ${gp.noise === "fixed" ? F("Fixed noise (sd, standardised)", num("gp.noiseValue", gp.noiseValue, `min="0.001"`)) : ""}
        ${F("Mean function", sel("gp.mean", gp.mean, [["data", "Average of results"], ["gls", "Fitted constant (GLS)"]]))}
        ${F("Output transform", sel("gp.transform", gp.transform, [["standardize", "Standardise"], ["log", "Log, then standardise"], ["none", "Centre only"]]), "Log suits positive, skewed outputs such as times or weights.")}
        ${chk("gp.priors", gp.priors, "Hyperparameter priors")}
        ${F("Prior width (log-sd)", slide("gp.priorWidth", gp.priorWidth, 0.1, 2, 0.05), "Smaller holds hyperparameters closer to the medians below.", gp.priorWidth)}
        ${F("Prior median: numeric lengthscale", num("gp.lenNumPrior", gp.lenNumPrior, `min="0.01"`), "On the 0–1 scale of each range.")}
        ${F("Prior median: choice lengthscale", num("gp.lenCatPrior", gp.lenCatPrior, `min="0.01"`))}
        ${F("Prior median: signal sd", num("gp.signalPrior", gp.signalPrior, `min="0.01"`))}
        ${F("Prior median: noise sd", num("gp.noisePrior", gp.noisePrior, `min="0.001"`))}
        ${gp.kernel === "rq" ? F("Prior median: RQ α", num("gp.alphaPrior", gp.alphaPrior, `min="0.01"`)) : ""}
        ${F("Optimiser restarts", num("gp.restarts", gp.restarts, `min="1" max="20"`))}
        ${F("Optimiser iterations", num("gp.maxIter", gp.maxIter, `min="20" step="50"`))}
        ${F("Results before fitting", num("gp.minPointsToFit", gp.minPointsToFit, `min="2"`), "Below this, the prior medians are used as-is.")}
        ${F("Jitter", num("gp.jitter", gp.jitter, `min="0"`))}` : `
        ${F("Polynomial degree", sel("blr.degree", blr.degree, [["1", "1 · linear"], ["2", "2 · quadratic"]]).replace('data-t="str"', 'data-t="num"'))}
        ${chk("blr.interactions", blr.interactions, "Pairwise interactions")}
        ${chk("blr.fitPrecisions", blr.fitPrecisions, "Learn precisions from data (evidence maximisation)")}
        ${F("Weight precision α", num("blr.alpha", blr.alpha, `min="0.0001"`), "Higher shrinks coefficients toward 0.")}
        ${F("Noise precision β", num("blr.beta", blr.beta, `min="0.01"`))}
        ${F("Output transform", sel("blr.transform", blr.transform, [["standardize", "Standardise"], ["log", "Log, then standardise"], ["none", "Centre only"]]))}`}`)}
      ${acc("features", "Input features (PCA)", `
        ${chk("pca.enabled", s.pca.enabled, "Input PCA")}
        <span class="help" style="margin-top:-8px">Rotates factors onto principal components of your recipes and keeps the leading ones. Only helps when factors move together.</span>
        ${F("Truncate by", sel("pca.mode", s.pca.mode, [["variance", "Variance kept"], ["k", "Number of components"]]))}
        ${s.pca.mode === "variance" ? F("Variance kept", slide("pca.value", s.pca.value, 0.5, 0.999, 0.001), "", pct(s.pca.value)) : F("Components kept", num("pca.value", s.pca.value, `min="1" max="${BC.layout(p).length}" step="1"`))}
        ${chk("pca.standardize", s.pca.standardize, "Standardise before PCA")}`)}
      ${acc("acq", "Choosing the next recipes", `
        ${F("Acquisition", sel("acquisition", s.acquisition, [["thompson", "Thompson sampling"], ["ei", "Expected improvement"], ["ucb", "Upper confidence bound"], ["pi", "Probability of improvement"], ["exploit", "Pure exploitation"], ["explore", "Pure exploration"]]))}
        ${F("UCB β", slide("ucbBeta", s.ucbBeta, 0, 5, 0.1), "Higher explores more.", s.ucbBeta)}
        ${F("Improvement margin ξ", num("xi", s.xi, `min="0" step="0.01"`), "For EI and PI.")}
        ${F("Monte Carlo samples", num("mcSamples", s.mcSamples, `min="8" step="8"`))}
        ${F("Batch strategy", sel("batchStrategy", s.batchStrategy, [["believer", "Kriging believer"], ["liar-min", "Constant liar (pessimistic)"], ["liar-max", "Constant liar (optimistic)"]]), "How later picks in a session account for earlier ones. Thompson sampling ignores this.")}
        ${F("Candidates scored", num("candidates", s.candidates, `min="50" step="50"`))}
        ${F("Share near your best recipes", slide("localFraction", s.localFraction, 0, 1, 0.05), "", pct(s.localFraction))}
        ${F("Variation size", slide("localRadius", s.localRadius, 0.01, 0.4, 0.01), "On the 0–1 scale of each range.", s.localRadius)}
        ${F("Top recipes to vary", num("localTop", s.localTop, `min="1" max="10" step="1"`))}`)}
      ${acc("scoring", "Scoring", `
        ${F("Combine outputs by", sel("combine", s.combine, [["geometric", "Weighted geometric mean"], ["arithmetic", "Weighted average"], ["min", "Worst output"]]), "Geometric mean needs every output to be decent; average lets a strong one make up for a weak one.")}
        ${F("Desirability shape", slide("desirabilityShape", s.desirabilityShape, 0.25, 4, 0.05), "Above 1 rewards only near-ideal results.", s.desirabilityShape)}`)}
      ${acc("nogo", "Rejected recipes", `
        ${chk("noGo.enabled", s.noGo.enabled, "Steer away from recipes I rejected")}
        ${F("How", sel("noGo.mode", s.noGo.mode, [["penalize", "Penalise nearby candidates"], ["exclude", "Exclude nearby candidates"]]))}
        ${F("Radius", slide("noGo.radius", s.noGo.radius, 0.02, 0.5, 0.01), "", s.noGo.radius)}
        ${F("Penalty strength", slide("noGo.strength", s.noGo.strength, 0, 1, 0.05), "", s.noGo.strength)}`)}`;
  }

  /** The "Preview next session" results inside Advanced settings. */
  function previewTable(p) {
    const pv = state.preview;
    if (pv === "busy") return `<span class="thinking">Planning a preview…</span>`;
    if (pv.error) return `<div class="notice bad">${esc(pv.error)}</div>`;
    return `<section class="card flush"><div class="card-head pad"><h3>Preview</h3><span class="faint small">${pv.ms} ms · not saved</span></div>
      <ul class="list">${pv.rows.map((q) => `<li><div class="item"><div class="main"><span class="meta" style="color:var(--ink)">${esc(Chef.summary(p, q.x, 4))}</span></div><span class="pill ${phaseClass(q.phase)}">${esc(PHASE_LABEL[q.phase] || q.phase)}</span></div></li>`).join("")}</ul></section>`;
  }

  /** Set a nested value from a dotted path, e.g. setPath(s, "gp.kernel", "rbf"). */
  function setPath(obj, path, val) {
    const ks = path.split(".");
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] = o[ks[i]] || {};
    o[ks[ks.length - 1]] = val;
  }

  /** The Guide panel: how it works, tasting guide, suggested measurements, sources. */
  function helpSheet(p) {
    const tips = (p.tips || []).filter(Boolean);
    return `
      <section class="stack"><h3>How it works</h3>
        <ol class="small muted" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px">
          <li><b style="color:var(--ink)">Set up.</b> List what you'll change, with ranges, and what you'll score.</li>
          <li><b style="color:var(--ink)">Initial design.</b> The first sessions spread recipes evenly across every range.</li>
          <li><b style="color:var(--ink)">Model picks.</b> A Gaussian process learns from your scores and proposes recipes that look promising or uncertain. You approve each one.</li>
          <li><b style="color:var(--ink)">Taste blind.</b> Cook, label with the codes, taste in the given order, score each sample.</li>
        </ol></section>
      ${tips.length ? `<section class="stack"><h3>For ${esc(p.name)}</h3><ul class="small" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px">${tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></section>` : ""}
      <section class="stack"><h3>Tasting guide</h3>${BC.PROTOCOL.map((sec) => `<div><h4 style="color:var(--marm);margin-bottom:4px">${esc(sec.when)}</h4><ul class="small" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px">${sec.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`).join("")}</section>
      <section class="stack"><h3>Suggested measurements</h3>
        <ul class="list">${Object.entries(BC.OUTPUT_LIBRARY).map(([k, o]) => `<li><div class="item"><div class="main"><span class="title">${esc(cap(nice(k)))} <span class="faint small" style="font-weight:600">${esc(o.category)}</span></span><span class="small muted">${esc(o.how)}</span></div>
          ${p.outputs.some((q) => q.name === k) ? `<span class="pill good">Added</span>` : `<button class="btn sm" data-act="add-lib-output" data-k="${k}">Add</button>`}</div></li>`).join("")}</ul></section>
      <section class="stack"><h3>Sources</h3><ul class="small muted" style="margin:0;padding-left:18px">${BC.REFERENCES.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></section>`;
  }

  Object.assign(Chef, { renderSheet, openSheet, closeSheet, PRESETS, activePreset, settingsSheet, previewTable, setPath, helpSheet });
})();
