"""Bayesian Chef command line.

    chef init omelette.toml --template omelette   start a project
    chef next omelette.toml                       propose a session, approve/edit/reject each run
    chef record omelette.toml                     enter measurements for planned runs
    chef status omelette.toml                     what has been learned so far
    chef outputs                                  suggested output measures
    chef add-output omelette.toml salt_jar        add a suggested or custom output
    chef protocol                                 full tasting protocol
"""

from __future__ import annotations

import argparse
import shutil
import sys
from importlib import resources
from pathlib import Path

import numpy as np

from . import guidance
from .optimize import best_guess, overall_scores, propose, space_filling
from .project import Project, Run
from .store import Log, Record

TEMPLATES = (
    "blank", "omelette", "bread", "vinaigrette",
    "beverages/lemonade", "beverages/chai", "beverages/margarita",
)
REPLICATE_EVERY = 3  # sessions


def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    try:
        ans = input(f"{prompt}{suffix}: ").strip()
    except EOFError:
        ans = ""
    return ans or default


def describe(project: Project, run: Run, indent: str = "    ") -> str:
    width = max(len(f.name) for f in project.factors)
    return "\n".join(f"{indent}{f.name:<{width}}  {f.fmt(run[f.name])}" for f in project.factors)


# --------------------------------------------------------------------- init

def cmd_init(args) -> None:
    dest = Path(args.project)
    if dest.exists() and not args.force:
        sys.exit(f"{dest} already exists (use --force to overwrite).")
    src = resources.files("bayesian_chef").joinpath("templates", *f"{args.template}.toml".split("/"))
    with resources.as_file(src) as p:
        shutil.copy(p, dest)
    Project.load(dest)
    print(f"Created {dest} from the '{args.template}' template.")
    print("Edit the factors, ranges, and outputs, then run: chef next", dest)


# --------------------------------------------------------------------- next

def cmd_next(args) -> None:
    project = Project.load(args.project)
    log = Log(project)
    rng = np.random.default_rng(args.seed)

    planned = log.by_status("planned")
    if planned and not args.more:
        print(f"{len(planned)} planned runs still need results. Here is that session again.\n")
        print_session(project, planned)
        print("\nRecord results with: chef record", args.project, "  (or pass --more to plan extra runs)")
        return

    n = args.n or project.batch_size
    session = log.next_session()
    proposals = make_proposals(project, log, n, session, rng)
    approved = approve(project, proposals, log, session, assume_yes=args.yes)
    if not approved:
        log.save()
        print("Nothing approved; no session planned.")
        return

    codes = rng.choice(np.arange(100, 1000), size=len(approved), replace=False)
    for rec, code in zip(approved, codes):
        rec.code = str(int(code))
    order = [approved[i] for i in rng.permutation(len(approved))]
    log.records = [r for r in log.records if r not in approved] + order
    log.save()
    print()
    print_session(project, order)


def make_proposals(project: Project, log: Log, n: int, session: int, rng) -> list[tuple[Run, str, str]]:
    """Return (run, phase, explanation) tuples."""
    active = [r for r in log.records if r.status != "rejected"]
    results = log.results()
    out: list[tuple[Run, str, str]] = []

    if project.baseline and not any(r.phase == "baseline" for r in active):
        out.append((dict(project.baseline), "baseline", "your current recipe, as the reference point"))

    remaining_doe = project.initial_runs - len(active) - len(out)
    if remaining_doe > 0 or not results:
        k = n - len(out)
        runs = space_filling(project, [r.run for r in active] + [run for run, _, _ in out], k, rng)
        left = max(remaining_doe, 0)
        for i, run in enumerate(runs):
            why = f"initial design ({left - i} left after this)" if i < left else "space-filling (no results yet)"
            out.append((run, "doe", why))
        return out

    k = n - len(out)
    replicate = None
    if session % REPLICATE_EVERY == 0 and k > 1:
        done = log.by_status("done")
        scores = overall_scores(project, [{"run": r.run, **r.outputs} for r in done])
        if len(done) and not np.all(np.isnan(scores)):
            replicate = done[int(np.nanargmax(scores))]
            k -= 1
    for p in propose(project, results, k, rng):
        preds = ", ".join(f"{o} ≈ {m:.3g} ± {s:.2g}" for o, (m, s) in p.predictions.items())
        out.append((p.run, "bo", f"model pick, expected score {p.score:.2f} ({preds})"))
    if replicate:
        out.append((dict(replicate.run), "replicate", f"repeat of your best run {replicate.run_id}, to measure noise"))
    return out


def approve(project: Project, proposals, log: Log, session: int, assume_yes: bool) -> list[Record]:
    approved: list[Record] = []
    approve_all = assume_yes
    print(f"Session {session}: {len(proposals)} proposed runs.\n")
    for i, (run, phase, why) in enumerate(proposals, 1):
        print(f"Proposal {i}/{len(proposals)}: {why}")
        print(describe(project, run))
        choice = "a" if approve_all else ask("[a]pprove  [e]dit  [r]eject  [A]pprove all  [q]uit", "a")
        if choice == "q":
            break
        if choice == "A":
            approve_all, choice = True, "a"
        if choice == "r":
            reason = ask("Why reject? (optional, saved in notes)")
            rec = log.add(run, session, phase, status="rejected")
            rec.notes = reason
            print()
            continue
        if choice == "e":
            run = edit_run(project, run)
            phase = "manual"
        approved.append(log.add(run, session, phase))
        print()
    return approved


def edit_run(project: Project, run: Run) -> Run:
    while True:
        new = dict(run)
        for f in project.factors:
            hint = f"{'/'.join(f.levels)}" if f.type == "categorical" else f"{f.low:g}-{f.high:g}"
            raw = ask(f"  {f.name} ({hint})", str(run[f.name]) if f.type == "categorical" else f"{run[f.name]:.4g}")
            try:
                new[f.name] = f.parse(raw)
            except ValueError:
                new[f.name] = raw
        try:
            project.validate(new)
            return new
        except ValueError as e:
            print(f"  Invalid: {e}. Try again.")


def print_session(project: Project, recs: list[Record]) -> None:
    print("=" * 60)
    print("COOKING SHEET: make each run, label it only with its code")
    print("=" * 60)
    for r in sorted(recs, key=lambda r: r.run_id):
        print(f"{r.run_id}  code {r.code}  ({r.phase})")
        print(describe(project, r.run))
    print()
    print("TASTING ORDER (blind): " + "  ->  ".join(r.code for r in recs))
    print()
    print("MEASURE AND RECORD for each code:")
    for o in project.outputs:
        goal = o.goal if o.goal != "target" else f"target {o.target:g}"
        print(f"  - {o.name} [{o.unit or 'value'}, {goal}]: {o.how}")
    if project.tips:
        print()
        print(f"For {project.name}:")
        for tip in project.tips:
            print(f"  - {tip}")
    print()
    print(guidance.protocol_text(["60 min before", "Setup", "During"]))


# ------------------------------------------------------------------- record

def cmd_record(args) -> None:
    project = Project.load(args.project)
    log = Log(project)
    names = {o.name for o in project.outputs}

    if args.run:
        rec = find(log, args.run)
        for item in args.values:
            key, _, val = item.partition("=")
            if key not in names:
                sys.exit(f"Unknown output {key!r}. Outputs: {', '.join(sorted(names))}")
            rec.outputs[key] = float(val)
        if any(v is not None for v in rec.outputs.values()):
            rec.status = "done"
        log.save()
        print(f"Saved {rec.run_id}: " + ", ".join(f"{k}={v:g}" for k, v in rec.outputs.items() if v is not None))
        return

    planned = log.by_status("planned")
    if not planned:
        print("No planned runs waiting for results. Run: chef next", args.project)
        return
    print("Enter results. Leave blank to skip a value, or type 'x' if the run was never made.\n")
    for rec in planned:
        print(f"Code {rec.code} ({rec.run_id})")
        for o in project.outputs:
            while True:
                raw = ask(f"  {o.name} [{o.unit or 'value'}]")
                if raw.lower() == "x":
                    rec.status = "rejected"
                    rec.notes = (rec.notes + " not made").strip()
                    break
                if not raw:
                    break
                try:
                    rec.outputs[o.name] = float(raw)
                    break
                except ValueError:
                    print("  Please enter a number.")
            if rec.status == "rejected":
                break
        if rec.status == "rejected":
            continue
        note = ask("  notes")
        if note:
            rec.notes = note
        if any(v is not None for v in rec.outputs.values()):
            rec.status = "done"
    log.save()
    print("\nSaved.")
    print("Next: chef status", args.project, " /  chef next", args.project)


def find(log: Log, key: str) -> Record:
    for r in log.records:
        if key.lower() in (r.run_id.lower(), r.code):
            return r
    sys.exit(f"No run with id or code {key!r}")


# ------------------------------------------------------------------- status

def cmd_status(args) -> None:
    project = Project.load(args.project)
    log = Log(project)
    done, planned, rejected = (log.by_status(s) for s in ("done", "planned", "rejected"))
    print(f"{project.name}: {len(done)} done, {len(planned)} planned, {len(rejected)} rejected.")
    active = len(done) + len(planned)
    if active < project.initial_runs:
        print(f"Initial design: {project.initial_runs - active} runs to go before the model starts choosing.")
    if not done:
        print("No results yet.")
        return

    results = log.results()
    scores = overall_scores(project, results)
    print("\nBest runs so far (combined score 0-1, 1 = every output on target):")
    for i in np.argsort(-np.nan_to_num(scores, nan=-1))[:5]:
        rec = done[i]
        vals = ", ".join(f"{k}={v:g}" for k, v in rec.outputs.items() if v is not None)
        print(f"  {scores[i]:.2f}  {rec.run_id}  {vals}")
    top = done[int(np.nanargmax(scores))]
    print(f"\nRecipe of the top run ({top.run_id}, {top.phase}):")
    print(describe(project, top.run))

    from .optimize import fit_models

    models = fit_models(project, results)
    noisy = [(o, m) for o, m in models.items() if len(m.z) >= 5]
    if noisy:
        print("\nEstimated measurement noise (± 1 sd). If it's large compared with the range, add replicates:")
        for o, m in noisy:
            print(f"  {o}: ± {m.noise_sd:.2g}")

    guess = best_guess(project, results, np.random.default_rng(args.seed))
    if guess:
        preds = ", ".join(f"{o} ≈ {m:.3g} ± {s:.2g}" for o, (m, s) in guess.predictions.items())
        print(f"\nModel's best untested guess (expected score {guess.score:.2f}; {preds}):")
        print(describe(project, guess.run, indent="    "))


# ------------------------------------------------------------------ outputs

def cmd_outputs(args) -> None:
    by_cat: dict[str, list[str]] = {}
    for name, spec in guidance.OUTPUT_LIBRARY.items():
        by_cat.setdefault(spec["category"], []).append(name)
    for cat, names in by_cat.items():
        print(f"{cat.upper()}")
        for name in names:
            spec = guidance.OUTPUT_LIBRARY[name]
            goal = spec["goal"] if spec["goal"] != "target" else f"target {spec['target']}"
            print(f"  {name:<16} {goal:<11} {spec['how']}")
        print()
    print("Add one with: chef add-output PROJECT NAME   (or a custom one with --goal/--low/--high)")


def cmd_add_output(args) -> None:
    path = Path(args.project)
    spec = dict(guidance.OUTPUT_LIBRARY.get(args.name, {}))
    spec.pop("category", None)
    for key in ("goal", "target", "low", "high", "weight", "unit", "how"):
        val = getattr(args, key)
        if val is not None:
            spec[key] = val
    if "goal" not in spec:
        sys.exit(f"{args.name!r} is not a suggested output; pass --goal (and ideally --low/--high/--how).")
    block = guidance.output_toml(args.name, spec)
    original = path.read_text()
    path.write_text(original.rstrip() + "\n\n" + block + "\n")
    try:
        Project.load(path)
    except Exception as e:
        path.write_text(original)
        sys.exit(f"Not added: {e}")
    print(f"Added output {args.name!r} to {path}:\n\n{block}")


def cmd_protocol(args) -> None:
    print(guidance.protocol_text())


# --------------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="chef", description="Bayesian Chef: DOE + Bayesian optimisation for cooking.")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init", help="create a project file from a template")
    s.add_argument("project")
    s.add_argument("--template", choices=TEMPLATES, default="blank")
    s.add_argument("--force", action="store_true")
    s.set_defaults(func=cmd_init)

    s = sub.add_parser("next", help="propose the next session and approve it")
    s.add_argument("project")
    s.add_argument("--n", type=int, help="runs this session (default: batch_size)")
    s.add_argument("--yes", action="store_true", help="approve all proposals without asking")
    s.add_argument("--more", action="store_true", help="plan more runs even if some lack results")
    s.add_argument("--seed", type=int)
    s.set_defaults(func=cmd_next)

    s = sub.add_parser("record", help="enter results")
    s.add_argument("project")
    s.add_argument("run", nargs="?", help="run id or tasting code (omit for interactive entry)")
    s.add_argument("values", nargs="*", help="output=value pairs")
    s.set_defaults(func=cmd_record)

    s = sub.add_parser("status", help="summarise results and the model's best guess")
    s.add_argument("project")
    s.add_argument("--seed", type=int, default=0)
    s.set_defaults(func=cmd_status)

    s = sub.add_parser("outputs", help="list suggested output measures")
    s.set_defaults(func=cmd_outputs)

    s = sub.add_parser("add-output", help="add a suggested or custom output to a project")
    s.add_argument("project")
    s.add_argument("name")
    s.add_argument("--goal", choices=["maximize", "minimize", "target"])
    s.add_argument("--target", type=float)
    s.add_argument("--low", type=float)
    s.add_argument("--high", type=float)
    s.add_argument("--weight", type=float)
    s.add_argument("--unit")
    s.add_argument("--how")
    s.set_defaults(func=cmd_add_output)

    s = sub.add_parser("protocol", help="print the tasting protocol")
    s.set_defaults(func=cmd_protocol)

    args = p.parse_args(argv)
    args.func(args)
