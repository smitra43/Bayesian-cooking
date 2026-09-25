/* Search space: validation, sampling (incl. mixtures), encoding, local
 * perturbation, space-filling designs and PCA feature maps. */
(function () {
  const BC = (globalThis.BC = globalThis.BC || {});
  const FACTOR_TYPES = ["continuous", "integer", "categorical", "component"];

  /** True for every factor type except choices. */
  function isNumeric(f) { return f.type !== "categorical"; }

  /** Rescale a factor value to 0–1 across its range (on a log scale if the factor uses one). */
  function toUnit(f, v) {
    v = Number(v);
    if (f.log) return (Math.log(v) - Math.log(f.low)) / (Math.log(f.high) - Math.log(f.low));
    return f.high > f.low ? (v - f.low) / (f.high - f.low) : 0;
  }

  /** The reverse of toUnit: a 0–1 position back to a real value (rounded for whole numbers). */
  function fromUnit(f, u) {
    u = Math.min(1, Math.max(0, u));
    const v = f.log ? Math.exp(Math.log(f.low) + u * (Math.log(f.high) - Math.log(f.low))) : f.low + u * (f.high - f.low);
    return f.type === "integer" ? Math.round(v) : v;
  }

  /** The factors that belong to one blend. */
  function components(p, group) { return p.factors.filter((f) => f.type === "component" && f.group === group); }

  /** List of human-readable problems with a project definition (empty = valid). */
  function checkProject(p) {
    const errs = [];
    if (!p.factors.length) errs.push("Add at least one factor.");
    if (!p.outputs.length) errs.push("Add at least one output.");
    const names = [...p.factors.map((f) => f.name), ...p.outputs.map((o) => o.name)];
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    if (dup.length) errs.push(`Names must be unique: ${[...new Set(dup)].join(", ")}.`);
    for (const f of p.factors) {
      if (!f.name) errs.push("Every factor needs a name.");
      if (!FACTOR_TYPES.includes(f.type)) errs.push(`${f.name}: unknown type.`);
      if (f.type === "categorical") {
        if (!f.levels || f.levels.length < 2) errs.push(`${f.name}: needs at least two options.`);
      } else {
        if (!(Number(f.low) < Number(f.high))) errs.push(`${f.name}: low must be below high.`);
        if (f.log && !(f.low > 0)) errs.push(`${f.name}: log scale needs a low above 0.`);
      }
      if (f.type === "component" && !(f.group in (p.mixtures || {}))) errs.push(`${f.name}: blend "${f.group}" has no total.`);
    }
    for (const [g, total] of Object.entries(p.mixtures || {})) {
      const cs = components(p, g);
      if (!cs.length) continue;
      if (cs.length < 2) errs.push(`Blend "${g}" needs at least two parts.`);
      const lo = cs.reduce((a, c) => a + c.low, 0), hi = cs.reduce((a, c) => a + c.high, 0);
      if (!(lo <= total + 1e-9 && total <= hi + 1e-9)) errs.push(`Blend "${g}": the part ranges can't add up to ${total}.`);
    }
    for (const o of p.outputs) {
      if (o.goal === "target" && (o.target === null || o.target === undefined || o.target === "")) errs.push(`${o.name}: needs a target value.`);
      if (!(o.weight > 0)) errs.push(`${o.name}: weight must be above 0.`);
    }
    return errs;
  }

  /** Problems with one run's factor values (empty = valid). */
  function checkRun(p, x) {
    const errs = [];
    for (const f of p.factors) {
      const v = x[f.name];
      if (v === undefined || v === null || v === "") { errs.push(`${f.name} is missing.`); continue; }
      if (f.type === "categorical") { if (!f.levels.includes(v)) errs.push(`${f.name}: pick one of the listed options.`); }
      else if (!(Number(v) >= f.low - 1e-9 && Number(v) <= f.high + 1e-9)) errs.push(`${f.name} must be between ${f.low} and ${f.high}.`);
    }
    for (const [g, total] of Object.entries(p.mixtures || {})) {
      const cs = components(p, g);
      if (!cs.length) continue;
      const s = cs.reduce((a, c) => a + Number(x[c.name]), 0);
      if (Math.abs(s - total) > 1e-6 * Math.max(1, total)) errs.push(`Blend "${g}" adds to ${+s.toFixed(3)}; it must add to ${total}.`);
    }
    return errs;
  }

  /** Random mixture within per-part bounds that sums exactly to total. */
  function sampleMixture(cs, total, rng) {
    const order = rng.permutation(cs.length);
    let remaining = total;
    const out = {};
    order.forEach((idx, k) => {
      const c = cs[idx];
      const rest = order.slice(k + 1).map((j) => cs[j]);
      if (!rest.length) { out[c.name] = remaining; return; }
      const lo = Math.max(c.low, remaining - rest.reduce((a, r) => a + r.high, 0));
      const hi = Math.min(c.high, remaining - rest.reduce((a, r) => a + r.low, 0));
      const v = lo + rng.uniform() * (hi - lo);
      out[c.name] = v;
      remaining -= v;
    });
    return out;
  }

  /** Latin-hypercube samples for free numeric factors; random levels; mixtures. */
  function sample(p, n, rng, method = "lhs") {
    const free = p.factors.filter((f) => f.type === "continuous" || f.type === "integer");
    const runs = Array.from({ length: n }, () => ({}));
    free.forEach((f, d) => {
      let u;
      if (method === "random") u = runs.map(() => rng.uniform());
      else if (method === "halton") u = runs.map((_, i) => halton(i + 1 + (rng.int(64)), PRIMES[d % PRIMES.length]));
      else { const perm = rng.permutation(n); u = perm.map((k) => (k + rng.uniform()) / n); }
      runs.forEach((r, i) => { r[f.name] = fromUnit(f, u[i]); });
    });
    for (const f of p.factors) {
      if (f.type !== "categorical") continue;
      if (method === "random") runs.forEach((r) => { r[f.name] = rng.choice(f.levels); });
      else { // balanced assignment, shuffled
        const perm = rng.permutation(n);
        runs.forEach((r, i) => { r[f.name] = f.levels[perm[i] % f.levels.length]; });
      }
    }
    for (const [g, total] of Object.entries(p.mixtures || {})) {
      const cs = components(p, g);
      if (cs.length) runs.forEach((r) => Object.assign(r, sampleMixture(cs, total, rng)));
    }
    return runs;
  }

  const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47];
  /** The i-th number of the Halton low-discrepancy sequence in base b. */
  function halton(i, b) { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }

  /** Nearby run: numeric factors jittered on the unit scale, categories
   * occasionally swapped, mixtures blended toward a random mixture. */
  function perturb(p, x, rng, radius = 0.1, swapProb = 0.15) {
    const y = { ...x };
    for (const f of p.factors) {
      if (f.type === "continuous" || f.type === "integer") y[f.name] = fromUnit(f, toUnit(f, x[f.name]) + radius * rng.normal());
      else if (f.type === "categorical" && rng.uniform() < swapProb) y[f.name] = rng.choice(f.levels);
    }
    for (const [g, total] of Object.entries(p.mixtures || {})) {
      const cs = components(p, g);
      if (!cs.length) continue;
      const r = sampleMixture(cs, total, rng), a = Math.min(1, Math.abs(radius * rng.normal()));
      for (const c of cs) y[c.name] = (1 - a) * Number(x[c.name]) + a * r[c.name];
    }
    return y;
  }

  // ---------------------------------------------------------------- encoding

  /** Column layout of the encoded feature matrix. */
  function layout(p) {
    const cols = [];
    for (const f of p.factors) {
      if (isNumeric(f)) cols.push({ factor: f.name, kind: "num" });
      else for (const lv of f.levels) cols.push({ factor: f.name, kind: "cat", level: lv });
    }
    return cols;
  }

  /** Encode runs: numeric factors on [0,1], categorical levels one-hot scaled
   * by 1/sqrt(2) so two different levels sit at distance 1. */
  function encode(p, runs) {
    const cols = layout(p);
    const byName = Object.fromEntries(p.factors.map((f) => [f.name, f]));
    return runs.map((x) => cols.map((c) =>
      c.kind === "num" ? toUnit(byName[c.factor], x[c.factor]) : (x[c.factor] === c.level ? Math.SQRT1_2 : 0)));
  }

  /** Squared straight-line distance between two encoded recipes. */
  function dist2(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return s; }

  // --------------------------------------------------------------------- DOE

  /**
   * Optimised Latin hypercube. Start from an LHS (one run per slice of every
   * continuous factor) and swap values between runs, keeping only swaps that
   * improve the criterion. Swapping preserves the 1-D stratification.
   *   maximin: minimise phi_p = sum d^-p over pairs (Morris & Mitchell 1995),
   *            i.e. push the closest runs apart.
   *   maxpro:  minimise sum 1 / prod_k (x_k - y_k)^2 (Joseph, Gul & Ba 2015),
   *            which keeps every 1-D and 2-D projection spread, the property
   *            per-factor (ARD) lengthscales rely on.
   * Existing runs are fixed anchors, so a design can be extended.
   */
  function optimizeLHS(p, existing, k, rng, criterion, iters) {
    const runs = sample(p, k, rng, "lhs");
    const facs = p.factors;
    const val = (x) => facs.map((f) => (isNumeric(f) ? toUnit(f, x[f.name]) : x[f.name]));
    const ex = existing.map(val);
    const P = 15;
    function pairTerm(a, b) {
      if (criterion === "maxpro") {
        let logProd = 0;
        facs.forEach((f, j) => {
          const d2 = isNumeric(f) ? (a[j] - b[j]) ** 2 : a[j] === b[j] ? 1 / (f.levels.length ** 2) : 1;
          logProd += Math.log(d2 + 1e-6);
        });
        return Math.exp(-logProd);
      }
      let d2 = 0;
      facs.forEach((f, j) => { d2 += isNumeric(f) ? (a[j] - b[j]) ** 2 : a[j] === b[j] ? 0 : 1; });
      return Math.pow(d2 + 1e-12, -P / 2);
    }
    function score(V) {
      let s = 0;
      for (let i = 0; i < V.length; i++) {
        for (let j = i + 1; j < V.length; j++) s += pairTerm(V[i], V[j]);
        for (const e of ex) s += pairTerm(V[i], e);
      }
      return s;
    }
    const groups = Object.keys(p.mixtures || {}).filter((g) => components(p, g).length);
    const moves = [
      ...facs.filter((f) => f.type !== "component").map((f) => ({ kind: "swap", names: [f.name] })),
      ...groups.map((g) => ({ kind: "swap", names: components(p, g).map((c) => c.name) })),
      ...groups.map((g) => ({ kind: "resample", group: g })),
    ];
    if (k < 2 && !ex.length) return runs;
    let V = runs.map(val), cur = score(V);
    for (let t = 0; t < iters; t++) {
      const mv = moves[rng.int(moves.length)];
      const i = rng.int(k), j = rng.int(k);
      if (mv.kind === "swap" && (i === j || k < 2)) continue;
      const old = { ...runs[i] }, oldJ = { ...runs[j] };
      if (mv.kind === "swap") for (const n of mv.names) { const tmp = runs[i][n]; runs[i][n] = runs[j][n]; runs[j][n] = tmp; }
      else Object.assign(runs[i], sampleMixture(components(p, mv.group), p.mixtures[mv.group], rng));
      const V2 = V.slice(); V2[i] = val(runs[i]); V2[j] = val(runs[j]);
      const s2 = score(V2);
      if (s2 < cur) { cur = s2; V = V2; }
      else { runs[i] = old; runs[j] = oldJ; }
    }
    return runs;
  }

  /** Quality of a design: spacing, worst 1-D coverage gap, factor correlation. */
  function designQuality(p, runs) {
    if (runs.length < 2) return null;
    const num = p.factors.filter(isNumeric);
    const U = num.map((f) => runs.map((x) => toUnit(f, x[f.name])));
    // 1-D coverage: largest empty stretch along each continuous factor
    // (whole-number factors with few values are skipped; their gaps are fixed).
    const gaps = U.map((u, a) => {
      if (num[a].type !== "continuous" && num[a].type !== "component") return -1;
      const s = [0, ...u.slice().sort((x, y) => x - y), 1];
      return Math.max(...s.slice(1).map((v, i) => v - s[i]));
    });
    let maxCorr = 0, pair = null;
    for (let a = 0; a < U.length; a++) for (let b = a + 1; b < U.length; b++) {
      if (num[a].type === "component" && num[b].type === "component" && num[a].group === num[b].group) continue; // linked by the blend total
      const r = Math.abs(BC.pearson(U[a], U[b]));
      if (r > maxCorr) { maxCorr = r; pair = [num[a].name, num[b].name]; }
    }
    return {
      minDistance: minDistance(p, runs),
      worstGap: Math.max(...gaps, -1) >= 0 ? Math.max(...gaps) : null,
      worstGapFactor: Math.max(...gaps, -1) >= 0 ? num[gaps.indexOf(Math.max(...gaps))].name : null,
      maxCorr: U.length > 1 ? maxCorr : null, maxCorrPair: pair,
    };
  }

  /** Initial design. method: maxpro | maximin | lhs | random | halton.
   * Existing runs are taken into account so designs extend gracefully. */
  function design(p, existing, k, rng, method = "maxpro", iters = 2000) {
    if (k <= 0) return [];
    if (method === "maximin" || method === "maxpro") return optimizeLHS(p, existing, k, rng, method, iters);
    return sample(p, k, rng, method);
  }

  /** Smallest pairwise distance in encoded space (design quality). */
  function minDistance(p, runs) {
    const x = encode(p, runs);
    let m = Infinity;
    for (let i = 0; i < x.length; i++) for (let j = i + 1; j < x.length; j++) m = Math.min(m, Math.sqrt(dist2(x[i], x[j])));
    return m;
  }

  // --------------------------------------------------------------------- PCA

  /** Fit PCA on rows of X. truncate: {mode: "k"|"variance", value}. */
  function fitPCA(X, { mode = "variance", value = 0.95, standardize = false } = {}) {
    const n = X.length, d = X[0].length;
    const mu = Array.from({ length: d }, (_, j) => BC.mean(X.map((r) => r[j])));
    const sc = Array.from({ length: d }, (_, j) => (standardize ? BC.sd(X.map((r) => r[j])) || 1 : 1));
    const Z = X.map((r) => r.map((v, j) => (v - mu[j]) / sc[j]));
    const C = BC.zeros(d, d);
    for (const r of Z) for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) C[i][j] += (r[i] * r[j]) / Math.max(1, n - 1);
    const { values, vectors } = BC.symEig(C);
    const vals = values.map((v) => Math.max(0, v));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const ratio = vals.map((v) => v / total);
    let k;
    if (mode === "k") k = Math.max(1, Math.min(d, Math.round(value)));
    else { let c = 0; k = 0; while (k < d && c < value - 1e-12) { c += ratio[k]; k++; } k = Math.max(1, k); }
    const comps = vectors.slice(0, k);
    return {
      k, ratio, mu, sc, components: comps, loadings: vectors,
      transform: (rows) => rows.map((r) => comps.map((v) => r.reduce((a, x, j) => a + ((x - mu[j]) / sc[j]) * v[j], 0))),
    };
  }

  Object.assign(BC, {
    FACTOR_TYPES, isNumeric, toUnit, fromUnit, components, checkProject, checkRun, sampleMixture, sample,
    perturb, layout, encode, dist2, design, designQuality, minDistance, fitPCA,
  });
})();
