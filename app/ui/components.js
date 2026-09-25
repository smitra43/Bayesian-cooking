/* Bayesian Chef · ui/components.js
 *
 * Reusable pieces of screen: recipe summaries, value lists, form
 * inputs, the rating question, pop-up dialogs and file downloads.
 *
 * Each function returns an HTML string (or opens a dialog). Views combine
 * them; none of them change the experiment.
 */
(function () {
  "use strict";
  const Chef = (window.Chef = window.Chef || {});
  // Helpers from earlier files, unpacked for readability.
  const { $, esc, nice, cap, fmtNum, fmtVal, unitOf, valid, toast, state } = Chef;

  /** One-line description of a recipe from its first few factors, e.g. "3 eggs · pan temp c 160 °C · butter". */
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

  /** A name/value list of every factor in a recipe. */
  function factorKv(p, x) {
    return `<dl class="kv">${p.factors.map((f) => {
      const amt = amountOf(p, f, x[f.name]);
      return `<div><dt title="${esc(nice(f.name))}">${esc(cap(nice(f.name)))}</dt><dd>${amt ? `${esc(amt)} <span class="faint">${esc(fmtVal(f, x[f.name]))}%</span>` : `${esc(fmtVal(f, x[f.name]))}<span class="faint">${esc(unitOf(f))}</span>`}</dd></div>`;
    }).join("")}</dl>`;
  }

  /** A form field for one factor (dropdown for choices, number box otherwise). */
  function factorInput(f, v, bind, id) {
    const fid = id || `in-${bind.replace(/[^a-z0-9]/gi, "-")}`;
    if (f.type === "categorical") {
      return `<label class="field"><span>${esc(cap(nice(f.name)))}</span><select id="${fid}" data-bind="${esc(bind)}">${f.levels.map((l) => `<option value="${esc(l)}"${l === v ? " selected" : ""}>${esc(nice(l))}</option>`).join("")}</select></label>`;
    }
    const step = f.type === "integer" ? 1 : "any";
    return `<label class="field"><span>${esc(cap(nice(f.name)))}<span class="faint">${esc(unitOf(f))}</span></span><input type="number" id="${fid}" step="${step}" min="${f.low}" max="${f.high}" data-bind="${esc(bind)}" value="${esc(v === undefined ? "" : f.type === "integer" ? Math.round(v) : +Number(v).toFixed(4))}"></label>`;
  }

  /** True when an output is a small whole-number scale (like 1–9), shown as tap-to-rate buttons. */
  function isScale(o) {
    const lo = Number(o.low), hi = Number(o.high);
    return valid(o.low) && valid(o.high) && Number.isInteger(lo) && Number.isInteger(hi) && hi - lo <= 10 && hi > lo;
  }

  /** Short goal description: "higher is better", "aim for 3"… */
  function goalText(o) {
    if (o.goal === "target") return `aim for ${o.target}${o.unit && !/^\d/.test(o.unit) ? " " + o.unit : ""}`;
    return o.goal === "maximize" ? "higher is better" : "lower is better";
  }

  /** Labels for the two ends of a rating scale. */
  function scaleEnds(o) {
    if (o.goal === "target") return ["Too little", "Too much"];
    if (/hedonic|like/i.test(o.how || "") || o.name === "liking") return ["Dislike", "Like"];
    return [String(o.low), String(o.high)];
  }

  /** One scoring question on the Taste screen: rating buttons or a number box. */
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

  async function offerFile(filename, data) {
    // 1. Hosted inside claude.ai: downloads must go through its save prompt.
    let dl = null;
    try { dl = window.claude && window.claude.use ? await window.claude.use("downloads") : null; } catch (e) { dl = null; }
    if (dl) {
      try { await dl.save({ filename, data }); toast(`Saved ${filename}`); return; }
      catch (e) { if (e && e.code === "declined") return; }
    }
    // 2. Everywhere else: an ordinary browser download.
    if (!window.claude) {
      try {
        const type = filename.endsWith(".csv") ? "text/csv" : "application/json";
        const url = URL.createObjectURL(new Blob([data], { type }));
        const a = document.createElement("a");
        a.href = url; a.download = filename; a.style.display = "none";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast(`Downloaded ${filename}`);
        return;
      } catch (e) { console.error(e); }
    }
    // 3. Last resort: show the text so it can be copied by hand.
    openModal(`<h2>Copy your data</h2><p class="muted small">Saving files isn't available here. Copy this into a file named <span class="mono">${esc(filename)}</span>.</p>
      <textarea id="copy-area" rows="10" readonly>${esc(data)}</textarea>
      <div class="row end"><button class="btn ghost" data-act="close-modal">Close</button><button class="btn primary" data-act="copy-area">Copy</button></div>`);
  }

  /** Show a centred dialog with the given HTML. */
  function openModal(html) {
    $("#modal-root").innerHTML = `<div class="modal-back" data-act="modal-back"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    const f = $("#modal-root input, #modal-root button");
    if (f) f.focus();
  }

  /** Close the dialog. */
  function closeModal() { $("#modal-root").innerHTML = ""; }

  /** Ask "are you sure?" and run onOk only if the user confirms. */
  function confirmModal(title, body, okLabel, onOk) {
    state.onConfirm = onOk;
    openModal(`<h2>${esc(title)}</h2><p class="muted">${esc(body)}</p><div class="row end"><button class="btn ghost" data-act="close-modal">Keep it</button><button class="btn danger" data-act="confirm-ok">${esc(okLabel)}</button></div>`);
  }

  Object.assign(Chef, { summary, amountOf, factorKv, factorInput, isScale, goalText, scaleEnds, question, offerFile, openModal, closeModal, confirmModal });
})();
