"""Configuration for the Skyfall-GS backend.

All settings come from environment variables (optionally loaded from a .env
file next to this package). The pipeline stages are expressed as command
*templates* so they can be tuned without touching the orchestration code.

Placeholders available in every command template:
  {repo}        Absolute path to the Skyfall-GS repository.
  {job_dir}     Absolute path to this job's working directory.
  {data_dir}    Dataset dir for this job (images/, transforms_train.json, ...).
  {images_dir}  Directory containing the uploaded RGB images.
  {model_dir}   Training output directory.
  {output_ply}  Path of the fused .ply to produce.
  {port}        A free TCP port assigned to this job (train.py needs one).
"""

from __future__ import annotations

import os
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent / ".env")
except Exception:  # python-dotenv is optional
    pass


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


# --- Paths ---------------------------------------------------------------

# Where uploaded data and outputs live. Each job gets a subdirectory here.
WORK_DIR = Path(_env("SKYFALL_WORK_DIR", str(Path(__file__).resolve().parent / "workspace"))).resolve()

# Absolute path to the cloned Skyfall-GS repository.
SKYFALL_REPO = Path(_env("SKYFALL_REPO", str(Path(__file__).resolve().parent.parent / "Skyfall-GS"))).resolve()


# --- Execution -----------------------------------------------------------

# Prefix prepended to every stage command, typically used to activate the
# conda environment. Default uses `conda run`. Set to "" to run commands
# directly (e.g. if the server already runs inside the right environment).
CMD_PREFIX = _env("SKYFALL_CMD_PREFIX", "conda run -n skyfall-gs")

# Set to "1" to skip preprocessing (assume data_dir already contains the
# Skyfall-GS dataset format: images/, transforms_train.json, points3D.txt).
SKIP_PREPROCESS = _env("SKYFALL_SKIP_PREPROCESS", "0") == "1"

# CORS: comma-separated list of allowed frontend origins ("*" allows all).
CORS_ORIGINS = [o.strip() for o in _env("SKYFALL_CORS_ORIGINS", "*").split(",") if o.strip()]

# Port range handed to train.py (one port per running job).
PORT_RANGE_START = int(_env("SKYFALL_PORT_START", "6210"))
PORT_RANGE_END = int(_env("SKYFALL_PORT_END", "6260"))


# --- Stage command templates --------------------------------------------
# These default to the commands documented in the Skyfall-GS README. Override
# any of them via the corresponding environment variable if your setup differs.

# Preprocessing for ground/object photos: COLMAP via the repo's convert.py.
# NOTE: Skyfall-GS ultimately expects transforms_train.json + points3D.txt.
# Depending on your data you may need a different converter (see SatelliteSfM).
PREPROCESS_COLMAP_CMD = _env(
    "SKYFALL_PREPROCESS_COLMAP_CMD",
    "python convert.py -s {data_dir}",
)

# Preprocessing for satellite imagery is handled by the external SatelliteSfM
# tool. By default we do nothing and assume the dataset is already prepared.
PREPROCESS_SATELLITE_CMD = _env(
    "SKYFALL_PREPROCESS_SATELLITE_CMD",
    "",
)

STAGE1_CMD = _env(
    "SKYFALL_STAGE1_CMD",
    (
        "python train.py -s {data_dir} -m {model_dir} --eval --port {port} "
        "--kernel_size 0.1 --resolution 1 --sh_degree 1 --appearance_enabled "
        "--lambda_depth 0 --lambda_opacity 10 --densify_until_iter 21000 "
        "--densify_grad_threshold 0.0001 --lambda_pseudo_depth 0.5 "
        "--start_sample_pseudo 1000 --end_sample_pseudo 21000 --size_threshold 20 "
        "--scaling_lr 0.001 --rotation_lr 0.001 --opacity_reset_interval 3000 "
        "--sample_pseudo_interval 10"
    ),
)

STAGE1_CHECKPOINT = _env("SKYFALL_STAGE1_CHECKPOINT", "chkpnt30000.pth")

STAGE2_CMD = _env(
    "SKYFALL_STAGE2_CMD",
    (
        "python train.py -s {data_dir} -m {model_dir}_idu "
        "--start_checkpoint {model_dir}/{stage1_checkpoint} "
        "--iterative_datasets_update --eval --port {port} --kernel_size 0.1 "
        "--resolution 1 --sh_degree 1 --appearance_enabled --lambda_depth 0 "
        "--lambda_opacity 0 --idu_opacity_reset_interval 5000 --idu_refine "
        "--idu_num_samples_per_view 2 --densify_grad_threshold 0.0002 "
        "--idu_num_cams 6 --idu_use_flow_edit --idu_render_size 1024 "
        "--idu_flow_edit_n_min 4 --idu_flow_edit_n_max 10 --idu_grid_size 3 "
        "--idu_grid_width 512 --idu_grid_height 512 --idu_episode_iterations 10000 "
        "--idu_iter_full_train 0 --idu_opacity_cooling_iterations 500 "
        "--lambda_pseudo_depth 0.5 --idu_densify_until_iter 9000 --idu_train_ratio 0.75"
    ),
)

# Set to "1" to run only Stage 1 (faster, lower quality). Skips Stage 2 (IDU).
SKIP_STAGE2 = _env("SKYFALL_SKIP_STAGE2", "0") == "1"

FUSE_ITERATION = _env("SKYFALL_FUSE_ITERATION", "80000")
FUSE_ITERATION_STAGE1 = _env("SKYFALL_FUSE_ITERATION_STAGE1", "30000")

FUSE_CMD = _env(
    "SKYFALL_FUSE_CMD",
    (
        "python create_fused_ply.py -m {model_dir} --output_ply {output_ply} "
        "--iteration {iteration} --load_from_checkpoints"
    ),
)


def ensure_dirs() -> None:
    WORK_DIR.mkdir(parents=True, exist_ok=True)
