# Code tour

This guide walks through how the code is organised, what happens when you
press a button, where your data goes, and how to add things. It assumes you
can read basic JavaScript or Python. If a concept is unfamiliar, the
[How it works](how-it-works.md) guide explains the ideas.

**Contents**

1. [The big picture](#1-the-big-picture)
2. [The engine, file by file](#2-the-engine-file-by-file)
3. [The user interface](#3-the-user-interface)
4. [Following one click: "Plan session"](#4-following-one-click-plan-session)
5. [Where your data lives](#5-where-your-data-lives)
6. [Tests, CI and the website](#6-tests-ci-and-the-website)
7. [How to add things](#7-how-to-add-things)
8. [The Python command-line version](#the-python-command-line-version)

---

## 1. The big picture

The app is plain HTML, CSS and JavaScript. There's no framework (no React,
no Vue) and no build step: the browser runs the files exactly as they are.
The only outside library is **Plotly**, for charts, loaded from a CDN.

```mermaid
flowchart TB
    subgraph Browser
        HTML[index.html<br/>layout + styles]
        UI[ui/app.js<br/>screens, clicks, saving, charts]
        subgraph Engine[engine/ — the maths, attached to window.BC]
            core[core.js<br/>random numbers, linear algebra]
            space[space.js<br/>factors, designs, PCA]
            models[models.js<br/>Gaussian process, regression]
            opt[optimize.js<br/>scoring, proposals]
            ana[analytics.js<br/>charts' numbers]
            lib[library.js<br/>templates, tasting guide]
        end
        Store[(localStorage or<br/>artifact database)]
        Plotly[Plotly from CDN]
    end
    HTML --> UI
    UI --> Engine
    UI --> Store
    UI --> Plotly
```

The key design rule: **the engine knows nothing about the screen**. Every
engine function takes plain data (a project object) and returns plain data.
That's why the engine can be tested in Node.js without a browser, and why
all the maths bugs can be found by the test suite.

### How the files connect

`index.html` loads the scripts in this order, at the bottom of the file:

```
plotly (CDN) → core.js → space.js → models.js → optimize.js → analytics.js
            → library.js → example-data.js → ui/app.js
```

Each engine file starts like this:

```js
(function () {
  const BC = (globalThis.BC = globalThis.BC || {});
  // ... functions ...
  Object.assign(BC, { design, encode, ... });
})();
```

It creates (or reuses) one shared object, `BC` (Bayesian Chef), and adds
its functions to it. Later files use earlier ones through `BC`, which is
why the order matters: `optimize.js` needs `BC.fitGP` from `models.js`.
`globalThis` is `window` in a browser and the global object in Node, so the
same file works in both places.

## 2. The engine, file by file

### `core.js`: basic tools

| Function | What it does |
|---|---|
| `Rng(seed)` | a random number generator you can **seed**. The same seed always gives the same sequence, so results can be reproduced. It provides `uniform()`, `normal()` (bell-curve numbers), `int(n)`, `choice(list)` and `permutation(n)`. |
| `cholesky`, `choleskyJitter`, `cholSolve`, `cholInverse` | matrix tools the Gaussian process needs. A Cholesky factor is a matrix "square root", the standard stable way to solve the GP's equations. `choleskyJitter` adds a tiny number to the diagonal if the matrix is numerically fragile. |
| `symEig` | eigenvalues and eigenvectors, used by PCA |
| `nelderMead(f, x0)` | minimises a function without needing its slope, used to fit GP settings |
| `mean`, `sd`, `normCdf`, `pearson` | basic statistics |

### `space.js`: recipes as numbers

| Function | What it does |
|---|---|
| `checkProject(p)`, `checkRun(p, x)` | return a list of plain-English problems (empty list = valid). The Setup screen and planner show these. |
| `sample(p, n, rng, method)` | `n` random recipes (Latin hypercube, Halton or random) that respect every range and blend total |
| `sampleMixture` | a random blend that adds up exactly to its total |
| `encode(p, runs)` | turns recipes into rows of numbers between 0 and 1 (choices become one-hot switches) |
| `design(p, existing, k, rng, method)` | the initial design. `maxpro` and `maximin` call `optimizeLHS`, which swaps values in a Latin hypercube to spread it better. |
| `perturb(p, x, rng, radius)` | a nearby variation of a recipe, used for local search |
| `designQuality(p, runs)` | closest-pair distance, worst coverage gap, strongest correlation between factors |
| `fitPCA(X, options)` | principal component analysis with truncation by variance kept or by number of components |

### `models.js`: the surrogate models

Both models return an object with the same methods, so the rest of the
code doesn't care which one you picked:

| Method | Returns |
|---|---|
| `predict(Xs, full)` | the predicted mean and variance at new recipes. With `full = true` it also returns the full covariance, which Thompson sampling needs. |
| `toY(z)` | converts from the model's internal rescaled units back to your units (e.g. liking 1–9) |
| `loo()` | leave-one-out predictions, for the Model check chart |
| `condition(x, z)` | a copy of the model with one extra pretend data point, used by the kriging-believer strategy |
| `info` | fitted hyperparameters and diagnostics |

- `fitGP(X, y, cols, opts)` builds a Gaussian process. It rescales the
  outputs, sets up the hyperparameters (lengthscales, signal, noise), and
  if there are at least `minPointsToFit` results, searches for the best ones
  with Nelder–Mead from several starting points. `KERNELS` holds the five
  kernel formulas.
- `fitBLR` builds Bayesian polynomial regression, learning its two
  precision settings with MacKay's evidence updates.
- `fitModel` picks one based on the settings.

### `optimize.js`: scoring and proposing

| Function | What it does |
|---|---|
| `DEFAULT_SETTINGS`, `mergeSettings(s)` | every setting and its default. `mergeSettings` fills any missing setting with the default, so old saved projects keep working when new settings are added. |
| `desirability`, `combine`, `runScore` | the scoring described in How it works, section 4 |
| `fitAll(p, s)` | fits one model per output from all tasted runs |
| `candidatePool(p, s, rng)` | about 600 candidate recipes: mostly spread out, some near your best |
| `noGoFactors` | lowers candidates that are close to recipes you rejected |
| `propose(p, s, k, sessionNo)` | **the main entry point.** Returns `k` proposals for the next session. |
| `acquire(p, s, k, rng)` | the model-driven part of `propose`: Thompson sampling, or EI/UCB/PI with a batch strategy |

`propose` decides which phase you're in:

```mermaid
flowchart TD
    A[propose] --> B{Baseline set and<br/>not cooked yet?}
    B -- yes --> C[add baseline first]
    B -- no --> D
    C --> D{Fewer runs than the<br/>initial design size,<br/>or no results yet?}
    D -- yes --> E[design: spread-out recipes]
    D -- no --> F{Repeat session?<br/>every 3rd}
    F -- yes --> G[reserve a slot for<br/>your best recipe]
    F -- no --> H
    G --> H[acquire: model picks]
```

### `analytics.js`: the numbers behind the charts

`progress`, `mainEffects`, `surface`, `diagnostics`, `runPCA`,
`correlations`, `pareto` and `replicates` each compute one chart's data.
`adviseSettings` produces the warnings in Advanced settings, such as
"ARD needs more results".

### `library.js` and `example-data.js`: content

- `TEMPLATES`: the starter experiments, each with a `folder` (Food or
  Beverages), factors, blends, baseline, outputs, settings and tasting
  `tips`.
- `OUTPUT_LIBRARY`: suggested measurements with instructions.
- `PROTOCOL` and `REFERENCES`: the tasting guide and its sources.
- `exampleProject()`: the omelette example. Simulating it is slow, so it's
  generated once by `app/tools/build-example.cjs` and saved in
  `example-data.js`.

## 3. The user interface

Everything on screen comes from `app/ui/app.js`. It uses one simple
pattern throughout:

1. **All state lives in one object**, `state`: which tab is open, the
   projects, the proposals being reviewed, draft scores, and so on.
2. **`render()` rebuilds the screen from `state`.** Each tab has a *view
   function* (`cookView`, `insightsView`, `logView`, `setupView`) that
   returns an HTML string. `render()` puts that string into `<main>`.
3. **Clicks are handled in one place.** Buttons carry a `data-act`
   attribute, like `<button data-act="plan">`. A single click listener on
   the whole document reads `data-act` and runs the matching action from a
   lookup table. This is called *event delegation*.
4. **An action changes `state` or the project, calls `save()` if data
   changed, then calls `render()` again.**

So to find what a button does: look up its `data-act` value in the big
`const A = { ... }` table inside the click listener near the bottom of
`app.js`.

Other attributes follow the same idea:

| Attribute | Used for |
|---|---|
| `data-tab` | switching tabs |
| `data-bind` | draft values: scores being typed, proposal edits |
| `data-f`, `data-o` | editing a factor or output in Setup (`"index:field"`) |
| `data-k` | an Advanced setting, as a path like `gp.kernel` |
| `data-ins` | Insights chart controls |

Charts are drawn after each render by `drawInsights`, which only computes
the chart for the view you've selected. Chart colours come from the CSS
variables in `index.html` (read with `tok("--honey")` and similar), so they
follow light and dark mode.

**Security note:** every piece of user text goes through `esc()` before it's
put into HTML. That stops a recipe name like `<script>` from running as
code.

## 4. Following one click: "Plan session"

Here's the whole journey when you press **Plan session 12**:

1. The button is `<button data-act="plan">`. The click listener finds
   `A.plan` and calls `planSession()`.
2. `planSession` sets `state.planning = true` and renders, so you see
   "Choosing recipes…". It then waits 30 milliseconds (`setTimeout`) so the
   browser can actually paint that message before the heavy maths starts.
3. It calls `BC.propose(project, settings, batchSize, 12)`.
4. `propose` (in `optimize.js`) sees the model phase, so it calls
   `acquire`, which:
   - fits a Gaussian process per output (`fitAll` → `fitGP`),
   - builds 600 candidates (`candidatePool`),
   - draws a plausible curve for each output and picks the best candidate
     (Thompson sampling), 3 times.
5. The proposals come back as a list of `{ x: recipe, phase, why,
   predictions }`. `planSession` stores them in `state.proposals`, each
   marked "approve".
6. `render()` runs again. Because `state.proposals` exists, `cookView`
   shows `reviewView` instead of the plan card.
7. When you press **Start session**, `startSession()` turns each approved
   proposal into a **run** with `status: "planned"`, a unique 3-digit
   code, and a random tasting position (`taste`). Rejected ones become runs
   with `status: "rejected"` and your reason in `notes`.
8. `save(project)` stores it (next section) and the Cook tab switches to
   the Prep step.

## 5. Where your data lives

### The project object

Everything about one experiment is a single JSON object:

```json
{
  "id": "k3j9x2ab…",
  "name": "My lemonade",
  "template": "lemonade",
  "factors": [
    { "name": "lemon_juice", "type": "component", "group": "drink", "low": 8, "high": 22, "unit": "% by weight" },
    { "name": "sweetener_type", "type": "categorical", "levels": ["cane_sugar", "honey", "agave"] }
  ],
  "mixtures": { "drink": 100 },
  "batchAmounts": { "drink": { "amount": 250, "unit": "g" } },
  "baseline": { "water": 76, "lemon_juice": 12, "…": "…" },
  "outputs": [
    { "name": "liking", "goal": "maximize", "low": 1, "high": 9, "weight": 2, "unit": "1-9", "how": "…" }
  ],
  "settings": { "batchSize": 4, "acquisition": "thompson", "gp": { "kernel": "matern52" }, "…": "…" },
  "tips": ["Chill every sample…"],
  "sessions": 3,
  "runs": [
    {
      "id": "R001", "session": 1, "status": "done", "phase": "baseline",
      "code": "349", "taste": 2,
      "x": { "water": 76, "lemon_juice": 12, "…": "…" },
      "y": { "liking": 7, "sweet_jar": 3 },
      "notes": "", "why": "Your current recipe, cooked first as the reference."
    }
  ],
  "createdAt": "…", "updatedAt": "…"
}
```

- `x` holds the recipe (factor values). `y` holds your scores (outputs).
- `status` is `planned` (to taste), `done` (tasted) or `rejected`.
- `phase` says why the run exists: `baseline`, `doe` (initial design), `bo`
  (model pick), `replicate`, `manual` (you edited it) or `not-made`.

**Log → Back up experiment** saves exactly this object as a `.json` file,
and **Import backup** loads one.

### Saving

`save(project)` updates `updatedAt`, then:

- **On GitHub Pages or your own computer:** it writes every project to the
  browser's `localStorage` under the key `bc:projects`. That storage belongs
  to this browser on this device, so clearing site data deletes it. Keep
  backups.
- **When the page runs inside claude.ai as an artifact:** `connect()` finds
  the artifact's database through `window.claude.use("db")` and saves each
  project as the document `projects/<id>`, with live sync across devices.
  Writes are queued so only one write per project runs at a time.

Two small extra keys: `bc:current` remembers the last experiment you
opened, and `bc:tab` the last tab.

The example project is never saved until you change it.

## 6. Tests, CI and the website

### Engine tests: `app/tests/engine.test.cjs`

Run with `node --test app/tests/engine.test.cjs`. The file loads the engine
files into Node and checks, among other things:

- the matrix maths solves equations correctly,
- every sample and design respects ranges and blend totals,
- optimised designs beat random ones,
- every kernel fits a known smooth function,
- ARD gives the relevant factor the shorter lengthscale,
- every acquisition method returns valid, distinct recipes,
- rejected recipes push proposals away,
- the model beats the initial design at finding a hidden best recipe,
- every template (including all Beverages) is valid.

### Python tests: `tests/test_chef.py`

Run with `pytest -q`. They cover the command-line version, including a full
simulated plan, record and status loop.

### CI: `.github/workflows/ci.yml`

On every pull request, GitHub runs both test suites on a fresh machine. A
red ✗ on the pull request means a test failed; click **Details** to see
which one.

### The website: `.github/workflows/pages.yml`

On every push to `main`:

1. run the engine tests,
2. run `app/tools/build-site.sh`, which copies the app into `_site/` and
   wraps `index.html` in a complete HTML page (`<!doctype html>`, `<head>`,
   character set, viewport). `app/index.html` doesn't have those itself
   because it's written as page content that a host wraps, so the build
   script adds them,
3. publish `_site/` to GitHub Pages.

## 7. How to add things

### A new template

1. Open `app/engine/library.js` and add an entry to `TEMPLATES`. Copy an
   existing one (lemonade is a good model) and change it. Give it a
   `folder` so it appears in the right group.
2. Run the engine tests. The "every template is valid" test checks your
   ranges, blends, baseline and outputs automatically.
3. For the command-line version, add a TOML file in
   `bayesian_chef/templates/` and its name to `TEMPLATES` in
   `bayesian_chef/cli.py`.

### A new suggested measurement

Add an entry to `OUTPUT_LIBRARY` in `app/engine/library.js` with a
`category`, `goal`, `low`, `high`, `unit` and a clear `how`. It appears in
Setup and in the Guide automatically. (For the command line, add it to
`OUTPUT_LIBRARY` in `bayesian_chef/guidance.py`.)

### A new kernel

1. Add a function to `KERNELS` in `app/engine/models.js`. It receives the
   squared scaled distance `r2` (and `alpha`, for kernels that need an extra
   setting) and must return 1 when `r2` is 0, falling towards 0 as `r2`
   grows.
2. Add it to the kernel `<select>` in `settingsSheet` in `app/ui/app.js`.
3. Add its name to the kernel list in `engine.test.cjs`, so it's tested
   against a known smooth function.

### A new acquisition method

Add a `case` to the `switch (s.acquisition)` block in `acquire`
(`app/engine/optimize.js`). You get Monte Carlo samples of each candidate's
overall score in `samples`; return one number where higher means "cook this
next". Then add it to the acquisition `<select>` in `settingsSheet` and to
the acquisition test loop.

### After changing the engine

The example omelette data was produced by the engine. If you change how
proposals are chosen, regenerate it with `node app/tools/build-example.cjs`
and rerun the tests.

---

## The Python command-line version

`bayesian_chef/` is a terminal version of the same idea. It's smaller than
the app: greedy maximin initial designs, one Gaussian process per output
(RBF-style kernel with separate lengthscales for numbers and choices), and
batch Thompson sampling.

| File | What it does |
|---|---|
| `project.py` | reads and checks the TOML project file; factors, outputs, blends, sampling, encoding |
| `model.py` | the Gaussian process, with hyperparameters fitted by maximum a posteriori (scipy) |
| `optimize.py` | desirability scoring, space-filling design, Thompson sampling proposals |
| `store.py` | the run log: a CSV file saved next to the project (`lemonade.runs.csv`) |
| `guidance.py` | the tasting protocol and suggested measurements |
| `cli.py` | the `chef` commands |

### Commands

```bash
chef init lemonade.toml --template beverages/lemonade   # start from a template
chef next lemonade.toml          # propose a session; approve / edit / reject each run
chef record lemonade.toml        # enter results interactively
chef record lemonade.toml 503 liking=7   # or record by tasting code
chef status lemonade.toml        # best runs, noise estimates, model's best untested guess
chef outputs                     # list suggested measurements
chef add-output lemonade.toml salt_jar   # add one to the project
chef protocol                    # print the full tasting protocol
```

### The project file

```toml
name = "Omelette"
batch_size = 2       # runs per session
initial_runs = 8     # initial design size before the model takes over
tips = ["Use the same pan every time."]   # printed with each session

[[factors]]          # type: continuous | integer | categorical | component
name = "pan_temp_c"
type = "continuous"
kind = "process"
low = 120
high = 200

[[factors]]
name = "fat"
type = "categorical"
levels = ["butter", "ghee", "olive_oil"]

[baseline]           # optional: your current recipe, cooked first as the reference
pan_temp_c = 160
fat = "butter"

[[outputs]]          # goal: maximize | minimize | target
name = "texture_jar"
goal = "target"
target = 3
low = 1
high = 5
weight = 1
how = "Just-about-right: 1 much too runny, 3 just right, 5 much too firm."
```

- **Blends:** give each part `type = "component"` and the same `group`,
  and set the total under `[mixtures]`, for example `flour = 100`. See
  `bayesian_chef/templates/bread.toml`.
- **Log scale:** add `log = true` to a factor, for ratios where doubling
  matters more than adding.
- **Custom outputs:** `chef add-output lemonade.toml crunch --goal maximize --low 0 --high 10 --how "..."`,
  or edit the TOML directly.
