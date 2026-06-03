#!/usr/bin/env bash
# =============================================================================
# Skyfall-GS RunPod setup
# -----------------------------------------------------------------------------
# Run this ON the RunPod GPU pod (Ubuntu 22.04 + CUDA 12.8 + NVIDIA driver).
# It clones Skyfall-GS, builds the conda env + CUDA submodules, installs the
# backend, and (optionally) launches the FastAPI server on :8000.
#
# Usage (on the pod):
#   bash setup_runpod.sh             # full install
#   bash setup_runpod.sh --serve     # full install, then start the backend
#   bash setup_runpod.sh --serve-only# skip install, just start the backend
# =============================================================================
# Note: we intentionally avoid `set -u` (nounset) because conda's
# activate/deactivate hook scripts reference unbound variables and would abort.
set -eo pipefail

# --- Settings (override via env) --------------------------------------------
WORKDIR="${WORKDIR:-/workspace}"
SKYFALL_REPO_URL="${SKYFALL_REPO_URL:-https://github.com/jayin92/Skyfall-GS.git}"
SKYFALL_REPO_DIR="${SKYFALL_REPO_DIR:-$WORKDIR/Skyfall-GS}"
BACKEND_DIR="${BACKEND_DIR:-$WORKDIR/image-3d/backend}"
ENV_NAME="${ENV_NAME:-skyfall-gs}"
PORT="${PORT:-8000}"

SERVE=0
SERVE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --serve) SERVE=1 ;;
    --serve-only) SERVE_ONLY=1 ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

log() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }

# --- Locate conda -----------------------------------------------------------
ensure_conda() {
  if command -v conda >/dev/null 2>&1; then
    return
  fi
  for base in /opt/conda /root/miniconda3 "$HOME/miniconda3"; do
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

ensure_conda
# Make `conda activate` work in this non-interactive shell.
CONDA_BASE="$(conda info --base)"
# shellcheck disable=SC1091
source "$CONDA_BASE/etc/profile.d/conda.sh"

install_all() {
  log "Checking GPU"
  nvidia-smi || { echo "No NVIDIA GPU visible — wrong pod type?"; exit 1; }

  log "Installing system deps (git, colmap, ffmpeg)"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    DEBIAN_FRONTEND=noninteractive apt-get install -y git git-lfs colmap ffmpeg build-essential || true
  fi

  mkdir -p "$WORKDIR"

  log "Cloning Skyfall-GS into $SKYFALL_REPO_DIR"
  if [ ! -d "$SKYFALL_REPO_DIR/.git" ]; then
    git clone --recurse-submodules "$SKYFALL_REPO_URL" "$SKYFALL_REPO_DIR"
  else
    git -C "$SKYFALL_REPO_DIR" pull --recurse-submodules || true
    git -C "$SKYFALL_REPO_DIR" submodule update --init --recursive || true
  fi

  log "Accepting Anaconda channel Terms of Service"
  # Recent conda versions refuse the default channels until ToS is accepted.
  conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main 2>/dev/null || true
  conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r 2>/dev/null || true

  log "Creating conda env '$ENV_NAME' (python 3.10)"
  if ! conda env list | grep -qE "^\s*$ENV_NAME\s"; then
    conda create -y -n "$ENV_NAME" python=3.10
  fi
  conda activate "$ENV_NAME"

  log "Installing CUDA toolkit 12.8 into env"
  conda install -y cuda-toolkit=12.8 cuda-nvcc=12.8 -c nvidia

  log "Installing Skyfall-GS python requirements"
  cd "$SKYFALL_REPO_DIR"
  # setuptools>=81 dropped the bundled pkg_resources, which OpenAI CLIP's
  # setup.py (a Skyfall-GS dependency) still imports. Pin below 81.
  pip install --upgrade pip wheel "setuptools<81"
  pip install -r requirements.txt
  pip install --force-reinstall torch torchvision torchaudio

  log "Building CUDA submodules"
  pip install submodules/diff-gaussian-rasterization-depth
  pip install submodules/simple-knn
  pip install submodules/fused-ssim

  log "Installing backend requirements"
  if [ -d "$BACKEND_DIR" ]; then
    pip install -r "$BACKEND_DIR/requirements.txt"
    # Write a backend/.env pointing at the cloned repo.
    cat > "$BACKEND_DIR/.env" <<EOF
SKYFALL_REPO=$SKYFALL_REPO_DIR
SKYFALL_CMD_PREFIX=conda run -n $ENV_NAME
SKYFALL_CORS_ORIGINS=*
EOF
    log "Wrote $BACKEND_DIR/.env"
  else
    log "WARNING: backend dir not found at $BACKEND_DIR."
    echo "Copy this repo's backend/ onto the pod (e.g. git clone your fork) and re-run with --serve-only."
  fi

  log "Install complete."
}

serve() {
  if [ ! -d "$BACKEND_DIR" ]; then
    echo "Backend dir not found at $BACKEND_DIR. Set BACKEND_DIR and retry."; exit 1
  fi
  conda activate "$ENV_NAME"
  log "Starting backend on 0.0.0.0:$PORT"
  cd "$(dirname "$BACKEND_DIR")"          # parent of backend/ so 'backend.main' imports
  exec uvicorn backend.main:app --host 0.0.0.0 --port "$PORT"
}

if [ "$SERVE_ONLY" -eq 1 ]; then
  serve
fi

install_all

if [ "$SERVE" -eq 1 ]; then
  serve
else
  echo
  log "Next steps"
  cat <<EOF
  1. Start the backend:
       bash $(basename "$0") --serve-only
     (or)  conda activate $ENV_NAME && cd $(dirname "$BACKEND_DIR") && \\
           uvicorn backend.main:app --host 0.0.0.0 --port $PORT

  2. On RunPod, expose TCP/HTTP port $PORT. You'll get a proxy URL like:
       https://<POD_ID>-$PORT.proxy.runpod.net

  3. On your Mac, set web/.env.local:
       NEXT_PUBLIC_API_BASE=https://<POD_ID>-$PORT.proxy.runpod.net
     then:  cd web && npm run dev
EOF
fi
