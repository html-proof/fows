from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Optional

from artifacts import store

# How much of the final score the trained model may claim, once it has an
# opinion about this user. Search stays lexical-dominated on purpose: a
# collaborative model that outranks an exact title match is a regression, not
# personalization.
MF_WEIGHT_RANK = 0.18
MF_WEIGHT_RECOMMEND = 0.45


def rank_songs_for_user(
    user_id: str,
    songs: List[Dict[str, Any]],
    query: str = "",
    top_k: int = 10,
    user_context: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    context = UserContext.from_payload(user_context)
    normalized_query = normalize_text(query)

    song_ids = [str(song.get("id", song.get("songId", ""))) for song in songs]
    mf_scores = store.score(user_id, song_ids)

    ranked = []
    for index, song in enumerate(songs):
        text_score = lexical_score(normalized_query, song)
        popularity_score = normalize_popularity(song.get("global_popularity_score", song.get("play_count", 0)))
        user_pref_score = preference_score(song, context.languages, context.artists)
        interaction_score = context.interaction_score(song_ids[index])

        # Strong lexical priority for search quality.
        heuristic_score = (
            0.55 * text_score +
            0.20 * user_pref_score +
            0.15 * popularity_score +
            0.10 * interaction_score
        )

        mf_score = float(mf_scores[index]) if mf_scores is not None else None
        final_score = blend(heuristic_score, mf_score, MF_WEIGHT_RANK)

        if normalized_query and text_score < 0.20:
            final_score *= 0.5

        rank_detail = {
            "final_score": round(final_score, 6),
            "text_score": round(text_score, 6),
            "preference_score": round(user_pref_score, 6),
            "popularity_score": round(popularity_score, 6),
            "interaction_score": round(interaction_score, 6),
            "original_index": index,
        }
        if mf_score is not None:
            rank_detail["model_score"] = round(mf_score, 6)

        ranked.append({**song, "_rank": rank_detail})

    ranked.sort(key=lambda x: x["_rank"]["final_score"], reverse=True)
    return ranked[: max(1, int(top_k))]


def recommend_for_user(
    user_id: str,
    user_data: Dict[str, Any],
    songs: List[Dict[str, Any]] | None = None,
    top_k: int = 20,
) -> Dict[str, Any]:
    catalog = songs or []
    context = UserContext.from_payload(user_data)

    song_ids = [str(song.get("id", song.get("songId", ""))) for song in catalog]
    mf_scores = store.score(user_id, song_ids)

    scored = []
    for index, song in enumerate(catalog):
        heuristic_score = preference_score(song, context.languages, context.artists)
        heuristic_score = (
            0.55 * heuristic_score +
            0.25 * normalize_popularity(song.get("global_popularity_score", song.get("play_count", 0))) +
            0.20 * context.interaction_score(song_ids[index])
        )

        mf_score = float(mf_scores[index]) if mf_scores is not None else None
        score = blend(heuristic_score, mf_score, MF_WEIGHT_RECOMMEND)

        entry = {**song, "_recommendation_score": round(score, 6)}
        if mf_score is not None:
            entry["_model_score"] = round(mf_score, 6)
        scored.append(entry)

    scored.sort(key=lambda x: x["_recommendation_score"], reverse=True)
    return {
        "recommended_for": user_id,
        "based_on": {
            "language": sorted(context.languages),
            "artists": sorted(context.artists),
            "model": "trained" if mf_scores is not None else "heuristic",
        },
        "songs": scored[: max(1, int(top_k))],
    }


class UserContext:
    """
    Per-request user features supplied by the Node gateway.

    The gateway already holds the realtime profile, so it sends it along rather
    than having this service open a second Firebase connection -- that keeps the
    ML instance stateless, credential-free, and cheap to boot.
    """

    __slots__ = ("languages", "artists", "interactions")

    def __init__(
        self,
        languages: set[str],
        artists: set[str],
        interactions: Dict[str, Dict[str, Any]],
    ) -> None:
        self.languages = languages
        self.artists = artists
        self.interactions = interactions

    @classmethod
    def from_payload(cls, payload: Optional[Dict[str, Any]]) -> "UserContext":
        data = payload or {}

        languages = {
            normalize_text(x)
            for x in coerce_list(data.get("languages", data.get("preferred_language", [])))
            if normalize_text(x)
        }
        artists = {
            normalize_text(x)
            for x in coerce_list(data.get("favoriteArtists", data.get("preferred_artists", [])))
            if normalize_text(x)
        }

        raw_interactions = data.get("songInteractions") or {}
        interactions: Dict[str, Dict[str, Any]] = {}
        if isinstance(raw_interactions, dict):
            for song_id, value in raw_interactions.items():
                if isinstance(value, dict):
                    interactions[str(song_id)] = value

        return cls(languages=languages, artists=artists, interactions=interactions)

    def interaction_score(self, song_id: str) -> float:
        """
        Observed engagement with this exact song, in [0, 1]. Neutral 0.5 when
        the user has never touched it.

        The previous implementation hashed the user and song id into a
        pseudo-random number, which meant 10% of every search ranking was noise
        dressed up as personalization.
        """
        entry = self.interactions.get(str(song_id))
        if not entry:
            return 0.5

        plays = to_float(entry.get("playCount", entry.get("play_count", 0)))
        skips = to_float(entry.get("skipCount", entry.get("skip_count", 0)))
        clicks = to_float(entry.get("searchClicked", entry.get("search_clicked", 0)))

        affinity = entry.get("affinity")
        if not is_number(affinity):
            affinity = plays * 2.0 + clicks * 0.75 - skips * 2.5

        # Squash an unbounded affinity into [0, 1] centred on 0.5, so a heavily
        # skipped song lands near 0 and a favourite saturates near 1.
        return clamp(0.5 + 0.5 * math.tanh(float(affinity) / 6.0), 0.0, 1.0)


def blend(heuristic_score: float, model_score: Optional[float], model_weight: float) -> float:
    """Mix the heuristic and trained scores, tolerating an absent model."""
    if model_score is None:
        return clamp(heuristic_score, 0.0, 1.0)
    return clamp((1.0 - model_weight) * heuristic_score + model_weight * model_score, 0.0, 1.0)


def lexical_score(query: str, song: Dict[str, Any]) -> float:
    if not query:
        return 0.5

    title = normalize_text(song.get("title", song.get("name", "")))
    artist = normalize_text(song.get("artist", song.get("primaryArtists", "")))
    haystack = f"{title} {artist}".strip()
    terms = [token for token in query.split() if token]

    if title == query:
        return 1.0
    if title.startswith(query):
        return 0.95
    if query in title:
        return 0.9
    if query in haystack:
        return 0.82

    if not terms:
        return 0.4

    hits = 0.0
    for term in terms:
        if term in title:
            hits += 1.0
        elif term in artist:
            hits += 0.8
        else:
            hits += fuzzy_term_match(term, tokenize(haystack))
    return clamp(hits / max(len(terms), 1), 0.0, 1.0)


def preference_score(song: Dict[str, Any], preferred_languages: set[str], preferred_artists: set[str]) -> float:
    language = normalize_text(song.get("language", ""))
    artist = normalize_text(song.get("artist", song.get("primaryArtists", "")))

    score = 0.35
    if language and language in preferred_languages:
        score += 0.3

    if artist:
        artist_tokens = [token.strip() for token in artist.split(",") if token.strip()]
        for token in artist_tokens:
            if token in preferred_artists:
                score += 0.35
                break

    return clamp(score, 0.0, 1.0)


def normalize_popularity(value: Any) -> float:
    try:
        raw = float(value)
    except (TypeError, ValueError):
        raw = 0.0

    if raw <= 0:
        return 0.3
    return clamp(math.log10(raw + 1) / 2.5, 0.0, 1.0)


def fuzzy_term_match(term: str, tokens: Iterable[str]) -> float:
    for token in tokens:
        if not token:
            continue
        max_distance = 2 if len(term) >= 7 else 1
        if abs(len(term) - len(token)) > max_distance:
            continue
        if levenshtein(term, token) <= max_distance:
            return 0.55
    return 0.0


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)

    rows = len(a) + 1
    cols = len(b) + 1
    dp = [[0 for _ in range(cols)] for _ in range(rows)]
    for i in range(rows):
        dp[i][0] = i
    for j in range(cols):
        dp[0][j] = j

    for i in range(1, rows):
        for j in range(1, cols):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            dp[i][j] = min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost,
            )
    return dp[-1][-1]


def tokenize(text: str) -> List[str]:
    return [token for token in normalize_text(text).replace(",", " ").split() if token]


def normalize_text(value: Any) -> str:
    return str(value or "").strip().lower()


def coerce_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v) for v in value]
    if isinstance(value, dict):
        return [str(v) for v in value.keys()]
    return [str(value)]


def to_float(value: Any) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return 0.0
    return result if math.isfinite(result) else 0.0


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))
