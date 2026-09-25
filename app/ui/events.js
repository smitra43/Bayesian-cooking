/* Bayesian Chef · ui/events.js
 *
 * Turns clicks, typing and other browser events into actions.
 *
 * Buttons carry data-act="name". One click listener looks that name up in the
 * ACTIONS table below and runs it. Inputs use data-bind / data-f / data-o /
 * data-k / data-ins attributes, handled by the "input" and "change"
 * listeners. To find what a button does, search this file for its data-act.
 */
(function () {
  "use strict";
  const Chef = (window.Chef = window.Chef || {});
  // Helpers from earlier files, unpacked for readability.
  const { $, nice, pct, clone, nowIso, valid, toast, state, store, cur, settings } = Chef;

  /** Switch to a tab. */
  function go(tab) {
    state.tab = tab; store.set("bc:tab", tab); Chef.render(); window.scrollTo({ top: 0 });
  }

  document.addEventListener("click", (e) => {
    const tabBtn = e.target.closest("[data-tab]");
    if (tabBtn) { if (state.sheet) Chef.closeSheet(); go(tabBtn.dataset.tab); return; }
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    const p = cur();
    // Every button action, keyed by its data-act value. `el` is the clicked element, `p` the open experiment.
    const ACTIONS = {
      "new-project": Chef.newProjectModal,
      "pick-template": () => { state.newTemplate = el.dataset.k; const name = $("#np-name").value; Chef.newProjectModal(); $("#np-name").value = name; },
      "create-project": () => { const name = $("#np-name").value.trim(); Chef.closeModal(); Chef.createProject(BC.fromTemplate(state.newTemplate, name || undefined)); toast("Created. Check the ranges, then plan your first session."); },
      "close-modal": Chef.closeModal,
      "modal-back": () => { if (e.target === el) Chef.closeModal(); },
      "confirm-ok": () => { const f = state.onConfirm; state.onConfirm = null; Chef.closeModal(); if (f) f(); },
      "copy-area": () => { const t = $("#copy-area"); const done = () => toast("Copied"); if (navigator.clipboard) navigator.clipboard.writeText(t.value).then(done, () => { t.select(); }); else t.select(); },
      "open-settings": () => Chef.openSheet("settings"),
      "open-help": () => Chef.openSheet("help"),
      "close-sheet": Chef.closeSheet,
      "open-run": () => Chef.openSheet(`run:${el.dataset.id}`),
      "batch-step": () => { p.settings.batchSize = Math.min(8, Math.max(1, settings(p).batchSize + Number(el.dataset.d))); Chef.save(p); Chef.render(); },
      plan: Chef.planSession,
      replan: () => { state.replans = (state.replans || 0) + 1; Chef.planSession(); },
      "discard-proposals": () => { state.proposals = null; Chef.render(); },
      "toggle-prop": () => { const i = Number(el.dataset.i); state.expanded = state.expanded === i ? null : i; Chef.render(); },
      decide: () => { const q = state.proposals[Number(el.dataset.i)]; q.decision = el.dataset.d; if (q.decision === "reject") q.editing = false; Chef.render(); },
      "edit-prop": () => { const i = Number(el.dataset.i); state.proposals[i].editing = true; state.expanded = i; Chef.render(); },
      "edit-done": () => { state.proposals[Number(el.dataset.i)].editing = false; Chef.render(); },
      "start-session": Chef.startSession,
      "start-tasting": () => { state.cookStep = "taste"; Chef.render(); window.scrollTo({ top: 0, behavior: "smooth" }); },
      "back-prep": () => { state.cookStep = "prep"; Chef.render(); window.scrollTo({ top: 0 }); },
      tick: () => { state.checks[el.dataset.i] = el.checked; },
      "cancel-session": () => Chef.confirmModal("Cancel this session?", "The recipes you haven't tasted yet are removed. Scores you've already saved stay.", "Cancel session", () => {
        p.runs = p.runs.filter((r) => r.status !== "planned");
        if (!p.runs.some((r) => r.session === p.sessions)) p.sessions = Math.max(0, p.sessions - 1);
        state.cookStep = null; Chef.save(p); Chef.render();
      }),
      scale: () => { const d = (state.drafts[el.dataset.id] = state.drafts[el.dataset.id] || {}); d[el.dataset.o] = Number(el.dataset.v); el.parentElement.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === el))); },
      how: () => { state.showHow[el.dataset.o] = !state.showHow[el.dataset.o]; Chef.render(); },
      "toggle-note": () => { state.noteOpen[el.dataset.id] = true; Chef.render(); const t = $(`#note-${el.dataset.id}`); if (t) t.focus(); },
      "save-result": () => Chef.saveResult(el.dataset.id),
      "not-made": () => {
        const r = p.runs.find((q) => q.id === el.dataset.id);
        r.status = "rejected"; r.phase = "not-made"; r.notes = (r.notes ? r.notes + " · " : "") + "not made";
        Chef.finishIfDone(p, r.session); Chef.save(p); Chef.render();
      },
      "dismiss-last": () => { state.lastSession = null; Chef.render(); },
      logfilter: () => { state.logFilter = el.dataset.f; Chef.render(); },
      "log-recipe": () => { state.logShowRecipe = el.checked; Chef.render(); },
      "save-run": () => {
        const r = p.runs.find((q) => q.id === el.dataset.id);
        document.querySelectorAll("#sheet-root [data-edit]").forEach((inp) => {
          const [k, o] = inp.dataset.edit.split(":");
          if (k === "y") { r.y = r.y || {}; if (inp.value === "") delete r.y[o]; else r.y[o] = Number(inp.value); }
          else r[k] = inp.value;
        });
        p.touched = true; Chef.save(p); Chef.closeSheet(); Chef.render(); toast(`Saved ${r.id}`);
      },
      "delete-run": () => Chef.confirmModal(`Delete ${el.dataset.id}?`, "The recipe and its scores are removed from this experiment.", "Delete", () => {
        p.runs = p.runs.filter((r) => r.id !== el.dataset.id); state.sheet = null; Chef.save(p); Chef.render();
      }),
      "export-csv": () => Chef.offerFile(`${Chef.slug(p.name)}-runs.csv`, Chef.csvOf(p)),
      "export-json": () => Chef.offerFile(`${Chef.slug(p.name)}.json`, JSON.stringify(p, null, 2)),
      "ins-view": () => { state.insights.view = el.dataset.v; Chef.render(); },
      "edit-f": () => { const i = Number(el.dataset.i); state.editF = state.editF === i ? null : i; Chef.render(); },
      "edit-o": () => { const i = Number(el.dataset.i); state.editO = state.editO === i ? null : i; Chef.render(); },
      "add-factor": () => {
        const type = el.dataset.type;
        const base = { name: Chef.uniqueName(p, type === "categorical" ? "choice" : type === "component" ? "part" : "factor"), type, kind: "composition" };
        if (type === "categorical") Object.assign(base, { levels: ["a", "b"] });
        else if (type === "component") {
          const g = (p.factors.find((f) => f.type === "component") || {}).group || "blend";
          Object.assign(base, { group: g, low: 0, high: 100, unit: "%" });
          if (!(g in p.mixtures)) p.mixtures[g] = 100;
        } else Object.assign(base, { low: 0, high: 10, unit: "" });
        p.factors.push(base); Chef.fillMissing(p); p.touched = true; state.editF = p.factors.length - 1; Chef.save(p); Chef.render();
      },
      "del-factor": () => { const f = p.factors[Number(el.dataset.i)]; Chef.confirmModal(`Remove ${nice(f.name)}?`, "Past recipes keep their values in exports, but the model stops using this factor.", "Remove", () => { p.factors.splice(Number(el.dataset.i), 1); Chef.cleanupMixtures(p); state.editF = null; Chef.save(p); Chef.render(); }); },
      "toggle-baseline": () => { p.baseline = el.checked ? Object.fromEntries(p.factors.map((f) => [f.name, Chef.defaultValue(f)])) : null; if (p.baseline) Chef.fillMixtureBaseline(p); Chef.save(p); Chef.render(); },
      "add-output": () => { p.outputs.push({ name: Chef.uniqueName(p, "output"), goal: "maximize", low: 1, high: 9, weight: 1, unit: "", how: "" }); state.editO = p.outputs.length - 1; Chef.save(p); Chef.render(); },
      "add-lib-output": () => {
        const k = el.dataset.k || ($("#lib-pick") && $("#lib-pick").value);
        if (!k || p.outputs.some((o) => o.name === k)) return;
        const { category, ...o } = BC.OUTPUT_LIBRARY[k];
        p.outputs.push({ name: k, ...o }); Chef.save(p); Chef.render(); toast(`Added ${nice(k)}`);
      },
      "del-output": () => { const o = p.outputs[Number(el.dataset.i)]; Chef.confirmModal(`Remove ${nice(o.name)}?`, "Recorded values stay in exports, but scores and the model stop using them.", "Remove", () => { p.outputs.splice(Number(el.dataset.i), 1); state.editO = null; Chef.save(p); Chef.render(); }); },
      duplicate: () => { const q = clone(p); Object.assign(q, { id: BC.uid(), name: `${p.name} (copy)`, runs: [], sessions: 0, example: false, createdAt: nowIso() }); Chef.createProject(q); },
      "delete-project": () => Chef.confirmModal(`Delete “${p.name}”?`, "This removes the experiment and all its results for good.", "Delete experiment", async () => {
        await Chef.removeProject(p.id); state.currentId = Chef.pickDefault(); if (!state.currentId) { state.projects.example = BC.exampleProject(); state.currentId = "example"; } Chef.resetViewState(); state.tab = "cook"; Chef.render();
      }),
      preset: () => { p.settings = BC.mergeSettings(p.settings); Object.assign(p.settings, Chef.PRESETS[el.dataset.k].set); state.preview = null; Chef.save(p); Chef.renderSheet(); },
      preview: () => {
        state.preview = "busy"; Chef.renderSheet();
        setTimeout(() => {
          const t0 = performance.now();
          try { const rows = BC.propose(p, settings(p), settings(p).batchSize, p.sessions + 1); state.preview = { rows, ms: Math.round(performance.now() - t0) }; }
          catch (err) { state.preview = { error: `Couldn't plan with these settings: ${err.message}` }; }
          Chef.renderSheet();
        }, 30);
      },
      "reset-knobs": () => Chef.confirmModal("Reset every setting?", "All advanced settings go back to their defaults. Your recipes and scores are untouched.", "Reset", () => { const b = settings(p).batchSize; p.settings = BC.mergeSettings({ batchSize: b }); state.preview = null; Chef.save(p); Chef.render(); }),
    };
    if (ACTIONS[act]) ACTIONS[act]();
  });

  // Keyboard: Enter/Space on role=button rows, Escape closes overlays.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if ($("#modal-root").innerHTML) Chef.closeModal(); else if (state.sheet) Chef.closeSheet(); return; }
    const t = e.target;
    if ((e.key === "Enter" || e.key === " ") && t.matches && t.matches('[role="button"][data-act], tr[data-act]')) { e.preventDefault(); t.click(); }
  });

  // Input bindings. `change` commits edits; `input` updates drafts live.
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.bind) {
      const [kind, a, b] = t.dataset.bind.split(":");
      if (kind === "draft") { (state.drafts[a] = state.drafts[a] || {})[b] = t.value; }
      else if (kind === "draftnote") { (state.drafts[a] = state.drafts[a] || {}).__notes = t.value; }
      else if (kind === "reason") { state.proposals[Number(a)].reason = t.value; }
    }
    if (t.type === "range" && t.dataset.k) {
      const head = t.closest(".field").querySelector(".knob-head .v");
      if (head) head.textContent = t.dataset.k === "pca.value" || t.dataset.k === "localFraction" ? pct(Number(t.value)) : t.value;
    }
  });

  document.addEventListener("change", (e) => {
    const t = e.target;
    const p = cur();
    if (t.id === "project-select") {
      if (t.value === "__new") { t.value = state.currentId; Chef.newProjectModal(); return; }
      state.currentId = t.value; store.set("bc:current", t.value); Chef.resetViewState(); Chef.render(); return;
    }
    if (t.id === "import-file") { Chef.importFile(t.files && t.files[0]); t.value = ""; return; }
    if (!p) return;
    if (t.dataset.bind) {
      const [kind, a, b] = t.dataset.bind.split(":");
      if (kind === "prop") {
        const q = state.proposals[Number(a)];
        const f = p.factors.find((x) => x.name === b);
        q.x[b] = f.type === "categorical" ? t.value : Number(t.value);
        q.edited = true;
        Chef.render(); return;
      }
      if (kind === "base") {
        const f = p.factors.find((x) => x.name === a);
        p.baseline[a] = f.type === "categorical" ? t.value : Number(t.value);
        Chef.save(p); Chef.render(); return;
      }
    }
    if (t.dataset.p === "tips") { p.tips = t.value.split("\n").map((x) => x.trim()).filter(Boolean); p.touched = true; Chef.save(p); return; }
    if (t.dataset.p === "name") { p.name = t.value.trim() || p.name; p.touched = true; Chef.save(p); Chef.renderTop(); return; }
    if (t.dataset.f) {
      const [i, key] = t.dataset.f.split(":");
      const f = p.factors[Number(i)];
      if (key === "name") {
        const nn = t.value.trim().replace(/\s+/g, "_");
        if (!nn || p.factors.some((x, j) => j !== Number(i) && x.name === nn)) { toast("Names must be unique and not empty."); Chef.render(); return; }
        Chef.renameKey(p, "x", f.name, nn); f.name = nn;
      } else if (key === "type") {
        f.type = t.value;
        if (f.type === "categorical") { f.levels = f.levels && f.levels.length ? f.levels : ["a", "b"]; delete f.log; }
        else { f.low = valid(f.low) ? f.low : 0; f.high = valid(f.high) ? f.high : 10; }
        if (f.type === "component") { f.group = f.group || "blend"; if (!(f.group in p.mixtures)) p.mixtures[f.group] = 100; }
        Chef.cleanupMixtures(p);
        for (const r of p.runs) if (r.x[f.name] !== undefined && (f.type === "categorical" ? !f.levels.includes(r.x[f.name]) : !isFinite(r.x[f.name]))) r.x[f.name] = Chef.defaultValue(f);
        if (p.baseline) p.baseline[f.name] = Chef.defaultValue(f);
      } else if (key === "levels") {
        f.levels = t.value.split(",").map((x) => x.trim().replace(/\s+/g, "_")).filter(Boolean);
        for (const r of p.runs) if (!f.levels.includes(r.x[f.name])) r.x[f.name] = f.levels[0];
      } else if (key === "log") f.log = t.checked;
      else if (key === "low" || key === "high") f[key] = Number(t.value);
      else if (key === "group") { f.group = t.value.trim() || "blend"; if (!(f.group in p.mixtures)) p.mixtures[f.group] = 100; Chef.cleanupMixtures(p); }
      else f[key] = t.value;
      Chef.fillMissing(p); p.touched = true; Chef.save(p); Chef.render(); return;
    }
    if (t.dataset.batch) {
      const [g, key] = t.dataset.batch.split(":");
      p.batchAmounts = p.batchAmounts || {};
      const b = (p.batchAmounts[g] = p.batchAmounts[g] || {});
      if (key === "amount") { if (t.value === "") delete p.batchAmounts[g]; else b.amount = Number(t.value); } else b.unit = t.value.trim();
      Chef.save(p); Chef.render(); return;
    }
    if (t.dataset.mix) { p.mixtures[t.dataset.mix] = Number(t.value); Chef.save(p); Chef.render(); return; }
    if (t.dataset.o) {
      const [i, key] = t.dataset.o.split(":");
      const o = p.outputs[Number(i)];
      if (key === "name") {
        const nn = t.value.trim().replace(/\s+/g, "_");
        if (!nn || p.outputs.some((x, j) => j !== Number(i) && x.name === nn) || p.factors.some((x) => x.name === nn)) { toast("Names must be unique and not empty."); Chef.render(); return; }
        Chef.renameKey(p, "y", o.name, nn); o.name = nn;
      } else if (["target", "low", "high", "weight"].includes(key)) o[key] = t.value === "" ? null : Number(t.value);
      else o[key] = t.value;
      Chef.save(p); Chef.render(); return;
    }
    if (t.dataset.k) {
      let v;
      const ty = t.dataset.t;
      if (ty === "bool") v = t.checked;
      else if (ty === "num") v = t.value === "" ? null : Number(t.value);
      else if (ty === "numOrNull") v = t.value === "" ? null : Number(t.value);
      else v = t.value;
      if (v === null && ty === "num") return;
      p.settings = BC.mergeSettings(p.settings);
      Chef.setPath(p.settings, t.dataset.k, v);
      state.preview = null;
      Chef.save(p); Chef.render(); return;
    }
    if (t.dataset.ins) {
      state.insights[t.dataset.ins] = t.value;
      if (t.dataset.ins === "sx" && state.insights.sy === t.value) state.insights.sy = null;
      if (t.dataset.ins === "pa" && state.insights.pb === t.value) state.insights.pb = null;
      Chef.render(); return;
    }
  });

  document.addEventListener("toggle", (e) => {
    const d = e.target;
    if (d.dataset && d.dataset.acc) state.accOpen[d.dataset.acc] = d.open;
  }, true);

  Object.assign(Chef, { go });
})();
