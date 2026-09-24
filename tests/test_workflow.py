import unittest

from bayesian_cooking import (
    BayesianRecipeWorkflow,
    CategoricalFactor,
    ContinuousFactor,
    OutputMetric,
    RecipeObservation,
    RecipeSpace,
)


class RecipeSpaceTests(unittest.TestCase):
    def test_grid_and_quantization(self) -> None:
        space = RecipeSpace(
            [
                ContinuousFactor("hydration", minimum=60, maximum=70, step=5),
                CategoricalFactor("flour", values=("white", "rye")),
            ]
        )

        self.assertEqual(
            space.grid(),
            [
                {"hydration": 60, "flour": "white"},
                {"hydration": 60, "flour": "rye"},
                {"hydration": 65, "flour": "white"},
                {"hydration": 65, "flour": "rye"},
                {"hydration": 70, "flour": "white"},
                {"hydration": 70, "flour": "rye"},
            ],
        )
        self.assertEqual(
            space.quantize({"hydration": 67, "flour": "white"}),
            {"hydration": 65, "flour": "white"},
        )


class BayesianWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.space = RecipeSpace(
            [
                ContinuousFactor("hydration", minimum=60, maximum=70, step=5),
                CategoricalFactor("flour", values=("white", "rye")),
            ]
        )
        self.workflow = BayesianRecipeWorkflow(
            self.space,
            [
                OutputMetric("crumb", weight=0.6),
                OutputMetric("handling", weight=0.4),
            ],
            prior_mean=0.5,
            prior_strength=2.0,
        )

    def test_register_updates_posterior_and_recommendation(self) -> None:
        posterior = self.workflow.register(
            RecipeObservation(
                parameters={"hydration": 66, "flour": "white"},
                metrics={"crumb": 0.9, "handling": 0.7},
            )
        )

        expected_score = (0.6 * 0.9 + 0.4 * 0.7)
        expected_mean = (2.0 * 0.5 + expected_score) / 3.0

        self.assertEqual(posterior.parameters, {"hydration": 65, "flour": "white"})
        self.assertEqual(posterior.observations, 1)
        self.assertAlmostEqual(posterior.posterior_mean, expected_mean)

        recommended = self.workflow.recommend_next_candidates(limit=1)[0]
        self.assertEqual(recommended.parameters, {"hydration": 65, "flour": "white"})

    def test_discovers_multiple_local_optima(self) -> None:
        experiments = [
            ({"hydration": 60, "flour": "white"}, 0.60),
            ({"hydration": 65, "flour": "white"}, 0.90),
            ({"hydration": 70, "flour": "white"}, 0.70),
            ({"hydration": 60, "flour": "rye"}, 0.65),
            ({"hydration": 65, "flour": "rye"}, 0.68),
            ({"hydration": 70, "flour": "rye"}, 0.88),
        ]

        for parameters, score in experiments:
            self.workflow.register(
                RecipeObservation(
                    parameters=parameters,
                    metrics={"crumb": score, "handling": score},
                )
            )

        optima = self.workflow.discover_local_optima()
        optimum_parameters = [posterior.parameters for posterior in optima]

        self.assertEqual(
            optimum_parameters,
            [
                {"hydration": 65, "flour": "white"},
                {"hydration": 70, "flour": "rye"},
            ],
        )


if __name__ == "__main__":
    unittest.main()
