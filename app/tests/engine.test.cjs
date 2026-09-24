// Engine tests: node --test app/tests
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

for (const f of ["core", "space", "models", "optimize", "analytics", "library", "example-data"]) require(path.join(__dirname, "..", "engine", `${f}.js`));
const BC = globalThis.BC;

test("cholesky solves a linear system", () => {
  const A = [[4, 2, 0.6], [2, 5, 1], [0.6, 1, 3]];
  const L = BC.cholesky(A);
  const x = BC.cholSolve(L, [1, 2, 3]);
  BC.matvec(A, x).forEach((v, i) => assert.ok(Math.abs(v - [1, 2, 3][i]) < 1e-10));
});

test("symmetric eigen-decomposition reconstructs the matrix", () => {
  const A = [[2, 1, 0], [1, 3, 1], [0, 1, 4]];
  const { values, vectors } = BC.symEig(A);
  assert.ok(values[0] >= values[1] && values[1] >= values[2]);
  vectors.forEach((v, k) => {
    const Av = BC.matvec(A, v);
    Av.forEach((x, i) => assert.ok(Math.abs(x - values[k] * v[i]) < 1e-8));
  });
});

test("samples respect bounds and blend totals", () => {
  const p = BC.fromTemplate("bread");
  const rng = BC.Rng(1);
  for (const x of BC.sample(p, 100, rng)) assert.deepEqual(BC.checkRun(p, x), []);
  for (const x of BC.design(p, [], 8, rng, "maxpro")) assert.deepEqual(BC.checkRun(p, x), []);
});

test("maximin and MaxPro beat random designs", () => {
  const p = BC.fromTemplate("omelette");
  const rng = BC.Rng(3);
  const rand = BC.designQuality(p, BC.design(p, [], 10, rng, "random"));
  const mm = BC.designQuality(p, BC.design(p, [], 10, rng, "maximin"));
  const mp = BC.designQuality(p, BC.design(p, [], 10, rng, "maxpro"));
  assert.ok(mm.minDistance > rand.minDistance);
  assert.ok(mp.worstGap < rand.worstGap);
});

test("invalid projects are explained", () => {
  const p = BC.fromTemplate("bread");
  p.mixtures.flour = 300;
  assert.match(BC.checkProject(p).join(" "), /can't add up to 300/);
});

test("PCA truncation by variance and by count", () => {
  const rng = BC.Rng(5);
  const X = Array.from({ length: 50 }, () => { const t = rng.normal(); return [t, 2 * t + 0.01 * rng.normal(), rng.normal() * 0.01]; });
  assert.equal(BC.fitPCA(X, { mode: "variance", value: 0.95 }).k, 1);
  assert.equal(BC.fitPCA(X, { mode: "k", value: 2 }).k, 2);
});

function synthetic(kernelOpts) {
  const cols = [{ kind: "num", factor: "a" }, { kind: "num", factor: "b" }];
  const rng = BC.Rng(9);
  const X = Array.from({ length: 30 }, () => [rng.uniform(), rng.uniform()]);
  const f = (x) => Math.sin(6 * x[0]) + 0.05 * x[1];
  const y = X.map((x) => f(x) + 0.05 * rng.normal());
  return { cols, X, y, f, m: BC.fitGP(X, y, cols, kernelOpts) };
}

for (const kernel of ["rbf", "matern52", "matern32", "exponential", "rq"]) {
  test(`GP (${kernel}) predicts a smooth function`, () => {
    const { m, f } = synthetic({ kernel });
    const Xs = [[0.2, 0.5], [0.5, 0.5], [0.8, 0.5]];
    const pr = m.predict(Xs);
    pr.mu.forEach((z, i) => assert.ok(Math.abs(m.toY(z) - f(Xs[i])) < 0.25, `${kernel} at ${Xs[i]}`));
  });
}

test("ARD finds the relevant factor", () => {
  const { m } = synthetic({ ard: true, kernel: "rbf" });
  const [la, lb] = m.info.lengthscales;
  assert.ok(la < lb, `lengthscale a=${la} should be shorter than b=${lb}`);
});

test("GP leave-one-out matches explicit refits", () => {
  const { cols, X, y } = synthetic({});
  const m = BC.fitGP(X.slice(0, 12), y.slice(0, 12), cols, { minPointsToFit: 999 });
  const loo = m.loo();
  const m2 = BC.fitGP(X.slice(1, 12), y.slice(1, 12), cols, { minPointsToFit: 999 });
  // Same hyperparameters, but the transform is re-estimated, so compare loosely.
  assert.ok(Math.abs(loo.mu[0] - m2.toY(m2.predict([X[0]]).mu[0])) < 0.3);
});

test("Bayesian polynomial regression fits a quadratic", () => {
  const cols = [{ kind: "num", factor: "a" }];
  const X = Array.from({ length: 20 }, (_, i) => [i / 19]);
  const y = X.map(([a]) => 3 - 10 * (a - 0.6) ** 2);
  const m = BC.fitBLR(X, y, cols, { degree: 2, interactions: false });
  assert.ok(Math.abs(m.toY(m.predict([[0.6]]).mu[0]) - 3) < 0.1);
  assert.equal(m.loo().mu.length, 20);
});

test("every acquisition proposes valid, distinct runs", () => {
  const p = BC.exampleProject();
  for (const acquisition of ["thompson", "ei", "ucb", "pi", "exploit", "explore"]) {
    for (const model of ["gp", "blr"]) {
      const s = BC.mergeSettings({ ...p.settings, acquisition, model, candidates: 200, seed: 1 });
      const props = BC.propose(p, s, 3, 99);
      assert.equal(props.length, 3);
      props.forEach((pr) => assert.deepEqual(BC.checkRun(p, pr.x), []));
      const keys = props.map((pr) => JSON.stringify(pr.x));
      assert.equal(new Set(keys).size, 3, `${acquisition}/${model} proposed duplicates`);
    }
  }
});

test("PCA features and ARD options run end to end", () => {
  const p = BC.exampleProject();
  const s = BC.mergeSettings({ ...p.settings, pca: { enabled: true, mode: "k", value: 3 }, gp: { ard: true, kernel: "rbf" }, candidates: 150 });
  const props = BC.propose(p, s, 2, 50);
  assert.equal(props.length, 2);
});

test("rejected runs push proposals away", () => {
  const p = BC.exampleProject();
  const s = BC.mergeSettings({ ...p.settings, acquisition: "exploit", candidates: 300, seed: 4, localFraction: 0 });
  const first = BC.propose(p, s, 1, 40)[0].x;
  p.runs.push({ id: "RX", status: "rejected", phase: "bo", x: first, y: {}, session: 99 });
  const s2 = { ...s, noGo: { enabled: true, radius: 0.15, mode: "exclude", strength: 1 } };
  const second = BC.propose(p, s2, 1, 40)[0].x;
  const d = Math.sqrt(BC.dist2(BC.encode(p, [first])[0], BC.encode(p, [second])[0]));
  assert.ok(d > 0.15 * Math.sqrt(BC.layout(p).length) - 1e-9);
});

test("BO beats the initial design on a hidden optimum", () => {
  const p = BC.fromTemplate("omelette");
  p.baseline = null;
  p.outputs = [{ name: "liking", goal: "maximize", low: 1, high: 9, weight: 1 }];
  p.settings = BC.mergeSettings({ batchSize: 2, initialRuns: 8, seed: 3, candidates: 300 });
  const rng = BC.Rng(3);
  const taste = (x) => 8 - ((x.pan_temp_c - 165) / 25) ** 2 - (x.eggs - 3) ** 2 - 2 * (x.fat !== "butter");
  for (let sess = 1; sess <= 10; sess++) {
    for (const pr of BC.propose(p, p.settings, 2, sess)) {
      p.runs.push({ id: `R${p.runs.length + 1}`, session: sess, status: "done", phase: pr.phase, x: pr.x, y: { liking: taste(pr.x) + 0.3 * rng.normal() } });
    }
  }
  const doe = p.runs.filter((r) => r.phase === "doe").map((r) => taste(r.x));
  const bo = p.runs.filter((r) => r.phase === "bo").map((r) => taste(r.x));
  assert.ok(Math.max(...bo) > Math.max(...doe), `bo ${Math.max(...bo)} vs doe ${Math.max(...doe)}`);
  assert.ok(Math.max(...bo) > 7);
});

test("analytics run on the example project", () => {
  const p = BC.exampleProject();
  const s = p.settings;
  const fitted = BC.fitAll(p, s);
  const eff = BC.mainEffects(p, s, fitted, "__score");
  assert.ok(Math.abs(eff.reduce((a, e) => a + e.importance, 0) - 1) < 1e-9);
  const top = eff.slice().sort((a, b) => b.importance - a.importance)[0].factor;
  assert.ok(["pan_temp_c", "eggs", "salt_pct"].includes(top), `top factor ${top}`);
  const surf = BC.surface(p, s, fitted, "liking", "pan_temp_c", "fat", p.runs[0].x, 10);
  assert.equal(surf.z.length, 3);
  const diag = BC.diagnostics(p, fitted);
  assert.equal(diag.length, 3);
  assert.ok(diag[0].r2 > 0.1, `liking LOO R2 ${diag[0].r2}`);
  assert.ok(diag[2].r2 > 0.5, `cook loss LOO R2 ${diag[2].r2}`);
  assert.ok(BC.runPCA(p, s).ratio.length > 2);
  assert.ok(BC.correlations(p).names.length > 3);
  assert.ok(BC.pareto(p, "liking", "cook_loss_pct").front.length >= 1);
  assert.ok(BC.replicates(p).groups.length >= 1);
  assert.ok(BC.progress(p, s).length === p.runs.length);
});

test("settings advice flags ARD on little data", () => {
  const p = BC.fromTemplate("omelette");
  assert.match(BC.adviseSettings(p, { gp: { ard: true } }).join(" "), /ARD/);
});

test("every template is valid, including the Beverages folder", () => {
  const folders = new Set(Object.values(BC.TEMPLATES).map((t) => t.folder));
  assert.ok(folders.has("Beverages"));
  for (const [key, t] of Object.entries(BC.TEMPLATES)) {
    const p = BC.fromTemplate(key);
    assert.deepEqual(BC.checkProject(p), [], key);
    if (p.baseline) assert.deepEqual(BC.checkRun(p, p.baseline), [], `${key} baseline`);
    for (const o of p.outputs) assert.ok(o.how, `${key}/${o.name} needs measuring instructions`);
    if (t.folder === "Beverages") assert.ok(p.tips.length >= 3, `${key} tips`);
  }
});

for (const key of ["lemonade", "chai", "margarita"]) {
  test(`${key}: initial design then model picks stay valid`, () => {
    const p = BC.fromTemplate(key);
    p.settings = BC.mergeSettings({ ...p.settings, seed: 5, candidates: 150 });
    const rng = BC.Rng(5);
    for (let sess = 1; sess <= 6; sess++) {
      for (const pr of BC.propose(p, p.settings, p.settings.batchSize, sess)) {
        assert.deepEqual(BC.checkRun(p, pr.x), [], `${key} session ${sess}`);
        const y = Object.fromEntries(p.outputs.map((o) => [o.name, Math.round((o.low + (o.high - o.low) * rng.uniform()) * 10) / 10]));
        p.runs.push({ id: `R${p.runs.length + 1}`, session: sess, status: "done", phase: pr.phase, x: pr.x, y });
      }
    }
    assert.ok(p.runs.some((r) => r.phase === "bo"), `${key} reached the model phase`);
  });
}
