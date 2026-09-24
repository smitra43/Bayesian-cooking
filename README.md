# Bayesian-cooking

A lightweight Bayesian workflow for iteratively refining recipes.

## Bread optimization workflow

The initial workflow in this repository focuses on bread experiments:

- define the recipe factors you want to explore (hydration, protein, flour mix, etc.)
- discretize each factor into a finite search space
- record bake outcomes as weighted metrics
- update posterior scores for each recipe candidate as new bakes are logged
- rank promising candidates and identify local optima in the discretized landscape

## Example

```python
from bayesian_cooking import (
    BayesianRecipeWorkflow,
    CategoricalFactor,
    ContinuousFactor,
    OutputMetric,
    RecipeObservation,
    RecipeSpace,
)

space = RecipeSpace(
    factors=[
        ContinuousFactor("hydration", minimum=60, maximum=75, step=5),
        ContinuousFactor("protein", minimum=11, maximum=13, step=1),
        CategoricalFactor("flour", values=("white", "whole_wheat")),
    ]
)

workflow = BayesianRecipeWorkflow(
    space=space,
    metrics=[
        OutputMetric("crumb", weight=0.4),
        OutputMetric("oven_spring", weight=0.4),
        OutputMetric("handling", weight=0.2),
    ],
    prior_mean=0.5,
)

workflow.register(
    RecipeObservation(
        parameters={"hydration": 70, "protein": 12, "flour": "white"},
        metrics={"crumb": 0.9, "oven_spring": 0.85, "handling": 0.7},
    )
)

next_trials = workflow.recommend_next_candidates(limit=3)
local_optima = workflow.discover_local_optima()
```

## Running tests

```bash
cd /home/runner/work/Bayesian-cooking/Bayesian-cooking
PYTHONPATH=src python -m unittest discover -s tests
```