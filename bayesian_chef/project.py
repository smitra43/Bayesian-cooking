"""Project definition: factors (what you vary), outputs (what you measure), settings.

A project is a TOML file. Factors can be:

    continuous  a number in [low, high], optionally searched on a log scale
    integer     a whole number in [low, high]
    categorical one of a list of levels
    component   part of a mixture; components sharing a `group` must sum to
                that group's total in [mixtures] (e.g. a flour blend = 100 %)
"""

from __future__ import annotations

import math
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

Run = dict  # {factor name: value}

GOALS = ("maximize", "minimize", "target")


@dataclass
class Factor:
    """Something you change between runs (a number, whole number, choice or blend part)."""
    name: str
    type: str
    low: float = 0.0
    high: float = 1.0
    levels: list[str] = field(default_factory=list)
    log: bool = False
    unit: str = ""
    group: str = ""
    kind: str = ""  # free label: "composition", "process", ...

    def to_unit(self, v) -> float:
        """Rescale a value to 0–1 across this factor's range (log scale if set)."""
        v = float(v)
        if self.log:
            return (math.log(v) - math.log(self.low)) / (math.log(self.high) - math.log(self.low))
        return (v - self.low) / (self.high - self.low) if self.high > self.low else 0.0

    def from_unit(self, u: float) -> float:
        """The reverse of to_unit: a 0–1 position back to a real value."""
        if self.log:
            v = math.exp(math.log(self.low) + u * (math.log(self.high) - math.log(self.low)))
        else:
            v = self.low + u * (self.high - self.low)
        return float(round(v)) if self.type == "integer" else v

    def parse(self, raw):
        """Convert a value from the CSV log or user input to the right type."""
        if self.type == "categorical":
            return str(raw)
        v = float(raw)
        return float(round(v)) if self.type == "integer" else v

    def fmt(self, v) -> str:
        """Format a value with its unit for printing."""
        if self.type == "categorical":
            return str(v)
        if self.type == "integer":
            return f"{int(round(float(v)))}{self.unit and ' ' + self.unit}"
        return f"{float(v):.3g}{self.unit and ' ' + self.unit}"


@dataclass
class Output:
    """Something you measure for each run, with a goal and a range used for scoring."""
    name: str
    goal: str = "maximize"
    weight: float = 1.0
    target: float | None = None
    low: float | None = None   # expected range, used to score desirability
    high: float | None = None
    unit: str = ""
    how: str = ""              # measurement instructions shown at record time


@dataclass
class Project:
    """A whole experiment: factors, outputs, blends, baseline and settings, loaded from TOML."""
    name: str
    factors: list[Factor]
    outputs: list[Output]
    mixtures: dict[str, float] = field(default_factory=dict)
    baseline: Run | None = None
    batch_size: int = 4
    initial_runs: int = 8
    candidates: int = 1000
    tips: list[str] = field(default_factory=list)
    path: Path | None = None

    @classmethod
    def load(cls, path: str | Path) -> "Project":
        """Read and validate a project file."""
        path = Path(path)
        with open(path, "rb") as f:
            cfg = tomllib.load(f)
        factors = [Factor(**spec) for spec in cfg.get("factors", [])]
        outputs = [Output(**spec) for spec in cfg.get("outputs", [])]
        p = cls(
            name=cfg.get("name", path.stem),
            factors=factors,
            outputs=outputs,
            mixtures=cfg.get("mixtures", {}),
            baseline=cfg.get("baseline"),
            batch_size=cfg.get("batch_size", 4),
            initial_runs=cfg.get("initial_runs", max(6, 2 * len(factors))),
            candidates=cfg.get("candidates", 1000),
            tips=cfg.get("tips", []),
            path=path,
        )
        p.check()
        return p

    # ------------------------------------------------------------------ checks

    def check(self) -> None:
        """Raise ValueError with a clear message if the project definition is invalid."""
        if not self.factors:
            raise ValueError("Project needs at least one factor.")
        if not self.outputs:
            raise ValueError("Project needs at least one output.")
        names = [f.name for f in self.factors] + [o.name for o in self.outputs]
        if len(set(names)) != len(names):
            raise ValueError("Factor and output names must be unique.")
        for f in self.factors:
            if f.type not in ("continuous", "integer", "categorical", "component"):
                raise ValueError(f"{f.name}: unknown type {f.type!r}")
            if f.type == "categorical" and len(f.levels) < 2:
                raise ValueError(f"{f.name}: categorical factors need at least 2 levels")
            if f.type != "categorical" and not f.low < f.high:
                raise ValueError(f"{f.name}: need low < high")
            if f.log and f.low <= 0:
                raise ValueError(f"{f.name}: log scale needs low > 0")
            if f.type == "component" and f.group not in self.mixtures:
                raise ValueError(f"{f.name}: mixture group {f.group!r} has no total in [mixtures]")
        for group, total in self.mixtures.items():
            comps = self.components(group)
            if len(comps) < 2:
                raise ValueError(f"Mixture {group!r} needs at least 2 components")
            if not sum(c.low for c in comps) <= total <= sum(c.high for c in comps):
                raise ValueError(f"Mixture {group!r}: bounds cannot sum to {total}")
        for o in self.outputs:
            if o.goal not in GOALS:
                raise ValueError(f"{o.name}: goal must be one of {GOALS}")
            if o.goal == "target" and o.target is None:
                raise ValueError(f"{o.name}: goal 'target' needs a target value")
            if o.weight <= 0:
                raise ValueError(f"{o.name}: weight must be positive")
        if self.baseline:
            self.validate(self.baseline)

    def components(self, group: str) -> list[Factor]:
        """The factors that belong to one blend."""
        return [f for f in self.factors if f.type == "component" and f.group == group]

    def validate(self, run: Run) -> None:
        """Raise ValueError if a run breaks a range or a blend total."""
        for f in self.factors:
            if f.name not in run:
                raise ValueError(f"missing value for {f.name}")
            v = run[f.name]
            if f.type == "categorical":
                if v not in f.levels:
                    raise ValueError(f"{f.name}={v!r} not in {f.levels}")
            elif not f.low - 1e-9 <= float(v) <= f.high + 1e-9:
                raise ValueError(f"{f.name}={v} outside [{f.low}, {f.high}]")
        for group, total in self.mixtures.items():
            s = sum(float(run[c.name]) for c in self.components(group))
            if abs(s - total) > 1e-6 * max(1.0, total):
                raise ValueError(f"mixture {group!r} sums to {s:.4g}, must be {total}")

    # ---------------------------------------------------------------- sampling

    def sample(self, n: int, rng: np.random.Generator) -> list[Run]:
        """Space-filling random runs that satisfy bounds and mixture totals."""
        free = [f for f in self.factors if f.type in ("continuous", "integer")]
        runs: list[Run] = [{} for _ in range(n)]
        if free:
            from scipy.stats import qmc

            u = qmc.LatinHypercube(d=len(free), seed=rng).random(n)
            for run, row in zip(runs, u):
                for f, ui in zip(free, row):
                    run[f.name] = f.from_unit(ui)
        for f in self.factors:
            if f.type == "categorical":
                for run in runs:
                    run[f.name] = str(rng.choice(f.levels))
        for group, total in self.mixtures.items():
            comps = self.components(group)
            for run in runs:
                run.update(sample_mixture(comps, total, rng))
        return runs

    # ---------------------------------------------------------------- encoding

    def encode(self, runs: list[Run]) -> tuple[np.ndarray, np.ndarray]:
        """(numeric features scaled to [0,1], one-hot categorical features).

        One-hot columns are scaled by 1/sqrt(2) so two different levels sit
        at distance 1, matching the full span of a numeric factor.
        """
        num = [f for f in self.factors if f.type != "categorical"]
        cat = [f for f in self.factors if f.type == "categorical"]
        xn = np.array([[f.to_unit(r[f.name]) for f in num] for r in runs], dtype=float)
        xc = np.array(
            [[float(r[f.name] == lv) / math.sqrt(2) for f in cat for lv in f.levels] for r in runs], dtype=float
        )
        return (
            xn.reshape(len(runs), len(num)),
            xc.reshape(len(runs), sum(len(f.levels) for f in cat)),
        )


def sample_mixture(comps: list[Factor], total: float, rng: np.random.Generator) -> Run:
    """Random mixture within per-component bounds that sums exactly to total.

    Components are filled in random order; each draws uniformly from the
    range that still leaves the remaining components feasible.
    """
    order = rng.permutation(len(comps))
    remaining = total
    out: Run = {}
    for k, i in enumerate(order):
        c = comps[i]
        rest = [comps[j] for j in order[k + 1:]]
        if not rest:
            out[c.name] = remaining
            break
        lo = max(c.low, remaining - sum(r.high for r in rest))
        hi = min(c.high, remaining - sum(r.low for r in rest))
        v = rng.uniform(lo, hi)
        out[c.name] = v
        remaining -= v
    return out
