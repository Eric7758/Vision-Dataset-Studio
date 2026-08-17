"""FastAPI 主应用。

渐进式迁移：新端点在 /api/v1/ 下，旧路径保留在 web_server.py 的 ThreadingHTTPServer 中。
可通过 uvicorn 独立启动:  uvicorn server.app:app --host 127.0.0.1 --port 8101
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from server.routers import ai, batch, caption, export, image_process, items, projects, workspace

app = FastAPI(
    title="Vision Dataset Studio API",
    description="视觉数据集工作台 API — 多控制图浏览 / Caption 编辑 / AI 标注 / 图像预处理 / 导出",
    version="1.0.0",
)


@app.exception_handler(FileNotFoundError)
async def file_not_found_handler(request: Request, exc: FileNotFoundError):
    return JSONResponse(status_code=404, content={"ok": False, "error": str(exc), "error_code": "not_found"})


@app.exception_handler(KeyError)
async def key_error_handler(request: Request, exc: KeyError):
    name = exc.args[0] if exc.args else ""
    return JSONResponse(status_code=404, content={"ok": False, "error": f"Item not found: {name}", "error_code": "not_found"})


@app.exception_handler(FileExistsError)
async def file_exists_handler(request: Request, exc: FileExistsError):
    return JSONResponse(status_code=409, content={"ok": False, "error": str(exc), "error_code": "already_exists"})


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"ok": False, "error": str(exc), "error_code": "invalid_request"})

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

for api_prefix in ("/api/v1", "/api"):
    app.include_router(workspace.router, prefix=api_prefix)
    app.include_router(items.router, prefix=api_prefix)
    app.include_router(batch.router, prefix=api_prefix)
    app.include_router(export.router, prefix=api_prefix)
    app.include_router(image_process.router, prefix=api_prefix)
    app.include_router(projects.router, prefix=api_prefix)
    app.include_router(ai.router, prefix=api_prefix)
    app.include_router(caption.router, prefix=api_prefix)


@app.on_event("startup")
async def startup():
    """启动时开启 WebSocket 广播后台任务。"""
    import asyncio

    from server.routers.ai import _broadcast_snapshots
    asyncio.create_task(_broadcast_snapshots())


@app.get("/api/v1/health")
async def health():
    return {"ok": True, "status": "healthy"}


@app.get("/api/health")
async def legacy_health():
    return {"ok": True, "status": "healthy"}
