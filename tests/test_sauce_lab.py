from pathlib import Path

import numpy as np
import pytest

from sauce_lab import cli
from sauce_lab.model import GP, thompson_batch
from sauce_lab.space import Space

CONFIG = Path(__file__).parent.parent / "config" / "vinaigrette.toml"


@pytest.fixture
def space():
    return Space.from_toml(CONFIG)


def test_grams_sum_to_batch(space):
    rng = np.random.default_rng(0)
    for r in space.sample(50, rng) + [space.control]:
        assert sum(space.to_grams(r).values()) == pytest.approx(space.batch_grams)


def test_control_has_zero_prior_mean(space):
    assert space.prior_mean([space.control])[0] == pytest.approx(0.0)


def test_accent_amount_ignored_without_accent(space):
    a = dict(space.control, accent="none", accent_pct=0.0)
    b = dict(space.control, accent="none", accent_pct=12.0)
    for fa, fb in zip(space.encode([a]), space.encode([b])):
        np.testing.assert_array_equal(fa, fb)


def test_thompson_batch_is_distinct():
    rng = np.random.default_rng(0)
    idx = thompson_batch(np.zeros(20), np.eye(20), 5, rng)
    assert len(set(idx)) == 5


def test_gp_learns_a_hidden_preference(space):
    """Synthetic taster who loves miso: the model should rank miso recipes above others."""
    rng = np.random.default_rng(1)
    recipes = space.sample(40, rng)
    y = np.array([3.0 if r["accent"] == "white_miso" else 0.0 for r in recipes]) + rng.normal(0, 0.5, 40)
    gp = GP.fit(space.encode(recipes), y, np.zeros(len(y)))

    test = space.sample(200, rng)
    mean, _ = gp.posterior(space.encode(test), np.zeros(len(test)))
    miso = np.array([r["accent"] == "white_miso" for r in test])
    assert mean[miso].mean() > mean[~miso].mean() + 1.5


def test_propose_then_score_roundtrip(space, tmp_path, capsys):
    log = tmp_path / "log.csv"
    base = ["--config", str(CONFIG), "--log", str(log)]
    cli.main(base + ["propose", "--k", "3", "--seed", "0"])
    rows = cli.read_log(log)
    assert len(rows) == 4 and sum(r["is_control"] == "1" for r in rows) == 1

    with pytest.raises(SystemExit):
        cli.main(base + ["propose"])  # unscored rows block a new session

    for i, r in enumerate(rows):
        r["score"] = str(5 + i % 3)
    cli.write_log(log, rows, space)
    recipes, y = cli.training_data(rows, space)
    assert len(y) == 4 and 0.0 in y

    cli.main(base + ["status"])
    cli.main(base + ["propose", "--k", "3", "--seed", "1"])
    assert len(cli.read_log(log)) == 8
