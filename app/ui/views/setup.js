/* Bayesian Chef · ui/views/setup.js
 *
 * The Setup tab: experiment name, factors, outputs, baseline recipe and
 * tasting notes, plus the "New experiment" dialog.
 */
(function () {
  "use strict";
  const Chef = (window.Chef = window.Chef || {});
  // Helpers from earlier files, unpacked for readability.
  const { esc, nice, cap, fmtNum, unitOf, state } = Chef;

  const TYPE_LABEL = { continuous: "Number", integer: "Whole number", categorical: "Choice", component: "Blend part" };

  /** One-line description of a factor for the Setup list. */
  function factorMeta(p, f) {
    if (f.type === "categorical") return `${TYPE_LABEL[f.type]} · ${f.levels.map(nice).join(", ")}`;
    const range = `${fmtNum(f.low)}–${fmtNum(f.high)}${unitOf(f)}`;
    return `${TYPE_LABEL[f.type]} · ${range}${f.type === "component" ? ` · ${nice(f.group)} blend` : ""}${f.log ? " · log scale" : ""}`;
  }

  /** One-line description of an output for the Setup list. */
  function outputMeta(o) {
    const goal = o.goal === "target" ? `Target ${o.target}` : o.goal === "maximize" ? "Higher is better" : "Lower is better";
    return `${goal} · ${fmtNum(o.low)}–${fmtNum(o.high)}${o.unit ? " " + o.unit : ""} · weight ${o.weight}`;
  }

  /** The Setup tab. */
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
        ${p.baseline ? `<div class="fields">${p.factors.map((f) => Chef.factorInput(f, p.baseline[f.name], `base:${f.name}`)).join("")}</div>
          ${BC.checkRun(p, p.baseline).length ? `<div class="notice bad small">${BC.checkRun(p, p.baseline).map(esc).join(" ")}</div>` : ""}` : `<p class="small muted">Optional. It gives every later recipe a fair comparison.</p>`}
      </section>

      <section class="card stack">
        <h3>Tasting notes for this recipe</h3>
        <textarea id="p-tips" data-p="tips" rows="4" placeholder="One per line, e.g. Chill every sample to fridge temperature.">${esc((p.tips || []).join("\n"))}</textarea>
        <p class="help">Shown on the checklist before every tasting.</p>
      </section>

      <div class="row"><button class="btn ghost sm" data-act="duplicate">Copy setup to a new experiment</button><span class="spacer"></span><button class="btn ghost sm danger" data-act="delete-project">Delete experiment</button></div>`;
  }

  /** Form for editing one factor. */
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

  /** Form for editing one output. */
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

  /** The "New experiment" dialog with templates grouped into folders. */
  function newProjectModal() {
    state.newTemplate = state.newTemplate || "lemonade";
    const t = BC.TEMPLATES;
    Chef.openModal(`<h2>New experiment</h2>
      <label class="field"><span>Name</span><input type="text" id="np-name" placeholder="${esc(t[state.newTemplate].name)}"></label>
      ${[...new Set(Object.values(t).map((v) => v.folder))].map((folder) => `<div class="stack" style="gap:8px"><span class="eyebrow">${esc(folder)}</span><div class="tpl-grid">${Object.entries(t).filter(([, v]) => v.folder === folder).map(([k, v]) => `<button type="button" data-act="pick-template" data-k="${k}" aria-pressed="${state.newTemplate === k}"><b>${esc(v.name)}</b><span class="small muted">${esc(v.description)}</span></button>`).join("")}</div></div>`).join("")}
      <div class="row end"><button class="btn ghost" data-act="close-modal">Cancel</button><button class="btn primary" data-act="create-project">Create</button></div>`);
  }

  Object.assign(Chef, { TYPE_LABEL, factorMeta, outputMeta, setupView, factorEditor, outputEditor, newProjectModal });
})();
