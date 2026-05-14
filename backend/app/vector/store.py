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
CAPTION_COLLECTION_NAME = "frame_captions"


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
# Qdrant implementation (local-embedded or remote)
# ─────────────────────────────────────────────────────────────────────────────

class QdrantVectorStore(VectorStore):
    """
    Qdrant-backed store. Supports two modes:
      • remote: settings.qdrant_url is set → HTTP client
      • embedded: otherwise → local persistent dir (qdrant_path)

    Collection is lazy-created on first upsert; vector size is inferred from
    the first batch of embeddings, so the store works for any embedding
    dimension transparently.
    """

    def __init__(self, collection_name: str) -> None:
        from qdrant_client import QdrantClient

        settings = get_settings()
        self._name = collection_name

        if settings.qdrant_url:
            self._client = QdrantClient(
                url=settings.qdrant_url,
                api_key=settings.qdrant_api_key or None,
            )
            target = settings.qdrant_url
        else:
            path = settings.qdrant_path or "./data/qdrant"
            from pathlib import Path as _P
            _P(path).mkdir(parents=True, exist_ok=True)
            self._client = QdrantClient(path=path)
            target = path

        self._created = self._collection_exists()
        self._vector_size: Optional[int] = None
        logger.info("qdrant_initialized", collection=collection_name, target=target)

    def _collection_exists(self) -> bool:
        try:
            self._client.get_collection(self._name)
            return True
        except Exception:
            return False

    def _ensure_collection(self, dim: int) -> None:
        if self._created:
            return
        from qdrant_client.http import models as qm
        self._client.create_collection(
            collection_name=self._name,
            vectors_config=qm.VectorParams(size=dim, distance=qm.Distance.COSINE),
        )
        self._created = True
        self._vector_size = dim
        logger.info("qdrant_collection_created", collection=self._name, dim=dim)

    @staticmethod
    def _to_point_id(s: str) -> str:
        """Qdrant point IDs must be uint or UUID; map any string id via UUIDv5."""
        import uuid as _uuid
        # Deterministic mapping so the same chroma-id always yields the same point.
        return str(_uuid.uuid5(_uuid.NAMESPACE_URL, s))

    def upsert(self, ids, embeddings, metadatas, documents) -> None:
        if not ids:
            return
        from qdrant_client.http import models as qm

        self._ensure_collection(len(embeddings[0]))

        points = []
        for cid, emb, meta, doc in zip(ids, embeddings, metadatas, documents):
            payload = dict(meta or {})
            payload["_external_id"] = cid
            payload["document"] = doc
            points.append(qm.PointStruct(
                id=self._to_point_id(cid),
                vector=list(emb),
                payload=payload,
            ))

        batch = 256
        for i in range(0, len(points), batch):
            self._client.upsert(collection_name=self._name, points=points[i : i + batch], wait=False)

    def query(self, embedding, n_results=10, where=None) -> List[Dict[str, Any]]:
        if not self._created:
            return []
        from qdrant_client.http import models as qm

        qfilter = None
        if where:
            must = []
            for k, v in where.items():
                must.append(qm.FieldCondition(key=k, match=qm.MatchValue(value=v)))
            qfilter = qm.Filter(must=must) if must else None

        try:
            hits = self._client.search(
                collection_name=self._name,
                query_vector=list(embedding),
                limit=n_results,
                with_payload=True,
                query_filter=qfilter,
            )
        except Exception as exc:
            logger.error("qdrant_query_error", error=str(exc))
            return []

        out = []
        for h in hits:
            payload = dict(h.payload or {})
            ext_id = payload.pop("_external_id", str(h.id))
            doc = payload.pop("document", "")
            out.append({
                "chroma_id": ext_id,
                "document": doc,
                "metadata": payload,
                "score": round(float(h.score or 0.0), 4),
            })
        return out

    def delete(self, ids) -> None:
        if not ids or not self._created:
            return
        from qdrant_client.http import models as qm
        self._client.delete(
            collection_name=self._name,
            points_selector=qm.PointIdsList(points=[self._to_point_id(i) for i in ids]),
        )

    def count(self) -> int:
        if not self._created:
            return 0
        try:
            return int(self._client.count(self._name, exact=True).count)
        except Exception:
            return 0


# ─────────────────────────────────────────────────────────────────────────────
# LanceDB implementation (embedded, columnar)
# ─────────────────────────────────────────────────────────────────────────────

class LanceDBVectorStore(VectorStore):
    """
    LanceDB embedded store. One on-disk Lance table per collection.
    Schema is created lazily on first upsert (vector dim inferred from data).
    """

    def __init__(self, collection_name: str) -> None:
        import lancedb

        settings = get_settings()
        path = settings.lancedb_path or "./data/lancedb"
        from pathlib import Path as _P
        _P(path).mkdir(parents=True, exist_ok=True)

        self._db = lancedb.connect(path)
        self._name = collection_name
        self._table = self._db.open_table(collection_name) if collection_name in self._db.table_names() else None
        logger.info("lancedb_initialized", collection=collection_name, path=path)

    def _rows(self, ids, embeddings, metadatas, documents) -> List[dict]:
        import json
        rows = []
        for cid, emb, meta, doc in zip(ids, embeddings, metadatas, documents):
            row = {
                "id": cid,
                "vector": list(emb),
                "document": doc or "",
                # LanceDB needs a fixed schema — stash heterogeneous metadata as JSON
                # and lift the well-known scalars we filter on into typed columns.
                "video_file_id": str((meta or {}).get("video_file_id", "")),
                "project_tag": str((meta or {}).get("project_tag", "")),
                "timestamp": float((meta or {}).get("timestamp", 0.0)),
                "frame_index": int((meta or {}).get("frame_index", 0)),
                "metadata_json": json.dumps(meta or {}),
            }
            rows.append(row)
        return rows

    def upsert(self, ids, embeddings, metadatas, documents) -> None:
        if not ids:
            return
        rows = self._rows(ids, embeddings, metadatas, documents)
        if self._table is None:
            self._table = self._db.create_table(self._name, data=rows, mode="overwrite")
        else:
            # delete-then-add for upsert semantics on the string id
            try:
                joined = ",".join(f"'{r['id']}'" for r in rows)
                self._table.delete(f"id IN ({joined})")
            except Exception:
                pass
            self._table.add(rows)

    def query(self, embedding, n_results=10, where=None) -> List[Dict[str, Any]]:
        if self._table is None:
            return []
        import json
        try:
            q = self._table.search(list(embedding)).limit(n_results)
            if where:
                clauses = []
                for k, v in where.items():
                    if isinstance(v, str):
                        clauses.append(f"{k} = '{v}'")
                    else:
                        clauses.append(f"{k} = {v}")
                if clauses:
                    q = q.where(" AND ".join(clauses))
            df = q.to_list()
        except Exception as exc:
            logger.error("lancedb_query_error", error=str(exc))
            return []

        out = []
        for row in df:
            # LanceDB returns L2 distance by default — map to cosine-like sim.
            dist = float(row.get("_distance", 0.0))
            score = max(0.0, 1.0 - dist)
            meta = {}
            try:
                meta = json.loads(row.get("metadata_json") or "{}")
            except Exception:
                meta = {}
            out.append({
                "chroma_id": row.get("id", ""),
                "document": row.get("document", ""),
                "metadata": meta,
                "score": round(score, 4),
            })
        return out

    def delete(self, ids) -> None:
        if not ids or self._table is None:
            return
        joined = ",".join(f"'{i}'" for i in ids)
        try:
            self._table.delete(f"id IN ({joined})")
        except Exception as exc:
            logger.error("lancedb_delete_error", error=str(exc))

    def count(self) -> int:
        if self._table is None:
            return 0
        try:
            return int(self._table.count_rows())
        except Exception:
            return 0


# ─────────────────────────────────────────────────────────────────────────────
# Singleton factories
# ─────────────────────────────────────────────────────────────────────────────

_store: Optional[VectorStore] = None
_frame_store: Optional[VectorStore] = None
_caption_store: Optional[VectorStore] = None


def _build_store(collection_name: str) -> VectorStore:
    backend = (get_settings().vector_store or "chroma").lower()
    if backend == "qdrant":
        return QdrantVectorStore(collection_name)
    if backend == "lancedb":
        return LanceDBVectorStore(collection_name)
    return ChromaVectorStore(collection_name)


def get_vector_store() -> VectorStore:
    global _store
    if _store is None:
        _store = _build_store(COLLECTION_NAME)
    return _store


def get_frame_store() -> VectorStore:
    global _frame_store
    if _frame_store is None:
        _frame_store = _build_store(FRAME_COLLECTION_NAME)
    return _frame_store


def get_caption_store() -> VectorStore:
    global _caption_store
    if _caption_store is None:
        _caption_store = _build_store(CAPTION_COLLECTION_NAME)
    return _caption_store
