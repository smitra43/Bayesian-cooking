"""Recipe search space: sampling, feature encoding, and conversion to grams."""

from __future__ import annotations

import math
import tomllib
from dataclasses import dataclass
from pathlib import Path

import numpy as np

Recipe = dict  # {variable name: category string or float}


@dataclass
class Continuous:
    name: str
    low: float
    high: float
    log: bool = False

    def to_unit(self, v: float) -> float:
        if self.log:
            return (math.log(v) - math.log(self.low)) / (math.log(self.high) - math.log(self.low))
        return (v - self.low) / (self.high - self.low)

    def from_unit(self, u: float) -> float:
        if self.log:
            return math.exp(math.log(self.low) + u * (math.log(self.high) - math.log(self.low)))
        return self.low + u * (self.high - self.low)


@dataclass
class Space:
    continuous: list[Continuous]
    categorical: dict[str, list[str]]
    control: Recipe
    prior: dict
    batch_grams: float
    n_candidates: int

    @classmethod
    def from_toml(cls, path: str | Path) -> "Space":
        with open(path, "rb") as f:
            cfg = tomllib.load(f)
        continuous = [Continuous(name, **spec) for name, spec in cfg["continuous"].items()]
        space = cls(
            continuous=continuous,
            categorical=cfg["categorical"],
            control=cfg["control"],
            prior=cfg.get("prior", {}),
            batch_grams=cfg.get("batch_grams", 40.0),
            n_candidates=cfg.get("candidates", 1000),
        )
        space.validate(space.control)
        return space

    @property
    def names(self) -> list[str]:
        return list(self.categorical) + [c.name for c in self.continuous]

    def validate(self, r: Recipe) -> None:
        for name, options in self.categorical.items():
            if r[name] not in options:
                raise ValueError(f"{name}={r[name]!r} not in {options}")
        for c in self.continuous:
            if not c.low <= float(r[c.name]) <= c.high:
                raise ValueError(f"{c.name}={r[c.name]} outside [{c.low}, {c.high}]")

    def sample(self, n: int, rng: np.random.Generator) -> list[Recipe]:
        out = []
        for _ in range(n):
            r = {name: str(rng.choice(opts)) for name, opts in self.categorical.items()}
            for c in self.continuous:
                r[c.name] = c.from_unit(rng.uniform())
            out.append(r)
        return out

    def encode(self, recipes: list[Recipe]) -> tuple[np.ndarray, np.ndarray]:
        """Return (continuous features in [0,1], one-hot categorical features).

        One-hot columns are scaled by 1/sqrt(2) so two different categories
        sit at distance 1. accent_pct is zeroed when there is no accent, so
        the model does not learn from a meaningless value.
        """
        cont = np.array([
            [0.0 if c.name == "accent_pct" and r.get("accent") == "none" else c.to_unit(float(r[c.name]))
             for c in self.continuous]
            for r in recipes
        ])
        cat = np.array([
            [float(r[name] == opt) / math.sqrt(2) for name, opts in self.categorical.items() for opt in opts]
            for r in recipes
        ])
        n_cat = sum(len(opts) for opts in self.categorical.values())
        return cont.reshape(len(recipes), len(self.continuous)), cat.reshape(len(recipes), n_cat)

    def prior_mean(self, recipes: list[Recipe]) -> np.ndarray:
        """Rules-of-thumb prior, in rating points relative to the control."""
        p = self.prior
        if not p:
            return np.zeros(len(recipes))

        def penalty(r: Recipe) -> float:
            doublings = math.log2(float(r["oil_to_acid"]) / p.get("ratio_center", 3.0))
            return (
                p.get("ratio_weight", 0.0) * doublings ** 2
                + p.get("salt_weight", 0.0) * (float(r["salt_pct"]) - p.get("salt_center", 1.5)) ** 2
                + p.get("sweet_weight", 0.0) * float(r["sweet_pct"]) ** 2
            )

        base = penalty(self.control)
        return np.array([base - penalty(r) for r in recipes])

    def to_grams(self, r: Recipe) -> dict[str, float]:
        """Scale a recipe to batch_grams total, returning grams per ingredient."""
        pct = {c.name: float(r[c.name]) for c in self.continuous if c.name.endswith("_pct")}
        if r.get("accent") == "none":
            pct["accent_pct"] = 0.0
        base = self.batch_grams / (1 + sum(pct.values()) / 100)
        ratio = float(r["oil_to_acid"])
        grams = {
            f"oil ({r['oil']})": base * ratio / (1 + ratio),
            f"acid ({r['acid']})": base / (1 + ratio),
        }
        for name, v in pct.items():
            label = name.removesuffix("_pct")
            if label == "accent":
                label = f"accent ({r['accent']})"
            if v > 0:
                grams[label] = base * v / 100
        return grams
