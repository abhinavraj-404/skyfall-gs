"""Skyfall-GS pipeline execution.

Runs the documented Skyfall-GS stages as subprocesses against a cloned repo,
streaming logs back to the caller via a callback. Each stage command is a
template defined in config.py and can be overridden via environment variables.
"""

from __future__ import annotations

import re
import shlex
import socket
import subprocess
import threading
from collections import deque
from pathlib import Path
from typing import Callable, Deque

from . import config

# Coarse weight of each stage in the overall 0..1 progress bar.
STAGE_WEIGHTS = {
    "preprocessing": 0.10,
    "training_stage1": 0.45,
    "training_stage2": 0.40,
    "fusing": 0.05,
}

_ITER_RE = re.compile(r"(\d+)\s*/\s*(\d+)")
_used_ports: set[int] = set()
_port_lock = threading.Lock()


def _acquire_port() -> int:
    with _port_lock:
        for port in range(config.PORT_RANGE_START, config.PORT_RANGE_END + 1):
            if port in _used_ports:
                continue
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                if s.connect_ex(("127.0.0.1", port)) != 0:  # nothing listening
                    _used_ports.add(port)
                    return port
        raise RuntimeError("No free port available in the configured range")


def _release_port(port: int) -> None:
    with _port_lock:
        _used_ports.discard(port)


class PipelineError(RuntimeError):
    pass


# update_cb(status, stage_label, progress_0_1, log_lines)
UpdateCb = Callable[[str, str, float, list[str]], None]


def _run(cmd: str, cwd: Path, log: Deque[str], on_log: Callable[[], None],
         stage_key: str, base_progress: float, report: Callable[[float], None]) -> None:
    """Run a shell command, streaming stdout/stderr into `log`."""
    log.append(f"$ {cmd}")
    on_log()

    proc = subprocess.Popen(
        shlex.split(cmd),
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    weight = STAGE_WEIGHTS.get(stage_key, 0.1)
    for line in proc.stdout:
        line = line.rstrip("\n")
        if not line:
            continue
        log.append(line)
        # Best-effort progress from "123/4560" style iteration counters.
        m = _ITER_RE.search(line)
        if m:
            cur, total = int(m.group(1)), int(m.group(2))
            if 0 < cur <= total:
                report(base_progress + weight * (cur / total))
        on_log()

    code = proc.wait()
    if code != 0:
        raise PipelineError(f"Command failed (exit {code}): {cmd}")


def _prefixed(cmd: str) -> str:
    prefix = config.CMD_PREFIX.strip()
    return f"{prefix} {cmd}" if prefix else cmd


def run_pipeline(
    *,
    job_id: str,
    data_dir: Path,
    images_dir: Path,
    model_dir: Path,
    source: str,
    update_cb: UpdateCb,
) -> Path:
    """Execute the full pipeline and return the path to the fused .ply."""
    repo = config.SKYFALL_REPO
    if not repo.exists():
        raise PipelineError(
            f"Skyfall-GS repo not found at {repo}. Clone it or set SKYFALL_REPO."
        )

    log: Deque[str] = deque(maxlen=400)
    state = {"status": "queued", "stage": "", "progress": 0.0}

    def emit() -> None:
        update_cb(state["status"], state["stage"], state["progress"], list(log))

    def report(p: float) -> None:
        state["progress"] = max(state["progress"], min(p, 0.999))
        emit()

    def fmt(template: str, **extra) -> str:
        return template.format(
            repo=repo,
            job_dir=data_dir.parent,
            data_dir=data_dir,
            images_dir=images_dir,
            model_dir=model_dir,
            output_ply=extra.get("output_ply", ""),
            port=extra.get("port", 0),
            iteration=extra.get("iteration", ""),
            stage1_checkpoint=config.STAGE1_CHECKPOINT,
        )

    port = _acquire_port()
    try:
        # --- Preprocessing ---------------------------------------------
        if not config.SKIP_PREPROCESS:
            pre_cmd = (
                config.PREPROCESS_SATELLITE_CMD
                if source == "satellite"
                else config.PREPROCESS_COLMAP_CMD
            )
            if pre_cmd.strip():
                state.update(status="preprocessing", stage="Estimating camera poses", progress=0.0)
                emit()
                _run(_prefixed(fmt(pre_cmd)), repo, log, emit, "preprocessing", 0.0, report)
            state["progress"] = STAGE_WEIGHTS["preprocessing"]

        # --- Stage 1: reconstruction -----------------------------------
        state.update(status="training_stage1", stage="Training · Stage 1 (reconstruction)")
        emit()
        base = STAGE_WEIGHTS["preprocessing"]
        _run(_prefixed(fmt(config.STAGE1_CMD, port=port)), repo, log, emit,
             "training_stage1", base, report)

        final_model_dir = model_dir
        fuse_iteration = config.FUSE_ITERATION_STAGE1

        # --- Stage 2: synthesis (IDU) ----------------------------------
        if not config.SKIP_STAGE2:
            state.update(status="training_stage2", stage="Training · Stage 2 (synthesis / IDU)")
            emit()
            base = STAGE_WEIGHTS["preprocessing"] + STAGE_WEIGHTS["training_stage1"]
            _run(_prefixed(fmt(config.STAGE2_CMD, port=port)), repo, log, emit,
                 "training_stage2", base, report)
            final_model_dir = Path(f"{model_dir}_idu")
            fuse_iteration = config.FUSE_ITERATION

        # --- Fuse PLY --------------------------------------------------
        state.update(status="fusing", stage="Fusing PLY for visualization")
        emit()
        output_ply = data_dir.parent / "output" / f"{job_id}_fused.ply"
        output_ply.parent.mkdir(parents=True, exist_ok=True)
        fuse_cmd = config.FUSE_CMD.format(
            model_dir=final_model_dir,
            output_ply=output_ply,
            iteration=fuse_iteration,
        )
        _run(_prefixed(fuse_cmd), repo, log, emit, "fusing",
             1.0 - STAGE_WEIGHTS["fusing"], report)

        if not output_ply.exists():
            raise PipelineError(f"Fused PLY was not produced at {output_ply}")

        state.update(status="done", stage="Done", progress=1.0)
        emit()
        return output_ply
    finally:
        _release_port(port)
