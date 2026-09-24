/* Bayesian Chef engine: seeded random numbers and small dense linear algebra.
 * Every engine file attaches to the global BC namespace so it runs as a
 * classic <script> in the browser and under `require` in Node tests. */
(function () {
  const BC = (globalThis.BC = globalThis.BC || {});

  // ------------------------------------------------------------------ random

  /** Seeded generator (mulberry32) with uniform, normal and choice helpers. */
  function Rng(seed) {
    let s = (seed === undefined || seed === null ? Math.floor(Math.random() * 2 ** 31) : seed) >>> 0;
    let spare = null;
    const rng = {
      uniform() {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      normal() {
        if (spare !== null) { const v = spare; spare = null; return v; }
        let u = 0, v = 0;
        while (u === 0) u = rng.uniform();
        v = rng.uniform();
        const r = Math.sqrt(-2 * Math.log(u));
        spare = r * Math.sin(2 * Math.PI * v);
        return r * Math.cos(2 * Math.PI * v);
      },
      int(n) { return Math.floor(rng.uniform() * n); },
      choice(arr) { return arr[rng.int(arr.length)]; },
      permutation(n) {
        const p = Array.from({ length: n }, (_, i) => i);
        for (let i = n - 1; i > 0; i--) { const j = rng.int(i + 1); [p[i], p[j]] = [p[j], p[i]]; }
        return p;
      },
    };
    return rng;
  }

  // ------------------------------------------------------------ linear algebra
  // Matrices are arrays of row arrays. Sizes here are small (runs <= a few
  // hundred, candidates <= a few thousand), so clarity beats cleverness.

  function zeros(n, m) { return Array.from({ length: n }, () => new Array(m).fill(0)); }
  function eye(n) { const a = zeros(n, n); for (let i = 0; i < n; i++) a[i][i] = 1; return a; }
  function transpose(a) { return a.length ? a[0].map((_, j) => a.map((r) => r[j])) : []; }

  function matmul(a, b) {
    const n = a.length, k = b.length, m = k ? b[0].length : 0;
    const out = zeros(n, m);
    for (let i = 0; i < n; i++) {
      const ai = a[i], oi = out[i];
      for (let p = 0; p < k; p++) {
        const v = ai[p]; if (v === 0) continue;
        const bp = b[p];
        for (let j = 0; j < m; j++) oi[j] += v * bp[j];
      }
    }
    return out;
  }

  function matvec(a, x) { return a.map((r) => dot(r, x)); }
  function dot(x, y) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * y[i]; return s; }

  /** Lower Cholesky factor of a symmetric positive-definite matrix, or null. */
  function cholesky(a) {
    const n = a.length, l = zeros(n, n);
    for (let j = 0; j < n; j++) {
      let d = a[j][j];
      const lj = l[j];
      for (let k = 0; k < j; k++) d -= lj[k] * lj[k];
      if (!(d > 0) || !isFinite(d)) return null;
      const djj = Math.sqrt(d);
      lj[j] = djj;
      for (let i = j + 1; i < n; i++) {
        const li = l[i];
        let s = a[i][j];
        for (let k = 0; k < j; k++) s -= li[k] * lj[k];
        li[j] = s / djj;
      }
    }
    return l;
  }

  /** Cholesky with escalating diagonal jitter; returns {L, jitter}. */
  function choleskyJitter(a, base = 1e-8) {
    const n = a.length;
    const scale = Math.max(1e-12, ...a.map((r, i) => Math.abs(r[i])));
    let jit = 0;
    for (let t = 0; t < 10; t++) {
      const b = jit ? a.map((r, i) => r.map((v, j) => (i === j ? v + jit : v))) : a;
      const L = cholesky(b);
      if (L) return { L, jitter: jit };
      jit = jit ? jit * 10 : base * scale;
    }
    throw new Error("Matrix is not positive definite, even with jitter.");
  }

  function solveLower(L, b) {
    const n = L.length, x = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = b[i];
      const li = L[i];
      for (let k = 0; k < i; k++) s -= li[k] * x[k];
      x[i] = s / li[i];
    }
    return x;
  }

  function solveUpperT(L, b) { // solves L^T x = b
    const n = L.length, x = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
      x[i] = s / L[i][i];
    }
    return x;
  }

  function cholSolve(L, b) { return solveUpperT(L, solveLower(L, b)); }

  /** Inverse of an SPD matrix from its Cholesky factor. */
  function cholInverse(L) {
    const n = L.length, inv = zeros(n, n);
    for (let j = 0; j < n; j++) {
      const e = new Array(n).fill(0); e[j] = 1;
      const col = cholSolve(L, e);
      for (let i = 0; i < n; i++) inv[i][j] = col[i];
    }
    return inv;
  }

  /** Eigen-decomposition of a symmetric matrix (Jacobi). Sorted descending. */
  function symEig(a) {
    const n = a.length;
    const m = a.map((r) => r.slice());
    const v = eye(n);
    for (let sweep = 0; sweep < 100; sweep++) {
      let off = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += m[i][j] ** 2;
      if (off < 1e-20) break;
      for (let p = 0; p < n; p++) {
        for (let q = p + 1; q < n; q++) {
          if (Math.abs(m[p][q]) < 1e-300) continue;
          const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
          const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (let k = 0; k < n; k++) {
            const mkp = m[k][p], mkq = m[k][q];
            m[k][p] = c * mkp - s * mkq; m[k][q] = s * mkp + c * mkq;
          }
          for (let k = 0; k < n; k++) {
            const mpk = m[p][k], mqk = m[q][k];
            m[p][k] = c * mpk - s * mqk; m[q][k] = s * mpk + c * mqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = v[k][p], vkq = v[k][q];
            v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
          }
        }
      }
    }
    const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => m[j][j] - m[i][i]);
    return {
      values: order.map((i) => m[i][i]),
      vectors: order.map((i) => v.map((row) => row[i])), // each entry is one eigenvector
    };
  }

  // ------------------------------------------------------------ optimisation

  /** Nelder-Mead minimiser. Returns {x, f, iters}. */
  function nelderMead(f, x0, { maxIter = 400, step = 0.5, tol = 1e-7 } = {}) {
    const n = x0.length;
    let simplex = [x0.slice()];
    for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += step; simplex.push(x); }
    let fs = simplex.map(f);
    let it = 0;
    for (; it < maxIter; it++) {
      const idx = fs.map((_, i) => i).sort((i, j) => fs[i] - fs[j]);
      simplex = idx.map((i) => simplex[i]); fs = idx.map((i) => fs[i]);
      if (Math.abs(fs[n] - fs[0]) < tol * (1 + Math.abs(fs[0]))) break;
      const c = new Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) c[k] += simplex[i][k] / n;
      const worst = simplex[n];
      const at = (t) => c.map((ck, k) => ck + t * (worst[k] - ck));
      const xr = at(-1), fr = f(xr);
      if (fr < fs[0]) {
        const xe = at(-2), fe = f(xe);
        if (fe < fr) { simplex[n] = xe; fs[n] = fe; } else { simplex[n] = xr; fs[n] = fr; }
      } else if (fr < fs[n - 1]) {
        simplex[n] = xr; fs[n] = fr;
      } else {
        const xc = fr < fs[n] ? at(-0.5) : at(0.5), fc = f(xc);
        if (fc < Math.min(fr, fs[n])) { simplex[n] = xc; fs[n] = fc; }
        else {
          for (let i = 1; i <= n; i++) {
            simplex[i] = simplex[i].map((v, k) => simplex[0][k] + 0.5 * (v - simplex[0][k]));
            fs[i] = f(simplex[i]);
          }
        }
      }
    }
    let best = 0;
    for (let i = 1; i <= n; i++) if (fs[i] < fs[best]) best = i;
    return { x: simplex[best], f: fs[best], iters: it };
  }

  // ------------------------------------------------------------------ stats

  function mean(x) { return x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN; }
  function sd(x) {
    if (x.length < 2) return 0;
    const m = mean(x);
    return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1));
  }
  function normPdf(z) { return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI); }
  function normCdf(z) { // Abramowitz-Stegun 7.1.26 via erf
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t *
      Math.exp(-(z * z) / 2);
    return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }
  function pearson(x, y) {
    const n = x.length; if (n < 3) return NaN;
    const mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
  }

  Object.assign(BC, {
    Rng, zeros, eye, transpose, matmul, matvec, dot, cholesky, choleskyJitter, solveLower, solveUpperT,
    cholSolve, cholInverse, symEig, nelderMead, mean, sd, normPdf, normCdf, pearson,
  });
})();
