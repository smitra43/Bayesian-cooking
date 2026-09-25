# Debugging guide

Something isn't working? This guide shows how to find out why, step by
step. Start with [the quick checks](#1-quick-checks), then look up your
symptom in [common problems](#3-common-problems).

**Contents**

1. [Quick checks](#1-quick-checks)
2. [Your tools](#2-your-tools)
3. [Common problems](#3-common-problems)
4. [Running and reading the tests](#4-running-and-reading-the-tests)
5. [Problems with GitHub (CI and the website)](#5-problems-with-github-ci-and-the-website)
6. [Problems with the command-line version](#6-problems-with-the-command-line-version)
7. [How to debug anything](#7-how-to-debug-anything)
8. [Reporting a bug](#8-reporting-a-bug)

---

## 1. Quick checks

Do these first. They solve most problems.

1. **Reload the page.** Your experiments are saved, so reloading is safe.
2. **Look at the dot next to the experiment menu** (top right). On a
   computer, hover over it to see its message:
   - green: all changes saved
   - yellow: saved in this browser only, or you're looking at the example
     (which is never saved)
   - red: not saved. The message says why.
3. **Check Setup for red "Needs fixing" messages.** An invalid range or
   blend stops the planner.
4. **Open the browser console** (next section) and look for red errors.

## 2. Your tools

### The browser console

Every browser has developer tools, with a **console** that shows errors and
lets you type JavaScript into the running page.

| Browser | Open the console with |
|---|---|
| Chrome, Edge | `F12`, or `Ctrl+Shift+J` (Windows) / `Cmd+Option+J` (Mac) |
| Firefox | `F12`, or `Ctrl+Shift+K` / `Cmd+Option+K` |
| Safari | enable **Develop** in Settings → Advanced, then `Cmd+Option+C` |

Red lines are errors. The file name and line number on the right (like
`actions.js:120`) tell you where in the code it happened; click it to jump
there.

Phones don't have an easy console, so reproduce the problem on a computer
when you can.

### Poking at the app from the console

The app exposes three objects on purpose, so you can inspect it:

- **`BC`**: the whole engine (every function from `app/engine/`).
- **`Chef`**: the whole interface (every function from `app/ui/`), plus
  `Chef.state`, the object everything on screen is drawn from.
- **`bcDebug`**: shortcuts to the live app.

Try these in the console:

```js
bcDebug.current()              // the experiment you're looking at, as a plain object
bcDebug.current().runs         // every run: recipe (x), scores (y), status
bcDebug.settings()             // the settings in use, with defaults filled in
bcDebug.state.tab              // which tab is open

BC.checkProject(bcDebug.current())          // list of setup problems ([] means fine)
BC.propose(bcDebug.current(), bcDebug.settings(), 3, 99)   // plan 3 recipes without saving
BC.fitAll(bcDebug.current(), bcDebug.settings()).models    // the fitted models, one per output

Chef.render()                               // redraw the screen from Chef.state
Chef.state.insights.view = "check"; Chef.render()   // jump straight to an Insights view

const ex = BC.exampleProject()              // a fresh copy of the omelette example to experiment on
BC.desirability({ goal: "maximize" }, 7, 1, 9)   // → 0.75
```

Changing `bcDebug.current()` directly changes what's on screen after the
next `bcDebug.render()`, but it isn't saved until the app saves it. Use a
copy (`JSON.parse(JSON.stringify(bcDebug.current()))`) if you just want to
experiment.

### Making problems repeatable

Proposals involve random numbers, so they differ each time. To make a
problem happen the same way twice, set **Advanced settings → Sessions →
Random seed** to any number, such as 42. The same seed and the same data
always give the same proposals. Clear it again afterwards.

### Seeing what's stored

In the console: `localStorage.getItem("bc:projects")` shows everything
saved in this browser as text. In Chrome you can also browse it under
Developer tools → **Application** → Local storage.

The keys are:

| Key | Holds |
|---|---|
| `bc:projects` | all your experiments |
| `bc:current` | the id of the experiment you last opened |
| `bc:tab` | the tab you last had open |

## 3. Common problems

| Symptom | Likely cause | Fix |
|---|---|---|
| Charts say "Charts couldn't load: app/vendor/plotly.min.js is missing…" | The chart library file is missing or damaged, usually from a partial copy of the folder. | Download or clone the repository again, or check that `app/vendor/plotly.min.js` exists (about 3.5 MB). Everything except the charts still works. |
| My experiments disappeared | You're in a different browser or a private window, you cleared site data, or you're on a different device. Browser storage belongs to one browser on one device. | Open the same browser you used before. If the data was cleared, **Log → Import backup** with your last backup. Back up regularly. |
| "Finish setting up" on the Cook tab | Something in Setup is invalid. The message lists what. | Fix each item in Setup. Common ones: lowest ≥ highest, a choice with fewer than 2 options, a "target" output with no target. |
| "Blend … the part ranges can't add up to 100" | The parts' lowest values add to more than the total, or their highest values add to less. | Widen the part ranges. For example, three parts with a total of 100 can't all have a lowest of 40. |
| "Couldn't plan: …" | An error while choosing recipes. The rest of the message says what. | Check Setup for problems. Try Advanced settings → Reset everything. If it persists, [report it](#8-reporting-a-bug) with the message. |
| Planning takes several seconds | Thompson sampling works with a large matrix: 600 candidates for every output. | Lower **Candidates scored** to 300, or choose the **Refine** preset (expected improvement is faster). |
| The same proposals every time | A random seed is set. | Clear **Advanced settings → Sessions → Random seed**. |
| It keeps proposing things like a recipe I rejected | The rejection zone is small, or turned off. | In **Advanced settings → Rejected recipes**, make sure it's on, then raise the radius or switch to "Exclude". |
| "Score at least one thing first" | You pressed save without entering any score. | Tap a rating or type a number. Use **Wasn't made** if you skipped that sample. |
| Model fit is near 0 or negative | Too few results, or your scores are noisy. | Normal early on. Keep tasting; taste blind and consistently. Check **Palate noise**: if it's large compared with your scale, your scores vary a lot for the same recipe. |
| "What matters" says a factor is 0% | Across the range you gave, that factor doesn't change the prediction much. | It may truly not matter, or its range is too narrow to show an effect. Consider fixing it or widening its range. |
| Nothing is saved when I open `index.html` as a file | Some browsers (notably Safari with certain privacy settings) don't allow saving for pages opened from disk. | Serve the folder instead: `python3 -m http.server -d app 8000`, then open http://localhost:8000. |
| Experiments saved from the file differ from the website's | Browsers keep separate storage for each site: the file on disk, localhost and the GitHub Pages site each have their own. | Move experiments with **Log → Back up experiment** and **Import backup**. |
| Blank page | A JavaScript error stopped the app starting, or a script file is missing. | Open the console and read the first red error. Then run `node --test app/tests/*.test.cjs`: the page tests report any missing file, broken script or undefined `Chef.` name. |
| "Chef.something is not a function" | A UI file calls a function that isn't published on `Chef`, or calls it before the file that defines it has loaded. | Check the function ends up in that file's `Object.assign(Chef, { … })` line, and that `index.html` loads the files in the right order. The page tests check both. |
| Red status dot: "Storage is full" | The browser or artifact storage limit is reached. | Back up, then delete old experiments in Setup. |

## 4. Running and reading the tests

Tests are small programs that check the code does what it should. Run them
after any change.

### App engine tests (JavaScript)

You need [Node.js](https://nodejs.org/) 20 or newer. From the repository
folder:

```bash
node --test app/tests/*.test.cjs
```

That runs both files: `engine.test.cjs` (the maths) and `site.test.cjs`
(the page: files exist, scripts parse, nothing loads from the internet).
A passing run ends like this:

```
# pass 31
# fail 0
```

A failure looks like this:

```
not ok 4 - maximin and MaxPro beat random designs
  ---
  error: '…what failed…'
  location: '/…/app/tests/engine.test.cjs:40:1'
```

It tells you **which test** (number 4, and its name), **what went wrong**,
and **where** (line 40 of the test file). Open that line to see what was
being checked, then work backwards into the engine function it calls.

To run just one test while you work on it:

```bash
node --test --test-name-pattern="MaxPro" app/tests/engine.test.cjs
```

### Python tests

You need Python 3.11 or newer.

```bash
pip install -e '.[dev]'
pytest -q                 # all tests
pytest -q -k beverage     # only tests with "beverage" in the name
pytest -q -x              # stop at the first failure
```

### After changing the engine

The example omelette data was produced by the engine. If you change how
recipes are proposed, regenerate it and rerun the tests:

```bash
node app/tools/build-example.cjs
node --test app/tests/*.test.cjs
```

## 5. Problems with GitHub (CI and the website)

### A red ✗ on a pull request

1. On the pull request, scroll to the checks and click **Details** next to
   the failed one (**Python CLI tests** or **App tests**).
2. Expand the red step to read the log. The failing test's name and error
   are near the bottom.
3. Run the same command on your computer (section 4) to reproduce it, fix
   it, and push again. CI reruns automatically.

### The website didn't update

1. Open the **Actions** tab on GitHub and find **Deploy app to GitHub
   Pages**.
2. If it says **skipped**, the repository is private. Free accounts can only
   publish Pages from public repositories.
3. If it failed, open it and read the red step. If the app tests failed,
   nothing is published, on purpose.
4. If it succeeded but you still see the old version, your browser is
   showing a cached copy. Do a hard refresh: `Ctrl+Shift+R` (Windows) or
   `Cmd+Shift+R` (Mac).
5. Check **Settings → Pages → Source** is set to **GitHub Actions**.

## 6. Problems with the command-line version

| Message or symptom | Meaning and fix |
|---|---|
| `ModuleNotFoundError: No module named 'tomllib'` | You're on Python older than 3.11. Upgrade Python. |
| `chef: command not found` | The package isn't installed. Run `pip install -e '.[dev]'` in the repository folder. |
| `… already exists (use --force to overwrite).` | `chef init` won't replace an existing file. Pick another name or add `--force`. |
| `N planned runs still need results. Here is that session again.` | You ran `chef next` before recording the last session. Run `chef record`, or add `--more` to plan extra runs anyway. |
| `Unknown output 'x'. Outputs: …` | A typo in `chef record ... x=7`. Use one of the listed names. |
| `No run with id or code '…'` | Check the code on your cooking sheet, or use the run id (`R003`). |
| `… is not a suggested output; pass --goal …` | For a custom output, give at least `--goal` (and ideally `--low`, `--high`, `--how`). |
| A `ValueError` when loading a project | The TOML file has an invalid value. The message names the factor or output. |

Your results live in a CSV next to the project file (for example
`lemonade.runs.csv`). You can open it in a spreadsheet to check or fix
values. Keep the column names unchanged.

## 7. How to debug anything

These habits work for any bug, in any program:

1. **Make it happen on purpose.** Write down the exact steps. If it only
   happens sometimes, set a random seed (section 2).
2. **Read the whole error message.** It usually says what went wrong and
   where. Search the codebase for the message text: every message in this
   app appears word for word in the code.
3. **Shrink the problem.** Does it happen with the example project? With a
   new blank experiment? With one factor instead of six? The smallest case
   that still fails points at the cause.
4. **Check your assumptions in the console.** Instead of guessing what a
   value is, print it: `bcDebug.current().factors`.
5. **Change one thing at a time**, then retest.
6. **Write a test for the bug** before fixing it, so it can't come back.
   Add it to `app/tests/engine.test.cjs` or `tests/test_chef.py`.

## 8. Reporting a bug

Open an issue on GitHub with:

- **what you did:** the exact steps,
- **what you expected** and **what happened instead**,
- **any red error** from the console (copy the text),
- your browser and device,
- if you can, a backup of the experiment (**Log → Back up experiment**),
  so someone else can load exactly your data.
