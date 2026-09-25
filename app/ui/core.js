/* Bayesian Chef · ui/core.js
 *
 * UI toolkit: small helpers every other UI file uses.
 *
 * Formatting (numbers, names, units), HTML escaping, icons and the pop-up
 * "toast" message. Nothing here knows about recipes or saving.
 *
 * Loaded first. Everything it defines is reachable as Chef.<name>.
 */
(function () {
  "use strict";
  const Chef = (window.Chef = window.Chef || {});

  const $ = (sel, root = document) => root.querySelector(sel);

  const main = $("#main");

  /** Escape text for safe use inside HTML, so user input can never run as code. */
  function esc(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /** Turn a stored name like "pan_temp_c" into readable text: "pan temp c". */
  function nice(name) { return String(name).replace(/_/g, " "); }

  /** Capitalise the first letter. */
  function cap(s) { s = String(s); return s.charAt(0).toUpperCase() + s.slice(1); }

  /** Format a number for display with sensible precision ("–" if missing). */
  function fmtNum(v, digits) {
    if (v === null || v === undefined || v === "" || !isFinite(v)) return "–";
    v = Number(v);
    if (digits !== undefined) return v.toFixed(digits);
    if (Number.isInteger(v)) return String(v);
    const a = Math.abs(v);
    return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
  }

  /** Format one factor value for display (option name, whole number or number). */
  function fmtVal(f, v) {
    if (f.type === "categorical") return nice(v);
    if (f.type === "integer") return `${Math.round(v)}`;
    return fmtNum(v);
  }

  /** The factor's unit with a leading space, or "". */
  function unitOf(f) { return f.unit ? ` ${f.unit}` : ""; }

  /** Chart axis label for a factor, e.g. "pan temp c (°C)". */
  function axisLabel(f) { return f.unit ? `${nice(f.name)} (${f.unit})` : nice(f.name); }

  /** Format 0.42 as "42%". */
  function pct(v) { return `${Math.round(v * 100)}%`; }

  /** Deep copy of plain data (objects, arrays, numbers, strings). */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** The current time as an ISO string, used for created/updated stamps. */
  function nowIso() { return new Date().toISOString(); }

  /** True if v is a real, finite number (or numeric string). */
  function valid(v) { return v !== null && v !== undefined && v !== "" && isFinite(v); }

  const PHASE_LABEL = { doe: "Design", bo: "Model pick", baseline: "Your recipe", replicate: "Repeat", manual: "Edited", "not-made": "Not made" };

  /** CSS class for a run's phase badge. */
  function phaseClass(ph) { return ph === "doe" ? "doe" : ph === "bo" ? "bo" : ph === "not-made" ? "bad" : "good"; }

  const ICONS = {
    pot: '<path d="M4 10h16v4a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6z"/><path d="M2 10h20"/><path d="M9 6.5c0-1.2 1-1.3 1-2.5M14 6.5c0-1.2 1-1.3 1-2.5"/>',
    chart: '<path d="M3 20h18"/><path d="M6 20v-7M11 20V5M16 20v-10"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>',
    sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
  };

  /** Inline SVG for one of the ICONS, sized in pixels. */
  function icon(n, size = 20) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
  }

  let toastTimer = null;

  /** Show a short message at the bottom of the screen for a few seconds. */
  function toast(msg) {
    let t = $("#toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  Object.assign(Chef, { $, main, esc, nice, cap, fmtNum, fmtVal, unitOf, axisLabel, pct, clone, nowIso, valid, PHASE_LABEL, phaseClass, ICONS, icon, toast });
})();
