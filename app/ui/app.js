/* Bayesian Chef: app shell, persistence, views and charts. */
(function () {
  "use strict";
  const BC = window.BC;

  // ================================================================== state

  const TABS = [
    { id: "cook", label: "Cook", icon: "pot" },
    { id: "insights", label: "Insights", icon: "chart" },
    { id: "log", label: "Log", icon: "list" },
    { id: "setup", label: "Setup", icon: "sliders" },
  ];
  const OLD_TABS = { kitchen: "cook", logbook: "log", pantry: "setup", knobs: "cook", guide: "cook" };

  const state = {
    projects: {},
    currentId: null,
    tab: "cook",
    proposals: null,       // [{x, phase, why, predictions, decision, reason, editing, edited}]
    planning: false,
    expanded: null,        // open proposal index
    cookStep: null,        // "prep" | "taste" (null = infer)
    drafts: {},            // runId -> {output: value, __notes}
    showHow: {},           // output -> bool
    noteOpen: {},          // runId -> bool
    checks: {},            // checklist ticks for this visit
    lastSession: null,     // session number just completed
    logFilter: "all",
    logShowRecipe: false,
    editF: null,           // open factor editor index
    editO: null,           // open output editor index
    sheet: null,           // "settings" | "help" | "run:<id>"
    accOpen: {},           // open accordions in the settings sheet
    preview: null,
    insights: { target: "__score", view: "effects", sx: null, sy: null, sz: "mean", diagOut: null, pa: null, pb: null },
    mode: "connecting",    // connecting | db | local
    saveState: "idle",     // idle | saving | saved | error
    saveError: "",
    db: null,
  };

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const main = $("#main");

  function cur() { return state.projects[state.currentId] || null; }
  function settings(p) { return BC.mergeSettings(p && p.settings); }

  // ============================================================== utilities

  function esc(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function nice(name) { return String(name).replace(/_/g, " "); }
  function cap(s) { s = String(s); return s.charAt(0).toUpperCase() + s.slice(1); }
  function fmtNum(v, digits) {
    if (v === null || v === undefined || v === "" || !isFinite(v)) return "–";
    v = Number(v);
    if (digits !== undefined) return v.toFixed(digits);
    if (Number.isInteger(v)) return String(v);
    const a = Math.abs(v);
    return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
  }
  function fmtVal(f, v) {
    if (f.type === "categorical") return nice(v);
    if (f.type === "integer") return `${Math.round(v)}`;
    return fmtNum(v);
  }
  function unitOf(f) { return f.unit ? ` ${f.unit}` : ""; }
  function axisLabel(f) { return f.unit ? `${nice(f.name)} (${f.unit})` : nice(f.name); }
  function pct(v) { return `${Math.round(v * 100)}%`; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function nowIso() { return new Date().toISOString(); }
  function valid(v) { return v !== null && v !== undefined && v !== "" && isFinite(v); }
  const PHASE_LABEL = { doe: "Design", bo: "Model pick", baseline: "Your recipe", replicate: "Repeat", manual: "Edited", "not-made": "Not made" };
  function phaseClass(ph) { return ph === "doe" ? "doe" : ph === "bo" ? "bo" : ph === "not-made" ? "bad" : "good"; }

  const ICONS = {
    pot: '<path d="M4 10h16v4a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6z"/><path d="M2 10h20"/><path d="M9 6.5c0-1.2 1-1.3 1-2.5M14 6.5c0-1.2 1-1.3 1-2.5"/>',
    chart: '<path d="M3 20h18"/><path d="M6 20v-7M11 20V5M16 20v-10"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>',
    sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
  };
  function icon(n, size = 20) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
  }

  let toastTimer = null;
  function toast(msg) {
    let t = $("#toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ============================================================ persistence

  const writeQueue = {};   // id -> {pending, writing, timer}

  function touch(p) { p.updatedAt = nowIso(); }

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

  function persistLocal() {
    const mine = Object.values(state.projects).filter((p) => !(p.example && !p.touched));
    store.set("bc:projects", mine);
  }

  function setSave(s, err = "") { state.saveState = s; state.saveError = err; renderStatus(); }

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
      render();
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
      if (!a || !main.contains(a) || !/INPUT|TEXTAREA|SELECT/.test(a.tagName)) render();
      else renderTop();
    }, () => {
      state.mode = "local";
      setSave("error", "Lost the connection to storage. Changes stay on this screen until you reload.");
    });
  }

  function pickDefault() {
    const ids = Object.values(state.projects).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")).map((p) => p.id);
    const nonExample = ids.filter((id) => !state.projects[id].example);
    const remembered = store.get("bc:current", null);
    if (remembered && state.projects[remembered]) return remembered;
    return nonExample[0] || ids[0] || null;
  }


  // ============================================================== rendering

  function render() {
    renderTop();
    const p = cur();
    main.className = state.tab === "insights" ? "wide" : "";
    if (!p) { main.innerHTML = emptyView(); renderSheet(); return; }
    const views = { cook: cookView, insights: insightsView, log: logView, setup: setupView };
    try {
      main.innerHTML = (views[state.tab] || cookView)(p);
    } catch (e) {
      console.error(e);
      main.innerHTML = `<div class="notice bad">Something went wrong drawing this page: ${esc(e.message)}. Check Setup for an invalid value.</div>`;
    }
    renderSheet();
    if (state.tab === "insights") requestAnimationFrame(() => drawInsights(p));
  }

  function renderTop() {
    const sel = $("#project-select");
    const ps = Object.values(state.projects).sort((a, b) => (a.example ? 1 : 0) - (b.example ? 1 : 0) || (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    sel.innerHTML = ps.map((p) => `<option value="${esc(p.id)}"${p.id === state.currentId ? " selected" : ""}>${esc(p.name)}</option>`).join("")
      + `<option value="__new">+ New experiment…</option>`;
    const p = cur();
    const planned = p ? p.runs.filter((r) => r.status === "planned").length : 0;
    const btn = (t, withIcon) => `<button type="button" data-tab="${t.id}" ${t.id === state.tab ? 'aria-current="page"' : ""}>${withIcon ? icon(t.icon, 22) : ""}<span>${t.label}</span>${t.id === "cook" && planned ? `<span class="badge-dot">${planned}</span>` : ""}</button>`;
    $("#topnav").innerHTML = TABS.map((t) => btn(t, false)).join("");
    $("#bottomnav").innerHTML = TABS.map((t) => btn(t, true)).join("");
    renderStatus();
  }

  function renderStatus() {
    const el = $("#status-dot");
    if (!el) return;
    let cls = "", text = "";
    if (state.mode === "connecting") text = "Connecting to storage";
    else if (state.saveState === "error") { cls = "bad"; text = state.saveError || "Not saved"; }
    else if (state.saveState === "saving") text = "Saving";
    else if (state.mode === "local") { cls = "warn"; text = "Saved in this browser only"; }
    else { cls = "ok"; text = "All changes saved"; }
    const p = cur();
    if (p && p.example && !p.touched && state.mode !== "connecting") { cls = "warn"; text = "Example data (not saved)"; }
    el.className = `status-dot ${cls}`;
    el.title = text;
    el.setAttribute("aria-label", text);
  }

  function emptyView() {
    return `<header class="page-head"><h1>Start your first experiment</h1><p class="sub">Pick a template or start from scratch. You can change everything afterwards.</p></header>
      <div><button class="btn primary lg" data-act="new-project">New experiment</button></div>`;
  }

  function summary(p, x, n = 3) {
    const parts = p.factors.slice(0, n).map((f) => {
      if (f.type === "categorical") return nice(x[f.name]);
      const amt = amountOf(p, f, x[f.name]);
      if (amt) return `${nice(f.name)} ${amt}`;
      if (f.unit && f.unit.toLowerCase() === nice(f.name).toLowerCase()) return `${fmtVal(f, x[f.name])} ${f.unit}`;
      const unit = f.unit && f.unit.length <= 4 ? ` ${f.unit}` : "";
      return `${nice(f.name)} ${fmtVal(f, x[f.name])}${unit}`;
    });
    const more = p.factors.length - n;
    return parts.join(" · ") + (more > 0 ? ` · +${more} more` : "");
  }

  /** For a blend part with a sample size set, the amount to measure out. */
  function amountOf(p, f, v) {
    const b = f.type === "component" && p.batchAmounts && p.batchAmounts[f.group];
    const total = b && p.mixtures[f.group];
    if (!b || !total || !b.amount) return "";
    const a = (Number(v) / total) * b.amount;
    return `${fmtNum(a, a >= 10 ? 0 : 1)} ${b.unit || ""}`.trim();
  }

  function factorKv(p, x) {
    return `<dl class="kv">${p.factors.map((f) => {
      const amt = amountOf(p, f, x[f.name]);
      return `<div><dt title="${esc(nice(f.name))}">${esc(cap(nice(f.name)))}</dt><dd>${amt ? `${esc(amt)} <span class="faint">${esc(fmtVal(f, x[f.name]))}%</span>` : `${esc(fmtVal(f, x[f.name]))}<span class="faint">${esc(unitOf(f))}</span>`}</dd></div>`;
    }).join("")}</dl>`;
  }

  // =================================================================== cook

  function phaseInfo(p) {
    const s = settings(p);
    const active = p.runs.filter((r) => r.status !== "rejected").length;
    const done = BC.doneRuns(p).length;
    const nInit = BC.initialRuns(p, s);
    const design = active < nInit || !done;
    return { design, active, done, nInit, frac: design ? Math.min(1, active / nInit) : 1 };
  }

  function cookView(p) {
    const errs = BC.checkProject(p);
    const planned = p.runs.filter((r) => r.status === "planned");
    const ph = phaseInfo(p);
    const head = `<header class="page-head">
        <span class="eyebrow">${p.example && !p.touched ? "Example · simulated results" : p.sessions ? `${p.sessions} session${p.sessions === 1 ? "" : "s"} so far` : "New experiment"}</span>
        <h1>${esc(p.name)}</h1>
        <div class="progress"><span>${ph.design ? `Initial design ${Math.min(ph.active, ph.nInit)} of ${ph.nInit}` : "Model is choosing"}</span><div class="bar" role="img" aria-label="${pct(ph.frac)} of the initial design planned"><i style="width:${Math.max(4, ph.frac * 100)}%"></i></div><span>${ph.done} tasted</span></div>
      </header>`;
    const example = p.example && !p.touched ? `<div class="notice info">This example uses simulated results so you can look around. Start your own from the experiment menu at the top.</div>` : "";
    let body;
    if (errs.length) body = `<section class="card stack"><h2>Finish setting up</h2><ul class="muted" style="margin:0;padding-left:18px">${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul><div><button class="btn primary" data-tab="setup">Open Setup</button></div></section>`;
    else if (planned.length) body = sessionFlow(p, planned);
    else if (state.proposals) body = reviewView(p);
    else body = planView(p);
    return head + example + body;
  }

  function planView(p) {
    const s = settings(p);
    const next = p.sessions + 1;
    const ph = phaseInfo(p);
    const hasBaseline = p.baseline && !p.runs.some((r) => r.phase === "baseline" && r.status !== "rejected");
    const why = ph.design
      ? hasBaseline ? "Your current recipe comes first, then recipes spread evenly across your ranges." : "These early recipes spread evenly across your ranges so the model gets a fair look at everything."
      : `Using your ${ph.done} results, the model picks recipes that look promising or that it's still unsure about.`;
    return `${lastSessionCard(p)}
      <section class="card next">
        <div class="stack" style="gap:6px"><span class="eyebrow">Next step</span><h2>Plan session ${next}</h2><p>${esc(why)} You approve every recipe before you cook.</p></div>
        <div class="row">
          <div class="stepper-num" role="group" aria-label="Samples this session">
            <button type="button" data-act="batch-step" data-d="-1" aria-label="Fewer samples">−</button>
            <span><b>${s.batchSize}</b> sample${s.batchSize === 1 ? "" : "s"}</span>
            <button type="button" data-act="batch-step" data-d="1" aria-label="More samples">+</button>
          </div>
          <span class="spacer"></span>
          ${state.planning ? `<span class="thinking">Choosing recipes…</span>` : `<button class="btn primary lg" data-act="plan">Plan session ${next}</button>`}
        </div>
      </section>
      ${recentCard(p)}`;
  }

  function outputsBrief(p, r, n = 3) {
    return p.outputs.slice(0, n).filter((o) => r.y && valid(r.y[o.name])).map((o) => `${nice(o.name)} ${fmtNum(r.y[o.name])}`).join(" · ");
  }

  function recentCard(p) {
    const s = settings(p), rg = BC.ranges(p);
    const recent = BC.doneRuns(p).slice(-4).reverse();
    if (!recent.length) return "";
    return `<section class="card flush">
      <div class="card-head pad"><h3>Recent tastings</h3><button class="link" data-tab="log">See all</button></div>
      <ul class="list">${recent.map((r) => { const sc = BC.runScore(p, r, s, rg); return `<li><button class="item" data-act="open-run" data-id="${esc(r.id)}">
        <div class="main"><span class="title">${esc(summary(p, r.x, 3))}</span><span class="meta">${esc(r.id)} · ${esc(outputsBrief(p, r))}</span></div>
        <span class="score">${sc === null ? "–" : sc.toFixed(2)}</span></button></li>`; }).join("")}</ul></section>`;
  }

  function lastSessionCard(p) {
    if (!state.lastSession) return "";
    const s = settings(p), rg = BC.ranges(p);
    const runs = p.runs.filter((r) => r.session === state.lastSession && r.status === "done");
    if (!runs.length) return "";
    const best = Math.max(...BC.doneRuns(p).map((r) => BC.runScore(p, r, s, rg) ?? 0));
    return `<section class="card">
      <div class="card-head"><h2>Session ${state.lastSession} done</h2><button class="btn ghost sm" data-act="dismiss-last">Dismiss</button><p>Nice work. Here's how each sample scored (1.00 means every output was ideal).</p></div>
      <ul class="list">${runs.map((r) => { const sc = BC.runScore(p, r, s, rg); return `<li><div class="item"><span class="mono" style="font-weight:600">${esc(r.code)}</span><div class="main"><span class="meta">${esc(outputsBrief(p, r))}</span></div><span class="score">${sc === null ? "–" : sc.toFixed(2)}</span>${sc !== null && sc >= best - 1e-9 ? `<span class="pill good">Best yet</span>` : ""}</div></li>`; }).join("")}</ul>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-tab="insights">See insights</button></div></section>`;
  }

  function reviewView(p) {
    const props = state.proposals;
    const approved = props.filter((q) => q.decision !== "reject");
    const invalid = approved.some((q) => BC.checkRun(p, q.x).length);
    return `<section class="card">
        <div class="card-head"><h2>Review session ${p.sessions + 1}</h2>
          <div class="row" style="gap:4px"><button class="btn ghost sm" data-act="replan">Suggest others</button><button class="btn ghost sm" data-act="discard-proposals">Cancel</button></div>
          <p>Tap a recipe to see or change it. Reject anything you wouldn't cook, and the model will steer away from it.</p></div>
        <ul class="list">${props.map((q, i) => propItem(p, q, i)).join("")}</ul>
      </section>
      <div class="sticky-foot"><span class="muted"><b>${approved.length}</b> of ${props.length} approved</span><span class="spacer"></span>
        <button class="btn primary" data-act="start-session" ${!approved.length || invalid ? "disabled" : ""}>Start session</button></div>`;
  }

  function propItem(p, q, i) {
    const open = state.expanded === i;
    const errs = BC.checkRun(p, q.x);
    const rejected = q.decision === "reject";
    const preds = q.predictions ? `<p class="small muted">Model expects ${Object.entries(q.predictions).map(([k, v]) => `${esc(nice(k))} ${fmtNum(v.mean)} ± ${fmtNum(v.sd)}`).join(", ")}.</p>` : "";
    return `<li class="prop ${rejected ? "rejected" : ""}">
      <div class="prop-row">
        <div class="main" data-act="toggle-prop" data-i="${i}" role="button" tabindex="0" aria-expanded="${open}">
          <div class="row" style="gap:6px"><span class="pill ${phaseClass(q.phase)}">${esc(PHASE_LABEL[q.phase] || q.phase)}</span>${q.edited ? `<span class="pill">Edited</span>` : ""}</div>
          <div class="meta" style="margin-top:6px;color:var(--ink)">${esc(summary(p, q.x, 3))}</div>
        </div>
        <div class="toggle-pair">
          <button type="button" class="yes" data-act="decide" data-i="${i}" data-d="approve" aria-pressed="${!rejected}" aria-label="Approve">${icon("check", 18)}</button>
          <button type="button" class="no" data-act="decide" data-i="${i}" data-d="reject" aria-pressed="${rejected}" aria-label="Reject">${icon("x", 18)}</button>
        </div>
      </div>
      ${open ? `<div class="stack">
        ${q.editing ? `<div class="fields">${p.factors.map((f) => factorInput(f, q.x[f.name], `prop:${i}:${f.name}`)).join("")}</div><div><button class="btn sm" data-act="edit-done" data-i="${i}">Done editing</button></div>`
          : `${factorKv(p, q.x)}<div><button class="btn sm" data-act="edit-prop" data-i="${i}">Edit values</button></div>`}
        <p class="small muted">${esc(q.why)}</p>${preds}</div>` : ""}
      ${errs.length && !rejected ? `<div class="notice bad small">${errs.map(esc).join(" ")}</div>` : ""}
      ${rejected ? `<label class="field"><span>Why not? (optional)</span><input type="text" id="reason-${i}" data-bind="reason:${i}" value="${esc(q.reason || "")}" placeholder="e.g. too hot for my pan"></label>` : ""}
    </li>`;
  }

  function factorInput(f, v, bind, id) {
    const fid = id || `in-${bind.replace(/[^a-z0-9]/gi, "-")}`;
    if (f.type === "categorical") {
      return `<label class="field"><span>${esc(cap(nice(f.name)))}</span><select id="${fid}" data-bind="${esc(bind)}">${f.levels.map((l) => `<option value="${esc(l)}"${l === v ? " selected" : ""}>${esc(nice(l))}</option>`).join("")}</select></label>`;
    }
    const step = f.type === "integer" ? 1 : "any";
    return `<label class="field"><span>${esc(cap(nice(f.name)))}<span class="faint">${esc(unitOf(f))}</span></span><input type="number" id="${fid}" step="${step}" min="${f.low}" max="${f.high}" data-bind="${esc(bind)}" value="${esc(v === undefined ? "" : f.type === "integer" ? Math.round(v) : +Number(v).toFixed(4))}"></label>`;
  }

  // ------------------------------------------------------------ session flow

  function sessionFlow(p, planned) {
    const sessionNo = planned[0].session;
    const all = p.runs.filter((r) => r.session === sessionNo && r.status !== "rejected").sort((a, b) => (a.taste || 0) - (b.taste || 0));
    const doneCount = all.filter((r) => r.status === "done").length;
    const step = state.cookStep || (doneCount ? "taste" : "prep");
    const stepEl = (n, label, st) => `<span class="${st}"><i>${st === "done" ? icon("check", 14) : n}</i>${label}</span>`;
    const steps = `<div class="steps" aria-label="Session progress">${stepEl(1, "Prep", step === "prep" ? "on" : "done")}<span class="sep"></span>${stepEl(2, "Taste", step === "taste" ? "on" : "")}<span class="sep"></span>${stepEl(3, "Done", "")}</div>`;
    return steps + (step === "prep" ? prepView(p, all) : tasteView(p, all, planned));
  }

  function prepView(p, all) {
    const tips = (p.tips || []).filter(Boolean);
    const core = [
      "No food, coffee, gum or mint for the last 30–60 minutes.",
      "Taste when you're neither hungry nor full.",
      "Same portion size and temperature for every sample.",
      "Water and plain crackers ready between samples.",
    ];
    const items = [...tips, ...core];
    return `<section class="card">
        <div class="card-head"><h2>Cook ${all.length === 1 ? "this recipe" : `these ${all.length}`}</h2><button class="btn ghost sm danger" data-act="cancel-session">Cancel session</button>
          <p>Label each sample with its code only, and keep this sheet away from the tasting table.</p></div>
        <div class="grid3">${all.slice().sort((a, b) => a.id.localeCompare(b.id)).map((r) => `
          <article class="recipe"><header><span class="code">${esc(r.code)}</span><span class="spacer"></span><span class="pill ${phaseClass(r.phase)}">${esc(PHASE_LABEL[r.phase] || r.phase)}</span></header>${factorKv(p, r.x)}</article>`).join("")}</div>
      </section>
      <section class="card">
        <div class="card-head"><h3>Before you taste</h3><button class="link" data-act="open-help">Full tasting guide</button></div>
        <ul class="checks">${items.map((t, i) => `<li><label><input type="checkbox" data-act="tick" data-i="${i}" ${state.checks[i] ? "checked" : ""}><span>${esc(t)}</span></label></li>`).join("")}</ul>
      </section>
      <div class="sticky-foot"><span class="muted">Order: <b class="mono">${all.map((r) => esc(r.code)).join(" → ")}</b></span><span class="spacer"></span><button class="btn primary" data-act="start-tasting">Start tasting</button></div>`;
  }

  function tasteView(p, all, planned) {
    const current = all.find((r) => r.status === "planned");
    const idx = all.indexOf(current);
    const d = state.drafts[current.id] || {};
    const last = planned.length === 1;
    return `<section class="card taste">
      <div class="row"><div class="dots" aria-hidden="true">${all.map((r) => `<i class="${r.status === "done" ? "done" : r === current ? "on" : ""}"></i>`).join("")}</div><span class="spacer"></span><span class="faint small">Sample ${idx + 1} of ${all.length}</span></div>
      <div><span class="eyebrow">Now tasting</span><div class="big-code">${esc(current.code)}</div></div>
      ${p.outputs.map((o) => question(o, d[o.name], current.id)).join("")}
      ${state.noteOpen[current.id] ? `<label class="field"><span>Note</span><textarea id="note-${esc(current.id)}" data-bind="draftnote:${esc(current.id)}" placeholder="Anything unusual?">${esc(d.__notes || "")}</textarea></label>`
        : `<div><button class="link" data-act="toggle-note" data-id="${esc(current.id)}">+ Add a note</button></div>`}
      <div class="row">
        <button class="btn ghost sm" data-act="back-prep">Cooking sheet</button>
        <button class="btn ghost sm" data-act="not-made" data-id="${esc(current.id)}">Wasn't made</button>
        <span class="spacer"></span>
        <button class="btn primary lg" data-act="save-result" data-id="${esc(current.id)}">${last ? "Save and finish" : "Save, next sample"}</button>
      </div>
    </section>`;
  }

  function isScale(o) {
    const lo = Number(o.low), hi = Number(o.high);
    return valid(o.low) && valid(o.high) && Number.isInteger(lo) && Number.isInteger(hi) && hi - lo <= 10 && hi > lo;
  }

  function goalText(o) {
    if (o.goal === "target") return `aim for ${o.target}${o.unit && !/^\d/.test(o.unit) ? " " + o.unit : ""}`;
    return o.goal === "maximize" ? "higher is better" : "lower is better";
  }

  function scaleEnds(o) {
    if (o.goal === "target") return ["Too little", "Too much"];
    if (/hedonic|like/i.test(o.how || "") || o.name === "liking") return ["Dislike", "Like"];
    return [String(o.low), String(o.high)];
  }

  function question(o, v, runId) {
    const head = `<div class="q-head"><b>${esc(cap(nice(o.name)))}</b><span class="faint">${esc(goalText(o))}</span>${o.how ? `<button type="button" class="info-btn" data-act="how" data-o="${esc(o.name)}" aria-label="How to measure ${esc(nice(o.name))}" aria-expanded="${!!state.showHow[o.name]}">i</button>` : ""}</div>
      ${state.showHow[o.name] ? `<p class="help">${esc(o.how)}</p>` : ""}`;
    if (isScale(o)) {
      const vals = []; for (let k = Number(o.low); k <= Number(o.high); k++) vals.push(k);
      const [a, b] = scaleEnds(o);
      return `<div class="q">${head}<div class="rate" role="group" aria-label="${esc(nice(o.name))}">${vals.map((k) => `<button type="button" data-act="scale" data-id="${esc(runId)}" data-o="${esc(o.name)}" data-v="${k}" aria-pressed="${String(v) === String(k)}">${k}</button>`).join("")}</div><div class="rate-ends"><span>${esc(a)}</span><span>${esc(b)}</span></div></div>`;
    }
    return `<label class="q">${head}<input type="number" step="any" inputmode="decimal" id="out-${esc(runId)}-${esc(o.name)}" data-bind="draft:${esc(runId)}:${esc(o.name)}" value="${esc(v === undefined ? "" : v)}" placeholder="${esc(o.unit || "value")}"></label>`;
  }

  // ---------------------------------------------------------------- actions

  function planSession() {
    const p = cur();
    state.planning = true; render();
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
      state.planning = false; render();
    }, 30);
  }

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
    save(p, { immediate: true });
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function coerceRun(p, x) {
    const y = {};
    for (const f of p.factors) y[f.name] = f.type === "categorical" ? String(x[f.name]) : f.type === "integer" ? Math.round(Number(x[f.name])) : Number(x[f.name]);
    return y;
  }

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
    save(p);
    finishIfDone(p, r.session);
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function finishIfDone(p, sessionNo) {
    if (p.runs.some((q) => q.status === "planned")) return;
    state.lastSession = sessionNo;
    state.cookStep = null;
  }

  // ==================================================================== log

  const STATUS_PILL = { done: ["good", "Tasted"], planned: ["warn", "To taste"], rejected: ["bad", "Rejected"] };

  function logView(p) {
    const s = settings(p);
    const rg = BC.ranges(p);
    const runs = p.runs.filter((r) => state.logFilter === "all" || r.status === state.logFilter).slice().reverse();
    const counts = { all: p.runs.length, done: 0, planned: 0, rejected: 0 };
    p.runs.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    const showF = state.logShowRecipe;
    const labels = { all: "All", done: "Tasted", planned: "To taste", rejected: "Rejected" };
    return `
      <header class="page-head"><h1>Log</h1><p class="sub">Every recipe you've planned, tasted or rejected. Tap one to see it or fix a score.</p></header>
      <div class="row"><div class="seg" role="group" aria-label="Filter">${["all", "done", "planned", "rejected"].map((f) => `<button type="button" data-act="logfilter" data-f="${f}" aria-pressed="${state.logFilter === f}">${labels[f]} <span class="faint">${counts[f] || 0}</span></button>`).join("")}</div>
        <span class="spacer"></span><label class="check small"><input type="checkbox" id="log-recipe" data-act="log-recipe" ${showF ? "checked" : ""}> Show recipes</label></div>
      <section class="card flush"><div class="table-wrap"><table>
        <thead><tr><th>Run</th><th class="n">Session</th><th>Status</th>${showF ? p.factors.map((f) => `<th class="${f.type === "categorical" ? "" : "n"}">${esc(nice(f.name))}</th>`).join("") : ""}${p.outputs.map((o) => `<th class="n">${esc(nice(o.name))}</th>`).join("")}<th class="n">Score</th></tr></thead>
        <tbody>${runs.length ? runs.map((r) => {
          const sc = r.status === "done" ? BC.runScore(p, r, s, rg) : null;
          const [cls, lab] = r.phase === "not-made" ? ["bad", "Not made"] : STATUS_PILL[r.status] || ["", r.status];
          return `<tr class="click" data-act="open-run" data-id="${esc(r.id)}" tabindex="0">
            <td><b>${esc(r.id)}</b>${r.code ? ` <span class="faint mono small">${esc(r.code)}</span>` : ""}</td><td class="n">${r.session || ""}</td><td><span class="pill ${cls}">${lab}</span></td>
            ${showF ? p.factors.map((f) => `<td class="${f.type === "categorical" ? "" : "n"}">${esc(r.x[f.name] === undefined ? "–" : fmtVal(f, r.x[f.name]))}</td>`).join("") : ""}
            ${p.outputs.map((o) => `<td class="n">${fmtNum(r.y && r.y[o.name])}</td>`).join("")}
            <td class="n">${sc === null ? "–" : `<span class="score">${sc.toFixed(2)}</span>`}</td></tr>`;
        }).join("") : `<tr><td colspan="${4 + (showF ? p.factors.length : 0) + p.outputs.length}" class="muted">Nothing here yet.</td></tr>`}</tbody>
      </table></div></section>
      <div class="row"><button class="btn ghost sm" data-act="export-csv">Export CSV</button><button class="btn ghost sm" data-act="export-json">Back up experiment</button>
        <label class="btn ghost sm" for="import-file">Import backup</label><input type="file" id="import-file" accept=".json,application/json" hidden></div>`;
  }

  function runSheet(p, r) {
    const s = settings(p), rg = BC.ranges(p);
    const sc = r.status === "done" ? BC.runScore(p, r, s, rg) : null;
    return `
      <div class="row">${r.code ? `<span class="ticket">${esc(r.code)}</span>` : ""}<span class="pill ${phaseClass(r.phase)}">${esc(PHASE_LABEL[r.phase] || r.phase)}</span><span class="faint small">Session ${r.session || "–"}</span><span class="spacer"></span>${sc !== null ? `<span class="score">${sc.toFixed(2)}</span>` : ""}</div>
      <section class="card">${factorKv(p, r.x)}${r.why ? `<p class="small muted" style="margin-top:12px">${esc(r.why)}</p>` : ""}</section>
      <h3>Results</h3>
      <div class="fields">${p.outputs.map((o) => `<label class="field"><span>${esc(cap(nice(o.name)))} <span class="faint">${esc(o.unit || "")}</span></span><input type="number" step="any" id="edit-${esc(o.name)}" data-edit="y:${esc(o.name)}" value="${esc(r.y && valid(r.y[o.name]) ? r.y[o.name] : "")}"></label>`).join("")}
        <label class="field"><span>Status</span><select id="edit-status" data-edit="status">${[["planned", "To taste"], ["done", "Tasted"], ["rejected", "Rejected"]].map(([k, l]) => `<option value="${k}"${k === r.status ? " selected" : ""}>${l}</option>`).join("")}</select></label></div>
      <label class="field"><span>Notes</span><textarea id="edit-notes" data-edit="notes">${esc(r.notes || "")}</textarea></label>
      <div class="row"><button class="btn ghost sm danger" data-act="delete-run" data-id="${esc(r.id)}">Delete</button><span class="spacer"></span><button class="btn primary" data-act="save-run" data-id="${esc(r.id)}">Save changes</button></div>`;
  }

  function csvOf(p) {
    const s = settings(p), rg = BC.ranges(p);
    const cols = ["run_id", "session", "status", "phase", "code", ...p.factors.map((f) => f.name), ...p.outputs.map((o) => o.name), "score", "notes", "created"];
    const q = (v) => { const t = v === undefined || v === null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const rows = p.runs.map((r) => [r.id, r.session, r.status, r.phase, r.code, ...p.factors.map((f) => r.x[f.name]), ...p.outputs.map((o) => (r.y ? r.y[o.name] : "")),
      r.status === "done" ? (BC.runScore(p, r, s, rg) ?? "") : "", r.notes, r.created].map(q).join(","));
    return [cols.join(","), ...rows].join("\n");
  }

  async function offerFile(filename, data) {
    let dl = null;
    try { dl = window.claude && window.claude.use ? await window.claude.use("downloads") : null; } catch (e) { dl = null; }
    if (dl) {
      try { await dl.save({ filename, data }); toast(`Saved ${filename}`); return; }
      catch (e) { if (e && e.code === "declined") return; }
    }
    openModal(`<h2>Copy your data</h2><p class="muted small">Saving files isn't available here. Copy this into a file named <span class="mono">${esc(filename)}</span>.</p>
      <textarea id="copy-area" rows="10" readonly>${esc(data)}</textarea>
      <div class="row end"><button class="btn ghost" data-act="close-modal">Close</button><button class="btn primary" data-act="copy-area">Copy</button></div>`);
  }

  // =============================================================== insights

  const cache = { key: null, value: null };

  function analyticsFor(p) {
    const s = settings(p);
    const key = `${p.id}|${p.updatedAt}|${JSON.stringify(s)}|${JSON.stringify(p.outputs)}|${JSON.stringify(p.factors)}|${state.insights.target}`;
    if (cache.key === key) return cache.value;
    const done = BC.doneRuns(p);
    const v = { s, done, progress: BC.progress(p, s) };
    const doe = p.runs.filter((r) => r.status !== "rejected" && (r.phase === "doe" || r.phase === "baseline")).map((r) => r.x);
    v.dq = BC.designQuality(p, doe);
    v.dqAll = BC.designQuality(p, p.runs.filter((r) => r.status !== "rejected").map((r) => r.x));
    v.reps = BC.replicates(p);
    v.corr = BC.correlations(p);
    v.pca = BC.runPCA(p, s);
    if (done.length >= 3) {
      v.fitted = BC.fitAll(p, s);
      const target = state.insights.target === "__score" || v.fitted.models[state.insights.target] ? state.insights.target : "__score";
      v.effects = BC.mainEffects(p, s, v.fitted, target);
      v.diag = BC.diagnostics(p, v.fitted);
      v.target = target;
      const pool = BC.candidatePool(p, s, BC.Rng(7));
      const pr = BC.predictor(p, s, v.fitted, "__score")(pool);
      let bi = 0; pr.mean.forEach((m, i) => { if (m > pr.mean[bi]) bi = i; });
      v.guess = { x: pool[bi], score: pr.mean[bi] };
    }
    cache.key = key; cache.value = v;
    return v;
  }

  const EXPLORE = [
    ["effects", "Effects"], ["surface", "Surface"], ["check", "Model check"], ["map", "PCA map"],
    ["parallel", "All runs"], ["corr", "Correlations"], ["tradeoffs", "Trade-offs"], ["details", "Model details"],
  ];

  function insightsView(p) {
    const v = analyticsFor(p);
    const I = state.insights;
    if (!I.sx || !p.factors.some((f) => f.name === I.sx)) I.sx = p.factors[0] && p.factors[0].name;
    if (!I.sy || !p.factors.some((f) => f.name === I.sy) || I.sy === I.sx) I.sy = (p.factors.find((f) => f.name !== I.sx) || {}).name;
    if (!I.diagOut || !p.outputs.some((o) => o.name === I.diagOut)) I.diagOut = p.outputs[0] && p.outputs[0].name;
    if (!I.pa || !p.outputs.some((o) => o.name === I.pa)) I.pa = p.outputs[0] && p.outputs[0].name;
    if (!I.pb || !p.outputs.some((o) => o.name === I.pb) || I.pb === I.pa) I.pb = (p.outputs.find((o) => o.name !== I.pa) || {}).name;

    const bestIdx = v.progress.reduce((bi, r, i) => (r.score !== null && (bi < 0 || r.score > v.progress[bi].score) ? i : bi), -1);
    const first = v.diag && v.diag[0];
    const repOut = p.outputs.find((o) => v.reps.pooled[o.name]);
    const stat = (label, val, sub) => `<div class="stat"><span class="eyebrow">${label}</span><span class="v">${val}</span><span class="s">${sub}</span></div>`;
    const head = `<header class="page-head"><h1>Insights</h1><p class="sub">${v.done.length} tasted recipes over ${p.sessions} session${p.sessions === 1 ? "" : "s"}. Scores run from 0 to 1, where 1 means every output hit its ideal.</p></header>
      <div class="stats">
        ${stat("Best score", bestIdx >= 0 ? v.progress[bestIdx].score.toFixed(2) : "–", bestIdx >= 0 ? `run ${esc(v.progress[bestIdx].id)}` : "no results yet")}
        ${stat("Tasted", v.done.length, `${p.runs.filter((r) => r.status === "rejected").length} rejected`)}
        ${stat("Model fit", first && isFinite(first.r2) ? first.r2.toFixed(2) : "–", first ? `R² on unseen runs, ${esc(nice(first.output))}` : "needs 3 results")}
        ${stat("Palate noise", repOut ? "±" + fmtNum(v.reps.pooled[repOut.name].sd) : first ? "±" + fmtNum(first.noise) : "–", repOut ? `from repeats, ${esc(nice(repOut.name))}` : first ? `model estimate, ${esc(nice(first.output))}` : "repeat a recipe to measure")}
      </div>`;

    if (v.done.length < 3) {
      return `${head}<div class="notice info">Taste at least 3 recipes and the model's view of what matters will appear here.</div>
        <section class="card"><div class="card-head"><h3>Progress</h3></div><div class="chart short" id="ch-progress"></div></section>`;
    }

    const best = bestIdx >= 0 ? BC.doneRuns(p).find((r) => r.id === v.progress[bestIdx].id) : null;
    const sel = (id, bind, val, opts) => `<select id="${id}" data-ins="${bind}">${opts.map(([k, l]) => `<option value="${esc(k)}"${k === val ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const targetOpts = [["__score", "Overall score"], ...p.outputs.map((o) => [o.name, cap(nice(o.name))])];

    return `${head}
      <div class="grid2">
        <section class="card"><div class="card-head"><div><span class="eyebrow">Best so far</span><h3>${esc(best ? best.id : "")}</h3></div><span class="score">${bestIdx >= 0 ? v.progress[bestIdx].score.toFixed(2) : "–"}</span></div>${best ? factorKv(p, best.x) : ""}</section>
        <section class="card"><div class="card-head"><div><span class="eyebrow">Model's best guess</span><h3>Not tasted yet</h3></div><span class="score" title="Expected score">${v.guess.score.toFixed(2)}</span></div>${factorKv(p, v.guess.x)}
          <p class="small muted" style="margin-top:12px">The recipe the model currently expects to score highest. Its uncertainty can still be large.</p></section>
      </div>
      <div class="grid2">
        <section class="card"><div class="card-head"><h3>What matters</h3><div style="width:170px">${sel("ins-target", "target", v.target, targetOpts)}</div>
          <p>How much ${v.target === "__score" ? "the overall score" : esc(nice(v.target))} changes as each factor moves across its range.</p></div><div class="chart short" id="ch-importance"></div></section>
        <section class="card"><div class="card-head"><h3>Progress</h3><p>Each dot is a tasted recipe. The line is the best so far.</p></div><div class="chart short" id="ch-progress"></div></section>
      </div>
      <section class="card">
        <div class="card-head"><h3>Explore</h3></div>
        <div class="chips" role="group" aria-label="Choose a view">${EXPLORE.map(([k, l]) => `<button type="button" data-act="ins-view" data-v="${k}" aria-pressed="${I.view === k}">${l}</button>`).join("")}</div>
        <div style="margin-top:16px">${exploreBody(p, v, sel)}</div>
      </section>`;
  }

  function exploreBody(p, v, sel) {
    const I = state.insights;
    const fOpts = p.factors.map((f) => [f.name, cap(nice(f.name))]);
    const oOpts = p.outputs.map((o) => [o.name, cap(nice(o.name))]);
    const caption = (t) => `<p class="small muted" style="margin-bottom:10px">${t}</p>`;
    const what = v.target === "__score" ? "the overall score" : esc(nice(v.target));
    switch (I.view) {
      case "surface":
        return `<div class="ctrls"><label class="field"><span>Across</span>${sel("ins-sx", "sx", I.sx, fOpts)}</label><label class="field"><span>Up</span>${sel("ins-sy", "sy", I.sy, fOpts.filter(([k]) => k !== I.sx))}</label>
          <label class="field"><span>Show</span>${sel("ins-sz", "sz", I.sz, [["mean", "Prediction"], ["sd", "Uncertainty"]])}</label></div>
          ${caption(`Predicted ${what} over two factors, with everything else held at your best recipe. Dots are recipes you've tasted.`)}<div class="chart tall" id="ch-surface"></div>`;
      case "check": {
        const d = v.diag.find((x) => x.output === I.diagOut);
        return `<div class="ctrls"><label class="field"><span>Output</span>${sel("ins-diag", "diagOut", I.diagOut, oOpts)}</label></div>
          ${d ? `<div class="statline"><span>R² <b>${isFinite(d.r2) ? d.r2.toFixed(2) : "–"}</b></span><span>Typical error <b>${fmtNum(d.rmse)}</b></span><span>Inside 95% band <b>${pct(d.coverage)}</b></span><span>Noise <b>±${fmtNum(d.noise)}</b></span></div>` : ""}
          ${caption("Left: each recipe predicted by a model that never saw it. Near the diagonal is good. Right: those errors divided by the model's own uncertainty; about 95% should fall between −2 and 2.")}
          <div class="grid2"><div class="chart" id="ch-loo"></div><div class="chart" id="ch-resid"></div></div>`;
      }
      case "map":
        return `${caption(`Left: your recipes projected onto their two main directions of variation, coloured by score. Right: how much variation each direction carries.${v.s.pca.enabled ? " The dashed line marks where the model's input PCA cuts off." : ""}`)}<div class="grid2"><div class="chart" id="ch-pca"></div><div class="chart" id="ch-scree"></div></div>`;
      case "parallel":
        return `${caption("Every tasted recipe as one line across all factors and outputs, coloured by score. Drag along an axis to filter.")}<div class="chart tall" id="ch-parcoords"></div>`;
      case "corr":
        return `${caption("How pairs of factors and outputs move together across tasted recipes. With few recipes, anything between −0.5 and 0.5 is probably noise.")}<div class="chart tall" id="ch-corr"></div>`;
      case "tradeoffs":
        if (p.outputs.length < 2) return `<p class="muted">Add a second output in Setup to see trade-offs.</p>`;
        return `<div class="ctrls"><label class="field"><span>Across</span>${sel("ins-pa", "pa", I.pa, oOpts)}</label><label class="field"><span>Up</span>${sel("ins-pb", "pb", I.pb, oOpts.filter(([k]) => k !== I.pa))}</label></div>
          ${caption("Highlighted recipes can't improve on one output without getting worse on the other (the Pareto front).")}<div class="chart tall" id="ch-pareto"></div>`;
      case "details":
        return modelTables(p, v) + designTable(p, v);
      default:
        return `${caption(`Average predicted ${what} as one factor changes while the others vary. Shaded band: the model's uncertainty.`)}
          <div class="multiples">${p.factors.map((f, i) => `<div><div class="eyebrow">${esc(nice(f.name))}</div><div class="chart" id="ch-me-${i}"></div></div>`).join("")}</div>`;
    }
  }

  function modelTables(p, v) {
    const rows = (v.diag || []).map((d) => {
      const hs = d.info.hypers.map((h) => `${esc(h.name)} <b>${fmtNum(h.value)}</b>`).join(" · ");
      return `<tr><td><b>${esc(cap(nice(d.output)))}</b></td><td>${esc(d.info.model)}${d.info.kernel ? ` · ${esc(d.info.kernel)}${d.info.ard ? " ARD" : ""}` : ""}${d.info.degree ? ` · degree ${d.info.degree}` : ""}</td><td class="n">${d.info.logML !== undefined ? d.info.logML.toFixed(1) : "–"}</td><td style="white-space:normal;min-width:260px">${hs}${d.info.fitted ? "" : ` <span class="pill">prior values</span>`}</td></tr>`;
    }).join("");
    return `<h4 style="margin-bottom:6px">Fitted models</h4><p class="small muted" style="margin-bottom:8px">Lengthscales are on the 0–1 scale of each factor's range; short means the output changes quickly with that factor.</p>
      <div class="table-wrap"><table><thead><tr><th>Output</th><th>Model</th><th class="n">Log evidence</th><th>Hyperparameters</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function designTable(p, v) {
    const row = (label, q) => q ? `<tr><td>${label}</td><td class="n">${fmtNum(q.minDistance)}</td><td class="n">${q.worstGap === null ? "–" : fmtNum(q.worstGap)}${q.worstGapFactor ? ` <span class="faint">${esc(nice(q.worstGapFactor))}</span>` : ""}</td><td class="n">${q.maxCorr === null ? "–" : fmtNum(q.maxCorr, 2)}${q.maxCorrPair ? ` <span class="faint">${esc(q.maxCorrPair.map(nice).join(" & "))}</span>` : ""}</td></tr>` : "";
    const reps = v.reps.groups.length ? v.reps.groups.map((g) => g.join(", ")).join("; ") : "none yet";
    return `<h4 style="margin:22px 0 6px">Design quality</h4><p class="small muted" style="margin-bottom:8px">Closest pair (higher is better), largest uncovered stretch of a factor's range (lower is better), and strongest correlation between two factors (lower is better).</p>
      <div class="table-wrap"><table><thead><tr><th>Recipes</th><th class="n">Closest pair</th><th class="n">Worst gap</th><th class="n">Max |r|</th></tr></thead><tbody>${row("Initial design", v.dq)}${row("All", v.dqAll)}</tbody></table></div>
      <p class="small muted" style="margin-top:10px">Repeated recipes: ${esc(reps)}.</p>`;
  }

  // ----------------------------------------------------------------- charts

  function tok(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  const PLOTLY_CONFIG = { responsive: true, displayModeBar: false };

  function axis(title, extra = {}) {
    return { title: title ? { text: title, font: { size: 12, color: tok("--ink-2") } } : undefined, gridcolor: tok("--line"), zerolinecolor: tok("--line-strong"), linecolor: tok("--line-strong"), tickfont: { color: tok("--ink-3"), size: 11 }, automargin: true, ...extra };
  }
  function layout(extra = {}) {
    return {
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "Nunito, system-ui, sans-serif", color: tok("--ink-2"), size: 12 },
      margin: { l: 52, r: 16, t: 12, b: 44 }, showlegend: false,
      hoverlabel: { bgcolor: tok("--surface"), bordercolor: tok("--line-strong"), font: { color: tok("--ink"), family: "Nunito, system-ui, sans-serif" } },
      ...extra,
    };
  }
  function alpha(hex, a) {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function seqScale() { return [[0, tok("--seq-0")], [0.25, tok("--seq-1")], [0.5, tok("--seq-2")], [0.75, tok("--seq-3")], [1, tok("--seq-4")]]; }
  function divScale() { return [[0, tok("--div-neg")], [0.5, tok("--div-mid")], [1, tok("--div-pos")]]; }
  const PHASE_SERIES = (ph) => (ph === "doe" ? "--series-1" : ph === "bo" ? "--series-2" : "--series-3");
  const PHASE_GROUP = (ph) => (ph === "doe" ? "Initial design" : ph === "bo" ? "Model pick" : "Baseline, repeat or edited");

  function plot(id, data, lay) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!window.Plotly) { el.innerHTML = `<p class="muted small">Charts couldn't load. Check your connection and reopen the page.</p>`; return; }
    window.Plotly.react(el, data, lay, PLOTLY_CONFIG);
  }

  function drawInsights(p) {
    let v;
    try { v = analyticsFor(p); } catch (e) { console.error(e); return; }
    const I = state.insights;
    const ink2 = tok("--ink-2"), ink3 = tok("--ink-3"), surface = tok("--surface");
    const s = v.s;
    const done = v.done;
    const view = I.view;

    // Progress
    const groups = ["doe", "bo", "other"];
    const pts = v.progress.filter((r) => r.score !== null);
    const data = groups.map((g) => {
      const rs = pts.filter((r) => (g === "other" ? r.phase !== "doe" && r.phase !== "bo" : r.phase === g));
      return { type: "scatter", mode: "markers", name: PHASE_GROUP(g === "other" ? "x" : g), x: rs.map((r) => r.i), y: rs.map((r) => r.score), text: rs.map((r) => r.id),
        marker: { size: 10, color: tok(PHASE_SERIES(g === "other" ? "x" : g)), line: { color: surface, width: 2 } }, hovertemplate: "%{text}<br>score %{y:.2f}<extra>%{fullData.name}</extra>" };
    }).filter((t) => t.x.length);
    data.push({ type: "scatter", mode: "lines", name: "Best so far", x: v.progress.map((r) => r.i), y: v.progress.map((r) => r.best), line: { color: ink2, width: 2, shape: "hv" }, hovertemplate: "best %{y:.2f}<extra></extra>" });
    plot("ch-progress", data, layout({ showlegend: true, legend: { orientation: "h", y: 1.16, x: 0, font: { size: 11 } }, margin: { l: 44, r: 12, t: 30, b: 40 },
      xaxis: axis("Recorded run", { dtick: v.progress.length > 20 ? 5 : 1 }), yaxis: axis("Overall score", { range: [0, 1.05] }) }));

    if (!v.fitted) return;

    // Importance
    const eff = v.effects.slice().sort((a, b) => a.importance - b.importance);
    plot("ch-importance", [{ type: "bar", orientation: "h", y: eff.map((e) => nice(e.factor)), x: eff.map((e) => e.importance), marker: { color: tok("--marm-bright") },
      text: eff.map((e) => pct(e.importance)), textposition: "outside", cliponaxis: false, textfont: { color: ink2 }, hovertemplate: "%{y}: %{x:.0%}<extra></extra>" }],
      layout({ margin: { l: 110, r: 40, t: 8, b: 36 }, xaxis: axis("Share of explained variation", { tickformat: ".0%", range: [0, Math.max(...eff.map((e) => e.importance)) * 1.25 || 1] }), yaxis: axis("", { automargin: true }) }));

    if (view === "effects") {
    const all = v.effects.flatMap((e) => e.curve.flatMap((c) => [c.mean - (c.sd || 0), c.mean + (c.sd || 0)]));
    const yr = [Math.min(...all), Math.max(...all)];
    const pad = (yr[1] - yr[0]) * 0.08 || 0.1;
    const ylab = v.target === "__score" ? "score" : nice(v.target);
    v.effects.forEach((e, i) => {
      const f = p.factors.find((q) => q.name === e.factor);
      const xs = e.curve.map((c) => (f.type === "categorical" ? nice(c.x) : c.x));
      const tr = [];
      if (f.type === "categorical") {
        tr.push({ type: "bar", x: xs, y: e.curve.map((c) => c.mean), marker: { color: tok("--honey") }, error_y: e.curve[0].sd !== null ? { type: "data", array: e.curve.map((c) => c.sd), color: ink2, thickness: 1.5, width: 4 } : undefined, hovertemplate: "%{x}: %{y:.2f}<extra></extra>" });
      } else {
        if (e.curve[0].sd !== null) {
          tr.push({ type: "scatter", mode: "lines", x: xs, y: e.curve.map((c) => c.mean + c.sd), line: { width: 0 }, hoverinfo: "skip" });
          tr.push({ type: "scatter", mode: "lines", x: xs, y: e.curve.map((c) => c.mean - c.sd), fill: "tonexty", fillcolor: alpha(tok("--honey"), 0.35), line: { width: 0 }, hoverinfo: "skip" });
        }
        tr.push({ type: "scatter", mode: "lines", x: xs, y: e.curve.map((c) => c.mean), line: { color: tok("--marm-bright"), width: 2.5 }, hovertemplate: `%{x:.3g}${esc(unitOf(f))}: %{y:.2f}<extra></extra>` });
      }
      plot(`ch-me-${i}`, tr, layout({ margin: { l: 40, r: 8, t: 6, b: 32 }, xaxis: axis(f.unit || ""), yaxis: axis(i === 0 ? ylab : "", { range: [yr[0] - pad, yr[1] + pad] }) }));
    });

    }
    if (view === "surface") {
    const bestRun = done.slice().sort((a, b) => (BC.runScore(p, b, s) ?? -1) - (BC.runScore(p, a, s) ?? -1))[0];
    let surfTarget = v.target;
    if (I.sz === "sd" && surfTarget === "__score") surfTarget = p.outputs.find((o) => v.fitted.models[o.name]).name;
    if (I.sx && I.sy && bestRun) {
      const sf = BC.surface(p, s, v.fitted, surfTarget, I.sx, I.sy, bestRun.x, 28);
      const fx = p.factors.find((f) => f.name === I.sx), fy = p.factors.find((f) => f.name === I.sy);
      const cat = fx.type === "categorical" || fy.type === "categorical";
      const z = I.sz === "sd" && sf.zsd ? sf.zsd : sf.z;
      const lab = I.sz === "sd" ? `± ${nice(surfTarget)}` : surfTarget === "__score" ? "score" : nice(surfTarget);
      const base = { x: sf.x.map((q) => (fx.type === "categorical" ? nice(q) : q)), y: sf.y.map((q) => (fy.type === "categorical" ? nice(q) : q)), z, colorscale: seqScale(),
        colorbar: { thickness: 10, outlinewidth: 0, tickfont: { color: ink3, size: 10 }, title: { text: lab, side: "right", font: { size: 11, color: ink2 } } },
        hovertemplate: `${nice(I.sx)} %{x}<br>${nice(I.sy)} %{y}<br>${lab} %{z:.2f}<extra></extra>` };
      const tr = [cat ? { ...base, type: "heatmap" } : { ...base, type: "contour", contours: { coloring: "heatmap", showlines: true }, line: { color: alpha(surface, 0.6), width: 1 }, ncontours: 14 }];
      tr.push({ type: "scatter", mode: "markers", x: done.map((r) => (fx.type === "categorical" ? nice(r.x[I.sx]) : r.x[I.sx])), y: done.map((r) => (fy.type === "categorical" ? nice(r.x[I.sy]) : r.x[I.sy])), text: done.map((r) => r.id),
        marker: { size: 8, color: tok("--ink"), line: { color: surface, width: 2 } }, hovertemplate: "%{text}<extra>recorded run</extra>" });
      plot("ch-surface", tr, layout({ xaxis: axis(axisLabel(fx)), yaxis: axis(axisLabel(fy)) }));
    }

    }
    if (view === "check") {
    const d = v.diag.find((x) => x.output === I.diagOut);
    if (d) {
      const lo = Math.min(...d.obs, ...d.lo), hi = Math.max(...d.obs, ...d.hi);
      plot("ch-loo", [
        { type: "scatter", mode: "lines", x: [lo, hi], y: [lo, hi], line: { color: ink3, dash: "dot", width: 1.5 }, hoverinfo: "skip" },
        { type: "scatter", mode: "markers", x: d.obs, y: d.pred, text: d.ids, error_y: { type: "data", symmetric: false, array: d.hi.map((h, i) => h - d.pred[i]), arrayminus: d.pred.map((m, i) => m - d.lo[i]), color: alpha(tok("--marm-bright"), 0.45), thickness: 1.5, width: 0 },
          marker: { size: 9, color: tok("--marm-bright"), line: { color: surface, width: 2 } }, hovertemplate: "%{text}<br>measured %{x:.3g}<br>predicted %{y:.3g}<extra></extra>" },
      ], layout({ xaxis: axis(`Measured ${nice(d.output)}`), yaxis: axis("Predicted without that run") }));
      plot("ch-resid", [{ type: "histogram", x: d.zres, xbins: { start: -4, end: 4, size: 0.5 }, marker: { color: tok("--honey"), line: { color: surface, width: 2 } }, hovertemplate: "%{x}: %{y} runs<extra></extra>" }],
        layout({ xaxis: axis("Error ÷ predicted uncertainty", { range: [-4, 4], dtick: 1 }), yaxis: axis("Runs"), bargap: 0.04,
          shapes: [-2, 2].map((x0) => ({ type: "line", x0, x1: x0, yref: "paper", y0: 0, y1: 1, line: { color: ink3, dash: "dot", width: 1 } })) }));
    }

    }
    if (view === "map") {
    if (v.pca) {
      const sc = v.pca.scores;
      const doneIdx = sc.map((_, i) => i).filter((i) => v.pca.score[i] !== null);
      const other = sc.map((_, i) => i).filter((i) => v.pca.score[i] === null);
      plot("ch-pca", [
        { type: "scatter", mode: "markers", x: other.map((i) => sc[i][0]), y: other.map((i) => sc[i][1] || 0), text: other.map((i) => v.pca.ids[i]), marker: { size: 9, color: "rgba(0,0,0,0)", line: { color: ink3, width: 1.5 } }, hovertemplate: "%{text}<extra>not scored</extra>" },
        { type: "scatter", mode: "markers", x: doneIdx.map((i) => sc[i][0]), y: doneIdx.map((i) => sc[i][1] || 0), text: doneIdx.map((i) => v.pca.ids[i]),
          marker: { size: 11, color: doneIdx.map((i) => v.pca.score[i]), colorscale: seqScale(), cmin: 0, cmax: 1, line: { color: surface, width: 2 }, colorbar: { thickness: 10, outlinewidth: 0, tickfont: { color: ink3, size: 10 }, title: { text: "score", side: "right", font: { size: 11 } } } },
          hovertemplate: "%{text}<br>score %{marker.color:.2f}<extra></extra>" },
      ], layout({ xaxis: axis(`PC1 (${pct(v.pca.ratio[0])})`), yaxis: axis(`PC2 (${pct(v.pca.ratio[1] || 0)})`) }));
      let cum = 0;
      const labels = v.pca.ratio.map((_, i) => `PC${i + 1}`);
      plot("ch-scree", [{ type: "bar", x: labels, y: v.pca.ratio, marker: { color: v.pca.ratio.map((_, i) => (v.pca.keep && i < v.pca.keep ? tok("--marm-bright") : tok("--honey"))) },
        text: v.pca.ratio.map((r) => { cum += r; return pct(cum); }), textposition: "outside", cliponaxis: false, textfont: { size: 10, color: ink3 }, hovertemplate: "%{x}: %{y:.0%} (cumulative %{text})<extra></extra>" }],
        layout({ margin: { l: 52, r: 16, t: 18, b: 44 }, xaxis: axis("Component"), yaxis: axis("Share of variance", { tickformat: ".0%" }), bargap: 0.25,
          shapes: v.pca.keep ? [{ type: "line", x0: v.pca.keep - 0.5, x1: v.pca.keep - 0.5, yref: "paper", y0: 0, y1: 1, line: { color: ink2, dash: "dash", width: 1.5 } }] : [] }));
    }

    }
    if (view === "parallel") {
    const rg = BC.ranges(p);
    const scored = done.filter((r) => BC.runScore(p, r, s, rg) !== null);
    if (scored.length) {
      const dims = p.factors.map((f) => (f.type === "categorical"
        ? { label: nice(f.name), values: scored.map((r) => f.levels.indexOf(r.x[f.name])), tickvals: f.levels.map((_, i) => i), ticktext: f.levels.map(nice), range: [0, f.levels.length - 1] }
        : { label: nice(f.name), values: scored.map((r) => Number(r.x[f.name])), range: [f.low, f.high] }));
      p.outputs.forEach((o) => { const vals = scored.map((r) => (valid(r.y[o.name]) ? Number(r.y[o.name]) : NaN)); if (vals.some(isFinite)) dims.push({ label: nice(o.name), values: vals }); });
      const scs = scored.map((r) => BC.runScore(p, r, s, rg));
      dims.push({ label: "score", values: scs, range: [0, 1] });
      plot("ch-parcoords", [{ type: "parcoords", dimensions: dims, line: { color: scs, colorscale: seqScale(), cmin: 0, cmax: 1, showscale: false },
        labelfont: { color: tok("--ink"), size: 12 }, tickfont: { color: ink3, size: 10 }, rangefont: { color: ink3, size: 9 } }],
        layout({ margin: { l: 60, r: 60, t: 44, b: 24 } }));
    }

    }
    if (view === "corr") {
    const c = v.corr;
    plot("ch-corr", [{ type: "heatmap", x: c.names.map(nice), y: c.names.map(nice), z: c.matrix, zmin: -1, zmax: 1, colorscale: divScale(),
      text: c.matrix.map((r) => r.map((x) => (isFinite(x) ? x.toFixed(2) : ""))), texttemplate: "%{text}", textfont: { size: 10, color: tok("--ink") },
      colorbar: { thickness: 10, outlinewidth: 0, tickfont: { color: ink3, size: 10 } }, hovertemplate: "%{y} vs %{x}: %{z:.2f}<extra></extra>", xgap: 2, ygap: 2 }],
      layout({ margin: { l: 110, r: 16, t: 8, b: 100 }, xaxis: axis("", { tickangle: -40 }), yaxis: axis("", { autorange: "reversed" }) }));

    }
    if (view === "tradeoffs") {
    if (I.pa && I.pb && p.outputs.length > 1) {
      const pr = BC.pareto(p, I.pa, I.pb);
      const oa = p.outputs.find((o) => o.name === I.pa), ob = p.outputs.find((o) => o.name === I.pb);
      const arrow = (o) => (o.goal === "maximize" ? " (higher is better)" : o.goal === "minimize" ? " (lower is better)" : ` (target ${o.target})`);
      const frontIds = new Set(pr.front.map((q) => q.id));
      const rest = pr.points.filter((q) => !frontIds.has(q.id));
      plot("ch-pareto", [
        { type: "scatter", mode: "markers", x: rest.map((q) => q.a), y: rest.map((q) => q.b), text: rest.map((q) => q.id), marker: { size: 9, color: ink3, opacity: 0.6, line: { color: surface, width: 2 } }, hovertemplate: "%{text}<extra></extra>" },
        { type: "scatter", mode: "lines+markers+text", x: pr.front.map((q) => q.a), y: pr.front.map((q) => q.b), text: pr.front.map((q) => q.id), textposition: "top center", textfont: { size: 10, color: ink2 },
          line: { color: tok("--marm-bright"), width: 2, shape: "hv" }, marker: { size: 11, color: tok("--marm-bright"), line: { color: surface, width: 2 } }, hovertemplate: "%{text} (on the front)<extra></extra>" },
      ], layout({ xaxis: axis(`${nice(I.pa)}${arrow(oa)}`), yaxis: axis(`${nice(I.pb)}${arrow(ob)}`) }));
    }
    }
  }

  // ---------------------------------------------------------- setup helpers

  function renameKey(p, where, oldName, newName) {
    for (const r of p.runs) { const obj = r[where]; if (obj && oldName in obj) { obj[newName] = obj[oldName]; delete obj[oldName]; } }
    if (where === "x" && p.baseline && oldName in p.baseline) { p.baseline[newName] = p.baseline[oldName]; delete p.baseline[oldName]; }
  }

  function defaultValue(f) {
    if (f.type === "categorical") return f.levels[0];
    const v = BC.fromUnit(f, 0.5);
    return f.type === "integer" ? Math.round(v) : v;
  }

  function fillMissing(p) {
    for (const f of p.factors) {
      for (const r of p.runs) if (r.x[f.name] === undefined) r.x[f.name] = defaultValue(f);
      if (p.baseline && p.baseline[f.name] === undefined) p.baseline[f.name] = defaultValue(f);
    }
  }

  // ================================================================== setup

  const TYPE_LABEL = { continuous: "Number", integer: "Whole number", categorical: "Choice", component: "Blend part" };

  function factorMeta(p, f) {
    if (f.type === "categorical") return `${TYPE_LABEL[f.type]} · ${f.levels.map(nice).join(", ")}`;
    const range = `${fmtNum(f.low)}–${fmtNum(f.high)}${unitOf(f)}`;
    return `${TYPE_LABEL[f.type]} · ${range}${f.type === "component" ? ` · ${nice(f.group)} blend` : ""}${f.log ? " · log scale" : ""}`;
  }

  function outputMeta(o) {
    const goal = o.goal === "target" ? `Target ${o.target}` : o.goal === "maximize" ? "Higher is better" : "Lower is better";
    return `${goal} · ${fmtNum(o.low)}–${fmtNum(o.high)}${o.unit ? " " + o.unit : ""} · weight ${o.weight}`;
  }

  function setupView(p) {
    const errs = BC.checkProject(p);
    const groups = [...new Set(p.factors.filter((f) => f.type === "component").map((f) => f.group).filter(Boolean))];
    const libOpts = Object.entries(BC.OUTPUT_LIBRARY).filter(([k]) => !p.outputs.some((o) => o.name === k));
    return `
      <header class="page-head"><h1>Setup</h1><p class="sub">What you change between recipes, and what you judge them on.</p></header>
      ${errs.length ? `<div class="notice bad">Needs fixing:<ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
      <section class="card"><label class="field"><span>Experiment name</span><input type="text" id="p-name" data-p="name" value="${esc(p.name)}"></label></section>

      <section class="card flush">
        <div class="card-head pad"><h3>What you change</h3><p>Each factor is one thing that varies between recipes, with the range you're willing to try.</p></div>
        <ul class="list">${p.factors.map((f, i) => `<li class="${state.editF === i ? "open" : ""}">
          <button class="item" data-act="edit-f" data-i="${i}" aria-expanded="${state.editF === i}"><div class="main"><span class="title">${esc(cap(nice(f.name)))}</span><span class="meta">${esc(factorMeta(p, f))}</span></div><span class="chev"></span></button>
          ${state.editF === i ? factorEditor(p, f, i) : ""}</li>`).join("")}</ul>
        ${groups.length ? `<div class="foot stack">${groups.map((g) => { const b = (p.batchAmounts || {})[g] || {}; return `<div class="fields">
          <label class="field"><span>${esc(cap(nice(g)))} blend adds up to</span><input type="number" step="any" id="mix-${esc(g)}" data-mix="${esc(g)}" value="${esc(p.mixtures[g] ?? 100)}"></label>
          <label class="field"><span>One sample is</span><input type="number" step="any" id="batch-amt-${esc(g)}" data-batch="${esc(g)}:amount" value="${esc(b.amount ?? "")}" placeholder="e.g. 250"></label>
          <label class="field"><span>Unit</span><input type="text" id="batch-unit-${esc(g)}" data-batch="${esc(g)}:unit" value="${esc(b.unit ?? "")}" placeholder="g or ml"></label></div>`; }).join("")}
          <p class="help">With a sample size set, the cooking sheet shows real amounts instead of percentages.</p></div>` : ""}
        <div class="foot row"><span class="small muted">Add</span><button class="btn sm" data-act="add-factor" data-type="continuous">Number</button><button class="btn sm" data-act="add-factor" data-type="categorical">Choice</button><button class="btn sm" data-act="add-factor" data-type="component">Blend part</button></div>
      </section>

      <section class="card flush">
        <div class="card-head pad"><h3>What you judge</h3><p>Each output is a score or measurement you record for every sample.</p></div>
        <ul class="list">${p.outputs.map((o, i) => `<li class="${state.editO === i ? "open" : ""}">
          <button class="item" data-act="edit-o" data-i="${i}" aria-expanded="${state.editO === i}"><div class="main"><span class="title">${esc(cap(nice(o.name)))}</span><span class="meta">${esc(outputMeta(o))}</span></div><span class="chev"></span></button>
          ${state.editO === i ? outputEditor(o, i) : ""}</li>`).join("")}</ul>
        <div class="foot row"><select id="lib-pick" aria-label="Suggested measurement" style="flex:1;min-width:180px"><option value="">Add a suggested measurement…</option>${["Sensory", "Physical", "Practical"].map((cat) => `<optgroup label="${cat}">${libOpts.filter(([, o]) => o.category === cat).map(([k]) => `<option value="${k}">${esc(cap(nice(k)))}</option>`).join("")}</optgroup>`).join("")}</select>
          <button class="btn sm" data-act="add-lib-output">Add</button><button class="btn sm ghost" data-act="add-output">Custom</button></div>
      </section>

      <section class="card stack">
        <label class="check"><input type="checkbox" id="baseline-on" data-act="toggle-baseline" ${p.baseline ? "checked" : ""}> Cook my current recipe first, as the reference</label>
        ${p.baseline ? `<div class="fields">${p.factors.map((f) => factorInput(f, p.baseline[f.name], `base:${f.name}`)).join("")}</div>
          ${BC.checkRun(p, p.baseline).length ? `<div class="notice bad small">${BC.checkRun(p, p.baseline).map(esc).join(" ")}</div>` : ""}` : `<p class="small muted">Optional. It gives every later recipe a fair comparison.</p>`}
      </section>

      <section class="card stack">
        <h3>Tasting notes for this recipe</h3>
        <textarea id="p-tips" data-p="tips" rows="4" placeholder="One per line, e.g. Chill every sample to fridge temperature.">${esc((p.tips || []).join("\n"))}</textarea>
        <p class="help">Shown on the checklist before every tasting.</p>
      </section>

      <div class="row"><button class="btn ghost sm" data-act="duplicate">Copy setup to a new experiment</button><span class="spacer"></span><button class="btn ghost sm danger" data-act="delete-project">Delete experiment</button></div>`;
  }

  function factorEditor(p, f, i) {
    const num = f.type !== "categorical";
    return `<div class="editor">
      <div class="fields">
        <label class="field"><span>Name</span><input type="text" id="f-name-${i}" data-f="${i}:name" value="${esc(f.name)}"></label>
        <label class="field"><span>Type</span><select id="f-type-${i}" data-f="${i}:type">${Object.entries(TYPE_LABEL).map(([k, l]) => `<option value="${k}"${f.type === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="field"><span>Kind</span><select id="f-kind-${i}" data-f="${i}:kind">${[["composition", "Ingredient"], ["process", "Process"], ["other", "Other"]].map(([k, l]) => `<option value="${k}"${(f.kind || "other") === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
      ${num ? `<div class="fields">
        <label class="field"><span>Lowest</span><input type="number" step="any" id="f-low-${i}" data-f="${i}:low" value="${esc(f.low)}"></label>
        <label class="field"><span>Highest</span><input type="number" step="any" id="f-high-${i}" data-f="${i}:high" value="${esc(f.high)}"></label>
        <label class="field"><span>Unit</span><input type="text" id="f-unit-${i}" data-f="${i}:unit" value="${esc(f.unit || "")}" placeholder="g, °C, min"></label>
        ${f.type === "component" ? `<label class="field"><span>Blend name</span><input type="text" id="f-group-${i}" data-f="${i}:group" value="${esc(f.group || "")}" placeholder="e.g. flour"></label>` : ""}
      </div>
      <label class="check small"><input type="checkbox" id="f-log-${i}" data-f="${i}:log" ${f.log ? "checked" : ""}> Log scale <span class="faint" style="font-weight:500">(for ratios, where doubling matters more than adding)</span></label>`
      : `<label class="field"><span>Options, separated by commas</span><input type="text" id="f-levels-${i}" data-f="${i}:levels" value="${esc((f.levels || []).join(", "))}" placeholder="butter, ghee"></label>`}
      <div class="row"><button class="btn ghost sm danger" data-act="del-factor" data-i="${i}">Remove factor</button><span class="spacer"></span><button class="btn sm" data-act="edit-f" data-i="${i}">Done</button></div>
    </div>`;
  }

  function outputEditor(o, i) {
    return `<div class="editor">
      <div class="fields">
        <label class="field"><span>Name</span><input type="text" id="o-name-${i}" data-o="${i}:name" value="${esc(o.name)}"></label>
        <label class="field"><span>Goal</span><select id="o-goal-${i}" data-o="${i}:goal">${[["maximize", "Higher is better"], ["minimize", "Lower is better"], ["target", "Hit a target"]].map(([k, l]) => `<option value="${k}"${o.goal === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        ${o.goal === "target" ? `<label class="field"><span>Target</span><input type="number" step="any" id="o-target-${i}" data-o="${i}:target" value="${esc(o.target ?? "")}"></label>` : ""}
      </div>
      <div class="fields">
        <label class="field"><span>Lowest</span><input type="number" step="any" id="o-low-${i}" data-o="${i}:low" value="${esc(o.low ?? "")}"></label>
        <label class="field"><span>Highest</span><input type="number" step="any" id="o-high-${i}" data-o="${i}:high" value="${esc(o.high ?? "")}"></label>
        <label class="field"><span>Unit</span><input type="text" id="o-unit-${i}" data-o="${i}:unit" value="${esc(o.unit || "")}"></label>
        <label class="field"><span>Weight</span><input type="number" step="any" min="0" id="o-weight-${i}" data-o="${i}:weight" value="${esc(o.weight ?? 1)}"></label>
      </div>
      <label class="field"><span>How to measure it</span><input type="text" id="o-how-${i}" data-o="${i}:how" value="${esc(o.how || "")}"></label>
      <p class="help">Lowest and highest set the range used for scoring. Weight sets how much this output counts in the overall score. Whole-number ranges of 10 or less become tap-to-rate buttons.</p>
      <div class="row"><button class="btn ghost sm danger" data-act="del-output" data-i="${i}">Remove output</button><span class="spacer"></span><button class="btn sm" data-act="edit-o" data-i="${i}">Done</button></div>
    </div>`;
  }

  // ================================================================= sheets

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
      title = `Run ${r.id}`; body = runSheet(p, r);
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

  function openSheet(name) { state.sheet = name; renderSheet(); }
  function closeSheet() { state.sheet = null; state.preview = null; renderSheet(); }

  const PRESETS = {
    balanced: { label: "Balanced", desc: "Default. Mixes new ideas with refining good ones.", set: { acquisition: "thompson", localFraction: 0.3, localRadius: 0.08 } },
    explore: { label: "Explore", desc: "Casts a wider net. Good early on.", set: { acquisition: "ucb", ucbBeta: 3.5, localFraction: 0.1, localRadius: 0.15 } },
    refine: { label: "Refine", desc: "Fine-tunes around your best recipes.", set: { acquisition: "ei", xi: 0, localFraction: 0.6, localRadius: 0.05 } },
  };
  function activePreset(s) {
    for (const [k, pr] of Object.entries(PRESETS)) if (Object.entries(pr.set).every(([key, val]) => s[key] === val)) return k;
    return null;
  }

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

  function previewTable(p) {
    const pv = state.preview;
    if (pv === "busy") return `<span class="thinking">Planning a preview…</span>`;
    if (pv.error) return `<div class="notice bad">${esc(pv.error)}</div>`;
    return `<section class="card flush"><div class="card-head pad"><h3>Preview</h3><span class="faint small">${pv.ms} ms · not saved</span></div>
      <ul class="list">${pv.rows.map((q) => `<li><div class="item"><div class="main"><span class="meta" style="color:var(--ink)">${esc(summary(p, q.x, 4))}</span></div><span class="pill ${phaseClass(q.phase)}">${esc(PHASE_LABEL[q.phase] || q.phase)}</span></div></li>`).join("")}</ul></section>`;
  }

  function setPath(obj, path, val) {
    const ks = path.split(".");
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] = o[ks[i]] || {};
    o[ks[ks.length - 1]] = val;
  }

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

  // ================================================================= modals

  function openModal(html) {
    $("#modal-root").innerHTML = `<div class="modal-back" data-act="modal-back"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    const f = $("#modal-root input, #modal-root button");
    if (f) f.focus();
  }
  function closeModal() { $("#modal-root").innerHTML = ""; }

  function confirmModal(title, body, okLabel, onOk) {
    state.onConfirm = onOk;
    openModal(`<h2>${esc(title)}</h2><p class="muted">${esc(body)}</p><div class="row end"><button class="btn ghost" data-act="close-modal">Keep it</button><button class="btn danger" data-act="confirm-ok">${esc(okLabel)}</button></div>`);
  }

  function newProjectModal() {
    state.newTemplate = state.newTemplate || "lemonade";
    const t = BC.TEMPLATES;
    openModal(`<h2>New experiment</h2>
      <label class="field"><span>Name</span><input type="text" id="np-name" placeholder="${esc(t[state.newTemplate].name)}"></label>
      ${[...new Set(Object.values(t).map((v) => v.folder))].map((folder) => `<div class="stack" style="gap:8px"><span class="eyebrow">${esc(folder)}</span><div class="tpl-grid">${Object.entries(t).filter(([, v]) => v.folder === folder).map(([k, v]) => `<button type="button" data-act="pick-template" data-k="${k}" aria-pressed="${state.newTemplate === k}"><b>${esc(v.name)}</b><span class="small muted">${esc(v.description)}</span></button>`).join("")}</div></div>`).join("")}
      <div class="row end"><button class="btn ghost" data-act="close-modal">Cancel</button><button class="btn primary" data-act="create-project">Create</button></div>`);
  }

  function createProject(p) {
    p.touched = true;
    state.projects[p.id] = normalize(p);
    state.currentId = p.id;
    store.set("bc:current", p.id);
    resetViewState();
    save(p, { immediate: true });
    state.tab = "setup";
    render();
  }

  function resetViewState() {
    Object.assign(state, { proposals: null, preview: null, drafts: {}, expanded: null, cookStep: null, lastSession: null, editF: null, editO: null, sheet: null, checks: {} });
  }

  // ================================================================= events

  function go(tab) {
    state.tab = tab; store.set("bc:tab", tab); render(); window.scrollTo({ top: 0 });
  }

  document.addEventListener("click", (e) => {
    const tabBtn = e.target.closest("[data-tab]");
    if (tabBtn) { if (state.sheet) closeSheet(); go(tabBtn.dataset.tab); return; }
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    const p = cur();
    const A = {
      "new-project": newProjectModal,
      "pick-template": () => { state.newTemplate = el.dataset.k; const name = $("#np-name").value; newProjectModal(); $("#np-name").value = name; },
      "create-project": () => { const name = $("#np-name").value.trim(); closeModal(); createProject(BC.fromTemplate(state.newTemplate, name || undefined)); toast("Created. Check the ranges, then plan your first session."); },
      "close-modal": closeModal,
      "modal-back": () => { if (e.target === el) closeModal(); },
      "confirm-ok": () => { const f = state.onConfirm; state.onConfirm = null; closeModal(); if (f) f(); },
      "copy-area": () => { const t = $("#copy-area"); const done = () => toast("Copied"); if (navigator.clipboard) navigator.clipboard.writeText(t.value).then(done, () => { t.select(); }); else t.select(); },
      "open-settings": () => openSheet("settings"),
      "open-help": () => openSheet("help"),
      "close-sheet": closeSheet,
      "open-run": () => openSheet(`run:${el.dataset.id}`),
      "batch-step": () => { p.settings.batchSize = Math.min(8, Math.max(1, settings(p).batchSize + Number(el.dataset.d))); save(p); render(); },
      plan: planSession,
      replan: () => { state.replans = (state.replans || 0) + 1; planSession(); },
      "discard-proposals": () => { state.proposals = null; render(); },
      "toggle-prop": () => { const i = Number(el.dataset.i); state.expanded = state.expanded === i ? null : i; render(); },
      decide: () => { const q = state.proposals[Number(el.dataset.i)]; q.decision = el.dataset.d; if (q.decision === "reject") q.editing = false; render(); },
      "edit-prop": () => { const i = Number(el.dataset.i); state.proposals[i].editing = true; state.expanded = i; render(); },
      "edit-done": () => { state.proposals[Number(el.dataset.i)].editing = false; render(); },
      "start-session": startSession,
      "start-tasting": () => { state.cookStep = "taste"; render(); window.scrollTo({ top: 0, behavior: "smooth" }); },
      "back-prep": () => { state.cookStep = "prep"; render(); window.scrollTo({ top: 0 }); },
      tick: () => { state.checks[el.dataset.i] = el.checked; },
      "cancel-session": () => confirmModal("Cancel this session?", "The recipes you haven't tasted yet are removed. Scores you've already saved stay.", "Cancel session", () => {
        p.runs = p.runs.filter((r) => r.status !== "planned");
        if (!p.runs.some((r) => r.session === p.sessions)) p.sessions = Math.max(0, p.sessions - 1);
        state.cookStep = null; save(p); render();
      }),
      scale: () => { const d = (state.drafts[el.dataset.id] = state.drafts[el.dataset.id] || {}); d[el.dataset.o] = Number(el.dataset.v); el.parentElement.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === el))); },
      how: () => { state.showHow[el.dataset.o] = !state.showHow[el.dataset.o]; render(); },
      "toggle-note": () => { state.noteOpen[el.dataset.id] = true; render(); const t = $(`#note-${el.dataset.id}`); if (t) t.focus(); },
      "save-result": () => saveResult(el.dataset.id),
      "not-made": () => {
        const r = p.runs.find((q) => q.id === el.dataset.id);
        r.status = "rejected"; r.phase = "not-made"; r.notes = (r.notes ? r.notes + " · " : "") + "not made";
        finishIfDone(p, r.session); save(p); render();
      },
      "dismiss-last": () => { state.lastSession = null; render(); },
      logfilter: () => { state.logFilter = el.dataset.f; render(); },
      "log-recipe": () => { state.logShowRecipe = el.checked; render(); },
      "save-run": () => {
        const r = p.runs.find((q) => q.id === el.dataset.id);
        document.querySelectorAll("#sheet-root [data-edit]").forEach((inp) => {
          const [k, o] = inp.dataset.edit.split(":");
          if (k === "y") { r.y = r.y || {}; if (inp.value === "") delete r.y[o]; else r.y[o] = Number(inp.value); }
          else r[k] = inp.value;
        });
        p.touched = true; save(p); closeSheet(); render(); toast(`Saved ${r.id}`);
      },
      "delete-run": () => confirmModal(`Delete ${el.dataset.id}?`, "The recipe and its scores are removed from this experiment.", "Delete", () => {
        p.runs = p.runs.filter((r) => r.id !== el.dataset.id); state.sheet = null; save(p); render();
      }),
      "export-csv": () => offerFile(`${slug(p.name)}-runs.csv`, csvOf(p)),
      "export-json": () => offerFile(`${slug(p.name)}.json`, JSON.stringify(p, null, 2)),
      "ins-view": () => { state.insights.view = el.dataset.v; render(); },
      "edit-f": () => { const i = Number(el.dataset.i); state.editF = state.editF === i ? null : i; render(); },
      "edit-o": () => { const i = Number(el.dataset.i); state.editO = state.editO === i ? null : i; render(); },
      "add-factor": () => {
        const type = el.dataset.type;
        const base = { name: uniqueName(p, type === "categorical" ? "choice" : type === "component" ? "part" : "factor"), type, kind: "composition" };
        if (type === "categorical") Object.assign(base, { levels: ["a", "b"] });
        else if (type === "component") {
          const g = (p.factors.find((f) => f.type === "component") || {}).group || "blend";
          Object.assign(base, { group: g, low: 0, high: 100, unit: "%" });
          if (!(g in p.mixtures)) p.mixtures[g] = 100;
        } else Object.assign(base, { low: 0, high: 10, unit: "" });
        p.factors.push(base); fillMissing(p); p.touched = true; state.editF = p.factors.length - 1; save(p); render();
      },
      "del-factor": () => { const f = p.factors[Number(el.dataset.i)]; confirmModal(`Remove ${nice(f.name)}?`, "Past recipes keep their values in exports, but the model stops using this factor.", "Remove", () => { p.factors.splice(Number(el.dataset.i), 1); cleanupMixtures(p); state.editF = null; save(p); render(); }); },
      "toggle-baseline": () => { p.baseline = el.checked ? Object.fromEntries(p.factors.map((f) => [f.name, defaultValue(f)])) : null; if (p.baseline) fillMixtureBaseline(p); save(p); render(); },
      "add-output": () => { p.outputs.push({ name: uniqueName(p, "output"), goal: "maximize", low: 1, high: 9, weight: 1, unit: "", how: "" }); state.editO = p.outputs.length - 1; save(p); render(); },
      "add-lib-output": () => {
        const k = el.dataset.k || ($("#lib-pick") && $("#lib-pick").value);
        if (!k || p.outputs.some((o) => o.name === k)) return;
        const { category, ...o } = BC.OUTPUT_LIBRARY[k];
        p.outputs.push({ name: k, ...o }); save(p); render(); toast(`Added ${nice(k)}`);
      },
      "del-output": () => { const o = p.outputs[Number(el.dataset.i)]; confirmModal(`Remove ${nice(o.name)}?`, "Recorded values stay in exports, but scores and the model stop using them.", "Remove", () => { p.outputs.splice(Number(el.dataset.i), 1); state.editO = null; save(p); render(); }); },
      duplicate: () => { const q = clone(p); Object.assign(q, { id: BC.uid(), name: `${p.name} (copy)`, runs: [], sessions: 0, example: false, createdAt: nowIso() }); createProject(q); },
      "delete-project": () => confirmModal(`Delete “${p.name}”?`, "This removes the experiment and all its results for good.", "Delete experiment", async () => {
        await removeProject(p.id); state.currentId = pickDefault(); if (!state.currentId) { state.projects.example = BC.exampleProject(); state.currentId = "example"; } resetViewState(); state.tab = "cook"; render();
      }),
      preset: () => { p.settings = BC.mergeSettings(p.settings); Object.assign(p.settings, PRESETS[el.dataset.k].set); state.preview = null; save(p); renderSheet(); },
      preview: () => {
        state.preview = "busy"; renderSheet();
        setTimeout(() => {
          const t0 = performance.now();
          try { const rows = BC.propose(p, settings(p), settings(p).batchSize, p.sessions + 1); state.preview = { rows, ms: Math.round(performance.now() - t0) }; }
          catch (err) { state.preview = { error: `Couldn't plan with these settings: ${err.message}` }; }
          renderSheet();
        }, 30);
      },
      "reset-knobs": () => confirmModal("Reset every setting?", "All advanced settings go back to their defaults. Your recipes and scores are untouched.", "Reset", () => { const b = settings(p).batchSize; p.settings = BC.mergeSettings({ batchSize: b }); state.preview = null; save(p); render(); }),
    };
    if (A[act]) A[act]();
  });

  // Keyboard: Enter/Space on role=button rows, Escape closes overlays.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if ($("#modal-root").innerHTML) closeModal(); else if (state.sheet) closeSheet(); return; }
    const t = e.target;
    if ((e.key === "Enter" || e.key === " ") && t.matches && t.matches('[role="button"][data-act], tr[data-act]')) { e.preventDefault(); t.click(); }
  });

  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "experiment"; }
  function uniqueName(p, base) { let i = 1; const names = new Set([...p.factors.map((f) => f.name), ...p.outputs.map((o) => o.name)]); while (names.has(`${base}_${i}`)) i++; return `${base}_${i}`; }
  function cleanupMixtures(p) { for (const g of Object.keys(p.mixtures)) if (!p.factors.some((f) => f.type === "component" && f.group === g)) delete p.mixtures[g]; }
  function fillMixtureBaseline(p) {
    for (const [g, total] of Object.entries(p.mixtures)) {
      const cs = BC.components(p, g); if (!cs.length) continue;
      Object.assign(p.baseline, BC.sampleMixture(cs, total, BC.Rng(1)));
    }
  }

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
      if (t.value === "__new") { t.value = state.currentId; newProjectModal(); return; }
      state.currentId = t.value; store.set("bc:current", t.value); resetViewState(); render(); return;
    }
    if (t.id === "import-file") { importFile(t.files && t.files[0]); t.value = ""; return; }
    if (!p) return;
    if (t.dataset.bind) {
      const [kind, a, b] = t.dataset.bind.split(":");
      if (kind === "prop") {
        const q = state.proposals[Number(a)];
        const f = p.factors.find((x) => x.name === b);
        q.x[b] = f.type === "categorical" ? t.value : Number(t.value);
        q.edited = true;
        render(); return;
      }
      if (kind === "base") {
        const f = p.factors.find((x) => x.name === a);
        p.baseline[a] = f.type === "categorical" ? t.value : Number(t.value);
        save(p); render(); return;
      }
    }
    if (t.dataset.p === "tips") { p.tips = t.value.split("\n").map((x) => x.trim()).filter(Boolean); p.touched = true; save(p); return; }
    if (t.dataset.p === "name") { p.name = t.value.trim() || p.name; p.touched = true; save(p); renderTop(); return; }
    if (t.dataset.f) {
      const [i, key] = t.dataset.f.split(":");
      const f = p.factors[Number(i)];
      if (key === "name") {
        const nn = t.value.trim().replace(/\s+/g, "_");
        if (!nn || p.factors.some((x, j) => j !== Number(i) && x.name === nn)) { toast("Names must be unique and not empty."); render(); return; }
        renameKey(p, "x", f.name, nn); f.name = nn;
      } else if (key === "type") {
        f.type = t.value;
        if (f.type === "categorical") { f.levels = f.levels && f.levels.length ? f.levels : ["a", "b"]; delete f.log; }
        else { f.low = valid(f.low) ? f.low : 0; f.high = valid(f.high) ? f.high : 10; }
        if (f.type === "component") { f.group = f.group || "blend"; if (!(f.group in p.mixtures)) p.mixtures[f.group] = 100; }
        cleanupMixtures(p);
        for (const r of p.runs) if (r.x[f.name] !== undefined && (f.type === "categorical" ? !f.levels.includes(r.x[f.name]) : !isFinite(r.x[f.name]))) r.x[f.name] = defaultValue(f);
        if (p.baseline) p.baseline[f.name] = defaultValue(f);
      } else if (key === "levels") {
        f.levels = t.value.split(",").map((x) => x.trim().replace(/\s+/g, "_")).filter(Boolean);
        for (const r of p.runs) if (!f.levels.includes(r.x[f.name])) r.x[f.name] = f.levels[0];
      } else if (key === "log") f.log = t.checked;
      else if (key === "low" || key === "high") f[key] = Number(t.value);
      else if (key === "group") { f.group = t.value.trim() || "blend"; if (!(f.group in p.mixtures)) p.mixtures[f.group] = 100; cleanupMixtures(p); }
      else f[key] = t.value;
      fillMissing(p); p.touched = true; save(p); render(); return;
    }
    if (t.dataset.batch) {
      const [g, key] = t.dataset.batch.split(":");
      p.batchAmounts = p.batchAmounts || {};
      const b = (p.batchAmounts[g] = p.batchAmounts[g] || {});
      if (key === "amount") { if (t.value === "") delete p.batchAmounts[g]; else b.amount = Number(t.value); } else b.unit = t.value.trim();
      save(p); render(); return;
    }
    if (t.dataset.mix) { p.mixtures[t.dataset.mix] = Number(t.value); save(p); render(); return; }
    if (t.dataset.o) {
      const [i, key] = t.dataset.o.split(":");
      const o = p.outputs[Number(i)];
      if (key === "name") {
        const nn = t.value.trim().replace(/\s+/g, "_");
        if (!nn || p.outputs.some((x, j) => j !== Number(i) && x.name === nn) || p.factors.some((x) => x.name === nn)) { toast("Names must be unique and not empty."); render(); return; }
        renameKey(p, "y", o.name, nn); o.name = nn;
      } else if (["target", "low", "high", "weight"].includes(key)) o[key] = t.value === "" ? null : Number(t.value);
      else o[key] = t.value;
      save(p); render(); return;
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
      setPath(p.settings, t.dataset.k, v);
      state.preview = null;
      save(p); render(); return;
    }
    if (t.dataset.ins) {
      state.insights[t.dataset.ins] = t.value;
      if (t.dataset.ins === "sx" && state.insights.sy === t.value) state.insights.sy = null;
      if (t.dataset.ins === "pa" && state.insights.pb === t.value) state.insights.pb = null;
      render(); return;
    }
  });

  document.addEventListener("toggle", (e) => {
    const d = e.target;
    if (d.dataset && d.dataset.acc) state.accOpen[d.dataset.acc] = d.open;
  }, true);

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

  // Redraw charts when the theme changes.
  const redraw = () => { if (state.tab === "insights" && cur()) drawInsights(cur()); };
  try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw); } catch (e) { /* old browsers */ }
  new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // =================================================================== boot

  state.projects.example = BC.exampleProject();
  const savedTab = store.get("bc:tab", "cook");
  state.tab = OLD_TABS[savedTab] || savedTab;
  if (!TABS.some((t) => t.id === state.tab)) state.tab = "cook";
  state.currentId = "example";
  render();
  connect();
})();
