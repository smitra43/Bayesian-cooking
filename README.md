# Bayesian Chef

Design of experiments and Bayesian optimisation for cooking, with you in the
loop. You define what you vary (composition and process parameters, with
ranges) and what you measure. The tool first plans a space-filling initial
design, then proposes each session's runs using a model of your results. You
approve, edit, or reject every proposal before you cook it.

## Quick start

```bash
pip install -e '.[dev]'

chef init omelette.toml --template omelette   # or: blank, bread, vinaigrette
# edit omelette.toml: factors, ranges, outputs

chef next omelette.toml      # propose a session; approve / edit / reject each run
# cook, taste blind in the printed order, measure
chef record omelette.toml    # enter results (or: chef record omelette.toml 503 liking=7)
chef status omelette.toml    # best runs, noise estimates, model's best untested guess
chef next omelette.toml      # repeat
```

## Project file

```toml
name = "Omelette"
batch_size = 2       # runs per session
initial_runs = 8     # initial design size before the model takes over

[[factors]]          # continuous | integer | categorical | component
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
...

[[outputs]]          # goal = maximize | minimize | target
name = "texture_jar"
goal = "target"
target = 3
low = 1
high = 5
weight = 1
how = "Just-about-right: 1 much too runny, 3 just right, 5 much too firm."
```

- **Mixtures:** use `type = "component"` with a shared `group`, and set the
  group total under `[mixtures]` (e.g. `flour = 100`). Proposals always sum
  to that total. See `bayesian_chef/templates/bread.toml`.
- **Log scale:** set `log = true` on a factor for things like ratios, where
  doubling matters more than adding a fixed amount.
- **Outputs:** `chef outputs` lists suggested measures (sensory,
  physical, practical). `chef add-output PROJECT NAME` copies one into your
  project. Add a custom one with
  `chef add-output PROJECT crunch --goal maximize --low 0 --high 10 --how "..."`,
  or edit the TOML directly.

## How it works

1. **Initial design:** greedy maximin selection from a Latin-hypercube
   pool. Each new run is as far as possible from every run already made or
   planned, so the space is covered evenly. Your baseline recipe comes first.
2. **Model:** one Gaussian process per output. Numeric factors are scaled to
   [0, 1] and categorical levels are one-hot encoded, each with its own
   lengthscale. The hyperparameters have weak priors and are fitted once an
   output has at least 5 results.
3. **Scoring:** each output is mapped to a 0-1 desirability using its goal
   and range. These are combined as a weighted geometric mean, so a result
   has to be good on every output to score well.
4. **Proposals:** batch Thompson sampling. For each slot, a plausible
   response surface is sampled from the model and the best candidate on it
   is picked. This balances exploring against exploiting without any extra
   settings.
5. **Replicates:** every third session, one slot re-runs your best recipe so
   far, so the tool can estimate how noisy your measurements are.
6. **Rejections** are logged with your reason. That gives a record of
   regions you consider infeasible.

## Tasting protocol

Printed with every session (`chef protocol` shows all of it). Highlights:
no food, coffee, gum or mint for 30-60 minutes beforehand; taste when
neither hungry nor full; blind 3-digit codes in randomised order; water and
unsalted crackers between samples; at most 4-6 samples per session. The
sources are listed in `bayesian_chef/guidance.py`.
