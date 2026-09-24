/* Settings, feature pipeline, desirability, and the proposal engine
 * (initial design, then Bayesian optimisation with several acquisitions). */
(function () {
  const BC = (globalThis.BC = globalThis.BC || {});

  const DEFAULT_SETTINGS = {
    // design
    doeMethod: "maxpro", initialRuns: null /* null = max(6, 2 x factors) */, doeIters: 2000,
    // sessions
    batchSize: 3, replicateEvery: 3, blindCodes: true, seed: null,
    // model
    model: "gp",
    gp: { ...BC.GP_DEFAULTS },
    blr: { ...BC.BLR_DEFAULTS },
    // features
    pca: { enabled: false, mode: "variance", value: 0.95, standardize: false },
    // acquisition
    acquisition: "thompson", ucbBeta: 2.0, xi: 0.01, mcSamples: 64, batchStrategy: "believer",
    candidates: 600, localFraction: 0.3, localRadius: 0.08, localTop: 3,
    // objectives
    combine: "geometric", desirabilityShape: 1.0,
    // rejected runs
    noGo: { enabled: true, radius: 0.15, mode: "penalize", strength: 0.8 },
  };

  function mergeSettings(s) {
    const d = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    if (!s) return d;
    const out = { ...d, ...s };
    for (const k of ["gp", "blr", "pca", "noGo"]) out[k] = { ...d[k], ...(s[k] || {}) };
    return out;
  }

  function initialRuns(p, s) { return s.initialRuns || Math.max(6, 2 * p.factors.length); }

  // ------------------------------------------------------------ feature maps

  /** Build the feature map (encoding, then optional PCA) from observed runs. */
  function featureMap(p, s, observedRuns) {
    const cols = BC.layout(p).map((c) => ({ ...c, label: c.kind === "num" ? c.factor : `${c.factor}=${c.level}` }));
    if (!s.pca.enabled || observedRuns.length < 3) {
      return { cols, apply: (runs) => BC.encode(p, runs), pca: null };
    }
    const E = BC.encode(p, observedRuns);
    const pca = BC.fitPCA(E, s.pca);
    const pcCols = Array.from({ length: pca.k }, (_, i) => ({ kind: "num", factor: `PC${i + 1}`, label: `PC${i + 1}` }));
    return { cols: pcCols, apply: (runs) => pca.transform(BC.encode(p, runs)), pca };
  }

  // ----------------------------------------------------------- desirability

  function outputRange(o, observed) {
    let lo = o.low !== null && o.low !== undefined && o.low !== "" ? Number(o.low) : observed.length ? Math.min(...observed) : 0;
    let hi = o.high !== null && o.high !== undefined && o.high !== "" ? Number(o.high) : observed.length ? Math.max(...observed) : 1;
    if (!(hi > lo)) { lo -= 1; hi += 1; }
    return [lo, hi];
  }

  function desirability(o, y, lo, hi, shape = 1) {
    let d;
    if (o.goal === "maximize") d = (y - lo) / (hi - lo);
    else if (o.goal === "minimize") d = (hi - y) / (hi - lo);
    else d = 1 - Math.abs(y - o.target) / Math.max(o.target - lo, hi - o.target, 1e-9);
    d = Math.min(1, Math.max(0, d));
    return shape === 1 ? d : Math.pow(d, shape);
  }

  const FLOOR = 0.01;
  function combine(ds, ws, rule = "geometric") {
    const W = ws.reduce((a, b) => a + b, 0);
    if (rule === "arithmetic") return ds.reduce((a, d, i) => a + (ws[i] / W) * d, 0);
    if (rule === "min") return Math.min(...ds);
    return Math.exp(ds.reduce((a, d, i) => a + (ws[i] / W) * Math.log(Math.max(d, FLOOR)), 0));
  }

  function doneRuns(p) { return (p.runs || []).filter((r) => r.status === "done"); }
  function observedValues(p, o) { return doneRuns(p).map((r) => r.y[o.name]).filter((v) => v !== null && v !== undefined && v !== "" && isFinite(v)).map(Number); }
  function ranges(p) { return Object.fromEntries(p.outputs.map((o) => [o.name, outputRange(o, observedValues(p, o))])); }

  /** Combined desirability of a recorded run (missing outputs skipped). */
  function runScore(p, r, s, rg = ranges(p)) {
    const ds = [], ws = [];
    for (const o of p.outputs) {
      const v = r.y ? r.y[o.name] : undefined;
      if (v === null || v === undefined || v === "" || !isFinite(v)) continue;
      ds.push(desirability(o, Number(v), ...rg[o.name], s.desirabilityShape));
      ws.push(o.weight);
    }
    return ds.length ? combine(ds, ws, s.combine) : null;
  }

  // ----------------------------------------------------------------- models

  /** Fit one model per output that has data. Returns {models, fmap}. */
  function fitAll(p, s) {
    const done = doneRuns(p);
    const fmap = featureMap(p, s, done.map((r) => r.x));
    const models = {};
    for (const o of p.outputs) {
      const rows = done.filter((r) => r.y[o.name] !== null && r.y[o.name] !== undefined && r.y[o.name] !== "" && isFinite(r.y[o.name]));
      if (!rows.length) continue;
      models[o.name] = BC.fitModel(fmap.apply(rows.map((r) => r.x)), rows.map((r) => Number(r.y[o.name])), fmap.cols, s);
    }
    return { models, fmap };
  }

  // ------------------------------------------------------ candidate handling

  function candidatePool(p, s, rng) {
    const n = Math.max(20, s.candidates);
    const nLocal = Math.round(n * s.localFraction);
    const pool = BC.sample(p, n - nLocal, rng, "lhs");
    const done = doneRuns(p);
    if (nLocal && done.length) {
      const rg = ranges(p);
      const top = done.map((r) => ({ r, sc: runScore(p, r, s, rg) ?? -1 })).sort((a, b) => b.sc - a.sc).slice(0, s.localTop);
      for (let i = 0; i < nLocal; i++) pool.push(BC.perturb(p, top[i % top.length].r.x, rng, s.localRadius));
    }
    return pool;
  }

  /** Multiplier in [0,1] per candidate from closeness to rejected runs. */
  function noGoFactors(p, s, poolEnc) {
    const rej = (p.runs || []).filter((r) => r.status === "rejected" && r.phase !== "not-made");
    if (!s.noGo.enabled || !rej.length) return poolEnc.map(() => 1);
    const R = BC.encode(p, rej.map((r) => r.x));
    const r2 = s.noGo.radius * s.noGo.radius * Math.max(1, R[0].length);
    return poolEnc.map((x) => {
      const d2 = Math.min(...R.map((r) => BC.dist2(x, r)));
      if (s.noGo.mode === "exclude") return d2 < r2 ? 0 : 1;
      return 1 - s.noGo.strength * Math.exp(-0.5 * d2 / r2);
    });
  }

  // --------------------------------------------------------------- proposals

  /**
   * Plan the next session. Returns [{x, phase, why, score?, predictions?}].
   * During the initial design (or with no results yet) runs are space-filling;
   * afterwards the chosen acquisition picks them.
   */
  function propose(p, sIn, k, sessionNo) {
    const s = mergeSettings(sIn);
    const rng = BC.Rng(s.seed === null || s.seed === "" ? undefined : Number(s.seed) + sessionNo * 7919);
    const active = (p.runs || []).filter((r) => r.status !== "rejected");
    const out = [];

    if (p.baseline && !active.some((r) => r.phase === "baseline")) {
      out.push({ x: { ...p.baseline }, phase: "baseline", why: "Your current recipe, cooked first as the reference." });
    }

    const nInit = initialRuns(p, s);
    const remaining = nInit - active.length - out.length;
    const done = doneRuns(p);
    if (remaining > 0 || !done.length) {
      const runs = BC.design(p, [...active.map((r) => r.x), ...out.map((o) => o.x)], k - out.length, rng, s.doeMethod, s.doeIters);
      runs.forEach((x, i) => out.push({
        x, phase: "doe",
        why: i < remaining ? `Initial design: spreads runs evenly across your ranges (${Math.max(0, remaining - i - 1)} left after this).`
          : "Space-filling: no results recorded yet, so the model can't choose.",
      }));
      return out;
    }

    let slots = k - out.length;
    let replicate = null;
    if (s.replicateEvery > 0 && sessionNo % s.replicateEvery === 0 && slots > 1) {
      const rg = ranges(p);
      const best = done.map((r) => ({ r, sc: runScore(p, r, s, rg) })).filter((a) => a.sc !== null).sort((a, b) => b.sc - a.sc)[0];
      if (best) { replicate = best.r; slots -= 1; }
    }

    const picks = acquire(p, s, slots, rng);
    out.push(...picks);
    if (replicate) out.push({ x: { ...replicate.x }, phase: "replicate", why: `Repeat of your best run ${replicate.id}, to measure how consistent your scores are.` });
    return out;
  }

  /** Core acquisition: returns `k` picks with predictions. */
  function acquire(p, s, k, rng) {
    const { models, fmap } = fitAll(p, s);
    const outs = p.outputs.filter((o) => models[o.name]);
    const rg = ranges(p);
    const pool = candidatePool(p, s, rng);
    const enc = BC.encode(p, pool);
    const F = fmap.apply(pool);
    const noGo = noGoFactors(p, s, enc);
    const w = outs.map((o) => o.weight);

    const scoreOf = (vals) => combine(outs.map((o, j) => desirability(o, vals[j], ...rg[o.name], s.desirabilityShape)), w, s.combine);

    // Current best observed combined score (for EI / PI).
    const best = Math.max(0, ...doneRuns(p).map((r) => runScore(p, r, s, rg) ?? 0));
    const chosen = [];
    const picks = [];
    let cur = { ...models };

    const describe = (i, preds) => {
      const pr = {};
      outs.forEach((o, j) => { pr[o.name] = preds[j][i]; });
      return pr;
    };

    if (s.acquisition === "thompson") {
      const posts = outs.map((o) => {
        const pr = cur[o.name].predict(F, true);
        const { L } = BC.choleskyJitter(pr.cov, 1e-9);
        return { pr, L };
      });
      const expected = F.map((_, i) => scoreOf(outs.map((o, j) => cur[o.name].toY(posts[j].pr.mu[i]))));
      for (let t = 0; t < k; t++) {
        const draws = posts.map(({ pr, L }) => {
          const e = F.map(() => rng.normal());
          return pr.mu.map((m, i) => { let v = m; const li = L[i]; for (let q = 0; q <= i; q++) v += li[q] * e[q]; return v; });
        });
        let bi = -1, bv = -Infinity;
        for (let i = 0; i < F.length; i++) {
          if (chosen.includes(i)) continue;
          const v = scoreOf(outs.map((o, j) => cur[o.name].toY(draws[j][i]))) * noGo[i];
          if (v > bv) { bv = v; bi = i; }
        }
        chosen.push(bi);
        picks.push({ i: bi, acq: bv, expected: expected[bi] });
      }
      const preds = outs.map((o, j) => posts[j].pr.mu.map((m, i) => ({ mean: cur[o.name].toY(m), sd: Math.sqrt(posts[j].pr.var[i]) * cur[o.name].transform.scale })));
      return picks.map((pk) => ({
        x: pool[pk.i], phase: "bo", score: pk.expected, acq: pk.acq, predictions: describe(pk.i, preds),
        why: `Model pick (Thompson sampling). Expected score ${pk.expected.toFixed(2)}.`,
      }));
    }

    // Marginal Monte Carlo acquisitions with a batch strategy.
    const S = Math.max(8, s.mcSamples);
    const eps = Array.from({ length: S }, () => outs.map(() => rng.normal()));
    for (let t = 0; t < k; t++) {
      const prs = outs.map((o) => cur[o.name].predict(F, false));
      let bi = -1, bv = -Infinity, bExp = 0;
      for (let i = 0; i < F.length; i++) {
        if (chosen.includes(i)) continue;
        const samples = eps.map((e) => scoreOf(outs.map((o, j) => cur[o.name].toY(prs[j].mu[i] + Math.sqrt(prs[j].var[i]) * e[j]))));
        const m = BC.mean(samples), sdv = BC.sd(samples);
        let a;
        switch (s.acquisition) {
          case "ei": a = BC.mean(samples.map((v) => Math.max(0, v - best - s.xi))); break;
          case "pi": a = samples.filter((v) => v > best + s.xi).length / S; break;
          case "ucb": a = m + s.ucbBeta * sdv; break;
          case "explore": a = sdv; break;
          default: a = scoreOf(outs.map((o, j) => cur[o.name].toY(prs[j].mu[i]))); // "exploit"
        }
        a *= noGo[i];
        if (a > bv) { bv = a; bi = i; bExp = m; }
      }
      chosen.push(bi);
      const preds = outs.map((o, j) => ({ mean: cur[o.name].toY(prs[j].mu[bi]), sd: Math.sqrt(prs[j].var[bi]) * cur[o.name].transform.scale }));
      picks.push({ i: bi, acq: bv, expected: bExp, preds });
      // Fantasise an outcome at the pick so the next pick goes elsewhere.
      const next = {};
      outs.forEach((o, j) => {
        let zf = prs[j].mu[bi];
        // Believer: assume the predicted mean. Liars: assume a pessimistic or
        // optimistic outcome (2 sd), which spreads or concentrates the batch.
        if (s.batchStrategy === "liar-min") zf -= 2 * Math.sqrt(prs[j].var[bi]);
        if (s.batchStrategy === "liar-max") zf += 2 * Math.sqrt(prs[j].var[bi]);
        next[o.name] = cur[o.name].condition(F[bi], zf);
      });
      cur = next;
    }
    const names = { ei: "expected improvement", pi: "probability of improvement", ucb: "upper confidence bound", explore: "pure exploration", exploit: "pure exploitation" };
    return picks.map((pk) => ({
      x: pool[pk.i], phase: "bo", score: pk.expected, acq: pk.acq,
      predictions: Object.fromEntries(outs.map((o, j) => [o.name, pk.preds[j]])),
      why: `Model pick (${names[s.acquisition] || s.acquisition}). Expected score ${pk.expected.toFixed(2)}.`,
    }));
  }

  Object.assign(BC, {
    DEFAULT_SETTINGS, mergeSettings, initialRuns, featureMap, outputRange, desirability, combine, doneRuns,
    observedValues, ranges, runScore, fitAll, candidatePool, noGoFactors, propose, acquire,
  });
})();
