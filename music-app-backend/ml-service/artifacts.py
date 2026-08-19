"""
Loads the artifacts produced by train.py and scores (user, song) pairs.

Deliberately tiny: numpy arrays plus two dict lookups. Nothing here allocates
per request, so the serving footprint stays flat regardless of traffic. If no
artifacts are present the store reports itself unloaded and every caller falls
back to the heuristic scores in model.py -- an untrained deployment must still
serve traffic, it just serves it without collaborative filtering.
"""

from __future__ import annotations

import json
import math
import os
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

# Must match train.ARTIFACT_VERSION. Older artifacts are ignored rather than
# loaded into a layout they were not written for.
SUPPORTED_ARTIFACT_VERSION = 2

MODEL_DIR = Path(os.getenv("MODEL_DIR", "artifacts"))


class ModelStore:
    def __init__(self, model_dir: Path = MODEL_DIR) -> None:
        self._model_dir = model_dir
        self._lock = threading.Lock()
        self._loaded = False
        self._error: Optional[str] = None
        self._metadata: Dict[str, Any] = {}
        self._user_index: Dict[str, int] = {}
        self._song_index: Dict[str, int] = {}
        self._user_vectors: Optional[np.ndarray] = None
        self._song_vectors: Optional[np.ndarray] = None
        self._user_biases: Optional[np.ndarray] = None
        self._song_biases: Optional[np.ndarray] = None
        self._global_bias: float = 0.0

    @property
    def loaded(self) -> bool:
        return self._loaded

    def load(self) -> None:
        """Load artifacts from disk. Safe to call repeatedly; never raises."""
        with self._lock:
            self._loaded = False
            self._error = None

            model_path = self._model_dir / "mf_model.npz"
            metadata_path = self._model_dir / "metadata.json"
            if not model_path.exists() or not metadata_path.exists():
                self._error = f"no artifacts in {self._model_dir}"
                return

            try:
                with metadata_path.open(encoding="utf-8") as fp:
                    metadata = json.load(fp)

                version = int(metadata.get("artifact_version", 0))
                if version != SUPPORTED_ARTIFACT_VERSION:
                    self._error = (
                        f"artifact_version {version} is not supported "
                        f"(expected {SUPPORTED_ARTIFACT_VERSION}); retrain with train.py"
                    )
                    return

                with np.load(model_path) as bundle:
                    user_vectors = bundle["user_vectors"]
                    song_vectors = bundle["song_vectors"]
                    user_biases = bundle["user_biases"]
                    song_biases = bundle["song_biases"]
                    global_bias = float(bundle["global_bias"])

                user_index = {str(k): int(v) for k, v in metadata.get("user_index", {}).items()}
                song_index = {str(k): int(v) for k, v in metadata.get("song_index", {}).items()}

                # Guard against index/array drift from a half-written artifact.
                if user_vectors.shape[0] != len(user_index) or song_vectors.shape[0] != len(song_index):
                    self._error = "artifact index size does not match embedding matrix size"
                    return

                self._metadata = metadata
                self._user_index = user_index
                self._song_index = song_index
                self._user_vectors = user_vectors
                self._song_vectors = song_vectors
                self._user_biases = user_biases
                self._song_biases = song_biases
                self._global_bias = global_bias
                self._loaded = True
            except Exception as exc:  # noqa: BLE001 - serving must survive bad artifacts
                self._error = f"{type(exc).__name__}: {exc}"

    def score(self, user_id: str, song_ids: List[str]) -> Optional[np.ndarray]:
        """
        Probabilities in [0, 1] for each song, or None when the model cannot
        score this user at all (not loaded, or an unseen user -- the cold-start
        case, where a learned score would be pure noise).

        Songs the model has never seen get 0.5, i.e. "no opinion", so they are
        neither promoted nor buried by a model that knows nothing about them.
        """
        if not self._loaded or self._user_vectors is None:
            return None

        user_code = self._user_index.get(str(user_id))
        if user_code is None:
            return None

        song_codes = np.array(
            [self._song_index.get(str(song_id), -1) for song_id in song_ids],
            dtype=np.int64,
        )
        known = song_codes >= 0

        scores = np.full(song_codes.shape, 0.5, dtype=np.float64)
        if not known.any():
            return scores

        codes = song_codes[known]
        logits = (
            self._global_bias
            + float(self._user_biases[user_code])
            + self._song_biases[codes]
            + self._song_vectors[codes] @ self._user_vectors[user_code]
        )
        scores[known] = 1.0 / (1.0 + np.exp(-np.clip(logits, -30.0, 30.0)))
        return scores

    def status(self) -> Dict[str, Any]:
        return {
            "loaded": self._loaded,
            "error": self._error,
            "model_dir": str(self._model_dir),
            "trained_at": self._metadata.get("trained_at"),
            "num_users": self._metadata.get("num_users"),
            "num_songs": self._metadata.get("num_songs"),
            "num_interactions": self._metadata.get("num_interactions"),
            "embedding_dim": self._metadata.get("embedding_dim"),
            "metrics": self._metadata.get("metrics"),
        }


store = ModelStore()


def resident_megabytes() -> Optional[float]:
    """Current RSS in MB, for the health endpoint. None where unavailable."""
    try:
        with open("/proc/self/statm", encoding="utf-8") as fp:
            pages = int(fp.read().split()[1])
        return round(pages * os.sysconf("SC_PAGE_SIZE") / (1024 * 1024), 1)
    except Exception:  # noqa: BLE001 - non-Linux or restricted /proc
        return None


def is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
