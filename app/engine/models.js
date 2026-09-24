/* Surrogate models. Every model exposes the same interface:
 *   predict(Xs, full)   -> {mu, var, cov?} on the latent (transformed) scale
 *   toY(z)              -> map latent values back to the output's units
 *   loo()               -> leave-one-out {mu, sd} in output units
 *   condition(x, yLat)  -> same hyperparameters, one extra (fantasy) point
 *   info                -> hyperparameters and diagnostics for display
 */
(function () {
  const BC = (globalThis.BC = globalThis.BC || {});

  // ------------------------------------------------------- output transforms

  function makeTransform(y, kind) {
    if (kind === "log") {
      const pos = y.every((v) => v > 0);
      if (!pos) kind = "standardize"; // log needs positive values; fall back quietly
      else {
        const ly = y.map(Math.log);
        const mu = BC.mean(ly), s = ly.length > 1 ? BC.sd(ly) || 1 : 1;
        return { kind, fwd: (v) => (Math.log(v) - mu) / s, inv: (z) => Math.exp(mu + s * z), scale: s };
      }
    }
    const mu = y.length ? BC.mean(y) : 0;
    const s = kind === "none" ? 1 : y.length > 1 ? BC.sd(y) || 1 : 1;
    return { kind, fwd: (v) => (v - mu) / s, inv: (z) => mu + s * z, scale: s };
  }

  // ----------------------------------------------------------------- kernels

  const KERNELS = {
    rbf: (r2) => Math.exp(-0.5 * r2),
    matern52: (r2) => { const r = Math.sqrt(5 * r2); return (1 + r + r * r / 3) * Math.exp(-r); },
    matern32: (r2) => { const r = Math.sqrt(3 * r2); return (1 + r) * Math.exp(-r); },
    exponential: (r2) => Math.exp(-Math.sqrt(r2)),
    rq: (r2, alpha) => Math.pow(1 + r2 / (2 * alpha), -alpha),
  };

  const GP_DEFAULTS = {
    kernel: "matern52", ard: false, catLengthscales: "shared", noise: "fit", noiseValue: 0.3,
    mean: "data", transform: "standardize", priors: true, priorWidth: 0.6,
    lenNumPrior: 0.35, lenCatPrior: 1.0, signalPrior: 1.0, noisePrior: 0.4, alphaPrior: 1.0,
    restarts: 3, maxIter: 300, minPointsToFit: 5, jitter: 1e-6, seed: 7,
  };

  /**
   * Gaussian process regression.
   * cols: [{kind: "num"|"cat", factor}] describing each feature column.
   */
  function fitGP(X, y, cols, opts = {}) {
    const o = { ...GP_DEFAULTS, ...opts };
    const tf = makeTransform(y, o.transform);
    const z = y.map(tf.fwd);
    const n = X.length;

    const numIdx = cols.map((c, i) => (c.kind === "num" ? i : -1)).filter((i) => i >= 0);
    const catFactors = [...new Set(cols.filter((c) => c.kind === "cat").map((c) => c.factor))];
    const catGroups = catFactors.map((f) => cols.map((c, i) => (c.kind === "cat" && c.factor === f ? i : -1)).filter((i) => i >= 0));

    // Hyperparameter layout (all on log scale).
    const spec = [];
    if (numIdx.length) {
      if (o.ard) numIdx.forEach((i) => spec.push({ name: `len:${cols[i].label || cols[i].factor}`, group: "lenNum", col: i, prior: o.lenNumPrior }));
      else spec.push({ name: "len:numeric", group: "lenNum", prior: o.lenNumPrior });
    }
    if (catGroups.length) {
      if (o.catLengthscales === "per-factor") catFactors.forEach((f, g) => spec.push({ name: `len:${f}`, group: "lenCat", cat: g, prior: o.lenCatPrior }));
      else spec.push({ name: "len:categorical", group: "lenCat", prior: o.lenCatPrior });
    }
    spec.push({ name: "signal", group: "signal", prior: o.signalPrior });
    if (o.noise === "fit") spec.push({ name: "noise", group: "noise", prior: o.noisePrior });
    if (o.kernel === "rq") spec.push({ name: "alpha", group: "alpha", prior: o.alphaPrior });

    function unpack(theta) {
      const h = { lenNum: new Array(cols.length).fill(1), lenCat: new Array(catGroups.length).fill(1), signal: 1,
        noise: o.noiseValue, alpha: 1 };
      spec.forEach((s, k) => {
        const v = Math.exp(theta[k]);
        if (s.group === "lenNum") { if (s.col !== undefined) h.lenNum[s.col] = v; else numIdx.forEach((i) => { h.lenNum[i] = v; }); }
        else if (s.group === "lenCat") { if (s.cat !== undefined) h.lenCat[s.cat] = v; else h.lenCat.fill(v); }
        else h[s.group] = v;
      });
      return h;
    }

    const kfun = KERNELS[o.kernel] || KERNELS.rbf;
    function kern(a, b, h) {
      let r2 = 0;
      for (const i of numIdx) { const d = (a[i] - b[i]) / h.lenNum[i]; r2 += d * d; }
      catGroups.forEach((g, gi) => {
        let s = 0; for (const i of g) s += (a[i] - b[i]) ** 2;
        r2 += s / (h.lenCat[gi] * h.lenCat[gi]);
      });
      return h.signal * h.signal * kfun(r2, h.alpha);
    }

    function gram(h, Xa) {
      const m = Xa.length, K = BC.zeros(m, m);
      for (let i = 0; i < m; i++) for (let j = 0; j <= i; j++) { const v = kern(Xa[i], Xa[j], h); K[i][j] = v; K[j][i] = v; }
      return K;
    }

    function core(h, Xa, za) {
      const K = gram(h, Xa);
      const nz = h.noise * h.noise + o.jitter;
      for (let i = 0; i < Xa.length; i++) K[i][i] += nz;
      const L = BC.cholesky(K);
      if (!L) return null;
      let c = 0;
      if (o.mean === "gls" && Xa.length) {
        const ones = new Array(Xa.length).fill(1);
        const ki1 = BC.cholSolve(L, ones), kiy = BC.cholSolve(L, za);
        c = BC.dot(ones, kiy) / BC.dot(ones, ki1);
      }
      const r = za.map((v) => v - c);
      const alpha = BC.cholSolve(L, r);
      const logdet = L.reduce((a, row, i) => a + Math.log(row[i]), 0);
      const lml = -0.5 * BC.dot(r, alpha) - logdet - 0.5 * Xa.length * Math.log(2 * Math.PI);
      return { L, alpha, c, lml };
    }

    const theta0 = spec.map((s) => Math.log(s.prior));
    function negLogPost(theta) {
      for (let k = 0; k < theta.length; k++) if (Math.abs(theta[k] - theta0[k]) > 5) return 1e10;
      const res = core(unpack(theta), X, z);
      if (!res) return 1e10;
      let v = -res.lml;
      if (o.priors) theta.forEach((t, k) => { v += 0.5 * ((t - theta0[k]) / o.priorWidth) ** 2; });
      return v;
    }

    let theta = theta0.slice(), fitted = false, iters = 0;
    if (n >= o.minPointsToFit && spec.length) {
      const rng = BC.Rng(o.seed);
      let best = { x: theta0, f: negLogPost(theta0) };
      for (let r = 0; r < Math.max(1, o.restarts); r++) {
        const start = r === 0 ? theta0 : theta0.map((t) => t + 0.8 * rng.normal());
        const res = BC.nelderMead(negLogPost, start, { maxIter: o.maxIter, step: 0.6 });
        iters += res.iters;
        if (res.f < best.f) best = res;
      }
      theta = best.x; fitted = true;
    }
    let h = unpack(theta);
    let fit = core(h, X, z);
    if (!fit) { // numerically bad optimum: fall back to the prior medians
      theta = theta0.slice(); h = unpack(theta); fit = core(h, X, z) || core({ ...h, noise: Math.max(h.noise, 0.1) }, X, z);
    }

    function build(Xa, za, fitA) {
      const model = {
        type: "gp", n: Xa.length, transform: tf, toY: (v) => tf.inv(v),
        predict(Xs, full = false) {
          const m = Xs.length;
          const Ks = Xa.map((xi) => Xs.map((xs) => kern(xi, xs, h)));
          const mu = new Array(m), v = BC.zeros(Xa.length, m);
          for (let j = 0; j < m; j++) {
            let s = fitA.c;
            for (let i = 0; i < Xa.length; i++) s += Ks[i][j] * fitA.alpha[i];
            mu[j] = s;
          }
          // v = L^{-1} Ks, column by column (forward substitution in place)
          for (let j = 0; j < m; j++) {
            for (let i = 0; i < Xa.length; i++) {
              let s = Ks[i][j];
              const li = fitA.L[i];
              for (let k = 0; k < i; k++) s -= li[k] * v[k][j];
              v[i][j] = s / li[i];
            }
          }
          const s2 = h.signal * h.signal;
          const vr = new Array(m);
          for (let j = 0; j < m; j++) { let s = 0; for (let i = 0; i < Xa.length; i++) s += v[i][j] * v[i][j]; vr[j] = Math.max(0, s2 - s); }
          const out = { mu, var: vr };
          if (full) {
            const cov = BC.zeros(m, m);
            for (let a = 0; a < m; a++) {
              for (let b = 0; b <= a; b++) {
                let s = kern(Xs[a], Xs[b], h);
                for (let i = 0; i < Xa.length; i++) s -= v[i][a] * v[i][b];
                cov[a][b] = s; cov[b][a] = s;
              }
            }
            out.cov = cov;
          }
          return out;
        },
        loo() {
          const Kinv = BC.cholInverse(fitA.L);
          const muL = za.map((zi, i) => zi - fitA.alpha[i] / Kinv[i][i]);
          const sdL = za.map((_, i) => Math.sqrt(1 / Kinv[i][i]));
          return { mu: muL.map(tf.inv), lo: muL.map((m, i) => tf.inv(m - 1.96 * sdL[i])), hi: muL.map((m, i) => tf.inv(m + 1.96 * sdL[i])), zmu: muL, zsd: sdL };
        },
        condition(x, zNew) {
          const Xb = [...Xa, x], zb = [...za, zNew];
          const f2 = core(h, Xb, zb);
          return f2 ? build(Xb, zb, f2) : model;
        },
        noiseY: h.noise * tf.scale,
        info: {
          model: "Gaussian process", kernel: o.kernel, ard: o.ard, fitted, iters, n: Xa.length,
          logML: fitA.lml, hypers: spec.map((s, k) => ({ name: s.name, value: Math.exp(theta[k]), prior: s.prior })),
          fixedNoise: o.noise === "fit" ? null : o.noiseValue,
          lengthscales: cols.map((c, i) => (c.kind === "num" ? h.lenNum[i] : h.lenCat[catFactors.indexOf(c.factor)])),
        },
      };
      return model;
    }
    return build(X, z, fit);
  }

  // ---------------------------------------------- Bayesian linear regression

  const BLR_DEFAULTS = { degree: 2, interactions: true, fitPrecisions: true, alpha: 1.0, beta: 4.0, transform: "standardize" };

  function basisFn(cols, degree, interactions) {
    const num = cols.map((c, i) => (c.kind === "num" ? i : -1)).filter((i) => i >= 0);
    return (x) => {
      const phi = [1, ...x.map((v, i) => (cols[i].kind === "num" ? v - 0.5 : v))];
      if (degree >= 2) for (const i of num) phi.push((x[i] - 0.5) ** 2);
      if (interactions) for (let a = 0; a < num.length; a++) for (let b = a + 1; b < num.length; b++) phi.push((x[num[a]] - 0.5) * (x[num[b]] - 0.5));
      return phi;
    };
  }

  function fitBLR(X, y, cols, opts = {}) {
    const o = { ...BLR_DEFAULTS, ...opts };
    const tf = makeTransform(y, o.transform);
    const z = y.map(tf.fwd);
    const phiOf = basisFn(cols, o.degree, o.interactions);
    const Phi = X.map(phiOf);
    const d = Phi.length ? Phi[0].length : phiOf(new Array(cols.length).fill(0.5)).length;

    function solve(PhiA, zA, alpha, beta) {
      const A = BC.zeros(d, d);
      for (const r of PhiA) for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) A[i][j] += beta * r[i] * r[j];
      for (let i = 0; i < d; i++) A[i][i] += alpha;
      const { L } = BC.choleskyJitter(A);
      const b = new Array(d).fill(0);
      PhiA.forEach((r, k) => { for (let i = 0; i < d; i++) b[i] += beta * r[i] * zA[k]; });
      const m = BC.cholSolve(L, b);
      return { L, m, alpha, beta };
    }

    let alpha = o.alpha, beta = o.beta, iters = 0;
    if (o.fitPrecisions && X.length >= 3) { // MacKay evidence fixed-point iterations
      for (; iters < 100; iters++) {
        const s = solve(Phi, z, alpha, beta);
        const S = BC.cholInverse(s.L);
        let gamma = 0; for (let i = 0; i < d; i++) gamma += 1 - alpha * S[i][i];
        const mm = BC.dot(s.m, s.m);
        const resid = Phi.reduce((a, r, k) => a + (z[k] - BC.dot(r, s.m)) ** 2, 0);
        const na = Math.min(1e4, Math.max(1e-4, gamma / Math.max(mm, 1e-12)));
        const nb = Math.min(1e4, Math.max(1e-2, (X.length - gamma) / Math.max(resid, 1e-12)));
        const done = Math.abs(na - alpha) / alpha < 1e-4 && Math.abs(nb - beta) / beta < 1e-4;
        alpha = na; beta = nb;
        if (done) break;
      }
    }

    function build(PhiA, zA) {
      const s = solve(PhiA, zA, alpha, beta);
      const S = BC.cholInverse(s.L);
      const model = {
        type: "blr", n: PhiA.length, transform: tf, toY: (v) => tf.inv(v),
        predict(Xs, full = false) {
          const P = Xs.map(phiOf);
          const mu = P.map((p) => BC.dot(p, s.m));
          const SP = P.map((p) => BC.matvec(S, p));
          const vr = P.map((p, i) => Math.max(0, BC.dot(p, SP[i])));
          const out = { mu, var: vr };
          if (full) out.cov = P.map((pa) => SP.map((sb) => BC.dot(pa, sb)));
          return out;
        },
        loo() {
          const mu = [], sdv = [];
          for (let i = 0; i < PhiA.length; i++) {
            const P2 = PhiA.filter((_, k) => k !== i), z2 = zA.filter((_, k) => k !== i);
            const s2 = solve(P2, z2, alpha, beta);
            const S2 = BC.cholInverse(s2.L);
            mu.push(BC.dot(PhiA[i], s2.m));
            sdv.push(Math.sqrt(1 / beta + BC.dot(PhiA[i], BC.matvec(S2, PhiA[i]))));
          }
          return { mu: mu.map(tf.inv), lo: mu.map((m, i) => tf.inv(m - 1.96 * sdv[i])), hi: mu.map((m, i) => tf.inv(m + 1.96 * sdv[i])), zmu: mu, zsd: sdv };
        },
        condition(x, zNew) { return build([...PhiA, phiOf(x)], [...zA, zNew]); },
        noiseY: tf.scale / Math.sqrt(beta),
        info: {
          model: "Bayesian polynomial regression", degree: o.degree, interactions: o.interactions, n: PhiA.length,
          fitted: o.fitPrecisions, iters, basisSize: d,
          hypers: [{ name: "weight precision α", value: alpha }, { name: "noise precision β", value: beta }],
          coefficients: s.m,
        },
      };
      return model;
    }
    return build(Phi, z);
  }

  function fitModel(X, y, cols, settings) {
    if (settings.model === "blr") return fitBLR(X, y, cols, settings.blr || {});
    return fitGP(X, y, cols, settings.gp || {});
  }

  Object.assign(BC, { KERNELS, GP_DEFAULTS, BLR_DEFAULTS, makeTransform, fitGP, fitBLR, fitModel });
})();
