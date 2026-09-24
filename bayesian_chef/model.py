"""Gaussian-process surrogate: one per output, on standardised values."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.optimize import minimize

# Log-normal priors on hyperparameters (median, log-sd), on the standardised
# scale. They say: smooth-ish response, and measurements are fairly noisy.
HYPER_PRIORS = {
    "len_num": (0.35, 0.5),  # lengthscale over [0,1]-scaled numeric factors
    "len_cat": (1.0, 0.5),   # lengthscale over one-hot categorical factors
    "signal": (1.0, 0.5),    # sd of the response surface
    "noise": (0.5, 0.6),     # sd of measurement / tasting noise
}
NAMES = list(HYPER_PRIORS)

X = tuple[np.ndarray, np.ndarray]


def kernel(a: X, b: X, h: dict) -> np.ndarray:
    def sqdist(p, q):
        return ((p[:, None, :] - q[None, :, :]) ** 2).sum(-1)

    d = sqdist(a[0], b[0]) / h["len_num"] ** 2 + sqdist(a[1], b[1]) / h["len_cat"] ** 2
    return h["signal"] ** 2 * np.exp(-0.5 * d)


def log_marginal_likelihood(x: X, y: np.ndarray, h: dict) -> float:
    k = kernel(x, x, h) + (h["noise"] ** 2 + 1e-8) * np.eye(len(y))
    try:
        l = np.linalg.cholesky(k)
    except np.linalg.LinAlgError:
        return -1e10
    alpha = np.linalg.solve(l.T, np.linalg.solve(l, y))
    return float(-0.5 * y @ alpha - np.log(np.diag(l)).sum() - 0.5 * len(y) * np.log(2 * np.pi))


@dataclass
class GP:
    x: X
    z: np.ndarray       # standardised observations
    mu: float
    sd: float
    h: dict

    @classmethod
    def fit(cls, x: X, y: np.ndarray) -> "GP":
        y = np.asarray(y, dtype=float)
        mu = float(y.mean()) if len(y) else 0.0
        sd = float(y.std()) if len(y) > 1 and y.std() > 0 else 1.0
        z = (y - mu) / sd
        h = {k: m for k, (m, _) in HYPER_PRIORS.items()}
        # With little data, stay at the prior medians rather than overfit.
        if len(y) >= 5:
            def neg_log_post(theta):
                hh = dict(zip(NAMES, np.exp(theta)))
                val = -log_marginal_likelihood(x, z, hh)
                for (m, s), t in zip(HYPER_PRIORS.values(), theta):
                    val += 0.5 * ((t - np.log(m)) / s) ** 2
                return val

            t0 = np.log([h[k] for k in NAMES])
            res = minimize(neg_log_post, t0, method="L-BFGS-B", bounds=[(t - 3, t + 3) for t in t0])
            h = dict(zip(NAMES, np.exp(res.x)))
        return cls(x=x, z=z, mu=mu, sd=sd, h=h)

    @property
    def noise_sd(self) -> float:
        """Estimated measurement noise, in the output's own units."""
        return self.h["noise"] * self.sd

    def posterior(self, xs: X) -> tuple[np.ndarray, np.ndarray]:
        """Posterior mean and covariance of the noise-free response at xs."""
        kss = kernel(xs, xs, self.h)
        if len(self.z) == 0:
            return np.full(len(kss), self.mu), kss * self.sd ** 2
        k = kernel(self.x, self.x, self.h) + (self.h["noise"] ** 2 + 1e-8) * np.eye(len(self.z))
        l = np.linalg.cholesky(k)
        ks = kernel(self.x, xs, self.h)
        alpha = np.linalg.solve(l.T, np.linalg.solve(l, self.z))
        v = np.linalg.solve(l, ks)
        mean = ks.T @ alpha
        cov = kss - v.T @ v
        return self.mu + self.sd * mean, cov * self.sd ** 2
