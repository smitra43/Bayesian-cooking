"""Initial design (space-filling DOE) and Bayesian-optimisation proposals."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .model import GP
from .project import Output, Project, Run

FLOOR = 0.01  # desirability floor, so one bad output doesn't zero everything


def flat(x: tuple[np.ndarray, np.ndarray]) -> np.ndarray:
    return np.hstack(x)


# ---------------------------------------------------------------- desirability

def output_range(o: Output, observed: np.ndarray) -> tuple[float, float]:
    lo = o.low if o.low is not None else (float(observed.min()) if len(observed) else 0.0)
    hi = o.high if o.high is not None else (float(observed.max()) if len(observed) else 1.0)
    if hi <= lo:
        lo, hi = lo - 1.0, hi + 1.0
    return lo, hi


def desirability(o: Output, y: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """Map an output to [0, 1], where 1 is ideal (Derringer-style)."""
    if o.goal == "maximize":
        d = (y - lo) / (hi - lo)
    elif o.goal == "minimize":
        d = (hi - y) / (hi - lo)
    else:
        d = 1 - np.abs(y - o.target) / max(o.target - lo, hi - o.target, 1e-9)
    return np.clip(d, 0.0, 1.0)


def combine(ds: list[np.ndarray], weights: list[float]) -> np.ndarray:
    """Weighted geometric mean of per-output desirabilities."""
    w = np.array(weights) / sum(weights)
    return np.exp(sum(wi * np.log(np.maximum(d, FLOOR)) for wi, d in zip(w, ds)))


def overall_scores(project: Project, results: list[dict]) -> np.ndarray:
    """Combined desirability of recorded runs (outputs missing from a run are skipped)."""
    scores = []
    ranges = {o.name: output_range(o, observed(results, o)) for o in project.outputs}
    for r in results:
        ds, ws = [], []
        for o in project.outputs:
            if r.get(o.name) is not None:
                ds.append(desirability(o, np.array([r[o.name]]), *ranges[o.name]))
                ws.append(o.weight)
        scores.append(float(combine(ds, ws)[0]) if ds else np.nan)
    return np.array(scores)


def observed(results: list[dict], o: Output) -> np.ndarray:
    return np.array([r[o.name] for r in results if r.get(o.name) is not None], dtype=float)


# ------------------------------------------------------------------------- DOE

def space_filling(project: Project, existing: list[Run], k: int, rng: np.random.Generator) -> list[Run]:
    """Greedy maximin design: each new run is as far as possible from all others."""
    pool = project.sample(max(project.candidates, 20 * k), rng)
    xp = flat(project.encode(pool))
    chosen: list[int] = []
    anchors = flat(project.encode(existing)) if existing else np.empty((0, xp.shape[1]))
    for _ in range(k):
        if len(anchors):
            dmin = np.sqrt(((xp[:, None, :] - anchors[None, :, :]) ** 2).sum(-1)).min(1)
        else:  # first point: the one closest to the centre of the pool
            dmin = -np.sqrt(((xp - xp.mean(0)) ** 2).sum(1))
        dmin[chosen] = -np.inf
        i = int(np.argmax(dmin))
        chosen.append(i)
        anchors = np.vstack([anchors, xp[i]])
    return [pool[i] for i in chosen]


# -------------------------------------------------------------------------- BO

@dataclass
class Proposal:
    run: Run
    score: float                                 # predicted combined desirability
    predictions: dict[str, tuple[float, float]]  # output -> (mean, sd)


def fit_models(project: Project, results: list[dict]) -> dict[str, GP]:
    models = {}
    for o in project.outputs:
        rows = [r for r in results if r.get(o.name) is not None]
        if rows:
            models[o.name] = GP.fit(project.encode([r["run"] for r in rows]), [r[o.name] for r in rows])
    return models


def propose(project: Project, results: list[dict], k: int, rng: np.random.Generator) -> list[Proposal]:
    """Batch Thompson sampling on combined desirability.

    `results` holds dicts with key "run" (factor values) plus output values.
    Each pick draws one joint posterior sample of every output over a pool of
    candidates, scores the pool, and takes the best not-yet-chosen candidate.
    """
    models = fit_models(project, results)
    pool = project.sample(project.candidates, rng)
    xp = project.encode(pool)
    outs = [o for o in project.outputs if o.name in models]
    ranges = {o.name: output_range(o, observed(results, o)) for o in outs}

    post = {}
    for o in outs:
        mean, cov = models[o.name].posterior(xp)
        l = np.linalg.cholesky(cov + 1e-6 * np.eye(len(mean)) * max(1.0, np.diag(cov).max()))
        post[o.name] = (mean, np.sqrt(np.clip(np.diag(cov), 0, None)), l)

    chosen: list[int] = []
    for _ in range(k):
        ds = []
        for o in outs:
            mean, _, l = post[o.name]
            draw = mean + l @ rng.standard_normal(len(mean))
            ds.append(desirability(o, draw, *ranges[o.name]))
        score = combine(ds, [o.weight for o in outs])
        score[chosen] = -np.inf
        chosen.append(int(np.argmax(score)))

    expected = combine(
        [desirability(o, post[o.name][0], *ranges[o.name]) for o in outs], [o.weight for o in outs]
    )
    return [
        Proposal(
            run=pool[i],
            score=float(expected[i]),
            predictions={o.name: (float(post[o.name][0][i]), float(post[o.name][1][i])) for o in outs},
        )
        for i in chosen
    ]


def best_guess(project: Project, results: list[dict], rng: np.random.Generator) -> Proposal | None:
    """The untested candidate with the highest expected desirability (pure exploitation)."""
    models = fit_models(project, results)
    if not models:
        return None
    pool = project.sample(project.candidates, rng)
    xp = project.encode(pool)
    outs = [o for o in project.outputs if o.name in models]
    preds = {o.name: models[o.name].posterior(xp) for o in outs}
    ds = [desirability(o, preds[o.name][0], *output_range(o, observed(results, o))) for o in outs]
    score = combine(ds, [o.weight for o in outs])
    i = int(np.argmax(score))
    return Proposal(
        run=pool[i],
        score=float(score[i]),
        predictions={
            o.name: (float(preds[o.name][0][i]), float(np.sqrt(max(preds[o.name][1][i, i], 0)))) for o in outs
        },
    )
