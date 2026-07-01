from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Tuple

import numpy as np
import pandas as pd
import tensorflow as tf


def build_ncf_model(num_users: int, num_songs: int, embedding_dim: int = 64) -> tf.keras.Model:
    user_input = tf.keras.layers.Input(shape=(1,), name="user_id")
    song_input = tf.keras.layers.Input(shape=(1,), name="song_id")

    user_embedding = tf.keras.layers.Embedding(num_users, embedding_dim, name="user_embedding")(user_input)
    song_embedding = tf.keras.layers.Embedding(num_songs, embedding_dim, name="song_embedding")(song_input)

    user_vec = tf.keras.layers.Flatten()(user_embedding)
    song_vec = tf.keras.layers.Flatten()(song_embedding)

    x = tf.keras.layers.Concatenate()([user_vec, song_vec])
    x = tf.keras.layers.Dense(128, activation="relu")(x)
    x = tf.keras.layers.Dropout(0.2)(x)
    x = tf.keras.layers.Dense(64, activation="relu")(x)
    output = tf.keras.layers.Dense(1, activation="sigmoid")(x)

    model = tf.keras.Model(inputs=[user_input, song_input], outputs=output)
    model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=1e-3),
        loss="binary_crossentropy",
        metrics=["accuracy", tf.keras.metrics.AUC(name="auc")],
    )
    return model


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


def encode_ids(frame: pd.DataFrame) -> Tuple[pd.DataFrame, dict, dict]:
    user_codes = {value: idx for idx, value in enumerate(sorted(frame["user_id"].unique()))}
    song_codes = {value: idx for idx, value in enumerate(sorted(frame["song_id"].unique()))}

    encoded = frame.copy()
    encoded["user_code"] = encoded["user_id"].map(user_codes).astype(np.int32)
    encoded["song_code"] = encoded["song_id"].map(song_codes).astype(np.int32)
    return encoded, user_codes, song_codes


def main() -> None:
    data_path = Path(os.getenv("TRAIN_DATA_PATH", "data/interactions.csv"))
    model_dir = Path(os.getenv("MODEL_DIR", "artifacts"))
    model_dir.mkdir(parents=True, exist_ok=True)

    frame = load_interactions(data_path)
    encoded, user_codes, song_codes = encode_ids(frame)

    model = build_ncf_model(
        num_users=len(user_codes),
        num_songs=len(song_codes),
        embedding_dim=int(os.getenv("EMBEDDING_DIM", "64")),
    )

    x_user = encoded["user_code"].values
    x_song = encoded["song_code"].values
    y = encoded["label"].values

    model.fit(
        [x_user, x_song],
        y,
        validation_split=0.1,
        epochs=int(os.getenv("EPOCHS", "5")),
        batch_size=int(os.getenv("BATCH_SIZE", "256")),
        verbose=1,
    )

    model_path = model_dir / "ncf_model.keras"
    model.save(model_path)

    metadata = {
        "num_users": len(user_codes),
        "num_songs": len(song_codes),
        "user_index": user_codes,
        "song_index": song_codes,
    }
    with (model_dir / "metadata.json").open("w", encoding="utf-8") as fp:
        json.dump(metadata, fp)

    print(f"Model saved to: {model_path}")


if __name__ == "__main__":
    main()
