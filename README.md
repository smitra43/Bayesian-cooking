# Bayesian-cooking

A sandbox for discovering sauces with Bayesian optimisation. It works like
AI-aided materials discovery: a surrogate model of your palate proposes
recipes, you taste and score them, and the model updates.

The first search space covers **vinaigrette-style cold emulsions**
(`config/vinaigrette.toml`). You can choose the oil, the acid and an accent
(miso, fish sauce, gochujang...), plus the oil:acid ratio and the salt,
sweetener, mustard, garlic and accent levels.

## Loop

```bash
pip install -e '.[dev]'
python -m sauce_lab propose --k 5   # control + 5 new recipes, 40 g each, with blind codes
# make them, taste blind, fill in `score` (1-10) in data/log.csv for every code
python -m sauce_lab status          # what the model has learned
python -m sauce_lab propose --k 5   # next session
```

Optional columns: `separation_s` is the number of seconds until the emulsion
visibly splits. `notes` is free text. Both are logged but not modelled yet.

## Design choices

- **Every session includes a control recipe.** Scores are modelled as the
  difference from the control, which cancels day-to-day drift in your palate.
- **Samples are coded and blind.** Taste in the printed order, and don't look
  at which recipe is which.
- **The prior mean encodes rules of thumb**: about a 3:1 oil:acid ratio and
  about 1.5% salt. The model can overrule them once you have data. Turn them
  off under `[prior]` in the config.
- **A Gaussian process with a mixed kernel.** Continuous amounts use one
  lengthscale and categorical ingredients (one-hot) use another. The
  hyperparameters are fitted by MAP once there are 5 or more scored samples.
- **Batch Thompson sampling** picks each session's recipes, trading off
  "probably good" against "not yet known".

## Equipment

A 0.01 g scale. At 40 g batches, salt is around 0.6 g, and a kitchen scale
can't weigh that accurately.

## Sanity check

A simulated taster with a hidden preference was run for 8 sessions of 5
recipes, over 10 seeds. The best recipe found averaged +3.8 points above the
control with Bayesian optimisation and +3.0 with random search. The best
possible was about +4.9.
