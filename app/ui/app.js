/* Bayesian Chef: app shell, persistence, views and charts. */
(function () {
  "use strict";
  const BC = window.BC;

  // ================================================================== state

  const TABS = [
    { id: "kitchen", label: "Kitchen" },
    { id: "logbook", label: "Logbook" },
    { id: "insights", label: "Insights" },
    { id: "pantry", label: "Pantry" },
    { id: "knobs", label: "Knobs" },
    { id: "guide", label: "Guide" },
  ];

  const state = {
    projects: {},
    currentId: null,
    tab: "kitchen",
    proposals: null,       // [{x, phase, why, predictions, decision, reason, editing}]
    planning: false,
    drafts: {},            // runId -> {output: value, notes}
    logFilter: "all",
    selectedRun: null,
    preview: null,
    insights: { target: "__score", sx: null, sy: null, sz: "mean", diagOut: null, pa: null, pb: null },
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
  const PHASE_LABEL = { doe: "design", bo: "model pick", baseline: "your recipe", replicate: "repeat", manual: "edited", "not-made": "not made" };

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

  function setSave(s, err = "") { state.saveState = s; state.saveError = err; renderSavePill(); }

  function renderSavePill() {
    const el = $("#savepill");
    if (!el) return;
    let cls = "", text = "";
    if (state.mode === "connecting") text = "Connecting…";
    else if (state.saveState === "error") { cls = "bad"; text = "Not saved"; }
    else if (state.saveState === "saving") text = "Saving…";
    else if (state.mode === "local") { cls = "warn"; text = "Saved in this browser only"; }
    else { cls = "ok"; text = "Saved"; }
    const p = cur();
    if (p && p.example && !p.touched && state.mode !== "connecting") { cls = "warn"; text = "Example data"; }
    el.className = `savepill ${cls}`;
    el.textContent = text;
    el.title = state.saveError || "";
  }

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
      if (!state.projects[state.currentId]) state.currentId = pickDefault();
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
      if (!state.projects[state.currentId]) state.currentId = pickDefault();
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
    if (!p) { main.innerHTML = emptyView(); return; }
    const views = { kitchen: kitchenView, logbook: logbookView, insights: insightsView, pantry: pantryView, knobs: knobsView, guide: guideView };
    try {
      main.innerHTML = (views[state.tab] || kitchenView)(p);
    } catch (e) {
      console.error(e);
      main.innerHTML = `<div class="notice bad">Something went wrong drawing this page: ${esc(e.message)}. Check the Pantry for an invalid setup.</div>`;
    }
    if (state.tab === "insights") requestAnimationFrame(() => drawInsights(p));
  }

  function renderTop() {
    const sel = $("#project-select");
    const ps = Object.values(state.projects).sort((a, b) => (a.example ? 1 : 0) - (b.example ? 1 : 0) || (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    sel.innerHTML = ps.map((p) => `<option value="${esc(p.id)}"${p.id === state.currentId ? " selected" : ""}>${esc(p.name)}</option>`).join("");
    const p = cur();
    const planned = p ? p.runs.filter((r) => r.status === "planned").length : 0;
    $("#tabs").innerHTML = TABS.map((t) => `<button class="tab" role="tab" type="button" data-tab="${t.id}" aria-selected="${t.id === state.tab}">${t.label}${t.id === "kitchen" && planned ? `<span class="count">${planned}</span>` : ""}</button>`).join("");
    renderSavePill();
  }

  function emptyView() {
    return `<section class="panel stack"><h2>Start your first experiment</h2>
      <p class="muted">Pick a template or start from scratch. You can change every factor and output afterwards.</p>
      <div class="row"><button class="btn primary" data-act="new-project">New experiment</button></div></section>`;
  }

  // ================================================================ kitchen

  function phaseSummary(p) {
    const s = settings(p);
    const active = p.runs.filter((r) => r.status !== "rejected").length;
    const done = BC.doneRuns(p).length;
    const nInit = BC.initialRuns(p, s);
    const acqNames = { thompson: "Thompson sampling", ei: "expected improvement", ucb: "upper confidence bound", pi: "probability of improvement", exploit: "pure exploitation", explore: "pure exploration" };
    if (active < nInit || !done) return { stage: "design", text: `Initial design: ${Math.min(active, nInit)} of ${nInit} runs planned. The first runs spread evenly across your ranges so the model has something to learn from.`, frac: Math.min(1, active / nInit) };
    return { stage: "model", text: `The model is choosing runs using ${acqNames[s.acquisition] || s.acquisition}, based on ${done} recorded results.`, frac: 1 };
  }

  function kitchenView(p) {
    const s = settings(p);
    const errs = BC.checkProject(p);
    const planned = p.runs.filter((r) => r.status === "planned");
    const ph = phaseSummary(p);
    const done = BC.doneRuns(p);
    const rg = BC.ranges(p);
    const scores = done.map((r) => BC.runScore(p, r, s, rg)).filter((v) => v !== null);
    const best = scores.length ? Math.max(...scores) : null;
    let body = "";
    if (errs.length) body = `<div class="notice bad">Fix the setup before planning a session:<ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul><div class="row" style="margin-top:8px"><button class="btn small" data-tab="pantry">Open Pantry</button></div></div>`;
    else if (planned.length) body = sessionView(p, planned);
    else if (state.proposals) body = approvalView(p);
    else body = planView(p);
    return `
      <section class="hero">
        <div class="stack" style="gap:6px">
          <span class="label">${p.example && !p.touched ? "Example experiment · simulated results" : "Experiment"}</span>
          <h1>${esc(p.name)}</h1>
          <p class="muted">${esc(ph.text)}</p>
        </div>
        <div class="progress-jar">
          <div class="row small"><span class="label">${ph.stage === "design" ? "Initial design" : "Learning"}</span><span class="spacer"></span><span class="num">${done.length} results · ${p.sessions} sessions${best !== null ? ` · best ${best.toFixed(2)}` : ""}</span></div>
          <div class="bar" role="img" aria-label="Initial design ${pct(ph.frac)} complete"><i style="width:${Math.max(4, ph.frac * 100)}%"></i></div>
        </div>
      </section>
      ${p.example && !p.touched ? `<div class="notice info">This is an example with simulated results so you can look around. Start your own with <b>+ New</b> at the top.</div>` : ""}
      ${body}`;
  }

  function planView(p) {
    const s = settings(p);
    const next = p.sessions + 1;
    const hasBaseline = p.baseline && !p.runs.some((r) => r.phase === "baseline" && r.status !== "rejected");
    const recent = BC.doneRuns(p).slice(-5).reverse();
    const rg = BC.ranges(p);
    return `
      <section class="panel stack">
        <div class="panel-head"><h2>Plan session ${next}</h2>
          <p class="muted">The app proposes recipes; you approve, edit or reject each one before cooking.${hasBaseline ? " Your current recipe goes first as the reference." : ""}</p></div>
        <div class="row">
          <div class="field"><span>Samples this session</span>
            <div class="seg" role="group" aria-label="Samples this session">${[1, 2, 3, 4, 5, 6].map((n) => `<button type="button" data-act="batch" data-n="${n}" aria-pressed="${s.batchSize === n}">${n}</button>`).join("")}</div>
            <span class="help">Keep to 4–6 tastings per sitting. Fewer for rich or spicy food.</span>
          </div>
          <span class="spacer"></span>
          ${state.planning ? `<span class="thinking muted">Thinking about the next session…</span>` : `<button class="btn primary" data-act="plan">Plan session ${next}</button>`}
        </div>
      </section>
      ${recent.length ? `<section class="panel"><div class="panel-head"><h3>Latest results</h3><button class="btn small ghost" data-tab="logbook">Open logbook</button></div>
        <div class="table-wrap"><table><thead><tr><th>Run</th><th>Session</th><th>Type</th>${p.outputs.map((o) => `<th>${esc(nice(o.name))}</th>`).join("")}<th>Score</th></tr></thead><tbody>
        ${recent.map((r) => { const sc = BC.runScore(p, r, s, rg); return `<tr><td class="mono">${esc(r.id)}</td><td class="n">${r.session}</td><td><span class="chip ${esc(r.phase)}">${esc(PHASE_LABEL[r.phase] || r.phase)}</span></td>${p.outputs.map((o) => `<td class="n">${fmtNum(r.y[o.name])}</td>`).join("")}<td class="n">${sc === null ? "–" : sc.toFixed(2)}</td></tr>`; }).join("")}
        </tbody></table></div></section>` : ""}`;
  }

  /** For a blend part with a batch size set, the amount to measure out. */
  function amountOf(p, f, v) {
    const b = f.type === "component" && p.batchAmounts && p.batchAmounts[f.group];
    const total = b && p.mixtures[f.group];
    if (!b || !total) return "";
    return `${fmtNum((Number(v) / total) * b.amount, Number(v) / total * b.amount >= 10 ? 0 : 1)} ${b.unit}`;
  }

  function factorRows(p, x) {
    return `<dl class="kv">${p.factors.map((f) => {
      const amt = amountOf(p, f, x[f.name]);
      return `<div><dt title="${esc(nice(f.name))}">${esc(nice(f.name))}</dt><dd>${amt ? `<b>${esc(amt)}</b> <span class="faint">(${esc(fmtVal(f, x[f.name]))}%)</span>` : `${esc(fmtVal(f, x[f.name]))}<span class="faint">${esc(unitOf(f))}</span>`}</dd></div>`;
    }).join("")}</dl>`;
  }

  function predChips(p, preds) {
    if (!preds) return "";
    return `<div class="preds">${Object.entries(preds).map(([k, v]) => `<span class="pred">${esc(nice(k))} ≈ <span class="num">${fmtNum(v.mean)} ± ${fmtNum(v.sd)}</span></span>`).join("")}</div>`;
  }

  function approvalView(p) {
    const props = state.proposals;
    const approved = props.filter((q) => q.decision !== "reject");
    const invalid = approved.some((q) => BC.checkRun(p, q.x).length);
    return `
      <section class="panel stack">
        <div class="panel-head"><h2>Review session ${p.sessions + 1}</h2>
          <div class="row"><button class="btn small ghost" data-act="discard-proposals">Discard</button><button class="btn small" data-act="replan">Suggest different ones</button></div>
          <p class="muted">Approve the ones you're happy to cook, edit anything that isn't practical, and reject what you'd never make. Rejections teach the model to avoid that area.</p>
        </div>
        <div class="grid grid-3">
          ${props.map((q, i) => proposalCard(p, q, i)).join("")}
        </div>
        <div class="row end">
          <span class="muted small">${approved.length} of ${props.length} approved</span>
          <button class="btn primary" data-act="start-session" ${!approved.length || invalid ? "disabled" : ""}>Start session with ${approved.length}</button>
        </div>
      </section>`;
  }

  function proposalCard(p, q, i) {
    const errs = BC.checkRun(p, q.x);
    const edit = q.decision === "edit";
    return `<article class="proposal ${q.decision === "reject" ? "rejected" : ""}">
      <div class="recipe-card">
        <header><span class="chip ${esc(q.phase)}">${esc(PHASE_LABEL[q.phase] || q.phase)}</span><span class="faint small">Proposal ${i + 1}</span></header>
        ${edit ? `<div class="edit-grid">${p.factors.map((f) => factorInput(f, q.x[f.name], `prop:${i}:${f.name}`)).join("")}</div>` : factorRows(p, q.x)}
        <p class="why">${esc(q.why)}</p>
        ${predChips(p, q.predictions)}
      </div>
      ${errs.length && q.decision !== "reject" ? `<div class="notice bad small">${errs.map(esc).join(" ")}</div>` : ""}
      <div class="seg" role="group" aria-label="Decision for proposal ${i + 1}">
        <button type="button" data-act="decide" data-i="${i}" data-d="approve" aria-pressed="${q.decision === "approve"}">Approve</button>
        <button type="button" data-act="decide" data-i="${i}" data-d="edit" aria-pressed="${edit}">Edit</button>
        <button type="button" data-act="decide" data-i="${i}" data-d="reject" aria-pressed="${q.decision === "reject"}">Reject</button>
      </div>
      ${q.decision === "reject" ? `<label class="field"><span>Why? (saved with the run)</span><input type="text" id="reason-${i}" data-bind="reason:${i}" value="${esc(q.reason || "")}" placeholder="e.g. too hot for my pan"></label>` : ""}
    </article>`;
  }

  function factorInput(f, v, bind, id) {
    const fid = id || `in-${bind.replace(/[^a-z0-9]/gi, "-")}`;
    if (f.type === "categorical") {
      return `<label class="field"><span>${esc(nice(f.name))}</span><select id="${fid}" data-bind="${esc(bind)}">${f.levels.map((l) => `<option value="${esc(l)}"${l === v ? " selected" : ""}>${esc(nice(l))}</option>`).join("")}</select></label>`;
    }
    const step = f.type === "integer" ? 1 : "any";
    return `<label class="field"><span>${esc(nice(f.name))}<span class="faint">${esc(unitOf(f))}</span></span><input type="number" id="${fid}" step="${step}" min="${f.low}" max="${f.high}" data-bind="${esc(bind)}" value="${esc(v === undefined ? "" : f.type === "integer" ? Math.round(v) : +Number(v).toFixed(4))}"></label>`;
  }

  function sessionView(p, planned) {
    const order = planned.slice().sort((a, b) => (a.taste || 0) - (b.taste || 0));
    const sessionNo = planned[0].session;
    const allSession = p.runs.filter((r) => r.session === sessionNo && r.status !== "rejected");
    return `
      <section class="panel stack">
        <div class="panel-head"><h2>Session ${sessionNo}: tasting order</h2>
          <button class="btn small danger" data-act="cancel-session">Cancel session</button>
          <p class="muted">Label each sample with its code only, then taste in this order.</p></div>
        <div class="tickets">${order.map((r, i) => `${i ? `<span class="arrow" aria-hidden="true">→</span>` : ""}<span class="ticket"><small>${i + 1}${["st", "nd", "rd"][i] || "th"}</small>${esc(r.code)}</span>`).join("")}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>Cooking sheet</h3><span class="muted small">${allSession.length} recipes</span></div>
        <div class="grid grid-3">${allSession.slice().sort((a, b) => a.id.localeCompare(b.id)).map((r) => `
          <article class="recipe-card">
            <header><span class="code">${esc(r.code)}</span><span class="faint small mono">${esc(r.id)}</span><span class="spacer"></span><span class="chip ${esc(r.phase)}">${esc(PHASE_LABEL[r.phase] || r.phase)}</span>${r.status === "done" ? `<span class="chip done">recorded</span>` : ""}</header>
            ${factorRows(p, r.x)}
          </article>`).join("")}</div>
      </section>
      <details class="panel" ${store.get("bc:protocol-open", true) ? "open" : ""} data-remember="bc:protocol-open">
        <summary><h3>Before and during tasting</h3></summary>
        ${tipsHtml(p)}
        ${protocolHtml()}
      </details>
      <section class="panel stack">
        <div class="panel-head"><h3>Record results</h3><p class="muted">Score each code right after tasting it. Blank values are skipped.</p></div>
        <div class="grid grid-2">${order.map((r) => resultCard(p, r)).join("")}</div>
      </section>`;
  }

  function resultCard(p, r) {
    const d = state.drafts[r.id] || {};
    return `<article class="result-card">
      <div class="row"><span class="ticket" style="font-size:1.1rem">${esc(r.code)}</span><span class="spacer"></span><span class="faint mono small">${esc(r.id)}</span></div>
      ${p.outputs.map((o) => outputInput(o, d[o.name], r.id)).join("")}
      <label class="field"><span>Notes</span><input type="text" id="note-${esc(r.id)}" data-bind="draftnote:${esc(r.id)}" value="${esc(d.__notes || "")}" placeholder="Anything unusual?"></label>
      <div class="row end"><button class="btn small ghost" data-act="not-made" data-id="${esc(r.id)}">Wasn't made</button><button class="btn small primary" data-act="save-result" data-id="${esc(r.id)}">Save ${esc(r.code)}</button></div>
    </article>`;
  }

  function isScale(o) {
    const lo = Number(o.low), hi = Number(o.high);
    return valid(o.low) && valid(o.high) && Number.isInteger(lo) && Number.isInteger(hi) && hi - lo <= 10 && hi > lo;
  }

  function outputInput(o, v, runId) {
    const goal = o.goal === "target" ? `target ${o.target}` : o.goal;
    const head = `<span>${esc(nice(o.name))} <span class="faint">(${esc(o.unit || "value")}, ${esc(goal)})</span></span>`;
    const help = o.how ? `<span class="help">${esc(o.how)}</span>` : "";
    if (isScale(o)) {
      const vals = []; for (let k = Number(o.low); k <= Number(o.high); k++) vals.push(k);
      return `<div class="field">${head}<div class="seg" role="group" aria-label="${esc(nice(o.name))}">${vals.map((k) => `<button type="button" data-act="scale" data-id="${esc(runId)}" data-o="${esc(o.name)}" data-v="${k}" aria-pressed="${String(v) === String(k)}">${k}</button>`).join("")}</div>${help}</div>`;
    }
    return `<label class="field">${head}<input type="number" step="any" id="out-${esc(runId)}-${esc(o.name)}" data-bind="draft:${esc(runId)}:${esc(o.name)}" value="${esc(v === undefined ? "" : v)}">${help}</label>`;
  }

  function tipsHtml(p) {
    const tips = (p.tips || []).filter(Boolean);
    if (!tips.length) return "";
    return `<div class="tips"><h4>For ${esc(p.name)}</h4><ul>${tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`;
  }

  function protocolHtml() {
    return `<div class="checklist">${BC.PROTOCOL.map((sec) => `<div><h4>${esc(sec.when)}</h4><ul>${sec.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`).join("")}</div>`;
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
        id: nextId(), session: sessionNo, status: "planned", phase: q.decision === "edit" ? "manual" : q.phase, code, taste: order[k] + 1,
        x: coerceRun(p, q.x), y: {}, notes: "", why: q.why, predictions: q.predictions || null, created: nowIso(),
      });
    });
    for (const q of state.proposals.filter((q) => q.decision === "reject")) {
      p.runs.push({ id: nextId(), session: sessionNo, status: "rejected", phase: q.phase, code: "", x: coerceRun(p, q.x), y: {}, notes: q.reason || "", why: q.why, created: nowIso() });
    }
    p.sessions = sessionNo;
    p.touched = true;
    state.proposals = null;
    save(p, { immediate: true });
    render();
    toast(`Session ${sessionNo} is ready. Cook, then taste in the printed order.`);
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
    if (!Object.keys(y).length) { toast("Enter at least one result first."); return; }
    r.y = { ...r.y, ...y };
    if (d.__notes) r.notes = d.__notes;
    r.status = "done";
    r.recorded = nowIso();
    delete state.drafts[id];
    p.touched = true;
    save(p);
    const left = p.runs.filter((q) => q.status === "planned").length;
    render();
    toast(left ? `Saved ${r.code}. ${left} to go.` : "Session complete. Plan the next one whenever you're ready.");
  }

  // ================================================================ logbook

  function logbookView(p) {
    const s = settings(p);
    const rg = BC.ranges(p);
    const runs = p.runs.filter((r) => state.logFilter === "all" || r.status === state.logFilter);
    const counts = { all: p.runs.length, done: 0, planned: 0, rejected: 0 };
    p.runs.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    const sel = p.runs.find((r) => r.id === state.selectedRun);
    return `
      <section class="panel stack">
        <div class="panel-head"><h2>Logbook</h2>
          <div class="row"><button class="btn small" data-act="export-csv">Export CSV</button><button class="btn small" data-act="export-json">Export experiment</button>
          <label class="btn small" for="import-file">Import experiment</label><input type="file" id="import-file" accept=".json,application/json" hidden></div>
          <p class="muted">Every run you've planned, cooked or rejected. Select a row to correct results or notes.</p></div>
        <div class="seg" role="group" aria-label="Filter runs">${["all", "done", "planned", "rejected"].map((f) => `<button type="button" data-act="logfilter" data-f="${f}" aria-pressed="${state.logFilter === f}">${f} <span class="faint">${counts[f] || 0}</span></button>`).join("")}</div>
        <div class="table-wrap"><table>
          <thead><tr><th>Run</th><th>Session</th><th>Status</th><th>Type</th><th>Code</th>${p.factors.map((f) => `<th>${esc(nice(f.name))}</th>`).join("")}${p.outputs.map((o) => `<th>${esc(nice(o.name))}</th>`).join("")}<th>Score</th><th>Notes</th></tr></thead>
          <tbody>${runs.length ? runs.map((r) => {
            const sc = r.status === "done" ? BC.runScore(p, r, s, rg) : null;
            return `<tr data-act="select-run" data-id="${esc(r.id)}" class="${r.id === state.selectedRun ? "sel" : ""}" style="cursor:pointer">
              <td class="mono">${esc(r.id)}</td><td class="n">${r.session || ""}</td><td><span class="chip ${esc(r.status)}">${esc(r.status)}</span></td>
              <td><span class="chip ${esc(r.phase)}">${esc(PHASE_LABEL[r.phase] || r.phase)}</span></td><td class="mono">${esc(r.code || "")}</td>
              ${p.factors.map((f) => `<td class="${f.type === "categorical" ? "" : "n"}">${esc(r.x[f.name] === undefined ? "–" : fmtVal(f, r.x[f.name]))}</td>`).join("")}
              ${p.outputs.map((o) => `<td class="n">${fmtNum(r.y && r.y[o.name])}</td>`).join("")}
              <td class="n">${sc === null ? "–" : sc.toFixed(2)}</td><td style="white-space:normal;min-width:160px">${esc(r.notes || "")}</td></tr>`;
          }).join("") : `<tr><td colspan="${7 + p.factors.length + p.outputs.length}" class="muted">No runs here yet.</td></tr>`}</tbody>
        </table></div>
      </section>
      ${sel ? runEditor(p, sel) : ""}`;
  }

  function runEditor(p, r) {
    return `<section class="panel stack">
      <div class="panel-head"><h3>Edit ${esc(r.id)}${r.code ? ` · code ${esc(r.code)}` : ""}</h3><button class="btn small ghost" data-act="close-run">Close</button>
        ${r.why ? `<p class="muted small">${esc(r.why)}</p>` : ""}</div>
      <div class="grid grid-3">
        ${p.outputs.map((o) => `<label class="field"><span>${esc(nice(o.name))} <span class="faint">(${esc(o.unit || "value")})</span></span><input type="number" step="any" id="edit-${esc(o.name)}" data-edit="y:${esc(o.name)}" value="${esc(r.y && valid(r.y[o.name]) ? r.y[o.name] : "")}"></label>`).join("")}
        <label class="field"><span>Status</span><select id="edit-status" data-edit="status">${["planned", "done", "rejected"].map((st) => `<option${st === r.status ? " selected" : ""}>${st}</option>`).join("")}</select></label>
      </div>
      <label class="field"><span>Notes</span><textarea id="edit-notes" data-edit="notes">${esc(r.notes || "")}</textarea></label>
      <div class="row end"><button class="btn small danger" data-act="delete-run" data-id="${esc(r.id)}">Delete run</button><button class="btn small primary" data-act="save-run" data-id="${esc(r.id)}">Save changes</button></div>
    </section>`;
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
    openModal(`<h3>Copy your data</h3><p class="muted small">Saving files isn't available here. Copy this text into a file named <span class="mono">${esc(filename)}</span>.</p>
      <textarea id="copy-area" rows="10" readonly>${esc(data)}</textarea>
      <div class="row end"><button class="btn" data-act="close-modal">Close</button><button class="btn primary" data-act="copy-area">Copy</button></div>`);
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
    }
    cache.key = key; cache.value = v;
    return v;
  }

  function insightsView(p) {
    const s = settings(p);
    const v = analyticsFor(p);
    const I = state.insights;
    const numF = p.factors;
    if (!I.sx || !p.factors.some((f) => f.name === I.sx)) I.sx = numF[0] && numF[0].name;
    if (!I.sy || !p.factors.some((f) => f.name === I.sy) || I.sy === I.sx) I.sy = (numF.find((f) => f.name !== I.sx) || {}).name;
    if (!I.diagOut || !p.outputs.some((o) => o.name === I.diagOut)) I.diagOut = p.outputs[0] && p.outputs[0].name;
    if (!I.pa || !p.outputs.some((o) => o.name === I.pa)) I.pa = p.outputs[0] && p.outputs[0].name;
    if (!I.pb || !p.outputs.some((o) => o.name === I.pb) || I.pb === I.pa) I.pb = (p.outputs.find((o) => o.name !== I.pa) || {}).name;

    const scores = v.progress.map((r) => r.score).filter((x) => x !== null);
    const bestIdx = scores.length ? v.progress.reduce((bi, r, i) => (r.score !== null && (bi < 0 || r.score > v.progress[bi].score) ? i : bi), -1) : -1;
    const liking = v.diag && v.diag[0];
    const repOut = p.outputs.find((o) => v.reps.pooled[o.name]);
    const targetOpts = [["__score", "Overall score"], ...p.outputs.map((o) => [o.name, nice(o.name)])];
    const sel = (id, bind, val, opts) => `<select id="${id}" data-ins="${bind}">${opts.map(([k, l]) => `<option value="${esc(k)}"${k === val ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const fOpts = p.factors.map((f) => [f.name, nice(f.name)]);
    const oOpts = p.outputs.map((o) => [o.name, nice(o.name)]);

    const kpis = `<div class="kpis">
      <div class="kpi"><span class="label">Results</span><span class="v">${v.done.length}</span><span class="s">${p.sessions} sessions · ${p.runs.filter((r) => r.status === "rejected").length} rejected</span></div>
      <div class="kpi"><span class="label">Best score</span><span class="v">${bestIdx >= 0 ? v.progress[bestIdx].score.toFixed(2) : "–"}</span><span class="s">${bestIdx >= 0 ? `run ${esc(v.progress[bestIdx].id)} · 1.00 = every output ideal` : "no results yet"}</span></div>
      <div class="kpi"><span class="label">Model fit</span><span class="v">${liking && isFinite(liking.r2) ? liking.r2.toFixed(2) : "–"}</span><span class="s">${liking ? `leave-one-out R² for ${esc(nice(liking.output))}` : "needs 3+ results"}</span></div>
      <div class="kpi"><span class="label">Palate noise</span><span class="v">${repOut ? "±" + fmtNum(v.reps.pooled[repOut.name].sd) : liking ? "±" + fmtNum(liking.noise) : "–"}</span><span class="s">${repOut ? `from repeated recipes (${esc(nice(repOut.name))})` : liking ? `model estimate for ${esc(nice(liking.output))}` : "repeat a recipe to measure it"}</span></div>
      <div class="kpi"><span class="label">Design spread</span><span class="v">${v.dq && v.dq.worstGap !== null ? pct(1 - v.dq.worstGap) : "–"}</span><span class="s">${v.dq && v.dq.worstGapFactor ? `worst coverage: ${esc(nice(v.dq.worstGapFactor))}` : "coverage of your ranges"}</span></div>
    </div>`;

    if (v.done.length < 3) {
      return `${kpis}<div class="notice info">Record at least 3 results and the model, importance, response surfaces and diagnostics will appear here.</div>
        <section class="panel"><div class="panel-head"><h3>Progress</h3></div><div class="chart" id="ch-progress"></div></section>
        ${designPanel(p, v)}`;
    }

    return `${kpis}
      <section class="panel"><div class="panel-head"><h3>Progress</h3><p class="muted small">Each dot is one recorded run's overall score. The line is the best so far.</p></div><div class="chart" id="ch-progress"></div></section>
      <div class="grid grid-2">
        <section class="panel"><div class="panel-head"><h3>What matters</h3><div class="chart-controls"><label class="field"><span>For</span>${sel("ins-target", "target", v.target, targetOpts)}</label></div>
          <p class="muted small">How much the predicted ${v.target === "__score" ? "overall score" : esc(nice(v.target))} changes as each factor sweeps its range (variance share of the main effect).</p></div>
          <div class="chart" id="ch-importance"></div></section>
        <section class="panel"><div class="panel-head"><h3>Response surface</h3>
          <div class="chart-controls"><label class="field"><span>Across</span>${sel("ins-sx", "sx", I.sx, fOpts)}</label><label class="field"><span>Up</span>${sel("ins-sy", "sy", I.sy, fOpts.filter(([k]) => k !== I.sx))}</label>
          <label class="field"><span>Show</span>${sel("ins-sz", "sz", I.sz, [["mean", "Prediction"], ["sd", "Uncertainty"]])}</label></div>
          <p class="muted small">${v.target === "__score" ? "Overall score" : esc(nice(v.target))}; other factors held at your best run. Dots are recorded runs.${I.sz === "sd" && v.target === "__score" ? " Uncertainty is shown per output; pick one under “For”." : ""}</p></div>
          <div class="chart tall" id="ch-surface"></div></section>
      </div>
      <section class="panel"><div class="panel-head"><h3>Main effects</h3><p class="muted small">Average prediction as one factor changes and the others vary. Shaded band: ±1 sd of the model's uncertainty.</p></div>
        <div class="small-multiples">${p.factors.map((f, i) => `<div><div class="label">${esc(nice(f.name))}</div><div class="chart" id="ch-me-${i}"></div></div>`).join("")}</div></section>
      <div class="grid grid-2">
        <section class="panel"><div class="panel-head"><h3>Model check</h3><div class="chart-controls"><label class="field"><span>Output</span>${sel("ins-diag", "diagOut", I.diagOut, oOpts)}</label></div>
          <p class="muted small">Each run predicted by a model that never saw it (leave-one-out). Points near the diagonal mean the model generalises.</p></div>
          ${diagStats(v, I.diagOut)}
          <div class="chart" id="ch-loo"></div></section>
        <section class="panel"><div class="panel-head"><h3>Standardised errors</h3><p class="muted small">If the model's uncertainty is honest, these look like a bell curve centred on 0, with about 95% between −2 and 2.</p></div>
          <div class="chart" id="ch-resid"></div></section>
      </div>
      <div class="grid grid-2">
        <section class="panel"><div class="panel-head"><h3>Map of your runs</h3><p class="muted small">Principal components of the factor settings; colour is overall score. Hollow dots were rejected or not yet tasted.</p></div>
          <div class="chart" id="ch-pca"></div></section>
        <section class="panel"><div class="panel-head"><h3>Variance by component</h3><p class="muted small">Share of the spread in your settings along each principal component.${v.s.pca.enabled ? " The dashed line marks where the model's input PCA truncates." : " Input PCA is off (Knobs → Features)."}</p></div>
          <div class="chart" id="ch-scree"></div></section>
      </div>
      <section class="panel"><div class="panel-head"><h3>All runs at once</h3><p class="muted small">Parallel coordinates. Drag along any axis to filter; colour is overall score.</p></div><div class="chart tall" id="ch-parcoords"></div></section>
      <div class="grid grid-2">
        <section class="panel"><div class="panel-head"><h3>Correlations</h3><p class="muted small">Pearson correlation across recorded runs. With few runs, treat anything under ±0.5 as noise.</p></div><div class="chart tall" id="ch-corr"></div></section>
        <section class="panel"><div class="panel-head"><h3>Trade-offs</h3>${p.outputs.length > 1 ? `<div class="chart-controls"><label class="field"><span>Across</span>${sel("ins-pa", "pa", I.pa, oOpts)}</label><label class="field"><span>Up</span>${sel("ins-pb", "pb", I.pb, oOpts.filter(([k]) => k !== I.pa))}</label></div>` : ""}
          <p class="muted small">Highlighted runs can't be improved on one output without losing on the other (the Pareto front).</p></div>
          ${p.outputs.length > 1 ? `<div class="chart tall" id="ch-pareto"></div>` : `<p class="muted">Add a second output to see trade-offs.</p>`}</section>
      </div>
      ${modelTables(p, v)}
      ${designPanel(p, v)}`;
  }

  function diagStats(v, out) {
    const d = v.diag && v.diag.find((x) => x.output === out);
    if (!d) return `<p class="muted small">No results for this output yet.</p>`;
    return `<div class="stats"><span>R² <b>${isFinite(d.r2) ? d.r2.toFixed(2) : "–"}</b></span><span>RMSE <b>${fmtNum(d.rmse)}</b></span><span>Inside 95% band <b>${pct(d.coverage)}</b></span><span>Noise <b>±${fmtNum(d.noise)}</b></span></div>`;
  }

  function modelTables(p, v) {
    const rows = (v.diag || []).map((d) => {
      const hs = d.info.hypers.map((h) => `${esc(h.name)} <span class="num">${fmtNum(h.value)}</span>`).join(" · ");
      return `<tr><td>${esc(nice(d.output))}</td><td>${esc(d.info.model)}${d.info.kernel ? ` · ${esc(d.info.kernel)}${d.info.ard ? " ARD" : ""}` : ""}${d.info.degree ? ` · degree ${d.info.degree}` : ""}</td><td class="n">${d.info.n}</td><td class="n">${d.info.logML !== undefined ? d.info.logML.toFixed(1) : "–"}</td><td style="white-space:normal">${hs}${d.info.fitted ? "" : ` <span class="chip">prior values</span>`}</td></tr>`;
    }).join("");
    return `<section class="panel"><div class="panel-head"><h3>Fitted models</h3><p class="muted small">Hyperparameters per output. Lengthscales are on the 0–1 scale of each factor's range: short means the output changes quickly with that factor.</p></div>
      <div class="table-wrap"><table><thead><tr><th>Output</th><th>Model</th><th>Results</th><th>Log marginal likelihood</th><th>Hyperparameters</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  function designPanel(p, v) {
    const row = (label, q) => q ? `<tr><td>${label}</td><td class="n">${fmtNum(q.minDistance)}</td><td class="n">${q.worstGap === null ? "–" : fmtNum(q.worstGap)}</td><td>${q.worstGapFactor ? esc(nice(q.worstGapFactor)) : "–"}</td><td class="n">${q.maxCorr === null ? "–" : fmtNum(q.maxCorr, 2)}</td><td>${q.maxCorrPair ? esc(q.maxCorrPair.map(nice).join(" & ")) : "–"}</td></tr>` : "";
    const reps = v.reps.groups.length ? v.reps.groups.map((g) => g.join(", ")).join("; ") : "none yet";
    return `<section class="panel"><div class="panel-head"><h3>Design quality</h3><p class="muted small">Closest pair distance (higher is better), largest uncovered stretch of any continuous factor as a share of its range (lower is better), and the strongest correlation between two factors (lower is better; high values make their effects hard to separate).</p></div>
      <div class="table-wrap"><table><thead><tr><th>Runs</th><th>Closest pair</th><th>Worst gap</th><th>In factor</th><th>Max |r|</th><th>Between</th></tr></thead><tbody>
      ${row("Initial design", v.dq)}${row("All runs", v.dqAll)}</tbody></table></div>
      <p class="small muted" style="margin-top:10px">Repeated recipes: ${esc(reps)}.</p></section>`;
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

    // Progress
    const groups = ["doe", "bo", "other"];
    const pts = v.progress.filter((r) => r.score !== null);
    const data = groups.map((g) => {
      const rs = pts.filter((r) => (g === "other" ? r.phase !== "doe" && r.phase !== "bo" : r.phase === g));
      return { type: "scatter", mode: "markers", name: PHASE_GROUP(g === "other" ? "x" : g), x: rs.map((r) => r.i), y: rs.map((r) => r.score), text: rs.map((r) => r.id),
        marker: { size: 10, color: tok(PHASE_SERIES(g === "other" ? "x" : g)), line: { color: surface, width: 2 } }, hovertemplate: "%{text}<br>score %{y:.2f}<extra>%{fullData.name}</extra>" };
    }).filter((t) => t.x.length);
    data.push({ type: "scatter", mode: "lines", name: "Best so far", x: v.progress.map((r) => r.i), y: v.progress.map((r) => r.best), line: { color: ink2, width: 2, shape: "hv" }, hovertemplate: "best %{y:.2f}<extra></extra>" });
    plot("ch-progress", data, layout({ showlegend: true, legend: { orientation: "h", y: 1.12, x: 0, font: { size: 12 } }, margin: { l: 52, r: 16, t: 30, b: 44 },
      xaxis: axis("Recorded run", { dtick: v.progress.length > 20 ? 5 : 1 }), yaxis: axis("Overall score", { range: [0, 1.05] }) }));

    if (!v.fitted) return;

    // Importance
    const eff = v.effects.slice().sort((a, b) => a.importance - b.importance);
    plot("ch-importance", [{ type: "bar", orientation: "h", y: eff.map((e) => nice(e.factor)), x: eff.map((e) => e.importance), marker: { color: tok("--marmalade") },
      text: eff.map((e) => pct(e.importance)), textposition: "outside", cliponaxis: false, textfont: { color: ink2 }, hovertemplate: "%{y}: %{x:.0%}<extra></extra>" }],
      layout({ margin: { l: 110, r: 40, t: 8, b: 36 }, xaxis: axis("Share of explained variation", { tickformat: ".0%", range: [0, Math.max(...eff.map((e) => e.importance)) * 1.25 || 1] }), yaxis: axis("", { automargin: true }) }));

    // Main effects (shared y range)
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
        tr.push({ type: "scatter", mode: "lines", x: xs, y: e.curve.map((c) => c.mean), line: { color: tok("--marmalade"), width: 2.5 }, hovertemplate: `%{x:.3g}${esc(unitOf(f))}: %{y:.2f}<extra></extra>` });
      }
      plot(`ch-me-${i}`, tr, layout({ margin: { l: 40, r: 8, t: 6, b: 32 }, xaxis: axis(f.unit || ""), yaxis: axis(i === 0 ? ylab : "", { range: [yr[0] - pad, yr[1] + pad] }) }));
    });

    // Surface
    const s = v.s;
    const done = v.done;
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

    // LOO
    const d = v.diag.find((x) => x.output === I.diagOut);
    if (d) {
      const lo = Math.min(...d.obs, ...d.lo), hi = Math.max(...d.obs, ...d.hi);
      plot("ch-loo", [
        { type: "scatter", mode: "lines", x: [lo, hi], y: [lo, hi], line: { color: ink3, dash: "dot", width: 1.5 }, hoverinfo: "skip" },
        { type: "scatter", mode: "markers", x: d.obs, y: d.pred, text: d.ids, error_y: { type: "data", symmetric: false, array: d.hi.map((h, i) => h - d.pred[i]), arrayminus: d.pred.map((m, i) => m - d.lo[i]), color: alpha(tok("--marmalade"), 0.45), thickness: 1.5, width: 0 },
          marker: { size: 9, color: tok("--marmalade"), line: { color: surface, width: 2 } }, hovertemplate: "%{text}<br>measured %{x:.3g}<br>predicted %{y:.3g}<extra></extra>" },
      ], layout({ xaxis: axis(`Measured ${nice(d.output)}`), yaxis: axis("Predicted without that run") }));
      plot("ch-resid", [{ type: "histogram", x: d.zres, xbins: { start: -4, end: 4, size: 0.5 }, marker: { color: tok("--honey"), line: { color: surface, width: 2 } }, hovertemplate: "%{x}: %{y} runs<extra></extra>" }],
        layout({ xaxis: axis("Error ÷ predicted uncertainty", { range: [-4, 4], dtick: 1 }), yaxis: axis("Runs"), bargap: 0.04,
          shapes: [-2, 2].map((x0) => ({ type: "line", x0, x1: x0, yref: "paper", y0: 0, y1: 1, line: { color: ink3, dash: "dot", width: 1 } })) }));
    }

    // PCA
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
      plot("ch-scree", [{ type: "bar", x: labels, y: v.pca.ratio, marker: { color: v.pca.ratio.map((_, i) => (v.pca.keep && i < v.pca.keep ? tok("--marmalade") : tok("--honey"))) },
        text: v.pca.ratio.map((r) => { cum += r; return pct(cum); }), textposition: "outside", cliponaxis: false, textfont: { size: 10, color: ink3 }, hovertemplate: "%{x}: %{y:.0%} (cumulative %{text})<extra></extra>" }],
        layout({ margin: { l: 52, r: 16, t: 18, b: 44 }, xaxis: axis("Component"), yaxis: axis("Share of variance", { tickformat: ".0%" }), bargap: 0.25,
          shapes: v.pca.keep ? [{ type: "line", x0: v.pca.keep - 0.5, x1: v.pca.keep - 0.5, yref: "paper", y0: 0, y1: 1, line: { color: ink2, dash: "dash", width: 1.5 } }] : [] }));
    }

    // Parallel coordinates
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

    // Correlations
    const c = v.corr;
    plot("ch-corr", [{ type: "heatmap", x: c.names.map(nice), y: c.names.map(nice), z: c.matrix, zmin: -1, zmax: 1, colorscale: divScale(),
      text: c.matrix.map((r) => r.map((x) => (isFinite(x) ? x.toFixed(2) : ""))), texttemplate: "%{text}", textfont: { size: 10, color: tok("--ink") },
      colorbar: { thickness: 10, outlinewidth: 0, tickfont: { color: ink3, size: 10 } }, hovertemplate: "%{y} vs %{x}: %{z:.2f}<extra></extra>", xgap: 2, ygap: 2 }],
      layout({ margin: { l: 110, r: 16, t: 8, b: 100 }, xaxis: axis("", { tickangle: -40 }), yaxis: axis("", { autorange: "reversed" }) }));

    // Pareto
    if (I.pa && I.pb && p.outputs.length > 1) {
      const pr = BC.pareto(p, I.pa, I.pb);
      const oa = p.outputs.find((o) => o.name === I.pa), ob = p.outputs.find((o) => o.name === I.pb);
      const arrow = (o) => (o.goal === "maximize" ? " (higher is better)" : o.goal === "minimize" ? " (lower is better)" : ` (target ${o.target})`);
      const frontIds = new Set(pr.front.map((q) => q.id));
      const rest = pr.points.filter((q) => !frontIds.has(q.id));
      plot("ch-pareto", [
        { type: "scatter", mode: "markers", x: rest.map((q) => q.a), y: rest.map((q) => q.b), text: rest.map((q) => q.id), marker: { size: 9, color: ink3, opacity: 0.6, line: { color: surface, width: 2 } }, hovertemplate: "%{text}<extra></extra>" },
        { type: "scatter", mode: "lines+markers+text", x: pr.front.map((q) => q.a), y: pr.front.map((q) => q.b), text: pr.front.map((q) => q.id), textposition: "top center", textfont: { size: 10, color: ink2 },
          line: { color: tok("--marmalade"), width: 2, shape: "hv" }, marker: { size: 11, color: tok("--marmalade"), line: { color: surface, width: 2 } }, hovertemplate: "%{text} (on the front)<extra></extra>" },
      ], layout({ xaxis: axis(`${nice(I.pa)}${arrow(oa)}`), yaxis: axis(`${nice(I.pb)}${arrow(ob)}`) }));
    }
  }

  // ================================================================= pantry

  function pantryView(p) {
    const errs = BC.checkProject(p);
    const groups = [...new Set(p.factors.filter((f) => f.type === "component").map((f) => f.group).filter(Boolean))];
    const libOpts = Object.entries(BC.OUTPUT_LIBRARY).filter(([k]) => !p.outputs.some((o) => o.name === k));
    return `
      <section class="panel stack">
        <div class="panel-head"><h2>Pantry</h2><p class="muted">What you vary (factors), what you measure (outputs), and your current recipe.</p></div>
        <label class="field" style="max-width:420px"><span>Experiment name</span><input type="text" id="p-name" data-p="name" value="${esc(p.name)}"></label>
        ${errs.length ? `<div class="notice bad">Needs fixing:<ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : `<div class="notice info">Setup looks good.${p.runs.length ? " Changing ranges after you've cooked is fine; the model uses the new ranges." : ""}</div>`}
      </section>
      <section class="panel stack">
        <div class="panel-head"><h3>Factors</h3><div class="row"><button class="btn small" data-act="add-factor" data-type="continuous">+ Number</button><button class="btn small" data-act="add-factor" data-type="categorical">+ Choice</button><button class="btn small" data-act="add-factor" data-type="component">+ Blend part</button></div>
          <p class="muted small">Numbers take a low–high range; choices take options separated by commas; blend parts share a blend name and always add up to its total (for example flours adding to 100%). Log scale suits ratios, where doubling matters more than adding.</p></div>
        <div class="table-wrap"><table class="editor-table"><thead><tr><th>Name</th><th>Type</th><th>Kind</th><th>Low</th><th>High</th><th>Unit</th><th>Log</th><th>Options / blend</th><th></th></tr></thead><tbody>
        ${p.factors.map((f, i) => `<tr>
          <td><input type="text" id="f-name-${i}" data-f="${i}:name" value="${esc(f.name)}"></td>
          <td><select id="f-type-${i}" data-f="${i}:type">${[["continuous", "number"], ["integer", "whole number"], ["categorical", "choice"], ["component", "blend part"]].map(([k, l]) => `<option value="${k}"${f.type === k ? " selected" : ""}>${l}</option>`).join("")}</select></td>
          <td><select id="f-kind-${i}" data-f="${i}:kind">${["composition", "process", "other"].map((k) => `<option${(f.kind || "other") === k ? " selected" : ""}>${k}</option>`).join("")}</select></td>
          <td><input type="number" step="any" id="f-low-${i}" data-f="${i}:low" value="${f.type === "categorical" ? "" : esc(f.low)}" ${f.type === "categorical" ? "disabled" : ""}></td>
          <td><input type="number" step="any" id="f-high-${i}" data-f="${i}:high" value="${f.type === "categorical" ? "" : esc(f.high)}" ${f.type === "categorical" ? "disabled" : ""}></td>
          <td><input type="text" id="f-unit-${i}" data-f="${i}:unit" value="${esc(f.unit || "")}"></td>
          <td><input type="checkbox" id="f-log-${i}" data-f="${i}:log" ${f.log ? "checked" : ""} ${f.type === "categorical" ? "disabled" : ""} aria-label="Log scale for ${esc(f.name)}"></td>
          <td>${f.type === "categorical" ? `<input type="text" id="f-levels-${i}" data-f="${i}:levels" value="${esc((f.levels || []).join(", "))}" placeholder="butter, ghee">`
            : f.type === "component" ? `<input type="text" id="f-group-${i}" data-f="${i}:group" value="${esc(f.group || "")}" placeholder="blend name, e.g. flour">` : `<span class="faint small">–</span>`}</td>
          <td><button class="btn small ghost" data-act="del-factor" data-i="${i}" aria-label="Remove ${esc(f.name)}">✕</button></td></tr>`).join("")}
        </tbody></table></div>
        ${groups.length ? `<div class="row">${groups.map((g) => { const b = (p.batchAmounts || {})[g] || {}; return `<label class="field"><span>Blend “${esc(g)}” adds up to</span><input type="number" step="any" id="mix-${esc(g)}" data-mix="${esc(g)}" value="${esc(p.mixtures[g] ?? 100)}"></label>
          <label class="field"><span>One sample of “${esc(g)}” is</span><input type="number" step="any" id="batch-amt-${esc(g)}" data-batch="${esc(g)}:amount" value="${esc(b.amount ?? "")}" placeholder="e.g. 90"></label>
          <label class="field"><span>in</span><input type="text" id="batch-unit-${esc(g)}" data-batch="${esc(g)}:unit" value="${esc(b.unit ?? "")}" placeholder="ml, g"></label>`; }).join("")}</div>
          <p class="help small faint">Set a sample size to see real amounts on the cooking sheet.</p>` : ""}
      </section>
      <section class="panel stack">
        <div class="panel-head"><h3>Your current recipe</h3>
          <label class="row small"><input type="checkbox" id="baseline-on" data-act="toggle-baseline" ${p.baseline ? "checked" : ""}> Cook it first as the reference</label>
          <p class="muted small">Optional. It's the first run of the initial design and a fair comparison for everything after.</p></div>
        ${p.baseline ? `<div class="grid grid-3">${p.factors.map((f) => factorInput(f, p.baseline[f.name], `base:${f.name}`)).join("")}</div>
          ${BC.checkRun(p, p.baseline).length ? `<div class="notice bad small">${BC.checkRun(p, p.baseline).map(esc).join(" ")}</div>` : ""}` : ""}
      </section>
      <section class="panel stack">
        <div class="panel-head"><h3>Outputs</h3>
          <div class="row"><select id="lib-pick" aria-label="Suggested output"><option value="">Add a suggested output…</option>${["Sensory", "Physical", "Practical"].map((cat) => `<optgroup label="${cat}">${libOpts.filter(([, o]) => o.category === cat).map(([k]) => `<option value="${k}">${esc(nice(k))}</option>`).join("")}</optgroup>`).join("")}</select>
          <button class="btn small" data-act="add-lib-output">Add</button><button class="btn small" data-act="add-output">+ Custom</button></div>
          <p class="muted small">Maximise, minimise, or hit a target. Low and high set the range used to score results; weight sets how much each output counts in the overall score.</p></div>
        <div class="table-wrap"><table class="editor-table"><thead><tr><th>Name</th><th>Goal</th><th>Target</th><th>Low</th><th>High</th><th>Weight</th><th>Unit</th><th>How to measure</th><th></th></tr></thead><tbody>
        ${p.outputs.map((o, i) => `<tr>
          <td><input type="text" id="o-name-${i}" data-o="${i}:name" value="${esc(o.name)}"></td>
          <td><select id="o-goal-${i}" data-o="${i}:goal">${["maximize", "minimize", "target"].map((g) => `<option${o.goal === g ? " selected" : ""}>${g}</option>`).join("")}</select></td>
          <td><input type="number" step="any" id="o-target-${i}" data-o="${i}:target" value="${esc(o.target ?? "")}" ${o.goal === "target" ? "" : "disabled"}></td>
          <td><input type="number" step="any" id="o-low-${i}" data-o="${i}:low" value="${esc(o.low ?? "")}"></td>
          <td><input type="number" step="any" id="o-high-${i}" data-o="${i}:high" value="${esc(o.high ?? "")}"></td>
          <td><input type="number" step="any" min="0" id="o-weight-${i}" data-o="${i}:weight" value="${esc(o.weight ?? 1)}"></td>
          <td><input type="text" id="o-unit-${i}" data-o="${i}:unit" value="${esc(o.unit || "")}"></td>
          <td style="min-width:240px"><input type="text" id="o-how-${i}" data-o="${i}:how" value="${esc(o.how || "")}"></td>
          <td><button class="btn small ghost" data-act="del-output" data-i="${i}" aria-label="Remove ${esc(o.name)}">✕</button></td></tr>`).join("")}
        </tbody></table></div>
      </section>
      <section class="panel stack">
        <div class="panel-head"><h3>Recipe notes</h3><p class="muted small">Shown with the tasting checklist every session. One note per line.</p></div>
        <textarea id="p-tips" data-p="tips" rows="4" placeholder="e.g. Chill every sample to fridge temperature before tasting.">${esc((p.tips || []).join("\n"))}</textarea>
      </section>
      <section class="panel stack">
        <div class="panel-head"><h3>Manage</h3></div>
        <div class="row"><button class="btn small" data-act="duplicate">Copy setup to a new experiment</button><span class="spacer"></span><button class="btn small danger" data-act="delete-project">Delete this experiment</button></div>
      </section>`;
  }

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

  // ================================================================== knobs

  function knobsView(p) {
    const s = settings(p);
    const warn = BC.adviseSettings(p, s);
    const n = BC.doneRuns(p).length;
    const sel = (path, val, opts, id) => `<select id="${id || "k-" + path.replace(/\./g, "-")}" data-k="${path}" data-t="str">${opts.map(([k, l]) => `<option value="${esc(k)}"${String(val) === String(k) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const num = (path, val, attrs = "", t = "num") => `<input type="number" step="any" id="k-${path.replace(/\./g, "-")}" data-k="${path}" data-t="${t}" value="${esc(val === null || val === undefined ? "" : val)}" ${attrs}>`;
    const chk = (path, val) => `<input type="checkbox" id="k-${path.replace(/\./g, "-")}" data-k="${path}" data-t="bool" ${val ? "checked" : ""}>`;
    const slide = (path, val, min, max, step) => `<input type="range" id="k-${path.replace(/\./g, "-")}" data-k="${path}" data-t="num" min="${min}" max="${max}" step="${step}" value="${esc(val)}">`;
    const F = (label, control, help, value) => `<label class="field"><span class="knob-head"><span>${label}</span>${value !== undefined ? `<span class="num">${esc(value)}</span>` : ""}</span>${control}${help ? `<span class="help">${help}</span>` : ""}</label>`;
    const gp = s.gp, blr = s.blr;
    return `
      <section class="panel stack">
        <div class="panel-head"><h2>Knobs</h2><div class="row"><button class="btn small" data-act="preview">Preview next session</button><button class="btn small danger" data-act="reset-knobs">Reset to defaults</button></div>
          <p class="muted">Every setting the planner uses. Changes apply to the next session you plan. Defaults suit 5–40 results.</p></div>
        ${warn.length ? `<div class="notice">With ${n} results:<ul>${warn.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : `<div class="notice info">No warnings for these settings with ${n} results.</div>`}
        ${state.preview ? previewTable(p) : ""}
      </section>
      <details class="panel" open><summary><h3>Initial design</h3></summary><div class="knob-section">
        ${F("Method", sel("doeMethod", s.doeMethod, [["maxpro", "MaxPro Latin hypercube"], ["maximin", "Maximin Latin hypercube"], ["lhs", "Plain Latin hypercube"], ["halton", "Halton sequence"], ["random", "Random"]]), "MaxPro keeps every single factor and every pair evenly covered, which per-factor lengthscales (ARD) need. Maximin pushes the closest runs apart.")}
        ${F("Initial runs", num("initialRuns", s.initialRuns, `min="1" placeholder="auto: ${Math.max(6, 2 * p.factors.length)}"`, "numOrNull"), "Runs before the model takes over. Blank = max(6, 2 × factors). A common rule of thumb is about 10 × factors for a full GP fit; cooking rarely affords that.")}
        ${F("Optimisation swaps", num("doeIters", s.doeIters, `min="0" step="100"`), "Swaps tried when optimising the Latin hypercube. More is slower and slightly better.")}
      </div></details>
      <details class="panel" open><summary><h3>Sessions</h3></summary><div class="knob-section">
        ${F("Samples per session", num("batchSize", s.batchSize, `min="1" max="12"`), "Also set on the Kitchen tab.")}
        ${F("Repeat best recipe every", num("replicateEvery", s.replicateEvery, `min="0"`), "Sessions between repeats of your best run, used to measure scoring noise. 0 turns repeats off.")}
        ${F("Random seed", num("seed", s.seed, `placeholder="random"`, "numOrNull"), "Fix it to make proposals reproducible. Blank uses a fresh seed each time.")}
      </div></details>
      <details class="panel" open><summary><h3>Model</h3></summary><div class="knob-section">
        ${F("Model family", sel("model", s.model, [["gp", "Gaussian process"], ["blr", "Bayesian polynomial regression"]]), "Gaussian processes bend to any smooth shape. Polynomial regression assumes a curved bowl or ridge and needs fewer results.")}
        ${s.model === "gp" ? `
        ${F("Kernel", sel("gp.kernel", gp.kernel, [["matern52", "Matérn 5/2"], ["matern32", "Matérn 3/2"], ["rbf", "RBF (squared exponential)"], ["rq", "Rational quadratic"], ["exponential", "Exponential (Matérn 1/2)"]]), "How smooth the response is assumed to be. RBF is smoothest; exponential is roughest. Matérn 5/2 is the usual default for optimisation.")}
        ${F("ARD (one lengthscale per factor)", chk("gp.ard", gp.ard), "Lets the model learn which factors matter. Needs roughly 3+ results per numeric factor.")}
        ${F("Choice lengthscales", sel("gp.catLengthscales", gp.catLengthscales, [["shared", "Shared across choice factors"], ["per-factor", "One per choice factor"]]))}
        ${F("Noise", sel("gp.noise", gp.noise, [["fit", "Learn from data"], ["fixed", "Fixed value"]]), "Scoring noise on the standardised scale.")}
        ${gp.noise === "fixed" ? F("Fixed noise (sd, standardised)", num("gp.noiseValue", gp.noiseValue, `min="0.001"`)) : ""}
        ${F("Mean function", sel("gp.mean", gp.mean, [["data", "Average of results"], ["gls", "Fitted constant (GLS)"]]), "What the model predicts far from any data.")}
        ${F("Output transform", sel("gp.transform", gp.transform, [["standardize", "Standardise"], ["log", "Log, then standardise"], ["none", "Centre only"]]), "Log suits positive, skewed outputs such as times or weights.")}
        ${F("Hyperparameter priors", chk("gp.priors", gp.priors), "Keeps lengthscales and noise near sensible values when data are scarce.")}
        ${F("Prior width (log-sd)", slide("gp.priorWidth", gp.priorWidth, 0.1, 2, 0.05), "Smaller holds hyperparameters closer to the prior medians below.", gp.priorWidth)}
        ${F("Prior median: numeric lengthscale", num("gp.lenNumPrior", gp.lenNumPrior, `min="0.01"`), "On the 0–1 scale of each range. 0.35 means the response changes noticeably over about a third of the range.")}
        ${F("Prior median: choice lengthscale", num("gp.lenCatPrior", gp.lenCatPrior, `min="0.01"`))}
        ${F("Prior median: signal sd", num("gp.signalPrior", gp.signalPrior, `min="0.01"`))}
        ${F("Prior median: noise sd", num("gp.noisePrior", gp.noisePrior, `min="0.001"`))}
        ${gp.kernel === "rq" ? F("Prior median: RQ α", num("gp.alphaPrior", gp.alphaPrior, `min="0.01"`)) : ""}
        ${F("Optimiser restarts", num("gp.restarts", gp.restarts, `min="1" max="20"`), "Nelder–Mead runs from different starting points; the best is kept.")}
        ${F("Optimiser iterations", num("gp.maxIter", gp.maxIter, `min="20" step="50"`))}
        ${F("Results before fitting", num("gp.minPointsToFit", gp.minPointsToFit, `min="2"`), "Below this, the prior medians are used as-is.")}
        ${F("Jitter", num("gp.jitter", gp.jitter, `min="0"`), "Added to the diagonal for numerical stability.")}` : `
        ${F("Polynomial degree", sel("blr.degree", blr.degree, [["1", "1 · linear"], ["2", "2 · quadratic"]]).replace('data-t="str"', 'data-t="num"'))}
        ${F("Pairwise interactions", chk("blr.interactions", blr.interactions), "Adds a term for every pair of numeric factors.")}
        ${F("Learn precisions from data", chk("blr.fitPrecisions", blr.fitPrecisions), "Evidence maximisation (MacKay). Off uses the fixed values below.")}
        ${F("Weight precision α", num("blr.alpha", blr.alpha, `min="0.0001"`), "Higher shrinks coefficients toward 0.")}
        ${F("Noise precision β", num("blr.beta", blr.beta, `min="0.01"`), "1/β is the noise variance on the standardised scale.")}
        ${F("Output transform", sel("blr.transform", blr.transform, [["standardize", "Standardise"], ["log", "Log, then standardise"], ["none", "Centre only"]]))}`}
      </div></details>
      <details class="panel" open><summary><h3>Input features</h3></summary><div class="knob-section">
        ${F("Input PCA", chk("pca.enabled", s.pca.enabled), "Rotates factors onto principal components of your runs and keeps the leading ones. Only helps when factors move together.")}
        ${F("Truncate by", sel("pca.mode", s.pca.mode, [["variance", "Variance kept"], ["k", "Number of components"]]))}
        ${s.pca.mode === "variance" ? F("Variance kept", slide("pca.value", s.pca.value, 0.5, 0.999, 0.001), "Components are kept until this share of variance is explained.", pct(s.pca.value)) : F("Components kept", num("pca.value", s.pca.value, `min="1" max="${BC.layout(p).length}" step="1"`))}
        ${F("Standardise before PCA", chk("pca.standardize", s.pca.standardize), "Scales each feature to unit variance first.")}
      </div></details>
      <details class="panel" open><summary><h3>Choosing the next runs</h3></summary><div class="knob-section">
        ${F("Acquisition", sel("acquisition", s.acquisition, [["thompson", "Thompson sampling"], ["ei", "Expected improvement"], ["ucb", "Upper confidence bound"], ["pi", "Probability of improvement"], ["exploit", "Pure exploitation (best prediction)"], ["explore", "Pure exploration (most uncertain)"]]), "Thompson sampling balances trying new areas against refining good ones without extra settings.")}
        ${F("UCB β", slide("ucbBeta", s.ucbBeta, 0, 5, 0.1), "Higher explores more.", s.ucbBeta)}
        ${F("Improvement margin ξ", num("xi", s.xi, `min="0" step="0.01"`), "For EI and PI: how much better than the current best counts as an improvement.")}
        ${F("Monte Carlo samples", num("mcSamples", s.mcSamples, `min="8" step="8"`), "Used to score EI, PI and UCB across several outputs.")}
        ${F("Batch strategy", sel("batchStrategy", s.batchStrategy, [["believer", "Kriging believer"], ["liar-min", "Constant liar (pessimistic)"], ["liar-max", "Constant liar (optimistic)"]]), "How later picks in a session account for earlier ones. Thompson sampling ignores this.")}
        ${F("Candidates scored", num("candidates", s.candidates, `min="50" step="50"`), "Random recipes the model scores each time. More finds better picks but is slower.")}
        ${F("Share near your best runs", slide("localFraction", s.localFraction, 0, 1, 0.05), "Part of the candidates are small variations of your top runs.", pct(s.localFraction))}
        ${F("Variation size", slide("localRadius", s.localRadius, 0.01, 0.4, 0.01), "Standard deviation of those variations, on the 0–1 scale of each range.", s.localRadius)}
        ${F("Top runs to vary", num("localTop", s.localTop, `min="1" max="10" step="1"`))}
      </div></details>
      <details class="panel" open><summary><h3>Scoring</h3></summary><div class="knob-section">
        ${F("Combine outputs by", sel("combine", s.combine, [["geometric", "Weighted geometric mean"], ["arithmetic", "Weighted average"], ["min", "Worst output"]]), "Geometric mean needs every output to be decent; average lets a strong output make up for a weak one.")}
        ${F("Desirability shape", slide("desirabilityShape", s.desirabilityShape, 0.25, 4, 0.05), "Above 1 rewards only results close to ideal; below 1 rewards any progress.", s.desirabilityShape)}
        <div class="field wide"><span>Output weights and ranges</span><span class="help">${p.outputs.map((o) => `${esc(nice(o.name))} × ${o.weight}`).join(" · ")}. Edit them in the Pantry.</span></div>
      </div></details>
      <details class="panel" open><summary><h3>Rejected recipes</h3></summary><div class="knob-section">
        ${F("Avoid areas you rejected", chk("noGo.enabled", s.noGo.enabled))}
        ${F("How", sel("noGo.mode", s.noGo.mode, [["penalize", "Penalise nearby candidates"], ["exclude", "Exclude nearby candidates"]]))}
        ${F("Radius", slide("noGo.radius", s.noGo.radius, 0.02, 0.5, 0.01), "Distance on the 0–1 scale of each range.", s.noGo.radius)}
        ${F("Penalty strength", slide("noGo.strength", s.noGo.strength, 0, 1, 0.05), "Share of a candidate's value removed right at a rejected recipe.", s.noGo.strength)}
      </div></details>`;
  }

  function previewTable(p) {
    const pv = state.preview;
    if (pv === "busy") return `<span class="thinking muted">Planning a preview…</span>`;
    if (pv.error) return `<div class="notice bad">${esc(pv.error)}</div>`;
    return `<div class="stack"><h4>Preview (nothing saved)</h4><div class="table-wrap"><table><thead><tr><th>Type</th>${p.factors.map((f) => `<th>${esc(nice(f.name))}</th>`).join("")}<th>Expected</th></tr></thead><tbody>
      ${pv.rows.map((q) => `<tr><td><span class="chip ${esc(q.phase)}">${esc(PHASE_LABEL[q.phase] || q.phase)}</span></td>${p.factors.map((f) => `<td class="${f.type === "categorical" ? "" : "n"}">${esc(fmtVal(f, q.x[f.name]))}</td>`).join("")}<td class="n">${q.score !== undefined ? q.score.toFixed(2) : "–"}</td></tr>`).join("")}
      </tbody></table></div><p class="small muted">Planned in ${pv.ms} ms.</p></div>`;
  }

  function setPath(obj, path, val) {
    const ks = path.split(".");
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] = o[ks[i]] || {};
    o[ks[ks.length - 1]] = val;
  }

  // ================================================================== guide

  function guideView(p) {
    return `
      <section class="panel stack">
        <h2>How Bayesian Chef works</h2>
        <div class="checklist">
          <div><h4>1 · Set up</h4><ul><li>In the Pantry, list what you'll vary (factors) with sensible ranges, and what you'll measure (outputs).</li><li>Add your current recipe as the reference if you have one.</li></ul></div>
          <div><h4>2 · Initial design</h4><ul><li>The first sessions spread runs evenly across every range (a MaxPro Latin hypercube by default).</li><li>This gives the model a fair look at each factor before it starts choosing.</li></ul></div>
          <div><h4>3 · Model picks</h4><ul><li>A Gaussian process learns how each output responds to the factors, with honest uncertainty.</li><li>Each session it proposes recipes that are promising, uncertain, or both. You approve, edit or reject every one.</li></ul></div>
          <div><h4>4 · Taste and record</h4><ul><li>Cook, label with the 3-digit codes, taste blind in the given order, record results.</li><li>Every few sessions it repeats your best recipe to check how consistent your scores are.</li></ul></div>
        </div>
      </section>
      <section class="panel stack"><h3>Tasting protocol</h3>${tipsHtml(p)}${protocolHtml()}</section>
      <section class="panel stack"><div class="panel-head"><h3>Suggested measurements</h3><p class="muted small">Add any of these to ${esc(p.name)}, or define your own in the Pantry.</p></div>
        <div class="table-wrap"><table><thead><tr><th>Output</th><th>Type</th><th>Goal</th><th>How</th><th></th></tr></thead><tbody>
        ${Object.entries(BC.OUTPUT_LIBRARY).map(([k, o]) => `<tr><td><b>${esc(nice(k))}</b></td><td>${esc(o.category)}</td><td>${esc(o.goal === "target" ? `target ${o.target}` : o.goal)}</td><td style="white-space:normal;min-width:260px">${esc(o.how)}</td>
          <td>${p.outputs.some((q) => q.name === k) ? `<span class="chip done">added</span>` : `<button class="btn small" data-act="add-lib-output" data-k="${k}">Add</button>`}</td></tr>`).join("")}
        </tbody></table></div></section>
      <section class="panel stack"><h3>Sources</h3><ul class="small muted">${BC.REFERENCES.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></section>`;
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
    openModal(`<h3>${esc(title)}</h3><p class="muted">${esc(body)}</p><div class="row end"><button class="btn" data-act="close-modal">Keep it</button><button class="btn danger" data-act="confirm-ok">${esc(okLabel)}</button></div>`);
  }

  function newProjectModal() {
    state.newTemplate = state.newTemplate || "omelette";
    const t = BC.TEMPLATES;
    openModal(`<h3>New experiment</h3>
      <label class="field"><span>Name</span><input type="text" id="np-name" placeholder="${esc(t[state.newTemplate].name)}"></label>
      ${[...new Set(Object.values(t).map((v) => v.folder))].map((folder) => `<div class="field"><span class="folder-name">${esc(folder)}</span><div class="template-grid">${Object.entries(t).filter(([, v]) => v.folder === folder).map(([k, v]) => `<button type="button" data-act="pick-template" data-k="${k}" aria-pressed="${state.newTemplate === k}"><b>${esc(v.name)}</b><span class="small muted">${esc(v.description)}</span></button>`).join("")}</div></div>`).join("")}
      <div class="row end"><button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-act="create-project">Create</button></div>`);
  }

  function createProject(p) {
    p.touched = true;
    state.projects[p.id] = normalize(p);
    state.currentId = p.id;
    store.set("bc:current", p.id);
    state.proposals = null; state.preview = null; state.selectedRun = null;
    save(p, { immediate: true });
    state.tab = "pantry";
    render();
  }

  // ================================================================= events

  document.addEventListener("click", (e) => {
    const tabBtn = e.target.closest("[data-tab]");
    if (tabBtn) {
      state.tab = tabBtn.dataset.tab; store.set("bc:tab", state.tab); state.preview = null; render(); window.scrollTo({ top: 0 }); return;
    }
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    const p = cur();
    const A = {
      "new-project": newProjectModal,
      "pick-template": () => { state.newTemplate = el.dataset.k; const name = $("#np-name").value; newProjectModal(); $("#np-name").value = name; },
      "create-project": () => { const name = $("#np-name").value.trim(); closeModal(); createProject(BC.fromTemplate(state.newTemplate, name || undefined)); toast("Created. Adjust factors and outputs, then plan your first session."); },
      "close-modal": closeModal,
      "modal-back": () => { if (e.target === el) closeModal(); },
      "confirm-ok": () => { const f = state.onConfirm; state.onConfirm = null; closeModal(); if (f) f(); },
      "copy-area": () => { const t = $("#copy-area"); const done = () => toast("Copied"); if (navigator.clipboard) navigator.clipboard.writeText(t.value).then(done, () => { t.select(); }); else t.select(); },
      batch: () => { p.settings.batchSize = Number(el.dataset.n); save(p); render(); },
      plan: planSession,
      replan: () => { state.replans = (state.replans || 0) + 1; planSession(); },
      "discard-proposals": () => { state.proposals = null; render(); },
      decide: () => { const q = state.proposals[Number(el.dataset.i)]; q.decision = el.dataset.d; render(); },
      "start-session": startSession,
      "cancel-session": () => confirmModal("Cancel this session?", "The planned runs are removed. Results you've already saved stay.", "Cancel session", () => {
        p.runs = p.runs.filter((r) => r.status !== "planned");
        if (!p.runs.some((r) => r.session === p.sessions)) p.sessions = Math.max(0, p.sessions - 1);
        save(p); render();
      }),
      scale: () => { const d = (state.drafts[el.dataset.id] = state.drafts[el.dataset.id] || {}); d[el.dataset.o] = Number(el.dataset.v); el.parentElement.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === el))); },
      "save-result": () => saveResult(el.dataset.id),
      "not-made": () => { const r = p.runs.find((q) => q.id === el.dataset.id); r.status = "rejected"; r.phase = "not-made"; r.notes = (r.notes ? r.notes + " · " : "") + "not made"; save(p); render(); },
      logfilter: () => { state.logFilter = el.dataset.f; render(); },
      "select-run": () => { state.selectedRun = el.dataset.id; render(); setTimeout(() => { const ed = main.querySelector(".panel:last-child"); if (ed) ed.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, 0); },
      "close-run": () => { state.selectedRun = null; render(); },
      "save-run": () => {
        const r = p.runs.find((q) => q.id === el.dataset.id);
        main.querySelectorAll("[data-edit]").forEach((inp) => {
          const [k, o] = inp.dataset.edit.split(":");
          if (k === "y") { r.y = r.y || {}; if (inp.value === "") delete r.y[o]; else r.y[o] = Number(inp.value); }
          else r[k] = inp.value;
        });
        p.touched = true; save(p); render(); toast(`Saved ${r.id}`);
      },
      "delete-run": () => confirmModal(`Delete ${el.dataset.id}?`, "The run and its results are removed from this experiment.", "Delete run", () => {
        p.runs = p.runs.filter((r) => r.id !== el.dataset.id); state.selectedRun = null; save(p); render();
      }),
      "export-csv": () => offerFile(`${slug(p.name)}-runs.csv`, csvOf(p)),
      "export-json": () => offerFile(`${slug(p.name)}.json`, JSON.stringify(p, null, 2)),
      "add-factor": () => {
        const type = el.dataset.type;
        const base = { name: uniqueName(p, type === "categorical" ? "choice" : type === "component" ? "part" : "factor"), type, kind: "composition" };
        if (type === "categorical") Object.assign(base, { levels: ["a", "b"] });
        else if (type === "component") {
          const g = (p.factors.find((f) => f.type === "component") || {}).group || "blend";
          Object.assign(base, { group: g, low: 0, high: 100, unit: "%" });
          if (!(g in p.mixtures)) p.mixtures[g] = 100;
        } else Object.assign(base, { low: 0, high: 10, unit: "" });
        p.factors.push(base); fillMissing(p); p.touched = true; save(p); render();
      },
      "del-factor": () => { const f = p.factors[Number(el.dataset.i)]; confirmModal(`Remove ${nice(f.name)}?`, "Past runs keep their values in exports, but the model stops using this factor.", "Remove", () => { p.factors.splice(Number(el.dataset.i), 1); cleanupMixtures(p); save(p); render(); }); },
      "toggle-baseline": () => { p.baseline = el.checked ? Object.fromEntries(p.factors.map((f) => [f.name, defaultValue(f)])) : null; if (p.baseline) fillMixtureBaseline(p); save(p); render(); },
      "add-output": () => { p.outputs.push({ name: uniqueName(p, "output"), goal: "maximize", low: 0, high: 10, weight: 1, unit: "", how: "" }); save(p); render(); },
      "add-lib-output": () => {
        const k = el.dataset.k || $("#lib-pick").value;
        if (!k || p.outputs.some((o) => o.name === k)) return;
        const { category, ...o } = BC.OUTPUT_LIBRARY[k];
        p.outputs.push({ name: k, ...o }); save(p); render(); toast(`Added ${nice(k)}`);
      },
      "del-output": () => { const o = p.outputs[Number(el.dataset.i)]; confirmModal(`Remove ${nice(o.name)}?`, "Recorded values stay in the logbook export, but the model and scores stop using them.", "Remove", () => { p.outputs.splice(Number(el.dataset.i), 1); save(p); render(); }); },
      duplicate: () => { const q = clone(p); Object.assign(q, { id: BC.uid(), name: `${p.name} (copy)`, runs: [], sessions: 0, example: false, createdAt: nowIso() }); createProject(q); },
      "delete-project": () => confirmModal(`Delete “${p.name}”?`, "This removes the experiment and all its results for good.", "Delete experiment", async () => {
        await removeProject(p.id); state.currentId = pickDefault(); if (!state.currentId) { state.projects.example = BC.exampleProject(); state.currentId = "example"; } state.tab = "kitchen"; render();
      }),
      preview: () => {
        state.preview = "busy"; render();
        setTimeout(() => {
          const t0 = performance.now();
          try { const rows = BC.propose(p, settings(p), settings(p).batchSize, p.sessions + 1); state.preview = { rows, ms: Math.round(performance.now() - t0) }; }
          catch (err) { state.preview = { error: `Couldn't plan with these settings: ${err.message}` }; }
          render();
        }, 30);
      },
      "reset-knobs": () => confirmModal("Reset every knob?", "All settings go back to their defaults. Your runs are untouched.", "Reset", () => { const b = p.settings.batchSize; p.settings = BC.mergeSettings({ batchSize: b }); save(p); render(); }),
    };
    if (A[act]) A[act]();
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

  // Input bindings. `change` commits structural edits; `input` updates drafts live.
  document.addEventListener("input", (e) => {
    const t = e.target;
    const p = cur();
    if (t.dataset.bind) {
      const [kind, a, b] = t.dataset.bind.split(":");
      if (kind === "draft") { (state.drafts[a] = state.drafts[a] || {})[b] = t.value; }
      else if (kind === "draftnote") { (state.drafts[a] = state.drafts[a] || {}).__notes = t.value; }
      else if (kind === "reason") { state.proposals[Number(a)].reason = t.value; }
    }
    if (t.type === "range" && t.dataset.k) {
      const head = t.closest(".field").querySelector(".knob-head .num");
      if (head) head.textContent = t.dataset.k === "pca.value" || t.dataset.k === "localFraction" ? pct(Number(t.value)) : t.value;
    }
    void p;
  });

  document.addEventListener("change", (e) => {
    const t = e.target;
    const p = cur();
    if (t.id === "project-select") {
      state.currentId = t.value; store.set("bc:current", t.value); state.proposals = null; state.preview = null; state.selectedRun = null; state.drafts = {}; render(); return;
    }
    if (t.id === "import-file") { importFile(t.files && t.files[0]); t.value = ""; return; }
    if (!p) return;
    if (t.dataset.bind) {
      const [kind, a, b] = t.dataset.bind.split(":");
      if (kind === "prop") {
        const q = state.proposals[Number(a)];
        const f = p.factors.find((x) => x.name === b);
        q.x[b] = f.type === "categorical" ? t.value : Number(t.value);
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
    if (d.dataset && d.dataset.remember) store.set(d.dataset.remember, d.open);
  }, true);

  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#modal-root").innerHTML) closeModal(); });

  function importFile(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const q = JSON.parse(r.result);
        if (!q || !Array.isArray(q.factors) || !Array.isArray(q.outputs)) throw new Error("That file isn't a Bayesian Chef experiment.");
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
  state.tab = store.get("bc:tab", "kitchen");
  if (!TABS.some((t) => t.id === state.tab)) state.tab = "kitchen";
  state.currentId = "example";
  render();
  connect();
})();
