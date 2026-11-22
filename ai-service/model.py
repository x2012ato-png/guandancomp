"""DanZero Deep Monte Carlo (DMC) Q-Network pure-NumPy inference engine.

Architecture:
    567 -> 512 (Tanh) -> 512 (Tanh) -> 512 (Tanh) -> 512 (Tanh) -> 512 (Tanh) -> 1 (Identity)

Because the pretrained DanZero Q-Network is a 6-layer MLP with Tanh activations,
we can execute forward passes directly with NumPy matrix multiplications (`@` and `np.tanh`),
achieving ~0.5-2ms inference latency on CPU without requiring PyTorch at runtime.
"""

from __future__ import annotations

import os
import pickle
from typing import Sequence

import numpy as np


class DanZeroQNetwork:
    """Pure-NumPy implementation of DanZero's `MLPQNetwork(567)`."""

    def __init__(self, ckpt_path: str | None = None) -> None:
        if ckpt_path is None:
            ckpt_path = os.environ.get("GUANDAN_DANZERO_CKPT") or os.path.join(
                os.path.dirname(__file__), "weights", "q_network.ckpt"
            )
        with open(ckpt_path, "rb") as f:
            raw_weights = pickle.load(f)

        if len(raw_weights) != 12:
            raise ValueError(f"Expected 12 weight arrays in q_network.ckpt, got {len(raw_weights)}")

        # In `q_network.ckpt` (exported from TF Dense layers):
        # raw_weights[0] has shape (567, 512), raw_weights[1] has shape (512,), etc.
        self.layers: list[tuple[np.ndarray, np.ndarray]] = []
        for i in range(0, 12, 2):
            w = np.asarray(raw_weights[i], dtype=np.float32)
            b = np.asarray(raw_weights[i + 1], dtype=np.float32)
            self.layers.append((w, b))

    def forward(self, x_batch: np.ndarray) -> np.ndarray:
        """Compute Q(s, a) values for a batch of state-action features.

        Args:
            x_batch: Array of shape (num_actions, 567).

        Returns:
            1D float32 array of shape (num_actions,) with Q-values.
        """
        h = np.asarray(x_batch, dtype=np.float32)
        if h.ndim == 1:
            h = h[np.newaxis, :]
        if h.shape[1] != 567:
            raise ValueError(f"Expected feature dimension 567, got {h.shape[1]}")

        # First 5 layers use Tanh activation; final layer is linear (Identity)
        with np.errstate(over="ignore", divide="ignore", invalid="ignore"):
            for w, b in self.layers[:-1]:
                h = np.tanh(h @ w + b)
            w_last, b_last = self.layers[-1]
            q = h @ w_last + b_last
        return q.squeeze(-1)

    def best_action_index(self, x_batch: np.ndarray) -> tuple[int, np.ndarray]:
        """Return (argmax index, q_values array)."""
        q_values = self.forward(x_batch)
        best_idx = int(np.argmax(q_values))
        return best_idx, q_values
