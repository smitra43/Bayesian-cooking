/* Bayesian Chef · ui/app.js
 *
 * The app shell: tabs, the header, render(), and start-up.
 *
 * render() rebuilds the visible tab from state. Start-up loads the
 * example experiment, draws the page, then connect()s to storage.
 *
 * Loaded last, after every other UI file.
 */
(function () {
  "use strict";
  const Chef = (window.Chef = window.Chef || {});
  // Helpers from earlier files, unpacked for readability.
  const { $, main, esc, icon, state, store, cur, settings } = Chef;

  const TABS = [
    { id: "cook", label: "Cook", icon: "pot" },
    { id: "insights", label: "Insights", icon: "chart" },
    { id: "log", label: "Log", icon: "list" },
    { id: "setup", label: "Setup", icon: "sliders" },
  ];

  const OLD_TABS = { kitchen: "cook", logbook: "log", pantry: "setup", knobs: "cook", guide: "cook" };

  /** Rebuild the visible tab from state. Call it after any change. */
  function render() {
    renderTop();
    const p = cur();
    main.className = state.tab === "insights" ? "wide" : "";
    if (!p) { main.innerHTML = emptyView(); Chef.renderSheet(); return; }
    const views = { cook: Chef.cookView, insights: Chef.insightsView, log: Chef.logView, setup: Chef.setupView };
    try {
      main.innerHTML = (views[state.tab] || Chef.cookView)(p);
    } catch (e) {
      console.error(e);
      main.innerHTML = `<div class="notice bad">Something went wrong drawing this page: ${esc(e.message)}. Check Setup for an invalid value.</div>`;
    }
    Chef.renderSheet();
    // Charts need the page drawn first, and Plotly loaded (only happens once).
    if (state.tab === "insights") requestAnimationFrame(() => Chef.ensurePlotly(() => Chef.drawInsights(p)));
  }

  /** Update the header: experiment menu, tab buttons and status dot. */
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

  /** Colour and label the save-status dot. */
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

  /** What to show when there are no experiments at all. */
  function emptyView() {
    return `<header class="page-head"><h1>Start your first experiment</h1><p class="sub">Pick a template or start from scratch. You can change everything afterwards.</p></header>
      <div><button class="btn primary lg" data-act="new-project">New experiment</button></div>`;
  }

  // Redraw charts when the theme changes.
  const redraw = () => { if (state.tab === "insights" && cur()) Chef.ensurePlotly(() => Chef.drawInsights(cur())); };

  try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw); } catch (e) { /* old browsers */ }

  new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // Register these before start-up runs: storage calls Chef.render() while loading.
  Object.assign(Chef, { TABS, OLD_TABS, render, renderTop, renderStatus, emptyView, redraw });

  // ---------------------------------------------------------------- start-up
  // 1. Always have the example available (it's only saved if you edit it).
  state.projects.example = BC.exampleProject();
  // 2. Reopen the tab you last used (old tab names from earlier versions still work).
  const savedTab = store.get("bc:tab", "cook");
  state.tab = OLD_TABS[savedTab] || savedTab;
  if (!TABS.some((t) => t.id === state.tab)) state.tab = "cook";
  // 3. Show the example straight away; connect() switches to your last experiment once storage loads.
  state.currentId = "example";

  // For debugging in the browser console: bcDebug.current(), bcDebug.state, bcDebug.render().
  window.bcDebug = { state, current: cur, render, settings: () => settings(cur()) };

  // 4. Draw the page, then load saved experiments (which draws again).
  render();
  Chef.connect();
})();
