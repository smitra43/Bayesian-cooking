"""Gaussian-process preference model and Thompson-sampling proposals."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.optimize import minimize

# Log-normal priors on hyperparameters: (median, log-sd). They encode
# "ratings vary by a couple of points, and your palate is noisy".
HYPER_PRIORS = {
    "len_cont": (0.3, 0.5),   # lengthscale over [0,1]-scaled continuous vars
    "len_cat": (1.0, 0.5),    # lengthscale over one-hot categorical vars
    "signal": (2.0, 0.5),     # sd of the rating surface around the prior mean
    "noise": (1.0, 0.5),      # sd of your rating noise
}
NAMES = list(HYPER_PRIORS)


def kernel(a: tuple[np.ndarray, np.ndarray], b: tuple[np.ndarray, np.ndarray], h: dict) -> np.ndarray:
    def sqdist(x, y):
        return ((x[:, None, :] - y[None, :, :]) ** 2).sum(-1)

    d = sqdist(a[0], b[0]) / h["len_cont"] ** 2 + sqdist(a[1], b[1]) / h["len_cat"] ** 2
    return h["signal"] ** 2 * np.exp(-0.5 * d)


@dataclass
class GP:
    x: tuple[np.ndarray, np.ndarray]
    resid: np.ndarray  # observed rating minus prior mean
    h: dict

    @classmethod
    def fit(cls, x, y, prior_mean, optimise: bool = True) -> "GP":
        resid = y - prior_mean
        h = {k: m for k, (m, _) in HYPER_PRIORS.items()}
        # With very little data, stay at the prior median of each hyperparameter.
        if optimise and len(y) >= 5:
            def neg_log_post(theta):
                hh = dict(zip(NAMES, np.exp(theta)))
                lp = -log_marginal_likelihood(x, resid, hh)
                for (k, (m, s)), t in zip(HYPER_PRIORS.items(), theta):
                    lp += 0.5 * ((t - np.log(m)) / s) ** 2
                return lp

            theta0 = np.log([h[k] for k in NAMES])
            res = minimize(neg_log_post, theta0, method="L-BFGS-B", bounds=[(t - 3, t + 3) for t in theta0])
            h = dict(zip(NAMES, np.exp(res.x)))
        return cls(x=x, resid=resid, h=h)

    def _chol(self):
        k = kernel(self.x, self.x, self.h) + (self.h["noise"] ** 2 + 1e-8) * np.eye(len(self.resid))
        return np.linalg.cholesky(k)

    def posterior(self, xs, prior_mean) -> tuple[np.ndarray, np.ndarray]:
        """Posterior mean and covariance of the latent rating at xs."""
        kss = kernel(xs, xs, self.h)
        if len(self.resid) == 0:
            return prior_mean, kss
        l = self._chol()
        ks = kernel(self.x, xs, self.h)
        alpha = np.linalg.solve(l.T, np.linalg.solve(l, self.resid))
        v = np.linalg.solve(l, ks)
        return prior_mean + ks.T @ alpha, kss - v.T @ v


def log_marginal_likelihood(x, resid, h) -> float:
    k = kernel(x, x, h) + (h["noise"] ** 2 + 1e-8) * np.eye(len(resid))
    try:
        l = np.linalg.cholesky(k)
    except np.linalg.LinAlgError:
        return -1e10
    alpha = np.linalg.solve(l.T, np.linalg.solve(l, resid))
    return float(-0.5 * resid @ alpha - np.log(np.diag(l)).sum() - 0.5 * len(resid) * np.log(2 * np.pi))


def thompson_batch(mean: np.ndarray, cov: np.ndarray, k: int, rng: np.random.Generator) -> list[int]:
    """Pick k distinct candidates, each the argmax of one posterior sample."""
    l = np.linalg.cholesky(cov + 1e-6 * np.eye(len(mean)))
    chosen: list[int] = []
    for _ in range(k):
        draw = mean + l @ rng.standard_normal(len(mean))
        draw[chosen] = -np.inf
        chosen.append(int(np.argmax(draw)))
    return chosen
