import os
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field

from artifacts import resident_megabytes, store
from model import rank_songs_for_user, recommend_for_user

API_KEY = os.getenv("ML_SERVICE_API_KEY", "").strip()

# The gateway batches candidates before calling us; these caps keep a single
# request from ballooning the working set on a 512 MB instance.
MAX_SONGS_PER_REQUEST = 200


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Load once at boot. A missing or unreadable artifact is not fatal -- the
    # service falls back to heuristic scoring and says so on /health.
    store.load()
    status = store.status()
    if status["loaded"]:
        print(f"[ml-service] model loaded: {status['num_users']} users, {status['num_songs']} songs")
    else:
        print(f"[ml-service] serving heuristics only ({status['error']})")
    yield


app = FastAPI(title="music-ml-service", version="2.0.0", lifespan=lifespan)


class RankRequest(BaseModel):
    userId: str
    songs: List[Dict[str, Any]]
    query: str = ""
    topK: int = Field(default=10, ge=1, le=100)
    userContext: Optional[Dict[str, Any]] = None


class RecommendRequest(BaseModel):
    userId: str
    userData: Dict[str, Any]
    songs: List[Dict[str, Any]] = []
    topK: int = Field(default=20, ge=1, le=100)


class ScoreRequest(BaseModel):
    userId: str
    songIds: List[str]


@app.get("/health")
def health() -> Dict[str, Any]:
    payload: Dict[str, Any] = {"status": "ok", "service": "ml-service", "model": store.status()}
    rss = resident_megabytes()
    if rss is not None:
        payload["rss_mb"] = rss
    return payload


@app.head("/health", include_in_schema=False)
def health_head() -> Response:
    return Response(status_code=200)


@app.get("/")
def root() -> Dict[str, str]:
    return {"message": "ML Service is healthy"}


@app.head("/", include_in_schema=False)
def root_head() -> Response:
    return Response(status_code=200)


def verify_api_key(request: Request, x_api_key: str | None = Header(default=None)) -> None:
    if API_KEY:
        if x_api_key != API_KEY:
            raise HTTPException(status_code=401, detail="Unauthorized")
        return

    client_host = request.client.host if request.client else ""
    if client_host not in ("127.0.0.1", "localhost", "::1"):
        raise HTTPException(status_code=401, detail="Unauthorized")


def enforce_song_cap(songs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return songs[:MAX_SONGS_PER_REQUEST]


@app.post("/rank")
def rank_songs(req: RankRequest, _auth: None = Depends(verify_api_key)) -> Dict[str, Any]:
    ranked = rank_songs_for_user(
        user_id=req.userId,
        songs=enforce_song_cap(req.songs),
        query=req.query,
        top_k=req.topK,
        user_context=req.userContext,
    )
    return {"results": ranked, "model": "trained" if store.loaded else "heuristic"}


@app.post("/recommend")
def recommend(req: RecommendRequest, _auth: None = Depends(verify_api_key)) -> Dict[str, Any]:
    return recommend_for_user(
        user_id=req.userId,
        user_data=req.userData,
        songs=enforce_song_cap(req.songs),
        top_k=req.topK,
    )


@app.post("/score")
def score(req: ScoreRequest, _auth: None = Depends(verify_api_key)) -> Dict[str, Any]:
    """
    Learned score only -- no heuristics, no song metadata.

    This is what the live gateway calls. It keeps ranking policy (lexical
    guardrails, language boosts, result partitioning) on the Node side where it
    already lives, and asks this service purely for the part that needs a
    trained model. Sending ids instead of full song objects also keeps the
    request small enough to fit comfortably in the latency budget.

    Returns an empty map for an unknown user rather than an error: cold start is
    a normal state, and the caller simply ranks without a model contribution.
    """
    song_ids = [str(x) for x in req.songIds[:MAX_SONGS_PER_REQUEST]]
    scores = store.score(req.userId, song_ids)

    if scores is None:
        return {"scores": {}, "model": "cold-start" if store.loaded else "unavailable"}

    return {
        "scores": {song_id: round(float(value), 6) for song_id, value in zip(song_ids, scores)},
        "model": "trained",
    }


@app.post("/model/reload")
def reload_model(_auth: None = Depends(verify_api_key)) -> Dict[str, Any]:
    """Pick up freshly trained artifacts without restarting the service."""
    store.load()
    return store.status()
