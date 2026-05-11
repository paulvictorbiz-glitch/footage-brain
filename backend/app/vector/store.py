"""
VectorStore abstraction layer.

Interface:
  - upsert(ids, embeddings, metadatas, documents)
  - query(embedding, n_results, where_filter) -> list of hits
  - delete(ids)
  - count() -> int

Concrete implementations:
  - ChromaVectorStore  (MVP)
  - (Qdrant, Milvus, OpenSearch in phase 2)
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from functools import lru_cache
from typing import Any, Dict, List, Optional

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Abstract base
# ─────────────────────────────────────────────────────────────────────────────

class VectorStore(ABC):

    @abstractmethod
    def upsert(
        self,
        ids: List[str],
        embeddings: List[List[float]],
        metadatas: List[Dict[str, Any]],
        documents: List[str],
    ) -> None: ...

    @abstractmethod
    def query(
        self,
        embedding: List[float],
        n_results: int = 10,
        where: Optional[Dict] = None,
    ) -> List[Dict[str, Any]]: ...

    @abstractmethod
    def delete(self, ids: List[str]) -> None: ...

    @abstractmethod
    def count(self) -> int: ...


# ─────────────────────────────────────────────────────────────────────────────
# Chroma implementation
# ─────────────────────────────────────────────────────────────────────────────

COLLECTION_NAME = "transcript_chunks"
FRAME_COLLECTION_NAME = "frame_embeddings"


class ChromaVectorStore(VectorStore):

    def __init__(self, collection_name: str = COLLECTION_NAME) -> None:
        import chromadb

        settings = get_settings()
        self._client = chromadb.PersistentClient(path=settings.chroma_dir)
        self._col = self._client.get_or_create_collection(
            collection_name,
            metadata={"hnsw:space": "cosine"},
        )
        logger.info("chroma_initialized", collection=collection_name, path=settings.chroma_dir)

    def upsert(
        self,
        ids: List[str],
        embeddings: List[List[float]],
        metadatas: List[Dict[str, Any]],
        documents: List[str],
    ) -> None:
        if not ids:
            return
        # Chroma upsert in batches to stay within limits
        batch = 500
        for i in range(0, len(ids), batch):
            self._col.upsert(
                ids=ids[i : i + batch],
                embeddings=embeddings[i : i + batch],
                metadatas=metadatas[i : i + batch],
                documents=documents[i : i + batch],
            )

    def query(
        self,
        embedding: List[float],
        n_results: int = 10,
        where: Optional[Dict] = None,
    ) -> List[Dict[str, Any]]:
        kwargs: dict = {
            "query_embeddings": [embedding],
            "n_results": min(n_results, self.count() or 1),
            "include": ["documents", "metadatas", "distances"],
        }
        if where:
            kwargs["where"] = where

        try:
            res = self._col.query(**kwargs)
        except Exception as exc:
            logger.error("chroma_query_error", error=str(exc))
            return []

        hits = []
        ids_list = res.get("ids", [[]])[0]
        docs_list = res.get("documents", [[]])[0]
        metas_list = res.get("metadatas", [[]])[0]
        dists_list = res.get("distances", [[]])[0]

        for i, cid in enumerate(ids_list):
            dist = dists_list[i] if i < len(dists_list) else 1.0
            score = max(0.0, 1.0 - dist)  # cosine distance → similarity
            meta = metas_list[i] if i < len(metas_list) else {}
            if meta is None:
                meta = {}
            hits.append({
                "chroma_id": cid,
                "document": docs_list[i] if i < len(docs_list) else "",
                "metadata": meta,
                "score": round(score, 4),
            })
        return hits

    def delete(self, ids: List[str]) -> None:
        if ids:
            self._col.delete(ids=ids)

    def count(self) -> int:
        return self._col.count()


# ─────────────────────────────────────────────────────────────────────────────
# Singleton factories
# ─────────────────────────────────────────────────────────────────────────────

_store: Optional[VectorStore] = None
_frame_store: Optional[VectorStore] = None


def get_vector_store() -> VectorStore:
    global _store
    if _store is None:
        _store = ChromaVectorStore(COLLECTION_NAME)
    return _store


def get_frame_store() -> VectorStore:
    global _frame_store
    if _frame_store is None:
        _frame_store = ChromaVectorStore(FRAME_COLLECTION_NAME)
    return _frame_store
