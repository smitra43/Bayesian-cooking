from pathlib import Path

import numpy as np
import pytest

from bayesian_chef import cli, guidance
from bayesian_chef.optimize import combine, desirability, propose, space_filling
from bayesian_chef.project import Output, Project
from bayesian_chef.store import Log

TEMPLATES = Path(__file__).parent.parent / "bayesian_chef" / "templates"


@pytest.fixture
def bread():
    return Project.load(TEMPLATES / "bread.toml")


@pytest.mark.parametrize("name", cli.TEMPLATES)
def test_templates_load(name):
    p = Project.load(TEMPLATES / f"{name}.toml")
    if name.startswith("beverages/"):
        assert p.tips and p.baseline


@pytest.mark.parametrize("name", [t for t in cli.TEMPLATES if t.startswith("beverages/")])
def test_beverage_init_and_session(name, tmp_path, capsys):
    proj = tmp_path / "drink.toml"
    cli.main(["init", str(proj), "--template", name])
    cli.main(["next", str(proj), "--yes", "--seed", "0"])
    out = capsys.readouterr().out
    assert "TASTING ORDER" in out and "For " in out


def test_samples_respect_bounds_and_mixtures(bread):
    for run in bread.sample(200, np.random.default_rng(0)):
        bread.validate(run)  # raises if a bound or mixture total is violated


def test_space_filling_spreads_out(bread):
    rng = np.random.default_rng(0)
    design = space_filling(bread, [], 8, rng)
    random = bread.sample(8, rng)

    def min_dist(runs):
        x = np.hstack(bread.encode(runs))
        d = np.sqrt(((x[:, None] - x[None]) ** 2).sum(-1))
        return d[np.triu_indices(len(runs), 1)].min()

    assert min_dist(design) > min_dist(random)


def test_desirability_goals():
    y = np.array([0.0, 5.0, 10.0])
    assert list(desirability(Output("a", "maximize"), y, 0, 10)) == [0, 0.5, 1]
    assert list(desirability(Output("a", "minimize"), y, 0, 10)) == [1, 0.5, 0]
    assert list(desirability(Output("a", "target", target=5), y, 0, 10)) == [0, 1, 0]
    assert combine([np.array([1.0]), np.array([0.25])], [1, 1])[0] == pytest.approx(0.5)


def test_bo_finds_hidden_optimum():
    """Synthetic cook whose ideal omelette is 3 eggs, ~165 °C, butter: BO should get close."""
    project = Project.load(TEMPLATES / "omelette.toml")
    project.outputs = [Output("liking", "maximize", low=1, high=9)]
    rng = np.random.default_rng(3)

    def taste(r):
        return 8 - ((r["pan_temp_c"] - 165) / 25) ** 2 - (r["eggs"] - 3) ** 2 - 2 * (r["fat"] != "butter")

    runs = space_filling(project, [], 8, rng)
    results = [{"run": r, "liking": taste(r) + rng.normal(0, 0.3)} for r in runs]
    for _ in range(6):
        for p in propose(project, results, 2, rng):
            results.append({"run": p.run, "liking": taste(p.run) + rng.normal(0, 0.3)})
    best_bo = max(taste(r["run"]) for r in results[8:])
    best_doe = max(taste(r["run"]) for r in results[:8])
    assert best_bo > best_doe and best_bo > 7


def test_full_loop(tmp_path, monkeypatch, capsys):
    proj = tmp_path / "omelette.toml"
    cli.main(["init", str(proj), "--template", "omelette"])

    # Session 1: baseline + initial design, approve all.
    cli.main(["next", str(proj), "--yes", "--seed", "0"])
    project = Project.load(proj)
    log = Log(project)
    planned = log.by_status("planned")
    assert len(planned) == project.batch_size
    assert planned[0].phase in ("baseline", "doe") and any(r.phase == "baseline" for r in planned)
    assert all(r.code for r in planned)

    # Unrecorded runs block a new proposal (it re-prints the session instead).
    cli.main(["next", str(proj), "--yes"])
    assert len(Log(project).records) == project.batch_size

    # Record by tasting code and by run id.
    cli.main(["record", str(proj), planned[0].code, "liking=7", "texture_jar=3"])
    cli.main(["record", str(proj), planned[1].run_id, "liking=5"])
    assert len(Log(project).by_status("done")) == 2

    # Interactive approval: approve, reject with a reason, edit a value.
    answers = iter(["a", "r", "too hot for my pan", "e", "3", "5", "1.0", "0", "150", "ghee"])
    monkeypatch.setattr("builtins.input", lambda _: next(answers))
    cli.main(["next", str(proj), "--n", "3", "--seed", "1"])
    log = Log(project)
    assert len(log.by_status("rejected")) == 1
    assert log.by_status("rejected")[0].notes == "too hot for my pan"
    manual = [r for r in log.records if r.phase == "manual"]
    assert manual and manual[0].run["pan_temp_c"] == 150 and manual[0].run["fat"] == "ghee"

    # Interactive record for all planned runs; 'x' marks one as never made.
    planned = log.by_status("planned")
    entries = ["x"] + ["6", "3", "8", ""] * (len(planned) - 1)
    answers = iter(entries)
    monkeypatch.setattr("builtins.input", lambda _: next(answers))
    cli.main(["record", str(proj)])
    log = Log(project)
    assert not log.by_status("planned")

    # Enough data for the model to take over, and status to report.
    rng = np.random.default_rng(0)
    for _ in range(5):
        cli.main(["next", str(proj), "--yes"])
        for r in Log(project).by_status("planned"):
            liking = int(rng.integers(3, 9))
            cli.main(["record", str(proj), r.run_id, f"liking={liking}", "texture_jar=3", "cook_loss_pct=9"])
    assert any(r.phase == "bo" for r in Log(project).records)
    cli.main(["status", str(proj)])
    out = capsys.readouterr().out
    assert "Best runs so far" in out and "best untested guess" in out


def test_add_output(tmp_path):
    proj = tmp_path / "p.toml"
    cli.main(["init", str(proj)])
    cli.main(["add-output", str(proj), "salt_jar"])
    cli.main(["add-output", str(proj), "crunch", "--goal", "maximize", "--low", "0", "--high", "10",
              "--how", 'Listen for the "crunch", 0-10'])
    names = [o.name for o in Project.load(proj).outputs]
    assert names[-2:] == ["salt_jar", "crunch"]
    with pytest.raises(SystemExit):
        cli.main(["add-output", str(proj), "mystery"])  # not in library, no --goal
    with pytest.raises(SystemExit):
        cli.main(["add-output", str(proj), "bad", "--goal", "target"])  # target without value
    assert [o.name for o in Project.load(proj).outputs] == names


def test_every_library_output_is_valid(tmp_path):
    proj = tmp_path / "p.toml"
    cli.main(["init", str(proj)])
    for name in guidance.OUTPUT_LIBRARY:
        if name != "liking":
            cli.main(["add-output", str(proj), name])
    assert len(Project.load(proj).outputs) == len(guidance.OUTPUT_LIBRARY)


def test_invalid_mixture_rejected(tmp_path):
    bad = (TEMPLATES / "bread.toml").read_text().replace("flour = 100", "flour = 200")
    p = tmp_path / "bad.toml"
    p.write_text(bad)
    with pytest.raises(ValueError, match="cannot sum"):
        Project.load(p)
