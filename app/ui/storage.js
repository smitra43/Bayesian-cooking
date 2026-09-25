/* Bayesian Chef · ui/storage.js
 *
 * Saving and loading experiments.
 *
 * Two places an experiment can live:
 *   1. The browser's localStorage (key "bc:projects"). This is the normal
 *      case: GitHub Pages, a local copy, any web server.
 *   2. Only when the page is hosted inside claude.ai as an artifact: that
 *      artifact's database, which syncs across devices. connect() detects
 *      this through window.claude; everywhere else window.claude doesn't
 *      exist and this path is skipped. Nothing else depends on it.
 *
 * save(p) is the only function other files call to persist a change.
 */
(function () {
  "use strict";
  const Chef = (window.Chef = window.Chef || {});
  // Helpers from earlier files, unpacked for readability.
  const { main, clone, nowIso, state, store } = Chef;

  const writeQueue = {};

  // id -> {pending, writing, timer}
  function touch(p) { p.updatedAt = nowIso(); }

  /** Persist an experiment. Local storage writes immediately; the claude.ai database writes are queued, one at a time per experiment. */
  function save(p, { immediate = false } = {}) {
    touch(p);
    if (state.mode === "local" || !state.db) { persistLocal(); setSave("saved"); return; }
    const q = (writeQueue[p.id] = writeQueue[p.id] || { pending: null, writing: false, timer: null });
    q.pending = clone(p);
    clearTimeout(q.timer);
    setSave("saving");
    q.timer = setTimeout(() => flush(p.id), immediate ? 0 : 400);
  }

  async function flush(id) {
    const q = writeQueue[id];
    if (!q || q.writing || !q.pending) return;
    q.writing = true;
    while (q.pending) {
      const body = q.pending; q.pending = null;
      try {
        await state.db.doc(`projects/${id}`).set(body);
        setSave("saved");
      } catch (e) {
        const code = e && e.code;
        if (code === "unavailable") { await new Promise((r) => setTimeout(r, 600 + Math.random() * 600)); q.pending = q.pending || body; continue; }
        const msg = code === "quota_exceeded" ? "Storage is full. Delete an old experiment to keep saving."
          : code === "invalid_argument" ? "This experiment couldn't be saved (it may be too large, or you can only view it)."
          : "Couldn't save just now. Your changes are kept on this screen.";
        setSave("error", msg);
      }
    }
    q.writing = false;
  }

  async function removeProject(id) {
    delete state.projects[id];
    if (state.db && state.mode === "db") {
      try { await state.db.doc(`projects/${id}`).delete(); } catch (e) { setSave("error", "Couldn't delete it from storage."); }
    } else persistLocal();
  }

  /** Write every experiment (except the untouched example) to localStorage. */
  function persistLocal() {
    const mine = Object.values(state.projects).filter((p) => !(p.example && !p.touched));
    store.set("bc:projects", mine);
  }

  /** Record the save state and update the status dot. */
  function setSave(s, err = "") { state.saveState = s; state.saveError = err; Chef.renderStatus(); }

  /** Fill in anything an older or imported experiment may be missing. */
  function normalize(p) {
    p.settings = BC.mergeSettings(p.settings);
    p.runs = p.runs || [];
    p.mixtures = p.mixtures || {};
    p.outputs = p.outputs || [];
    p.factors = p.factors || [];
    p.sessions = p.sessions || Math.max(0, ...p.runs.map((r) => r.session || 0));
    return p;
  }

  async function connect() {
    const claude = window.claude;
    let db = null;
    try { db = claude && claude.use ? await claude.use("db") : null; } catch (e) { db = null; }
    if (!db) {
      state.mode = "local";
      for (const p of store.get("bc:projects", [])) state.projects[p.id] = normalize(p);
      state.currentId = pickDefault(); // reopen the last experiment, not the example
      Chef.render();
      return;
    }
    state.db = db;
    state.mode = "db";
    let first = true;
    db.collection("projects").onSnapshot((snap) => {
      const seen = new Set();
      for (const d of snap.docs) {
        const remote = d.data();
        if (!remote || !remote.id) continue;
        seen.add(remote.id);
        const local = state.projects[remote.id];
        const q = writeQueue[remote.id];
        const busy = q && (q.pending || q.writing);
        if (!busy && (!local || (remote.updatedAt || "") >= (local.updatedAt || ""))) state.projects[remote.id] = normalize(clone(remote));
      }
      for (const id of Object.keys(state.projects)) {
        if (!seen.has(id) && !(state.projects[id].example && !state.projects[id].touched) && !(writeQueue[id] && (writeQueue[id].pending || writeQueue[id].writing))) delete state.projects[id];
      }
      if (!state.projects.example && !snap.docs.some((d) => d.id === "example") && first) state.projects.example = BC.exampleProject();
      if (first || !state.projects[state.currentId]) state.currentId = pickDefault();
      first = false;
      if (state.saveState !== "saving") setSave("saved");
      // Re-render unless the viewer is typing in a field.
      const a = document.activeElement;
      if (!a || !main.contains(a) || !/INPUT|TEXTAREA|SELECT/.test(a.tagName)) Chef.render();
      else Chef.renderTop();
    }, () => {
      state.mode = "local";
      setSave("error", "Lost the connection to storage. Changes stay on this screen until you reload.");
    });
  }

  /** Which experiment to open: the last one used, else the newest non-example one. */
  function pickDefault() {
    const ids = Object.values(state.projects).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")).map((p) => p.id);
    const nonExample = ids.filter((id) => !state.projects[id].example);
    const remembered = store.get("bc:current", null);
    if (remembered && state.projects[remembered]) return remembered;
    return nonExample[0] || ids[0] || null;
  }

  Object.assign(Chef, { writeQueue, touch, save, flush, removeProject, persistLocal, setSave, normalize, connect, pickDefault });
})();
