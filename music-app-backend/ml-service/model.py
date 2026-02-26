from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List


def rank_songs_for_user(user_id: str, songs: List[Dict[str, Any]], query: str = "", top_k: int = 10) -> List[Dict[str, Any]]:
    normalized_query = normalize_text(query)
    preferred_languages = {normalize_text(x) for x in coerce_list(safe_get_user_pref(user_id, "preferred_language"))}
    preferred_artists = {normalize_text(x) for x in coerce_list(safe_get_user_pref(user_id, "preferred_artists"))}

    ranked = []
    for index, song in enumerate(songs):
        text_score = lexical_score(normalized_query, song)
        popularity_score = normalize_popularity(song.get("global_popularity_score", song.get("play_count", 0)))
        user_pref_score = preference_score(song, preferred_languages, preferred_artists)
        interaction_score = interaction_bias(user_id, song)

        # Strong lexical priority for search quality.
        final_score = (
            0.55 * text_score +
            0.20 * user_pref_score +
            0.15 * popularity_score +
            0.10 * interaction_score
        )
        if normalized_query and text_score < 0.20:
            final_score *= 0.5

        ranked_song = {
            **song,
            "_rank": {
                "final_score": round(final_score, 6),
                "text_score": round(text_score, 6),
                "preference_score": round(user_pref_score, 6),
                "popularity_score": round(popularity_score, 6),
                "interaction_score": round(interaction_score, 6),
                "original_index": index,
            },
        }
        ranked.append(ranked_song)

    ranked.sort(key=lambda x: x["_rank"]["final_score"], reverse=True)
    return ranked[: max(1, int(top_k))]


def recommend_for_user(
    user_id: str,
    user_data: Dict[str, Any],
    songs: List[Dict[str, Any]] | None = None,
    top_k: int = 20,
) -> Dict[str, Any]:
    catalog = songs or []
    preferred_languages = {normalize_text(x) for x in coerce_list(user_data.get("preferred_language", []))}
    preferred_artists = {normalize_text(x) for x in coerce_list(user_data.get("preferred_artists", []))}

    scored = []
    for song in catalog:
        score = preference_score(song, preferred_languages, preferred_artists)
        score = 0.7 * score + 0.3 * normalize_popularity(song.get("global_popularity_score", song.get("play_count", 0)))
        scored.append({**song, "_recommendation_score": round(score, 6)})

    scored.sort(key=lambda x: x["_recommendation_score"], reverse=True)
    return {
        "recommended_for": user_id,
        "based_on": {
            "language": sorted(preferred_languages),
            "artists": sorted(preferred_artists),
        },
        "songs": scored[: max(1, int(top_k))],
    }


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


def interaction_bias(user_id: str, song: Dict[str, Any]) -> float:
    # Deterministic pseudo-personalization fallback before trained model is loaded.
    song_id = normalize_text(str(song.get("id", "")))
    seed = abs(hash(f"{user_id}:{song_id}")) % 1000
    return seed / 1000.0


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
    return [str(value)]


def safe_get_user_pref(_user_id: str, _key: str) -> List[str]:
    # Replace with cache/feature store lookup once model serving is added.
    return []


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))
