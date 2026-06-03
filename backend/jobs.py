"""Job management: persistence, a single-worker queue, and pipeline driving.

GPU training is serialized through one worker thread (a typical box trains one
scene at a time). Jobs and their state are persisted to JSON so the API can
restart without losing history.
"""

from __future__ import annotations

import json
import queue
import shutil
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import config
from . import pipeline


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class JobOutput:
    name: str
    url: str
    size: int
    kind: str  # "ply" | "video" | "other"


@dataclass
class Job:
    id: str
    name: str
    source: str
    status: str = "queued"
    stage: str = ""
    progress: float = 0.0
    num_images: int = 0
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)
    error: Optional[str] = None
    log_tail: list[str] = field(default_factory=list)
    outputs: list[JobOutput] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        return d

    @property
    def dir(self) -> Path:
        return config.WORK_DIR / self.id

    @property
    def images_dir(self) -> Path:
        return self.dir / "data" / "images"

    @property
    def data_dir(self) -> Path:
        return self.dir / "data"

    @property
    def model_dir(self) -> Path:
        return self.dir / "model"


class JobManager:
    def __init__(self) -> None:
        config.ensure_dirs()
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._load_all()
        self._worker = threading.Thread(target=self._run_worker, daemon=True)
        self._worker.start()

    # --- persistence ----------------------------------------------------

    def _meta_path(self, job_id: str) -> Path:
        return config.WORK_DIR / job_id / "job.json"

    def _save(self, job: Job) -> None:
        job.updated_at = _now()
        path = self._meta_path(job.id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(job.to_dict(), indent=2))

    def _load_all(self) -> None:
        for meta in config.WORK_DIR.glob("*/job.json"):
            try:
                data = json.loads(meta.read_text())
                outputs = [JobOutput(**o) for o in data.pop("outputs", [])]
                job = Job(**data, outputs=outputs) if "outputs" not in data else Job(**data)
                job.outputs = outputs
                # Jobs interrupted by a restart are marked failed.
                if job.status not in ("done", "failed"):
                    job.status = "failed"
                    job.error = "Interrupted by server restart"
                self._jobs[job.id] = job
            except Exception:
                continue

    # --- CRUD -----------------------------------------------------------

    def create(self, name: str, source: str, files: list[tuple[str, bytes]]) -> Job:
        job_id = uuid.uuid4().hex[:12]
        job = Job(id=job_id, name=name or job_id, source=source, num_images=len(files))
        job.images_dir.mkdir(parents=True, exist_ok=True)
        for idx, (filename, content) in enumerate(files):
            safe = Path(filename).name or f"image_{idx:04d}.png"
            (job.images_dir / safe).write_bytes(content)
        with self._lock:
            self._jobs[job_id] = job
        self._save(job)
        self._queue.put(job_id)
        return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            jobs = list(self._jobs.values())
        return sorted(jobs, key=lambda j: j.created_at, reverse=True)

    def delete(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.pop(job_id, None)
        if not job:
            return False
        shutil.rmtree(job.dir, ignore_errors=True)
        return True

    # --- worker ---------------------------------------------------------

    def _update(self, job: Job, *, status=None, stage=None, progress=None,
                log=None, error=None) -> None:
        with self._lock:
            if status is not None:
                job.status = status
            if stage is not None:
                job.stage = stage
            if progress is not None:
                job.progress = progress
            if log is not None:
                job.log_tail = log[-60:]
            if error is not None:
                job.error = error
        self._save(job)

    def _run_worker(self) -> None:
        while True:
            job_id = self._queue.get()
            job = self.get(job_id)
            if not job:
                continue
            try:
                self._process(job)
            except Exception as exc:  # noqa: BLE001
                self._update(job, status="failed", error=str(exc))
            finally:
                self._queue.task_done()

    def _process(self, job: Job) -> None:
        def cb(status: str, stage: str, progress: float, log: list[str]) -> None:
            self._update(job, status=status, stage=stage, progress=progress, log=log)

        output_ply = pipeline.run_pipeline(
            job_id=job.id,
            data_dir=job.data_dir,
            images_dir=job.images_dir,
            model_dir=job.model_dir,
            source=job.source,
            update_cb=cb,
        )

        out = JobOutput(
            name=output_ply.name,
            url=f"/jobs/{job.id}/files/{output_ply.name}",
            size=output_ply.stat().st_size,
            kind="ply",
        )
        with self._lock:
            job.outputs = [out]
            job.status = "done"
            job.stage = "Done"
            job.progress = 1.0
        self._save(job)

    def output_file(self, job_id: str, filename: str) -> Optional[Path]:
        job = self.get(job_id)
        if not job:
            return None
        path = (job.dir / "output" / Path(filename).name).resolve()
        # Guard against path traversal.
        if not str(path).startswith(str((job.dir / "output").resolve())):
            return None
        return path if path.exists() else None


manager = JobManager()
