"""FastAPI server exposing the Skyfall-GS reconstruction pipeline.

Endpoints
  GET    /                      Health / info
  POST   /jobs                  Create a job from uploaded images
  GET    /jobs                  List jobs
  GET    /jobs/{id}             Job detail (poll this for progress)
  DELETE /jobs/{id}             Delete a job and its files
  GET    /jobs/{id}/files/{fn}  Download an output file (e.g. fused .ply)
"""

from __future__ import annotations

from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from . import config
from .jobs import manager

app = FastAPI(title="Skyfall-GS Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def info() -> dict:
    return {
        "name": "Skyfall-GS Backend",
        "repo": str(config.SKYFALL_REPO),
        "repo_present": config.SKYFALL_REPO.exists(),
        "work_dir": str(config.WORK_DIR),
        "skip_preprocess": config.SKIP_PREPROCESS,
        "skip_stage2": config.SKIP_STAGE2,
    }


@app.post("/jobs")
async def create_job(
    images: list[UploadFile] = File(...),
    name: str = Form(""),
    source: Literal["colmap", "satellite"] = Form("colmap"),
) -> dict:
    if not images:
        raise HTTPException(status_code=400, detail="No images uploaded")

    files: list[tuple[str, bytes]] = []
    for img in images:
        content = await img.read()
        if content:
            files.append((img.filename or "image.png", content))
    if not files:
        raise HTTPException(status_code=400, detail="Uploaded images were empty")

    job = manager.create(name=name.strip(), source=source, files=files)
    return job.to_dict()


@app.get("/jobs")
def list_jobs() -> list[dict]:
    return [j.to_dict() for j in manager.list()]


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.to_dict()


@app.delete("/jobs/{job_id}")
def delete_job(job_id: str) -> dict:
    if not manager.delete(job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    return {"deleted": job_id}


@app.get("/jobs/{job_id}/files/{filename}")
def download_file(job_id: str, filename: str):
    path = manager.output_file(job_id, filename)
    if not path:
        raise HTTPException(status_code=404, detail="File not found")
    media = "application/octet-stream"
    return FileResponse(path, media_type=media, filename=path.name)
