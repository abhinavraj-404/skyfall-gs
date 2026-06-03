#!/usr/bin/env bash
# =============================================================================
# Skyfall-GS RunPod setup  (idempotent, fail-fast)
# -----------------------------------------------------------------------------
# Run ON a RunPod GPU pod (Ubuntu + NVIDIA driver supporting CUDA 12.8).
# Clones Skyfall-GS, builds a conda env with a CUDA-12.8-matched PyTorch and the
# custom CUDA submodules, installs the backend, and optionally serves it.
#
# Usage (on the pod):
#   bash setup_runpod.sh              # full install
#   bash setup_runpod.sh --serve      # full install, then start the backend
#   bash setup_runpod.sh --serve-only # skip install, just start the backend
#
# Re-running is safe: completed steps are detected and skipped.
# =============================================================================
#
# Why this script is shaped the way it is (hard-won lessons):
#   * conda hooks reference unbound vars  -> never use `set -u`.
#   * conda must be sourced before activate -> ensure_conda() + activate_env().
#   * setuptools>=81 dropped pkg_resources, which OpenAI CLIP imports
#       -> pin setuptools<81 AND install CLIP with --no-build-isolation.
#   * torch 2.12 ships ONLY cu13 wheels, which mismatch a 12.8 driver
#       -> pin an explicit cu128 torch version from the cu128 index.
#   * the CUDA submodules import torch at build time
#       -> build them with --no-build-isolation.
# =============================================================================
set -eo pipefail

# --- Settings (override via env) --------------------------------------------
WORKDIR="${WORKDIR:-/workspace}"
SKYFALL_REPO_URL="${SKYFALL_REPO_URL:-https://github.com/jayin92/Skyfall-GS.git}"
SKYFALL_REPO_DIR="${SKYFALL_REPO_DIR:-$WORKDIR/Skyfall-GS}"
BACKEND_DIR="${BACKEND_DIR:-$WORKDIR/image-3d/backend}"
ENV_NAME="${ENV_NAME:-skyfall-gs}"
PYTHON_VERSION="${PYTHON_VERSION:-3.10}"
PORT="${PORT:-8000}"

# CUDA 12.8-matched PyTorch. torch>=2.9 dropped cu128; 2.8.0 is the last with it.
TORCH_VERSION="${TORCH_VERSION:-2.8.0}"
TORCHVISION_VERSION="${TORCHVISION_VERSION:-0.23.0}"
TORCHAUDIO_VERSION="${TORCHAUDIO_VERSION:-2.8.0}"
TORCH_INDEX_URL="${TORCH_INDEX_URL:-https://download.pytorch.org/whl/cu128}"
# Build for common datacenter arches: A100(8.0) A40/3090(8.6) L40/4090(8.9) H100(9.0)
TORCH_CUDA_ARCH_LIST="${TORCH_CUDA_ARCH_LIST:-8.0;8.6;8.9;9.0}"

CLIP_REF="dcba3cb2e2827b402d2701e7e1c7d9fed8a20ef1"

SERVE=0
SERVE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --serve) SERVE=1 ;;
    --serve-only) SERVE_ONLY=1 ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

log()  { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m[ok]\033[0m %s\n" "$*"; }
die()  { printf "\n\033[1;31m[error]\033[0m %s\n" "$*" >&2; exit 1; }

# --- conda ------------------------------------------------------------------
ensure_conda() {
  if command -v conda >/dev/null 2>&1; then
    eval "$(conda shell.bash hook)"
    return
  fi
  for base in /opt/conda /root/miniconda3 "$HOME/miniconda3" /root/anaconda3; do
    if [ -f "$base/etc/profile.d/conda.sh" ]; then
      # shellcheck disable=SC1091
      source "$base/etc/profile.d/conda.sh"
      return
    fi
  done
  log "Conda not found — installing Miniconda"
  curl -fsSL https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -o /tmp/miniconda.sh
  bash /tmp/miniconda.sh -b -p "$HOME/miniconda3"
  # shellcheck disable=SC1091
  source "$HOME/miniconda3/etc/profile.d/conda.sh"
}

activate_env() {
  set +u                          # conda hooks reference unbound vars
  conda activate "$ENV_NAME"
  # Verify we're really in the env's interpreter, not system python.
  local py; py="$(command -v python)"
  case "$py" in
    *"/envs/$ENV_NAME/"*) : ;;
    *) die "Wrong python after activate: $py (expected .../envs/$ENV_NAME/...)";;
  esac
  ok "python = $py ($(python --version 2>&1))"
}

pin_setuptools() {
  # Keep setuptools<81 so pkg_resources stays available for CLIP & others.
  python - <<'PY' 2>/dev/null || pip install -q "setuptools<81"
import sys
try:
    import setuptools
    major = int(setuptools.__version__.split(".")[0])
    sys.exit(0 if major < 81 else 1)
except Exception:
    sys.exit(1)
PY
}

# =============================================================================
install_all() {
  ensure_conda

  log "Checking GPU"
  nvidia-smi || die "No NVIDIA GPU visible — wrong pod type?"

  log "Installing system deps (git, colmap, ffmpeg)"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
      git git-lfs colmap ffmpeg build-essential || true
  fi
  mkdir -p "$WORKDIR"

  log "Cloning Skyfall-GS into $SKYFALL_REPO_DIR"
  if [ ! -d "$SKYFALL_REPO_DIR/.git" ]; then
    git clone --recurse-submodules "$SKYFALL_REPO_URL" "$SKYFALL_REPO_DIR"
  else
    git -C "$SKYFALL_REPO_DIR" submodule update --init --recursive || true
  fi
  [ -d "$SKYFALL_REPO_DIR/submodules/diff-gaussian-rasterization-depth" ] \
    || die "Submodules missing — clone did not fetch them."

  log "Accepting Anaconda channel Terms of Service"
  conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main 2>/dev/null || true
  conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r 2>/dev/null || true

  log "Creating conda env '$ENV_NAME' (python $PYTHON_VERSION)"
  if ! conda env list | grep -qE "/envs/$ENV_NAME$|^\s*$ENV_NAME\s"; then
    conda create -y -n "$ENV_NAME" "python=$PYTHON_VERSION"
  else
    ok "env already exists"
  fi
  activate_env

  log "Installing CUDA toolkit 12.8 into env"
  conda install -y -c nvidia cuda-toolkit=12.8 cuda-nvcc=12.8

  # --- pip baseline ------------------------------------------------------
  log "Preparing pip / setuptools"
  pip install --upgrade pip wheel
  pip install "setuptools<81"
  # Constrain BOTH normal resolution and isolated build overlays to setuptools<81.
  CONSTRAINTS="$WORKDIR/.pip-constraints.txt"
  echo "setuptools<81" > "$CONSTRAINTS"
  export PIP_CONSTRAINT="$CONSTRAINTS"
  export PIP_BUILD_CONSTRAINT="$CONSTRAINTS"   # pip>=26.2 build-constraint path

  # --- CLIP (must precede requirements; no isolation) --------------------
  log "Installing OpenAI CLIP (no build isolation)"
  pip install --no-build-isolation "git+https://github.com/openai/CLIP.git@${CLIP_REF}"

  # --- torch matched to CUDA 12.8 (BEFORE other requirements) ------------
  log "Installing PyTorch $TORCH_VERSION (cu128)"
  pip install --force-reinstall --index-url "$TORCH_INDEX_URL" \
    "torch==$TORCH_VERSION" "torchvision==$TORCHVISION_VERSION" "torchaudio==$TORCHAUDIO_VERSION"
  pin_setuptools

  log "Verifying PyTorch / CUDA match"
  python - <<PY
import torch, sys
print("torch", torch.__version__, "torch.version.cuda", torch.version.cuda)
cu = torch.version.cuda or ""
if not cu.startswith("12.8"):
    sys.exit(f"torch CUDA is {cu!r}, expected 12.8.x — aborting before submodule build")
PY
  ok "torch is built for CUDA 12.8"

  # --- remaining requirements (CLIP & torch already satisfied) -----------
  log "Installing remaining Skyfall-GS requirements"
  cd "$SKYFALL_REPO_DIR"
  pip install -r requirements.txt
  pin_setuptools

  # --- CUDA submodules (no isolation; import torch at build time) --------
  log "Building CUDA submodules"
  export TORCH_CUDA_ARCH_LIST
  for sm in diff-gaussian-rasterization-depth simple-knn fused-ssim; do
    log "  building $sm"
    pip install --no-build-isolation "./submodules/$sm"
  done

  # --- verify ------------------------------------------------------------
  log "Verifying the environment"
  python - <<'PY'
import importlib, torch, sys
print("torch", torch.__version__, "cuda build", torch.version.cuda,
      "cuda available", torch.cuda.is_available())
fail = False
for m in ("clip", "diff_gaussian_rasterization", "simple_knn", "fused_ssim"):
    try:
        importlib.import_module(m)
        print("ok  ", m)
    except Exception as e:  # noqa: BLE001
        print("FAIL", m, "->", e); fail = True
sys.exit(1 if fail else 0)
PY
  ok "all Skyfall-GS modules import"

  # --- backend -----------------------------------------------------------
  log "Installing backend"
  if [ -d "$BACKEND_DIR" ]; then
    pip install -r "$BACKEND_DIR/requirements.txt"
    cat > "$BACKEND_DIR/.env" <<EOF
SKYFALL_REPO=$SKYFALL_REPO_DIR
SKYFALL_CMD_PREFIX=conda run -n $ENV_NAME
SKYFALL_CORS_ORIGINS=*
EOF
    ok "wrote $BACKEND_DIR/.env"
  else
    log "WARNING: backend dir not found at $BACKEND_DIR"
    echo "Clone your image-3d repo into $WORKDIR, then re-run with --serve-only."
  fi

  log "Install complete."
}

serve() {
  ensure_conda
  activate_env
  [ -d "$BACKEND_DIR" ] || die "Backend dir not found at $BACKEND_DIR (set BACKEND_DIR)."
  log "Starting backend on 0.0.0.0:$PORT"
  cd "$(dirname "$BACKEND_DIR")"   # parent of backend/ so `backend.main` imports
  exec uvicorn backend.main:app --host 0.0.0.0 --port "$PORT"
}

# --- entrypoint -------------------------------------------------------------
if [ "$SERVE_ONLY" -eq 1 ]; then
  serve
fi

install_all

if [ "$SERVE" -eq 1 ]; then
  serve
else
  log "Next steps"
  cat <<EOF
  1. Start the backend:
       bash $(basename "$0") --serve-only

  2. On RunPod, expose TCP/HTTP port $PORT -> proxy URL like:
       https://<POD_ID>-$PORT.proxy.runpod.net

  3. On your Mac, set web/.env.local:
       NEXT_PUBLIC_API_BASE=https://<POD_ID>-$PORT.proxy.runpod.net
     then:  cd web && npm run dev
EOF
fi
