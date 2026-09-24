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
    strength_jar: { category: "Sensory", goal: "target", target: 3, low: 1, high: 5, weight: 1, unit: "1-5", how: "Just-about-right strength (tea, coffee or alcohol): 1 much too weak, 3 just right, 5 much too strong." },
    spice_jar: { category: "Sensory", goal: "target", target: 3, low: 1, high: 5, weight: 1, unit: "1-5", how: "Just-about-right spice: 1 much too little, 3 just right, 5 much too much." },
    heat: { category: "Sensory", goal: "target", target: 5, low: 0, high: 10, weight: 1, unit: "0-10", how: "Heat: 0 none, 10 the most you can stand. Set the target to your ideal." },
    cook_loss_pct: { category: "Physical", goal: "minimize", low: 0, high: 40, weight: 1, unit: "%", how: "Weigh before and after cooking: (raw - cooked) / raw x 100." },
    core_temp_c: { category: "Physical", goal: "target", target: 60, low: 40, high: 90, weight: 1, unit: "°C", how: "Probe thermometer in the thickest part, straight after cooking." },
    height_mm: { category: "Physical", goal: "maximize", low: 0, high: 150, weight: 1, unit: "mm", how: "Ruler at the tallest point after cooling. Seed displacement if you want volume." },
    spread_ratio: { category: "Physical", goal: "target", target: 5, low: 2, high: 10, weight: 1, unit: "ratio", how: "Cookies and similar: diameter / height, after cooling." },
    ph: { category: "Physical", goal: "target", target: 3.6, low: 2.5, high: 5, weight: 1, unit: "pH", how: "Calibrated pH meter. Shelf-stable acidified sauces must be at or below 4.6; aim for 4.0 or lower." },
    brix: { category: "Physical", goal: "target", target: 10, low: 0, high: 40, weight: 1, unit: "°Bx", how: "Refractometer reading of dissolved solids (mostly sugar)." },
    line_spread_mm: { category: "Physical", goal: "target", target: 40, low: 10, high: 80, weight: 1, unit: "mm", how: "Line-spread test: fill a ring on a sheet of concentric circles, lift it, read the average spread after 60 s." },
    dilution_pct: { category: "Physical", goal: "target", target: 25, low: 0, high: 50, weight: 1, unit: "%", how: "Shaken or stirred drinks: weigh the build before ice and the strained drink after: (after - before) / before x 100." },
    serve_temp_c: { category: "Physical", goal: "target", target: 4, low: -2, high: 90, weight: 1, unit: "°C", how: "Thermometer in the glass right before tasting. Sweetness and bitterness perception shift with temperature." },
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
      name: "Omelette", folder: "Food", description: "Eggs, dairy, salt timing and pan heat.",
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
      name: "Yeasted loaf", folder: "Food", description: "Flour blend, hydration, salt, preferment, bulk rise.",
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
      name: "Vinaigrette", folder: "Food", description: "Oil, acid, ratio, salt and mustard.",
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
    // ---------------------------------------------------------- beverages
    lemonade: {
      name: "Lemonade", folder: "Beverages", description: "Water, lemon and sugar as a blend, plus salt, zest and sweetener.",
      factors: [
        { name: "water", type: "component", group: "drink", kind: "composition", low: 60, high: 84, unit: "% by weight" },
        { name: "lemon_juice", type: "component", group: "drink", kind: "composition", low: 8, high: 22, unit: "% by weight" },
        { name: "sweetener", type: "component", group: "drink", kind: "composition", low: 6, high: 16, unit: "% by weight" },
        { name: "sweetener_type", type: "categorical", kind: "composition", levels: ["cane_sugar", "honey", "agave"] },
        { name: "salt_pct", type: "continuous", kind: "composition", low: 0, high: 0.15, unit: "% of drink" },
        { name: "zest_g_per_l", type: "continuous", kind: "composition", low: 0, high: 4, unit: "g/L" },
      ],
      mixtures: { drink: 100 }, batchAmounts: { drink: { amount: 250, unit: "g" } },
      baseline: { water: 76, lemon_juice: 12, sweetener: 12, sweetener_type: "cane_sugar", salt_pct: 0.05, zest_g_per_l: 1 },
      outputs: [out("liking"), out("sweet_jar"), out("sour_jar"), out("brix", { target: 11, low: 4, high: 18, weight: 0.5, how: "Refractometer on the finished drink. Most commercial lemonades sit around 10-12 °Bx." })],
      settings: { batchSize: 4, initialRuns: 10 },
      tips: [
        "Make 250 g of each sample and chill all of them to the same fridge temperature for at least an hour. Colder drinks taste less sweet.",
        "Juice lemons on the day and strain the pulp; lemon juice loses its fresh aroma within hours.",
        "Dissolve the sweetener fully (stir until the liquid is clear) before judging sweetness.",
        "Serve 30-40 ml pours. Four samples of a sweet-sour drink is plenty per sitting.",
      ],
    },
    chai: {
      name: "Masala chai", folder: "Beverages", description: "Tea, milk, sugar, spices and simmer time, per 250 ml cup.",
      factors: [
        { name: "tea_g", type: "continuous", kind: "composition", low: 2, high: 6, unit: "g per cup" },
        { name: "tea_type", type: "categorical", kind: "composition", levels: ["assam_ctc", "assam_leaf", "darjeeling"] },
        { name: "milk_pct", type: "continuous", kind: "composition", low: 20, high: 60, unit: "% of liquid" },
        { name: "sugar_g", type: "continuous", kind: "composition", low: 0, high: 20, unit: "g per cup" },
        { name: "ginger_g", type: "continuous", kind: "composition", low: 0, high: 8, unit: "g fresh, grated" },
        { name: "cardamom_pods", type: "integer", kind: "composition", low: 0, high: 6, unit: "pods, crushed" },
        { name: "cinnamon_g", type: "continuous", kind: "composition", low: 0, high: 1.5, unit: "g stick" },
        { name: "simmer_min", type: "continuous", kind: "process", low: 3, high: 15, unit: "min" },
      ],
      mixtures: {},
      baseline: { tea_g: 4, tea_type: "assam_ctc", milk_pct: 40, sugar_g: 10, ginger_g: 3, cardamom_pods: 3, cinnamon_g: 0.5, simmer_min: 6 },
      outputs: [out("liking"), out("strength_jar", { how: "Tea strength: 1 much too weak, 3 just right, 5 much too strong or bitter." }), out("spice_jar"), out("sweet_jar", { weight: 0.5 })],
      settings: { batchSize: 3, initialRuns: 12 },
      tips: [
        "Eight factors is a lot for a drink you make one cup at a time. Fix any you already know (for example the tea type) in the Pantry to cut the runs needed.",
        "Keep the pan, heat setting and lid the same every time; evaporation changes strength as much as tea weight does.",
        "Strain and let every sample cool to about 60 °C before tasting. Hot liquid dulls sweetness and makes bitterness harder to judge.",
        "Rinse with room-temperature water between cups. Milk fat coats the mouth, so wait a full minute.",
      ],
    },
    margarita: {
      name: "Margarita", folder: "Beverages", description: "Tequila, lime, orange liqueur and agave as a blend, plus shake time and salt.",
      factors: [
        { name: "tequila", type: "component", group: "build", kind: "composition", low: 40, high: 60, unit: "% of build" },
        { name: "lime_juice", type: "component", group: "build", kind: "composition", low: 20, high: 35, unit: "% of build" },
        { name: "orange_liqueur", type: "component", group: "build", kind: "composition", low: 10, high: 30, unit: "% of build" },
        { name: "agave_syrup", type: "component", group: "build", kind: "composition", low: 0, high: 12, unit: "% of build" },
        { name: "tequila_type", type: "categorical", kind: "composition", levels: ["blanco", "reposado"] },
        { name: "liqueur_type", type: "categorical", kind: "composition", levels: ["triple_sec", "dry_curacao"] },
        { name: "shake_s", type: "continuous", kind: "process", low: 8, high: 20, unit: "s" },
        { name: "saline_drops", type: "integer", kind: "composition", low: 0, high: 4, unit: "drops of 20% saline" },
      ],
      mixtures: { build: 100 }, batchAmounts: { build: { amount: 90, unit: "ml" } },
      baseline: { tequila: 50, lime_juice: 25, orange_liqueur: 20, agave_syrup: 5, tequila_type: "blanco", liqueur_type: "triple_sec", shake_s: 12, saline_drops: 1 },
      outputs: [out("liking"), out("sour_jar"), out("sweet_jar"), out("strength_jar", { how: "Alcohol strength: 1 much too weak or watery, 3 just right, 5 much too boozy." }), out("dilution_pct", { weight: 0.5 })],
      settings: { batchSize: 3, initialRuns: 10, replicateEvery: 4 },
      tips: [
        "Only if you're of legal drinking age, and never before driving.",
        "Three tasting pours of 25 ml add up to about one standard drink. Keep to 3 samples per session and spit if you can; scores drift upward as alcohol builds.",
        "Build each drink at 90 ml, shake with the same amount of ice from the same freezer, strain, and pour 25 ml to taste.",
        "Squeeze limes within the hour and strain; lime juice changes character fast.",
        "Drink a glass of water and eat something plain before the session, and water between samples.",
      ],
    },
    blank: {
      name: "New experiment", folder: "Start from scratch", description: "Start from scratch.",
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
      outputs: t.outputs, settings: BC.mergeSettings(t.settings), tips: t.tips || [], batchAmounts: t.batchAmounts || {}, runs: [], sessions: 0, createdAt: now, updatedAt: now,
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
