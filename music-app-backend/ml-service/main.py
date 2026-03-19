import os
from typing import Any, Dict, List

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field

from model import rank_songs_for_user, recommend_for_user

app = FastAPI(title="music-ml-service", version="1.0.0")
API_KEY = os.getenv("ML_SERVICE_API_KEY", "").strip()


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


@app.post("/rank")
def rank_songs(req: RankRequest, _auth: None = Depends(verify_api_key)) -> Dict[str, Any]:
    ranked = rank_songs_for_user(
        user_id=req.userId,
        songs=req.songs,
        query=req.query,
        top_k=req.topK,
    )
    return {"results": ranked}


@app.post("/recommend")
def recommend(req: RecommendRequest, _auth: None = Depends(verify_api_key)) -> Dict[str, Any]:
    return recommend_for_user(
        user_id=req.userId,
        user_data=req.userData,
        songs=req.songs,
        top_k=req.topK,
    )
