/* Bayesian Chef · ui/views/cook.js
 *
 * The Cook tab: plan a session, review proposals, then the
 * Prep → Taste → Done flow for a planned session.
 *
 * cookView(p) picks which of those to show from the experiment's state.
 */
(function () {
  "use strict";
  const Chef = (window.Chef = window.Chef || {});
  // Helpers from earlier files, unpacked for readability.
  const { esc, nice, fmtNum, pct, valid, PHASE_LABEL, phaseClass, icon, state, settings } = Chef;

  /** Where the experiment is: still in the initial design, or letting the model choose. */
  function phaseInfo(p) {
    const s = settings(p);
    const active = p.runs.filter((r) => r.status !== "rejected").length;
    const done = BC.doneRuns(p).length;
    const nInit = BC.initialRuns(p, s);
    const design = active < nInit || !done;
    return { design, active, done, nInit, frac: design ? Math.min(1, active / nInit) : 1 };
  }

  /** The whole Cook tab: header, then whichever step applies (setup problems, session, review, or plan). */
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

  /** The "Plan session" card, plus the last session's summary and recent tastings. */
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

  /** Short text of a run's scores, e.g. "liking 7 · texture jar 3". */
  function outputsBrief(p, r, n = 3) {
    return p.outputs.slice(0, n).filter((o) => r.y && valid(r.y[o.name])).map((o) => `${nice(o.name)} ${fmtNum(r.y[o.name])}`).join(" · ");
  }

  /** List of the most recent tasted recipes. */
  function recentCard(p) {
    const s = settings(p), rg = BC.ranges(p);
    const recent = BC.doneRuns(p).slice(-4).reverse();
    if (!recent.length) return "";
    return `<section class="card flush">
      <div class="card-head pad"><h3>Recent tastings</h3><button class="link" data-tab="log">See all</button></div>
      <ul class="list">${recent.map((r) => { const sc = BC.runScore(p, r, s, rg); return `<li><button class="item" data-act="open-run" data-id="${esc(r.id)}">
        <div class="main"><span class="title">${esc(Chef.summary(p, r.x, 3))}</span><span class="meta">${esc(r.id)} · ${esc(outputsBrief(p, r))}</span></div>
        <span class="score">${sc === null ? "–" : sc.toFixed(2)}</span></button></li>`; }).join("")}</ul></section>`;
  }

  /** Summary shown right after a session finishes. */
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

  /** Review screen: every proposal with approve/reject buttons. */
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

  /** One proposal in the review list, expandable to see or edit its values. */
  function propItem(p, q, i) {
    const open = state.expanded === i;
    const errs = BC.checkRun(p, q.x);
    const rejected = q.decision === "reject";
    const preds = q.predictions ? `<p class="small muted">Model expects ${Object.entries(q.predictions).map(([k, v]) => `${esc(nice(k))} ${fmtNum(v.mean)} ± ${fmtNum(v.sd)}`).join(", ")}.</p>` : "";
    return `<li class="prop ${rejected ? "rejected" : ""}">
      <div class="prop-row">
        <div class="main" data-act="toggle-prop" data-i="${i}" role="button" tabindex="0" aria-expanded="${open}">
          <div class="row" style="gap:6px"><span class="pill ${phaseClass(q.phase)}">${esc(PHASE_LABEL[q.phase] || q.phase)}</span>${q.edited ? `<span class="pill">Edited</span>` : ""}</div>
          <div class="meta" style="margin-top:6px;color:var(--ink)">${esc(Chef.summary(p, q.x, 3))}</div>
        </div>
        <div class="toggle-pair">
          <button type="button" class="yes" data-act="decide" data-i="${i}" data-d="approve" aria-pressed="${!rejected}" aria-label="Approve">${icon("check", 18)}</button>
          <button type="button" class="no" data-act="decide" data-i="${i}" data-d="reject" aria-pressed="${rejected}" aria-label="Reject">${icon("x", 18)}</button>
        </div>
      </div>
      ${open ? `<div class="stack">
        ${q.editing ? `<div class="fields">${p.factors.map((f) => Chef.factorInput(f, q.x[f.name], `prop:${i}:${f.name}`)).join("")}</div><div><button class="btn sm" data-act="edit-done" data-i="${i}">Done editing</button></div>`
          : `${Chef.factorKv(p, q.x)}<div><button class="btn sm" data-act="edit-prop" data-i="${i}">Edit values</button></div>`}
        <p class="small muted">${esc(q.why)}</p>${preds}</div>` : ""}
      ${errs.length && !rejected ? `<div class="notice bad small">${errs.map(esc).join(" ")}</div>` : ""}
      ${rejected ? `<label class="field"><span>Why not? (optional)</span><input type="text" id="reason-${i}" data-bind="reason:${i}" value="${esc(q.reason || "")}" placeholder="e.g. too hot for my pan"></label>` : ""}
    </li>`;
  }

  /** The Prep → Taste steps for a planned session. */
  function sessionFlow(p, planned) {
    const sessionNo = planned[0].session;
    const all = p.runs.filter((r) => r.session === sessionNo && r.status !== "rejected").sort((a, b) => (a.taste || 0) - (b.taste || 0));
    const doneCount = all.filter((r) => r.status === "done").length;
    const step = state.cookStep || (doneCount ? "taste" : "prep");
    const stepEl = (n, label, st) => `<span class="${st}"><i>${st === "done" ? icon("check", 14) : n}</i>${label}</span>`;
    const steps = `<div class="steps" aria-label="Session progress">${stepEl(1, "Prep", step === "prep" ? "on" : "done")}<span class="sep"></span>${stepEl(2, "Taste", step === "taste" ? "on" : "")}<span class="sep"></span>${stepEl(3, "Done", "")}</div>`;
    return steps + (step === "prep" ? prepView(p, all) : tasteView(p, all, planned));
  }

  /** Prep step: cooking sheet with codes and the pre-tasting checklist. */
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
          <article class="recipe"><header><span class="code">${esc(r.code)}</span><span class="spacer"></span><span class="pill ${phaseClass(r.phase)}">${esc(PHASE_LABEL[r.phase] || r.phase)}</span></header>${Chef.factorKv(p, r.x)}</article>`).join("")}</div>
      </section>
      <section class="card">
        <div class="card-head"><h3>Before you taste</h3><button class="link" data-act="open-help">Full tasting guide</button></div>
        <ul class="checks">${items.map((t, i) => `<li><label><input type="checkbox" data-act="tick" data-i="${i}" ${state.checks[i] ? "checked" : ""}><span>${esc(t)}</span></label></li>`).join("")}</ul>
      </section>
      <div class="sticky-foot"><span class="muted">Order: <b class="mono">${all.map((r) => esc(r.code)).join(" → ")}</b></span><span class="spacer"></span><button class="btn primary" data-act="start-tasting">Start tasting</button></div>`;
  }

  /** Taste step: one blind sample at a time with its scoring questions. */
  function tasteView(p, all, planned) {
    const current = all.find((r) => r.status === "planned");
    const idx = all.indexOf(current);
    const d = state.drafts[current.id] || {};
    const last = planned.length === 1;
    return `<section class="card taste">
      <div class="row"><div class="dots" aria-hidden="true">${all.map((r) => `<i class="${r.status === "done" ? "done" : r === current ? "on" : ""}"></i>`).join("")}</div><span class="spacer"></span><span class="faint small">Sample ${idx + 1} of ${all.length}</span></div>
      <div><span class="eyebrow">Now tasting</span><div class="big-code">${esc(current.code)}</div></div>
      ${p.outputs.map((o) => Chef.question(o, d[o.name], current.id)).join("")}
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

  Object.assign(Chef, { phaseInfo, cookView, planView, outputsBrief, recentCard, lastSessionCard, reviewView, propItem, sessionFlow, prepView, tasteView });
})();
