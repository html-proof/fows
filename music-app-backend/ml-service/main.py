from typing import Any, Dict, List

from fastapi import FastAPI
from pydantic import BaseModel, Field

from model import rank_songs_for_user, recommend_for_user

app = FastAPI(title="music-ml-service", version="1.0.0")


class RankRequest(BaseModel):
    userId: str
    songs: List[Dict[str, Any]]
    query: str = ""
    topK: int = Field(default=10, ge=1, le=100)


class RecommendRequest(BaseModel):
    userId: str
    userData: Dict[str, Any]
    songs: List[Dict[str, Any]] = []
    topK: int = Field(default=20, ge=1, le=100)


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok", "service": "ml-service"}


@app.post("/rank")
def rank_songs(req: RankRequest) -> Dict[str, Any]:
    ranked = rank_songs_for_user(
        user_id=req.userId,
        songs=req.songs,
        query=req.query,
        top_k=req.topK,
    )
    return {"results": ranked}


@app.post("/recommend")
def recommend(req: RecommendRequest) -> Dict[str, Any]:
    return recommend_for_user(
        user_id=req.userId,
        user_data=req.userData,
        songs=req.songs,
        top_k=req.topK,
    )
