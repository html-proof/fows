"""
Train the personalization model.

This used to build a Keras/NCF network. TensorFlow needs well over 512 MB of
RAM just to import and pulls a ~1 GB image, so it could never run on the Render
instance that actually serves traffic. This is the same model family -- learned
user/song embeddings scored against each other -- implemented directly in numpy
with SGD. It trains a few hundred thousand interactions in seconds and produces
artifacts the serving process loads in a few MB.

Input CSV schema (unchanged):
    user_id, song_id, label   # label in [0, 1]

Output (MODEL_DIR, default ./artifacts):
    mf_model.npz    user/song embeddings + biases, float32
    metadata.json   id -> row index maps, training metrics, schema version
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Dict, Tuple

import numpy as np
import pandas as pd

# Bump when the artifact layout changes so the server refuses stale files.
ARTIFACT_VERSION = 2


def load_interactions(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(f"Interactions file not found: {path}")

    frame = pd.read_csv(path)
    required = {"user_id", "song_id", "label"}
    missing = required - set(frame.columns)
    if missing:
        raise ValueError(f"Missing required columns: {sorted(missing)}")

    frame = frame.dropna(subset=["user_id", "song_id", "label"]).copy()
    frame["user_id"] = frame["user_id"].astype(str)
    frame["song_id"] = frame["song_id"].astype(str)
    frame["label"] = frame["label"].astype(float).clip(0, 1)
    return frame


def encode_ids(frame: pd.DataFrame) -> Tuple[pd.DataFrame, Dict[str, int], Dict[str, int]]:
    user_codes = {value: idx for idx, value in enumerate(sorted(frame["user_id"].unique()))}
    song_codes = {value: idx for idx, value in enumerate(sorted(frame["song_id"].unique()))}

    encoded = frame.copy()
    encoded["user_code"] = encoded["user_id"].map(user_codes).astype(np.int32)
    encoded["song_code"] = encoded["song_id"].map(song_codes).astype(np.int32)
    return encoded, user_codes, song_codes


def sigmoid(x: np.ndarray) -> np.ndarray:
    # Branch on sign so exp() never overflows on large-magnitude logits.
    x = np.asarray(x, dtype=np.float64)
    out = np.empty_like(x)
    positive = x >= 0
    out[positive] = 1.0 / (1.0 + np.exp(-x[positive]))
    exp_x = np.exp(x[~positive])
    out[~positive] = exp_x / (1.0 + exp_x)
    return out


def log_loss(labels: np.ndarray, probabilities: np.ndarray) -> float:
    eps = 1e-7
    p = np.clip(probabilities, eps, 1.0 - eps)
    return float(-np.mean(labels * np.log(p) + (1.0 - labels) * np.log(1.0 - p)))


def roc_auc(labels: np.ndarray, scores: np.ndarray) -> float:
    """Rank-based AUC. Returns 0.5 when either class is absent."""
    positives = labels >= 0.5
    n_pos = int(positives.sum())
    n_neg = int(labels.size - n_pos)
    if n_pos == 0 or n_neg == 0:
        return 0.5

    order = np.argsort(scores, kind="mergesort")
    ranks = np.empty(scores.size, dtype=np.float64)
    ranks[order] = np.arange(1, scores.size + 1, dtype=np.float64)

    # Average ranks within ties, otherwise tied scores inflate AUC.
    sorted_scores = scores[order]
    start = 0
    for end in range(1, sorted_scores.size + 1):
        if end == sorted_scores.size or sorted_scores[end] != sorted_scores[start]:
            if end - start > 1:
                ranks[order[start:end]] = ranks[order[start:end]].mean()
            start = end

    return float((ranks[positives].sum() - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg))


class MatrixFactorization:
    """
    Logistic matrix factorization:

        logit(u, i) = global_bias + user_bias[u] + song_bias[i]
                      + dot(user_vector[u], song_vector[i])

    Trained with mini-batch SGD on binary cross-entropy plus L2 regularization.
    Same idea as the NCF model it replaces, without the dense MLP head that was
    the part too expensive to serve.
    """

    def __init__(
        self,
        num_users: int,
        num_songs: int,
        embedding_dim: int = 32,
        learning_rate: float = 0.05,
        regularization: float = 0.02,
        seed: int = 42,
    ) -> None:
        rng = np.random.default_rng(seed)
        scale = 1.0 / np.sqrt(embedding_dim)
        self.user_vectors = rng.normal(0.0, scale, size=(num_users, embedding_dim)).astype(np.float32)
        self.song_vectors = rng.normal(0.0, scale, size=(num_songs, embedding_dim)).astype(np.float32)
        self.user_biases = np.zeros(num_users, dtype=np.float32)
        self.song_biases = np.zeros(num_songs, dtype=np.float32)
        self.global_bias = np.float32(0.0)
        self.learning_rate = learning_rate
        self.regularization = regularization
        self.rng = rng

    def logits(self, users: np.ndarray, songs: np.ndarray) -> np.ndarray:
        interaction = np.einsum("ij,ij->i", self.user_vectors[users], self.song_vectors[songs])
        return self.global_bias + self.user_biases[users] + self.song_biases[songs] + interaction

    def fit_epoch(self, users: np.ndarray, songs: np.ndarray, labels: np.ndarray, batch_size: int) -> None:
        order = self.rng.permutation(users.size)
        lr = self.learning_rate
        reg = self.regularization

        for start in range(0, order.size, batch_size):
            batch = order[start:start + batch_size]
            u, i, y = users[batch], songs[batch], labels[batch]

            error = (sigmoid(self.logits(u, i)) - y).astype(np.float32)
            user_vec = self.user_vectors[u]
            song_vec = self.song_vectors[i]

            grad_user = error[:, None] * song_vec + reg * user_vec
            grad_song = error[:, None] * user_vec + reg * song_vec

            # A user or song can appear several times in one batch, so scatter
            # updates with np.add.at rather than plain fancy indexing -- the
            # latter would silently keep only the last write per duplicate.
            np.add.at(self.user_vectors, u, -lr * grad_user)
            np.add.at(self.song_vectors, i, -lr * grad_song)
            np.add.at(self.user_biases, u, -lr * (error + reg * self.user_biases[u]))
            np.add.at(self.song_biases, i, -lr * (error + reg * self.song_biases[i]))
            self.global_bias -= np.float32(lr * error.mean())

    def predict(self, users: np.ndarray, songs: np.ndarray) -> np.ndarray:
        return sigmoid(self.logits(users, songs))


def main() -> None:
    data_path = Path(os.getenv("TRAIN_DATA_PATH", "data/interactions.csv"))
    model_dir = Path(os.getenv("MODEL_DIR", "artifacts"))
    model_dir.mkdir(parents=True, exist_ok=True)

    embedding_dim = int(os.getenv("EMBEDDING_DIM", "32"))
    epochs = int(os.getenv("EPOCHS", "12"))
    batch_size = int(os.getenv("BATCH_SIZE", "256"))
    learning_rate = float(os.getenv("LEARNING_RATE", "0.05"))
    regularization = float(os.getenv("REGULARIZATION", "0.02"))

    frame = load_interactions(data_path)
    encoded, user_codes, song_codes = encode_ids(frame)

    users = encoded["user_code"].to_numpy(dtype=np.int32)
    songs = encoded["song_code"].to_numpy(dtype=np.int32)
    labels = encoded["label"].to_numpy(dtype=np.float32)

    # Hold out 10%, the same validation split the Keras version used.
    rng = np.random.default_rng(42)
    shuffled = rng.permutation(users.size)
    split = max(1, int(users.size * 0.9))
    train_idx, val_idx = shuffled[:split], shuffled[split:]

    model = MatrixFactorization(
        num_users=len(user_codes),
        num_songs=len(song_codes),
        embedding_dim=embedding_dim,
        learning_rate=learning_rate,
        regularization=regularization,
    )

    started = time.time()
    for epoch in range(1, epochs + 1):
        model.fit_epoch(users[train_idx], songs[train_idx], labels[train_idx], batch_size)

        train_pred = model.predict(users[train_idx], songs[train_idx])
        line = f"epoch {epoch}/{epochs}  loss={log_loss(labels[train_idx], train_pred):.4f}"
        if val_idx.size > 0:
            val_pred = model.predict(users[val_idx], songs[val_idx])
            line += (
                f"  val_loss={log_loss(labels[val_idx], val_pred):.4f}"
                f"  val_auc={roc_auc(labels[val_idx], val_pred):.4f}"
            )
        print(line)

    final_pred = model.predict(users, songs)
    metrics = {
        "loss": log_loss(labels, final_pred),
        "auc": roc_auc(labels, final_pred),
        "train_seconds": round(time.time() - started, 2),
    }

    np.savez_compressed(
        model_dir / "mf_model.npz",
        user_vectors=model.user_vectors,
        song_vectors=model.song_vectors,
        user_biases=model.user_biases,
        song_biases=model.song_biases,
        global_bias=np.asarray(model.global_bias, dtype=np.float32),
    )

    metadata = {
        "artifact_version": ARTIFACT_VERSION,
        "embedding_dim": embedding_dim,
        "num_users": len(user_codes),
        "num_songs": len(song_codes),
        "num_interactions": int(users.size),
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "metrics": metrics,
        "user_index": user_codes,
        "song_index": song_codes,
    }
    with (model_dir / "metadata.json").open("w", encoding="utf-8") as fp:
        json.dump(metadata, fp)

    print(f"Model saved to: {model_dir / 'mf_model.npz'}")
    print(f"Metrics: loss={metrics['loss']:.4f} auc={metrics['auc']:.4f}")


if __name__ == "__main__":
    main()
