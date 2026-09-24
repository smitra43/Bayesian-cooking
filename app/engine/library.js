/* Templates, suggested output measures, tasting protocol, and an example
 * project with simulated results. */
(function () {
  const BC = (globalThis.BC = globalThis.BC || {});

  const HEDONIC = "9-point hedonic scale: 1 dislike extremely, 5 neither like nor dislike, 9 like extremely.";

  const OUTPUT_LIBRARY = {
    liking: { category: "Sensory", goal: "maximize", low: 1, high: 9, weight: 2, unit: "1-9", how: HEDONIC },
    vs_control: { category: "Sensory", goal: "maximize", low: -3, high: 3, weight: 1, unit: "-3..+3", how: "Compared with the reference sample: -3 much worse, 0 same, +3 much better." },
    salt_jar: { category: "Sensory", goal: "target", target: 3, low: 1, high: 5, weight: 1, unit: "1-5", how: "Just-about-right: 1 much too little salt, 3 just right, 5 much too much." },
    sweet_jar: { category: "Sensory", goal: "target", target: 3, low: 1, high: 5, weight: 1, unit: "1-5", how: "Just-about-right: 1 much too little sweetness, 3 just right, 5 much too much." },
    sour_jar: { category: "Sensory", goal: "target", target: 3, low: 1, high: 5, weight: 1, unit: "1-5", how: "Just-about-right: 1 much too little sourness, 3 just right, 5 much too much." },
    texture_jar: { category: "Sensory", goal: "target", target: 3, low: 1, high: 5, weight: 1, unit: "1-5", how: "Just-about-right for texture: 1 much too soft or runny, 3 just right, 5 much too firm." },
    heat: { category: "Sensory", goal: "target", target: 5, low: 0, high: 10, weight: 1, unit: "0-10", how: "Heat: 0 none, 10 the most you can stand. Set the target to your ideal." },
    cook_loss_pct: { category: "Physical", goal: "minimize", low: 0, high: 40, weight: 1, unit: "%", how: "Weigh before and after cooking: (raw - cooked) / raw x 100." },
    core_temp_c: { category: "Physical", goal: "target", target: 60, low: 40, high: 90, weight: 1, unit: "°C", how: "Probe thermometer in the thickest part, straight after cooking." },
    height_mm: { category: "Physical", goal: "maximize", low: 0, high: 150, weight: 1, unit: "mm", how: "Ruler at the tallest point after cooling. Seed displacement if you want volume." },
    spread_ratio: { category: "Physical", goal: "target", target: 5, low: 2, high: 10, weight: 1, unit: "ratio", how: "Cookies and similar: diameter / height, after cooling." },
    ph: { category: "Physical", goal: "target", target: 3.6, low: 2.5, high: 5, weight: 1, unit: "pH", how: "Calibrated pH meter. Shelf-stable acidified sauces must be at or below 4.6; aim for 4.0 or lower." },
    brix: { category: "Physical", goal: "target", target: 10, low: 0, high: 40, weight: 1, unit: "°Bx", how: "Refractometer reading of dissolved solids (mostly sugar)." },
    line_spread_mm: { category: "Physical", goal: "target", target: 40, low: 10, high: 80, weight: 1, unit: "mm", how: "Line-spread test: fill a ring on a sheet of concentric circles, lift it, read the average spread after 60 s." },
    separation_s: { category: "Physical", goal: "maximize", low: 0, high: 3600, weight: 1, unit: "s", how: "Emulsions: seconds until a visible layer separates in a clear jar." },
    browning_L: { category: "Physical", goal: "target", target: 55, low: 20, high: 90, weight: 1, unit: "L*", how: "Photo beside a grey card under the same light each time; read L* lightness with a colour-picker app." },
    crumb_open_pct: { category: "Physical", goal: "maximize", low: 0, high: 50, weight: 1, unit: "%", how: "Photo of the cut face; hole area as a % of the slice (ImageJ threshold)." },
    active_min: { category: "Practical", goal: "minimize", low: 0, high: 60, weight: 1, unit: "min", how: "Hands-on minutes, not waiting time." },
    cost: { category: "Practical", goal: "minimize", low: 0, high: 10, weight: 1, unit: "$", how: "Ingredient cost per serving." },
  };

  const PROTOCOL = [
    { when: "60 min before", tips: [
      "No food, coffee, alcohol, smoking, gum or mint (toothpaste, mouthwash). Water is fine. Sensory panels use 30 minutes as the minimum; 60 is safer after strong or spicy food.",
      "Taste when you're neither hungry nor full; mid-morning or mid-afternoon works well. Hunger makes everything taste better and inflates scores (Cabanac 1971).",
      "Skip perfume, scented lotion and scented hand soap. They interfere with aroma.",
    ] },
    { when: "Setup", tips: [
      "Weigh everything. Use a 0.01 g scale for anything under about 5 g (salt, spices, yeast).",
      "Make every sample the same size and serve them all at the same temperature.",
      "Label samples only with their 3-digit codes. If someone can plate them for you, taste fully blind.",
      "Have room-temperature water and plain unsalted crackers ready to cleanse your palate (Lucak & Delwiche 2009).",
    ] },
    { when: "During", tips: [
      "Taste in the order shown. It's randomised because the first sample in a session tends to be scored differently (MacFie et al. 1989).",
      "Score each sample before moving on, and don't go back to change scores.",
      "Between samples, sip water, eat a bit of cracker and wait 30-60 s. After rich, salty or spicy samples, wait 2-3 min.",
      "Keep to 4-6 samples per session. After that, taste fatigue makes scores noisy.",
      "For spicy food, taste the mildest first if you can tell. Capsaicin burn carries over to the next sample.",
    ] },
    { when: "After", tips: [
      "Record every result right away, including the samples you disliked. Low scores are data too.",
      "Note anything unusual (a swapped ingredient, the oven running hot, tasting while hungry).",
      "Every few sessions the app repeats your best recipe. The gap between the two scores shows how consistent your palate is.",
    ] },
  ];

  const REFERENCES = [
    "Lawless & Heymann, Sensory Evaluation of Food, 2nd ed. (Springer, 2010)",
    "Meilgaard, Civille & Carr, Sensory Evaluation Techniques, 5th ed. (CRC, 2016)",
    "Peryam & Pilgrim (1957), Food Technology 11:9-14 (the 9-point hedonic scale)",
    "Cabanac (1971), Science 173:1103-1107 (hunger changes how pleasant food tastes)",
    "MacFie et al. (1989), J. Sensory Studies 4:129-148 (serving-order effects)",
    "Lucak & Delwiche (2009), Chemosensory Perception 2:32-39 (palate cleansers)",
    "Joseph, Gul & Ba (2015), Biometrika 102:371-380 (MaxPro designs)",
  ];

  function out(name, extra = {}) { const { category, ...o } = OUTPUT_LIBRARY[name]; return { name, ...o, ...extra }; }

  const TEMPLATES = {
    omelette: {
      name: "Omelette", description: "Eggs, dairy, salt timing and pan heat.",
      factors: [
        { name: "eggs", type: "integer", kind: "composition", low: 2, high: 4, unit: "eggs" },
        { name: "dairy_g_per_egg", type: "continuous", kind: "composition", low: 0, high: 15, unit: "g" },
        { name: "salt_pct", type: "continuous", kind: "composition", low: 0.5, high: 1.5, unit: "% of egg" },
        { name: "salt_rest_min", type: "integer", kind: "process", low: 0, high: 20, unit: "min" },
        { name: "pan_temp_c", type: "continuous", kind: "process", low: 120, high: 200, unit: "°C" },
        { name: "fat", type: "categorical", kind: "composition", levels: ["butter", "ghee", "olive_oil"] },
      ],
      mixtures: {},
      baseline: { eggs: 3, dairy_g_per_egg: 0, salt_pct: 1.0, salt_rest_min: 0, pan_temp_c: 160, fat: "butter" },
      outputs: [out("liking"), out("texture_jar", { how: "Just-about-right: 1 much too runny, 3 just right, 5 much too firm or rubbery." }), out("cook_loss_pct", { high: 20, weight: 0.5 })],
      settings: { batchSize: 2 },
    },
    bread: {
      name: "Yeasted loaf", description: "Flour blend, hydration, salt, preferment, bulk rise.",
      factors: [
        { name: "bread_flour", type: "component", group: "flour", kind: "composition", low: 50, high: 100, unit: "%" },
        { name: "whole_wheat", type: "component", group: "flour", kind: "composition", low: 0, high: 50, unit: "%" },
        { name: "hydration_pct", type: "continuous", kind: "composition", low: 65, high: 82, unit: "% of flour" },
        { name: "salt_pct", type: "continuous", kind: "composition", low: 1.6, high: 2.4, unit: "% of flour" },
        { name: "preferment_pct", type: "continuous", kind: "composition", low: 0, high: 40, unit: "% of flour" },
        { name: "bulk_rise_pct", type: "continuous", kind: "process", low: 30, high: 100, unit: "% rise" },
      ],
      mixtures: { flour: 100 }, baseline: null,
      outputs: [out("height_mm", { low: 50, high: 130 }), out("crumb_open_pct", { low: 5, high: 40 }), out("liking")],
      settings: { batchSize: 3 },
    },
    vinaigrette: {
      name: "Vinaigrette", description: "Oil, acid, ratio, salt and mustard.",
      factors: [
        { name: "oil_to_acid", type: "continuous", kind: "composition", low: 1, high: 5, log: true, unit: "ratio" },
        { name: "salt_pct", type: "continuous", kind: "composition", low: 0.5, high: 3, unit: "% of base" },
        { name: "mustard_pct", type: "continuous", kind: "composition", low: 0, high: 12, unit: "% of base" },
        { name: "oil", type: "categorical", kind: "composition", levels: ["olive", "neutral", "walnut"] },
        { name: "acid", type: "categorical", kind: "composition", levels: ["red_wine_vinegar", "sherry_vinegar", "lemon"] },
      ],
      mixtures: {}, baseline: { oil_to_acid: 3, salt_pct: 1.5, mustard_pct: 5, oil: "olive", acid: "red_wine_vinegar" },
      outputs: [out("liking"), out("separation_s", { high: 600 })],
      settings: { batchSize: 5 },
    },
    blank: {
      name: "New experiment", description: "Start from scratch.",
      factors: [
        { name: "salt_pct", type: "continuous", kind: "composition", low: 0.5, high: 2.5, unit: "%" },
        { name: "cook_min", type: "integer", kind: "process", low: 5, high: 20, unit: "min" },
      ],
      mixtures: {}, baseline: null, outputs: [out("liking")], settings: {},
    },
  };

  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

  function fromTemplate(key, name) {
    const t = JSON.parse(JSON.stringify(TEMPLATES[key]));
    const now = new Date().toISOString();
    return {
      id: uid(), name: name || t.name, template: key, factors: t.factors, mixtures: t.mixtures, baseline: t.baseline,
      outputs: t.outputs, settings: BC.mergeSettings(t.settings), runs: [], sessions: 0, createdAt: now, updatedAt: now,
    };
  }

  /** Example omelette project with simulated results, for a first look. */
  function exampleProject() {
    if (BC.EXAMPLE_PROJECT) return JSON.parse(JSON.stringify(BC.EXAMPLE_PROJECT));
    return simulateExample();
  }

  function simulateExample() {
    const p = fromTemplate("omelette", "Example: Sunday omelette");
    p.id = "example"; p.example = true;
    p.settings.seed = 42;
    p.settings.batchSize = 3;
    p.settings.initialRuns = 10;
    const rng = BC.Rng(2024);
    const taste = (x) => 8.2 - ((x.pan_temp_c - 158) / 22) ** 2 - 0.9 * (x.eggs - 3) ** 2 - ((x.salt_pct - 1.05) / 0.35) ** 2
      + 0.04 * x.salt_rest_min - 0.02 * (x.dairy_g_per_egg - 5) ** 2 + (x.fat === "butter" ? 0.4 : x.fat === "ghee" ? 0.2 : -0.6);
    const texture = (x) => 3 + (x.pan_temp_c - 160) / 18 - x.dairy_g_per_egg / 8 + 0.3 * (x.eggs - 3);
    const loss = (x) => 6 + (x.pan_temp_c - 120) / 10 - 0.2 * x.dairy_g_per_egg;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const t0 = Date.parse("2026-08-02T10:30:00Z");
    for (let sess = 1; sess <= 11; sess++) {
      const props = BC.propose(p, p.settings, p.settings.batchSize, sess);
      const codes = [];
      props.forEach((pr, j) => {
        let code; do { code = String(100 + rng.int(900)); } while (codes.includes(code)); codes.push(code);
        const x = pr.x;
        const run = {
          id: `R${String(p.runs.length + 1).padStart(3, "0")}`, session: sess, status: "done", phase: pr.phase, code,
          x, y: {
            liking: Math.round(clamp(taste(x) + 0.5 * rng.normal(), 1, 9)),
            texture_jar: Math.round(clamp(texture(x) + 0.35 * rng.normal(), 1, 5)),
            cook_loss_pct: +clamp(loss(x) + 0.8 * rng.normal(), 0, 30).toFixed(1),
          },
          notes: "", why: pr.why, created: new Date(t0 + (sess * 3 + j * 0.01) * 86400000).toISOString(),
        };
        p.runs.push(run);
      });
      p.sessions = sess;
    }
    p.settings.seed = null;
    return p;
  }

  Object.assign(BC, { OUTPUT_LIBRARY, PROTOCOL, REFERENCES, TEMPLATES, fromTemplate, exampleProject, simulateExample, uid });
})();
