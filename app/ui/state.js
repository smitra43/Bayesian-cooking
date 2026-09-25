/* Bayesian Chef · ui/state.js
 *
 * App state: the single object that describes what's on screen.
 *
 * `state` holds the experiments and every bit of view state (open tab,
 * proposals under review, draft scores…). Views read it; actions change it
 * and then call Chef.render(). `store` wraps localStorage for small
 * per-browser preferences (last tab, last experiment).
 */
(function () {
  "use strict";
  const Chef = (window.Chef = window.Chef || {});

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

  /** The experiment currently open, or null. */
  function cur() { return state.projects[state.currentId] || null; }

  /** The experiment's settings with every missing value filled from the defaults. */
  function settings(p) { return BC.mergeSettings(p && p.settings); }

  /** Clear per-experiment view state (proposals, drafts, open editors…) when switching experiments. */
  function resetViewState() {
    Object.assign(state, { proposals: null, preview: null, drafts: {}, expanded: null, cookStep: null, lastSession: null, editF: null, editO: null, sheet: null, checks: {} });
  }

  Object.assign(Chef, { state, store, cur, settings, resetViewState });
})();
