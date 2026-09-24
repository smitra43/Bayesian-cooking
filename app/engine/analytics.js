/* Analytics computed from a project's runs and fitted models. */
(function () {
  const BC = (globalThis.BC = globalThis.BC || {});

  function valid(v) { return v !== null && v !== undefined && v !== "" && isFinite(v); }

  /** Score of every done run, and the running best, in run order. */
  function progress(p, s) {
    const rg = BC.ranges(p);
    let best = -Infinity;
    return BC.doneRuns(p).map((r, i) => {
      const sc = BC.runScore(p, r, s, rg);
      if (sc !== null) best = Math.max(best, sc);
      return { i: i + 1, id: r.id, phase: r.phase, score: sc, best: isFinite(best) ? best : null };
    });
  }

  /** Posterior mean of the target ("__score" = combined desirability) at runs. */
  function predictor(p, s, fitted, target) {
    const { models, fmap } = fitted;
    const outs = p.outputs.filter((o) => models[o.name]);
    const rg = BC.ranges(p);
    return (runs) => {
      const F = fmap.apply(runs);
      if (target !== "__score") {
        const m = models[target];
        const pr = m.predict(F);
        return { mean: pr.mu.map(m.toY), sd: pr.var.map((v) => Math.sqrt(v) * m.transform.scale) };
      }
      const prs = outs.map((o) => models[o.name].predict(F));
      const mean = runs.map((_, i) => BC.combine(
        outs.map((o, j) => BC.desirability(o, models[o.name].toY(prs[j].mu[i]), ...rg[o.name], s.desirabilityShape)),
        outs.map((o) => o.weight), s.combine));
      return { mean, sd: null };
    };
  }

  /** Main effects: for each factor, the average prediction as that factor
   * sweeps its range while everything else follows a background sample.
   * Importance = variance of that curve, normalised to sum to 1. */
  function mainEffects(p, s, fitted, target, { grid = 12, background = 60, seed = 11 } = {}) {
    const rng = BC.Rng(seed);
    const base = BC.sample(p, background, rng, "lhs");
    const pred = predictor(p, s, fitted, target);
    const effects = p.factors.map((f) => {
      const xs = f.type === "categorical" ? f.levels.slice()
        : Array.from({ length: grid }, (_, g) => BC.fromUnit(f, g / (grid - 1)));
      const uniq = f.type === "integer" ? [...new Set(xs)] : xs;
      const curve = uniq.map((v) => {
        const runs = base.map((b) => setFactor(p, b, f, v));
        const pr = pred(runs);
        return { x: v, mean: BC.mean(pr.mean), sd: pr.sd ? BC.mean(pr.sd) : null };
      });
      const ms = curve.map((c) => c.mean);
      return { factor: f.name, type: f.type, unit: f.unit || "", curve, variance: BC.sd(ms) ** 2 || 0 };
    });
    const total = effects.reduce((a, e) => a + e.variance, 0) || 1;
    effects.forEach((e) => { e.importance = e.variance / total; });
    return effects;
  }

  /** Set one factor; for a blend part, rescale the other parts to keep the total. */
  function setFactor(p, x, f, v) {
    const y = { ...x, [f.name]: v };
    if (f.type === "component") {
      const total = p.mixtures[f.group];
      const others = BC.components(p, f.group).filter((c) => c.name !== f.name);
      const rest = others.reduce((a, c) => a + Number(x[c.name]), 0);
      const left = total - v;
      others.forEach((c) => { y[c.name] = rest > 0 ? (Number(x[c.name]) * left) / rest : left / others.length; });
    }
    return y;
  }

  /** 2-D response surface over factors fx, fy with others fixed at `anchor`. */
  function surface(p, s, fitted, target, fx, fy, anchor, n = 30) {
    const F = Object.fromEntries(p.factors.map((f) => [f.name, f]));
    const axis = (f) => (f.type === "categorical" ? f.levels.slice() : Array.from({ length: n }, (_, g) => BC.fromUnit(f, g / (n - 1))));
    const ax = axis(F[fx]), ay = axis(F[fy]);
    const runs = [];
    for (const vy of ay) for (const vx of ax) runs.push(setFactor(p, setFactor(p, anchor, F[fx], vx), F[fy], vy));
    const pr = predictor(p, s, fitted, target)(runs);
    const z = ay.map((_, j) => ax.map((_, i) => pr.mean[j * ax.length + i]));
    const zsd = pr.sd ? ay.map((_, j) => ax.map((_, i) => pr.sd[j * ax.length + i])) : null;
    return { x: ax, y: ay, z, zsd };
  }

  /** Leave-one-out predictions and calibration per output. */
  function diagnostics(p, fitted) {
    const done = BC.doneRuns(p);
    return p.outputs.filter((o) => fitted.models[o.name]).map((o) => {
      const m = fitted.models[o.name];
      const rows = done.filter((r) => valid(r.y[o.name]));
      const obs = rows.map((r) => Number(r.y[o.name]));
      const loo = m.loo();
      const resid = obs.map((y, i) => y - loo.mu[i]);
      const ss = obs.reduce((a, y) => a + (y - BC.mean(obs)) ** 2, 0);
      const r2 = ss > 0 ? 1 - resid.reduce((a, e) => a + e * e, 0) / ss : NaN;
      const covered = obs.filter((y, i) => y >= loo.lo[i] && y <= loo.hi[i]).length;
      const zres = rows.map((r, i) => (m.transform.fwd(obs[i]) - loo.zmu[i]) / loo.zsd[i]);
      return {
        output: o.name, ids: rows.map((r) => r.id), obs, pred: loo.mu, lo: loo.lo, hi: loo.hi, zres,
        r2, rmse: Math.sqrt(BC.mean(resid.map((e) => e * e))), coverage: obs.length ? covered / obs.length : NaN,
        noise: m.noiseY, info: m.info,
      };
    });
  }

  /** PCA of the encoded factor settings of all non-rejected runs. */
  function runPCA(p, s) {
    const runs = (p.runs || []).filter((r) => r.status !== "rejected");
    if (runs.length < 3) return null;
    const E = BC.encode(p, runs.map((r) => r.x));
    const pca = BC.fitPCA(E, { mode: "k", value: Math.min(2, E[0].length), standardize: s.pca.standardize });
    const full = BC.fitPCA(E, { mode: "k", value: E[0].length, standardize: s.pca.standardize });
    const scores = pca.transform(E);
    const cols = BC.layout(p).map((c) => (c.kind === "num" ? c.factor : `${c.factor}=${c.level}`));
    const rg = BC.ranges(p);
    return {
      scores, ids: runs.map((r) => r.id), status: runs.map((r) => r.status),
      score: runs.map((r) => (r.status === "done" ? BC.runScore(p, r, s, rg) : null)),
      ratio: full.ratio, loadings: full.loadings.slice(0, 2), cols,
      keep: s.pca.enabled ? BC.fitPCA(E, s.pca).k : null,
    };
  }

  /** Pearson correlations between numeric factors and outputs over done runs. */
  function correlations(p) {
    const done = BC.doneRuns(p);
    const vars = [
      ...p.factors.filter((f) => f.type !== "categorical").map((f) => ({ name: f.name, get: (r) => Number(r.x[f.name]) })),
      ...p.outputs.map((o) => ({ name: o.name, get: (r) => (valid(r.y[o.name]) ? Number(r.y[o.name]) : NaN) })),
    ];
    const m = vars.map((a) => vars.map((b) => {
      const pairs = done.map((r) => [a.get(r), b.get(r)]).filter(([u, v]) => isFinite(u) && isFinite(v));
      return BC.pearson(pairs.map((q) => q[0]), pairs.map((q) => q[1]));
    }));
    return { names: vars.map((v) => v.name), matrix: m, n: done.length };
  }

  /** Non-dominated runs for two outputs, respecting each goal. */
  function pareto(p, a, b) {
    const oa = p.outputs.find((o) => o.name === a), ob = p.outputs.find((o) => o.name === b);
    if (!oa || !ob) return { points: [], front: [] };
    const good = (o, v) => (o.goal === "maximize" ? v : o.goal === "minimize" ? -v : -Math.abs(v - o.target));
    const pts = BC.doneRuns(p).filter((r) => valid(r.y[a]) && valid(r.y[b]))
      .map((r) => ({ id: r.id, a: Number(r.y[a]), b: Number(r.y[b]), ga: good(oa, Number(r.y[a])), gb: good(ob, Number(r.y[b])) }));
    const front = pts.filter((q) => !pts.some((r) => r !== q && r.ga >= q.ga && r.gb >= q.gb && (r.ga > q.ga || r.gb > q.gb)));
    return { points: pts, front: front.sort((u, v) => u.a - v.a) };
  }

  /** Spread of repeated recipes (identical factor settings). */
  function replicates(p) {
    const groups = {};
    for (const r of BC.doneRuns(p)) {
      const key = p.factors.map((f) => (f.type === "categorical" ? r.x[f.name] : Number(r.x[f.name]).toFixed(4))).join("|");
      (groups[key] = groups[key] || []).push(r);
    }
    const reps = Object.values(groups).filter((g) => g.length > 1);
    const pooled = {};
    for (const o of p.outputs) {
      let ss = 0, dof = 0;
      for (const g of reps) {
        const v = g.map((r) => r.y[o.name]).filter(valid).map(Number);
        if (v.length > 1) { const m = BC.mean(v); ss += v.reduce((a, x) => a + (x - m) ** 2, 0); dof += v.length - 1; }
      }
      pooled[o.name] = dof ? { sd: Math.sqrt(ss / dof), dof } : null;
    }
    return { groups: reps.map((g) => g.map((r) => r.id)), pooled };
  }

  /** Warnings about settings that don't suit the amount of data. */
  function adviseSettings(p, s) {
    const s2 = BC.mergeSettings(s);
    const n = BC.doneRuns(p).length;
    const dims = BC.layout(p).filter((c) => c.kind === "num").length;
    const w = [];
    if (s2.model === "gp" && s2.gp.ard && n < 3 * dims)
      w.push(`ARD fits one lengthscale per numeric factor (${dims}). With ${n} results, aim for at least ${3 * dims} before trusting it.`);
    if (s2.model === "gp" && !s2.gp.priors && n < 15)
      w.push("Hyperparameter priors are off. With fewer than ~15 results the fit can latch onto noise.");
    if (s2.pca.enabled)
      w.push("Input PCA only helps when factors move together. Your design spreads them independently, so it usually discards information.");
    if (s2.model === "blr" && s2.blr.degree >= 2 && s2.blr.interactions) {
      const k = 1 + BC.layout(p).length + dims + (dims * (dims - 1)) / 2;
      if (n < k) w.push(`The quadratic model has ${k} coefficients but only ${n} results; it leans heavily on its prior.`);
    }
    if (s2.acquisition === "thompson" && s2.candidates > 900)
      w.push("Thompson sampling with more than ~900 candidates can take several seconds per session on a phone.");
    if (s2.batchSize > 6) w.push("More than 6 tastings per session makes scores noisy from palate fatigue.");
    if (s2.gp.noise === "fixed" && s2.gp.noiseValue < 0.05) w.push("Fixed noise near zero forces the model through every score, including mistakes.");
    return w;
  }

  Object.assign(BC, { progress, predictor, mainEffects, setFactor, surface, diagnostics, runPCA, correlations, pareto, replicates, adviseSettings });
})();
