from fastapi import APIRouter
from app.api import sources, files, search, duplicates, dashboard, media, tools, thermal, timelines

api_router = APIRouter()
api_router.include_router(sources.router)
api_router.include_router(files.router)
api_router.include_router(search.router)
api_router.include_router(duplicates.router)
api_router.include_router(dashboard.router)
api_router.include_router(media.router)
api_router.include_router(tools.router)
api_router.include_router(thermal.router)
api_router.include_router(timelines.router)
