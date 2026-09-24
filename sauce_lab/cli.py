"""Command-line loop: propose a tasting session, then summarise what was learned.

    python -m sauce_lab propose --k 5   # write a new session to the log
    (taste blind, fill in the score column)
    python -m sauce_lab status          # fit the model, show best recipes
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

import numpy as np

from .model import GP, thompson_batch
from .space import Recipe, Space

EXTRA_COLS = ["session", "code", "is_control", "score", "separation_s", "notes"]


def read_log(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def write_log(path: Path, rows: list[dict], space: Space) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=EXTRA_COLS[:3] + space.names + EXTRA_COLS[3:])
        w.writeheader()
        w.writerows(rows)


def training_data(rows: list[dict], space: Space) -> tuple[list[Recipe], np.ndarray]:
    """Scored rows as recipes, with ratings relative to that session's control."""
    control_score = {
        r["session"]: float(r["score"]) for r in rows if r["is_control"] == "1" and r["score"].strip()
    }
    recipes, y = [], []
    for r in rows:
        if not r["score"].strip() or r["session"] not in control_score:
            continue
        recipe = {n: r[n] for n in space.categorical} | {c.name: float(r[c.name]) for c in space.continuous}
        recipes.append(recipe)
        y.append(float(r["score"]) - control_score[r["session"]])
    return recipes, np.array(y)


def fit(rows: list[dict], space: Space) -> GP:
    recipes, y = training_data(rows, space)
    x = space.encode(recipes)
    return GP.fit(x, y, space.prior_mean(recipes))


def propose(space: Space, rows: list[dict], k: int, rng: np.random.Generator) -> list[Recipe]:
    gp = fit(rows, space)
    cands = space.sample(space.n_candidates, rng)
    mean, cov = gp.posterior(space.encode(cands), space.prior_mean(cands))
    return [cands[i] for i in thompson_batch(mean, cov, k, rng)]


def cmd_propose(args, space: Space) -> None:
    rng = np.random.default_rng(args.seed)
    rows = read_log(args.log)
    unscored = [r for r in rows if not r["score"].strip()]
    if unscored and not args.force:
        raise SystemExit(f"{len(unscored)} rows in {args.log} have no score yet. Score them or pass --force.")

    session = max((int(r["session"]) for r in rows), default=0) + 1
    recipes = [space.control] + propose(space, rows, args.k, rng)
    codes = rng.choice(np.arange(100, 1000), size=len(recipes), replace=False)
    order = rng.permutation(len(recipes))

    print(f"Session {session}: {len(recipes)} samples of {space.batch_grams:g} g. Taste in this order, blind.\n")
    for i in order:
        r, code = recipes[i], int(codes[i])
        rows.append(
            {"session": session, "code": code, "is_control": int(i == 0)}
            | {n: (round(v, 3) if isinstance(v, float) else v) for n, v in r.items()}
            | {"score": "", "separation_s": "", "notes": ""}
        )
        print(f"[{code}]")
        for name, g in space.to_grams(r).items():
            print(f"    {g:6.2f} g  {name}")
        print()
    write_log(args.log, rows, space)
    print(f"Wrote session {session} to {args.log}. Fill in 'score' (1-10) for every code, "
          "including the control, then run `status` or `propose` again.")


def cmd_status(args, space: Space) -> None:
    rows = read_log(args.log)
    recipes, y = training_data(rows, space)
    if not len(y):
        raise SystemExit("No scored sessions yet. Run `propose` and score a session first.")
    gp = fit(rows, space)
    mean, cov = gp.posterior(space.encode(recipes), space.prior_mean(recipes))
    sd = np.sqrt(np.clip(np.diag(cov), 0, None))

    print(f"{len(y)} scored samples. Ratings are points relative to the control.\n")
    print("Fitted palate model:")
    for k, v in gp.h.items():
        print(f"    {k:9s} {v:.2f}")
    print("\nBest tasted recipes (model's estimate, which smooths out one-off noisy scores):")
    for i in np.argsort(-mean)[:5]:
        r = recipes[i]
        desc = f"{r['oil']} / {r['acid']} / {r['accent']}, ratio {r['oil_to_acid']:.1f}, salt {r['salt_pct']:.1f}%"
        print(f"    {mean[i]:+.1f} ± {sd[i]:.1f}  (raw {y[i]:+.0f})  {desc}")


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="sauce_lab")
    p.add_argument("--config", type=Path, default=Path("config/vinaigrette.toml"))
    p.add_argument("--log", type=Path, default=Path("data/log.csv"))
    sub = p.add_subparsers(dest="cmd", required=True)
    pp = sub.add_parser("propose", help="propose the next tasting session")
    pp.add_argument("--k", type=int, default=5, help="new recipes per session (plus the control)")
    pp.add_argument("--seed", type=int, default=None)
    pp.add_argument("--force", action="store_true", help="propose even if rows are unscored")
    sub.add_parser("status", help="fit the model and summarise results")
    args = p.parse_args(argv)

    space = Space.from_toml(args.config)
    {"propose": cmd_propose, "status": cmd_status}[args.cmd](args, space)
