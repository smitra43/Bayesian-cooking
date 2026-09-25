/* Bayesian Chef · ui/actions.js
 *
 * Actions that change an experiment: planning and starting a
 * session, saving a score, creating and importing experiments, and the
 * housekeeping needed when factors or outputs are renamed or added.
 *
 * Pattern: change the project, call Chef.save(project), then Chef.render().
 */
(function () {
  "use strict";
  const Chef = (window.Chef = window.Chef || {});
  // Helpers from earlier files, unpacked for readability.
  const { nowIso, valid, toast, state, store, cur, settings } = Chef;

  /** Ask the engine for the next session's recipes and show them for review. */
  function planSession() {
    const p = cur();
    state.planning = true; Chef.render();
    setTimeout(() => {
      try {
        const s = settings(p);
        const props = BC.propose(p, { ...s, seed: s.seed === null || s.seed === "" ? null : Number(s.seed) + (state.replans || 0) }, s.batchSize, p.sessions + 1);
        state.proposals = props.map((q) => ({ ...q, x: { ...q.x }, decision: "approve", reason: "" }));
        state.expanded = null;
        state.lastSession = null;
      } catch (e) {
        console.error(e);
        toast(`Couldn't plan: ${e.message}`);
      }
      state.planning = false; Chef.render();
    }, 30);
  }

  /** Turn approved proposals into planned runs with blind codes and a random tasting order. */
  function startSession() {
    const p = cur();
    const sessionNo = p.sessions + 1;
    const rng = BC.Rng();
    const used = new Set(p.runs.map((r) => r.code).filter(Boolean));
    const approved = state.proposals.filter((q) => q.decision !== "reject");
    const order = rng.permutation(approved.length);
    let n = p.runs.length;
    const nextId = () => `R${String(++n).padStart(3, "0")}`;
    approved.forEach((q, k) => {
      let code; do { code = String(100 + rng.int(900)); } while (used.has(code)); used.add(code);
      p.runs.push({
        id: nextId(), session: sessionNo, status: "planned", phase: q.edited ? "manual" : q.phase, code, taste: order[k] + 1,
        x: coerceRun(p, q.x), y: {}, notes: "", why: q.why, predictions: q.predictions || null, created: nowIso(),
      });
    });
    for (const q of state.proposals.filter((q) => q.decision === "reject")) {
      p.runs.push({ id: nextId(), session: sessionNo, status: "rejected", phase: q.phase, code: "", x: coerceRun(p, q.x), y: {}, notes: q.reason || "", why: q.why, created: nowIso() });
    }
    p.sessions = sessionNo;
    p.touched = true;
    state.proposals = null;
    state.cookStep = "prep";
    state.checks = {};
    Chef.save(p, { immediate: true });
    Chef.render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** Clean a recipe's values to the right types (text for choices, whole numbers where needed). */
  function coerceRun(p, x) {
    const y = {};
    for (const f of p.factors) y[f.name] = f.type === "categorical" ? String(x[f.name]) : f.type === "integer" ? Math.round(Number(x[f.name])) : Number(x[f.name]);
    return y;
  }

  /** Save the scores typed for one sample and move on to the next. */
  function saveResult(id) {
    const p = cur();
    const r = p.runs.find((q) => q.id === id);
    const d = state.drafts[id] || {};
    const y = {};
    for (const o of p.outputs) if (valid(d[o.name])) y[o.name] = Number(d[o.name]);
    if (!Object.keys(y).length) { toast("Score at least one thing first."); return; }
    r.y = { ...r.y, ...y };
    if (d.__notes) r.notes = d.__notes;
    r.status = "done";
    r.recorded = nowIso();
    delete state.drafts[id];
    p.touched = true;
    Chef.save(p);
    finishIfDone(p, r.session);
    Chef.render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** If no samples are left to taste, mark the session finished so the summary shows. */
  function finishIfDone(p, sessionNo) {
    if (p.runs.some((q) => q.status === "planned")) return;
    state.lastSession = sessionNo;
    state.cookStep = null;
  }

  /** The experiment's runs as CSV text, one row per run. */
  function csvOf(p) {
    const s = settings(p), rg = BC.ranges(p);
    const cols = ["run_id", "session", "status", "phase", "code", ...p.factors.map((f) => f.name), ...p.outputs.map((o) => o.name), "score", "notes", "created"];
    const q = (v) => { const t = v === undefined || v === null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const rows = p.runs.map((r) => [r.id, r.session, r.status, r.phase, r.code, ...p.factors.map((f) => r.x[f.name]), ...p.outputs.map((o) => (r.y ? r.y[o.name] : "")),
      r.status === "done" ? (BC.runScore(p, r, s, rg) ?? "") : "", r.notes, r.created].map(q).join(","));
    return [cols.join(","), ...rows].join("\n");
  }

  /** Rename a factor or output everywhere it's stored (all runs and the baseline). */
  function renameKey(p, where, oldName, newName) {
    for (const r of p.runs) { const obj = r[where]; if (obj && oldName in obj) { obj[newName] = obj[oldName]; delete obj[oldName]; } }
    if (where === "x" && p.baseline && oldName in p.baseline) { p.baseline[newName] = p.baseline[oldName]; delete p.baseline[oldName]; }
  }

  /** A sensible value for a factor: the first option, or the middle of its range. */
  function defaultValue(f) {
    if (f.type === "categorical") return f.levels[0];
    const v = BC.fromUnit(f, 0.5);
    return f.type === "integer" ? Math.round(v) : v;
  }

  /** Give every run and the baseline a value for any factor they lack (after adding a factor). */
  function fillMissing(p) {
    for (const f of p.factors) {
      for (const r of p.runs) if (r.x[f.name] === undefined) r.x[f.name] = defaultValue(f);
      if (p.baseline && p.baseline[f.name] === undefined) p.baseline[f.name] = defaultValue(f);
    }
  }

  /** Add a new experiment, open it, save it, and switch to Setup. */
  function createProject(p) {
    p.touched = true;
    state.projects[p.id] = Chef.normalize(p);
    state.currentId = p.id;
    store.set("bc:current", p.id);
    Chef.resetViewState();
    Chef.save(p, { immediate: true });
    state.tab = "setup";
    Chef.render();
  }

  /** A file-name-safe version of a name. */
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "experiment"; }

  /** A name like "factor_2" that isn't used yet. */
  function uniqueName(p, base) { let i = 1; const names = new Set([...p.factors.map((f) => f.name), ...p.outputs.map((o) => o.name)]); while (names.has(`${base}_${i}`)) i++; return `${base}_${i}`; }

  /** Remove blend totals that no factor uses any more. */
  function cleanupMixtures(p) { for (const g of Object.keys(p.mixtures)) if (!p.factors.some((f) => f.type === "component" && f.group === g)) delete p.mixtures[g]; }

  /** Give the baseline recipe valid blend values. */
  function fillMixtureBaseline(p) {
    for (const [g, total] of Object.entries(p.mixtures)) {
      const cs = BC.components(p, g); if (!cs.length) continue;
      Object.assign(p.baseline, BC.sampleMixture(cs, total, BC.Rng(1)));
    }
  }

  /** Load an experiment from a backup .json file chosen by the user. */
  function importFile(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const q = JSON.parse(r.result);
        if (!q || !Array.isArray(q.factors) || !Array.isArray(q.outputs)) throw new Error("That file isn't a Bayesian Chef backup.");
        q.id = BC.uid(); q.example = false; q.name = `${q.name || "Imported"} (imported)`;
        createProject(q); toast("Imported.");
      } catch (err) { toast(err.message); }
    };
    r.readAsText(file);
  }

  Object.assign(Chef, { planSession, startSession, coerceRun, saveResult, finishIfDone, csvOf, renameKey, defaultValue, fillMissing, createProject, slug, uniqueName, cleanupMixtures, fillMixtureBaseline, importFile });
})();
