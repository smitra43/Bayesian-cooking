/* Bayesian Chef · ui/views/log.js
 *
 * The Log tab (a table of every run) and the side panel for editing one run.
 */
(function () {
  "use strict";
  const Chef = (window.Chef = window.Chef || {});
  // Helpers from earlier files, unpacked for readability.
  const { esc, nice, cap, fmtNum, fmtVal, valid, PHASE_LABEL, phaseClass, state, settings } = Chef;

  const STATUS_PILL = { done: ["good", "Tasted"], planned: ["warn", "To taste"], rejected: ["bad", "Rejected"] };

  /** The Log tab: filter buttons and the table of runs. */
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

  /** Side panel for one run: its recipe, scores, status and notes. */
  function runSheet(p, r) {
    const s = settings(p), rg = BC.ranges(p);
    const sc = r.status === "done" ? BC.runScore(p, r, s, rg) : null;
    return `
      <div class="row">${r.code ? `<span class="ticket">${esc(r.code)}</span>` : ""}<span class="pill ${phaseClass(r.phase)}">${esc(PHASE_LABEL[r.phase] || r.phase)}</span><span class="faint small">Session ${r.session || "–"}</span><span class="spacer"></span>${sc !== null ? `<span class="score">${sc.toFixed(2)}</span>` : ""}</div>
      <section class="card">${Chef.factorKv(p, r.x)}${r.why ? `<p class="small muted" style="margin-top:12px">${esc(r.why)}</p>` : ""}</section>
      <h3>Results</h3>
      <div class="fields">${p.outputs.map((o) => `<label class="field"><span>${esc(cap(nice(o.name)))} <span class="faint">${esc(o.unit || "")}</span></span><input type="number" step="any" id="edit-${esc(o.name)}" data-edit="y:${esc(o.name)}" value="${esc(r.y && valid(r.y[o.name]) ? r.y[o.name] : "")}"></label>`).join("")}
        <label class="field"><span>Status</span><select id="edit-status" data-edit="status">${[["planned", "To taste"], ["done", "Tasted"], ["rejected", "Rejected"]].map(([k, l]) => `<option value="${k}"${k === r.status ? " selected" : ""}>${l}</option>`).join("")}</select></label></div>
      <label class="field"><span>Notes</span><textarea id="edit-notes" data-edit="notes">${esc(r.notes || "")}</textarea></label>
      <div class="row"><button class="btn ghost sm danger" data-act="delete-run" data-id="${esc(r.id)}">Delete</button><span class="spacer"></span><button class="btn primary" data-act="save-run" data-id="${esc(r.id)}">Save changes</button></div>`;
  }

  Object.assign(Chef, { STATUS_PILL, logView, runSheet });
})();
