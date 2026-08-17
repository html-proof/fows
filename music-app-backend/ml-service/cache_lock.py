"""
Lightweight Redis-backed cache-stampede prevention.

Usage (in an async FastAPI endpoint):
    async with CacheLock(redis, key="resolve:song_id", ttl=300) as cached:
        if cached is not None:
            return cached          # cache hit, lock never acquired
        result = await expensive_provider_call()
        await cached.set(result)   # writes to Redis and releases lock
        return result

If Redis is unavailable the context manager falls through transparently —
the caller gets None and must handle the miss without locking (fail-open).
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncGenerator

try:
    import redis.asyncio as aioredis
    _REDIS_AVAILABLE = True
except ImportError:
    _REDIS_AVAILABLE = False


REDIS_URL = os.getenv("REDIS_URL", "")
_redis_client: Any = None


def _get_redis() -> Any:
    global _redis_client
    if not _REDIS_AVAILABLE or not REDIS_URL:
        return None
    if _redis_client is None:
        _redis_client = aioredis.from_url(REDIS_URL, decode_responses=True)
    return _redis_client


class _CacheHandle:
    """Returned from CacheLock when there is a cache miss and a lock is held."""

    def __init__(self, redis: Any, key: str, lock_key: str, lock_val: str, ttl: int) -> None:
        self._redis = redis
        self._key = key
        self._lock_key = lock_key
        self._lock_val = lock_val
        self._ttl = ttl

    async def set(self, value: Any) -> None:
        """Write the computed value to Redis and release the lock."""
        try:
            serialized = json.dumps(value)
            await self._redis.set(self._key, serialized, ex=self._ttl)
        finally:
            script = """
                if redis.call("get", KEYS[1]) == ARGV[1] then
                    return redis.call("del", KEYS[1])
                else
                    return 0
                end
            """
            await self._redis.eval(script, 1, self._lock_key, self._lock_val)


@asynccontextmanager
async def CacheLock(
    key: str,
    ttl: int = 300,
    lock_ttl: int = 15,
    wait_interval: float = 0.1,
    wait_timeout: float = 5.0,
) -> AsyncGenerator[Any, None]:
    """
    Async context manager that:
    - Returns the cached value immediately (no lock) on a cache HIT.
    - On MISS: acquires a Redis lock so only one caller fetches the provider;
      other concurrent callers poll until the result is cached, then return it.
    - Yields None if Redis is unavailable (fail-open).
    - Yields a _CacheHandle on cache miss + lock acquired; caller must call
      handle.set(result) to populate the cache and release the lock.
    """
    redis = _get_redis()
    if redis is None:
        yield None
        return

    try:
        raw = await redis.get(key)
        if raw is not None:
            yield json.loads(raw)
            return
    except Exception:
        yield None
        return

    lock_key = f"{key}:lock"
    lock_val = str(uuid.uuid4())

    try:
        acquired = await redis.set(lock_key, lock_val, nx=True, ex=lock_ttl)

        if acquired:
            handle = _CacheHandle(redis, key, lock_key, lock_val, ttl)
            yield handle
            return

        # Another request holds the lock — poll until it populates the cache.
        deadline = asyncio.get_event_loop().time() + wait_timeout
        while asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(wait_interval)
            try:
                raw = await redis.get(key)
                if raw is not None:
                    yield json.loads(raw)
                    return
            except Exception:
                break

        # Timed out waiting — fall through with no cached value.
        yield None

    except Exception:
        yield None
