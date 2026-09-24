from __future__ import annotations

from dataclasses import dataclass
from itertools import product
from math import isclose, sqrt
from typing import Dict, List, Mapping, Sequence, Tuple


@dataclass(frozen=True)
class ContinuousFactor:
    name: str
    minimum: float
    maximum: float
    step: float

    def __post_init__(self) -> None:
        if self.step <= 0:
            raise ValueError("Continuous factor step must be positive.")
        if self.maximum < self.minimum:
            raise ValueError("Continuous factor maximum must be >= minimum.")

    def values(self) -> Tuple[float, ...]:
        values: List[float] = []
        current = self.minimum
        while current <= self.maximum or isclose(current, self.maximum):
            values.append(round(current, 10))
            current += self.step
        if values[-1] != self.maximum:
            values.append(self.maximum)
        return tuple(values)

    def quantize(self, value: float) -> float:
        allowed = self.values()
        closest = min(allowed, key=lambda candidate: (abs(candidate - value), candidate))
        return closest


@dataclass(frozen=True)
class CategoricalFactor:
    name: str
    values: Tuple[str, ...]

    def __post_init__(self) -> None:
        if not self.values:
            raise ValueError("Categorical factor must define at least one value.")

    def quantize(self, value: str) -> str:
        if value not in self.values:
            raise ValueError(f"Unsupported categorical value {value!r} for {self.name}.")
        return value


Factor = ContinuousFactor | CategoricalFactor


@dataclass(frozen=True)
class OutputMetric:
    name: str
    weight: float = 1.0
    objective: str = "maximize"

    def __post_init__(self) -> None:
        if self.objective not in {"maximize", "minimize"}:
            raise ValueError("Metric objective must be 'maximize' or 'minimize'.")


@dataclass(frozen=True)
class RecipeObservation:
    parameters: Mapping[str, float | str]
    metrics: Mapping[str, float]
    notes: str = ""


@dataclass(frozen=True)
class CandidatePosterior:
    parameters: Mapping[str, float | str]
    observations: int
    posterior_mean: float
    posterior_variance: float

    @property
    def upper_confidence_bound(self) -> float:
        return self.posterior_mean + sqrt(self.posterior_variance)


class RecipeSpace:
    def __init__(self, factors: Sequence[Factor]):
        if not factors:
            raise ValueError("Recipe space must include at least one factor.")
        names = [factor.name for factor in factors]
        if len(names) != len(set(names)):
            raise ValueError("Recipe factor names must be unique.")
        self.factors = tuple(factors)
        self._factors_by_name = {factor.name: factor for factor in factors}

    def quantize(self, parameters: Mapping[str, float | str]) -> Dict[str, float | str]:
        quantized: Dict[str, float | str] = {}
        missing = set(self._factors_by_name) - set(parameters)
        if missing:
            raise ValueError(f"Missing parameters for factors: {sorted(missing)}")
        unknown = set(parameters) - set(self._factors_by_name)
        if unknown:
            raise ValueError(f"Unknown parameters: {sorted(unknown)}")

        for name, value in parameters.items():
            factor = self._factors_by_name[name]
            quantized[name] = factor.quantize(value)  # type: ignore[arg-type]
        return quantized

    def grid(self) -> List[Dict[str, float | str]]:
        factor_names = [factor.name for factor in self.factors]
        factor_values = [
            factor.values() if isinstance(factor, ContinuousFactor) else factor.values
            for factor in self.factors
        ]
        return [
            dict(zip(factor_names, combination))
            for combination in product(*factor_values)
        ]

    def key_for(self, parameters: Mapping[str, float | str]) -> Tuple[Tuple[str, float | str], ...]:
        quantized = self.quantize(parameters)
        return tuple((name, quantized[name]) for name in sorted(quantized))

    def neighbors(self, parameters: Mapping[str, float | str]) -> List[Dict[str, float | str]]:
        quantized = self.quantize(parameters)
        neighbors: List[Dict[str, float | str]] = []

        for factor in self.factors:
            current = quantized[factor.name]
            if isinstance(factor, ContinuousFactor):
                values = factor.values()
                index = values.index(current)  # type: ignore[arg-type]
                for neighbor_index in (index - 1, index + 1):
                    if 0 <= neighbor_index < len(values):
                        neighbor = dict(quantized)
                        neighbor[factor.name] = values[neighbor_index]
                        neighbors.append(neighbor)
            else:
                for option in factor.values:
                    if option == current:
                        continue
                    neighbor = dict(quantized)
                    neighbor[factor.name] = option
                    neighbors.append(neighbor)
        return neighbors


class BayesianRecipeWorkflow:
    def __init__(
        self,
        space: RecipeSpace,
        metrics: Sequence[OutputMetric],
        *,
        prior_mean: float = 0.0,
        prior_strength: float = 1.0,
        observation_variance: float = 1.0,
    ):
        if not metrics:
            raise ValueError("Workflow must define at least one output metric.")
        if prior_strength <= 0:
            raise ValueError("Prior strength must be positive.")
        if observation_variance <= 0:
            raise ValueError("Observation variance must be positive.")

        self.space = space
        self.metrics = tuple(metrics)
        self.prior_mean = prior_mean
        self.prior_strength = prior_strength
        self.observation_variance = observation_variance
        self._scores_by_candidate: Dict[Tuple[Tuple[str, float | str], ...], List[float]] = {}

    def score(self, observation: RecipeObservation) -> float:
        missing = {metric.name for metric in self.metrics} - set(observation.metrics)
        if missing:
            raise ValueError(f"Missing metrics: {sorted(missing)}")
        total = 0.0
        weight_sum = 0.0
        for metric in self.metrics:
            direction = 1.0 if metric.objective == "maximize" else -1.0
            total += direction * metric.weight * observation.metrics[metric.name]
            weight_sum += metric.weight
        if weight_sum == 0:
            raise ValueError("Metric weights must not all be zero.")
        return total / weight_sum

    def register(self, observation: RecipeObservation) -> CandidatePosterior:
        candidate_key = self.space.key_for(observation.parameters)
        candidate_scores = self._scores_by_candidate.setdefault(candidate_key, [])
        candidate_scores.append(self.score(observation))
        return self.posterior_for(dict(candidate_key))

    def posterior_for(self, parameters: Mapping[str, float | str]) -> CandidatePosterior:
        quantized = self.space.quantize(parameters)
        candidate_key = self.space.key_for(quantized)
        scores = self._scores_by_candidate.get(candidate_key, [])
        observations = len(scores)
        posterior_weight = self.prior_strength + observations
        posterior_mean = (
            self.prior_mean * self.prior_strength + sum(scores)
        ) / posterior_weight
        posterior_variance = self.observation_variance / posterior_weight
        return CandidatePosterior(
            parameters=quantized,
            observations=observations,
            posterior_mean=posterior_mean,
            posterior_variance=posterior_variance,
        )

    def rank_candidates(self) -> List[CandidatePosterior]:
        posteriors = [
            self.posterior_for(candidate)
            for candidate in self.space.grid()
        ]
        return sorted(
            posteriors,
            key=lambda posterior: (
                posterior.posterior_mean,
                posterior.observations,
                posterior.upper_confidence_bound,
            ),
            reverse=True,
        )

    def recommend_next_candidates(self, limit: int = 5, exploration: float = 0.0) -> List[CandidatePosterior]:
        ranked = sorted(
            (self.posterior_for(candidate) for candidate in self.space.grid()),
            key=lambda posterior: posterior.posterior_mean
            + exploration * sqrt(posterior.posterior_variance),
            reverse=True,
        )
        return ranked[:limit]

    def discover_local_optima(self, minimum_observations: int = 1) -> List[CandidatePosterior]:
        optima: List[CandidatePosterior] = []
        for candidate in self.space.grid():
            posterior = self.posterior_for(candidate)
            if posterior.observations < minimum_observations:
                continue
            neighbor_posteriors = [
                self.posterior_for(neighbor)
                for neighbor in self.space.neighbors(candidate)
            ]
            if all(
                posterior.posterior_mean >= neighbor.posterior_mean
                for neighbor in neighbor_posteriors
            ):
                optima.append(posterior)
        return sorted(optima, key=lambda posterior: posterior.posterior_mean, reverse=True)
