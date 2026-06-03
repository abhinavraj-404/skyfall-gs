#!/usr/bin/env bash
# Start the Skyfall-GS backend API.
# Run from the repository root: ./backend/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
exec uvicorn backend.main:app --host 0.0.0.0 --port "${PORT:-8000}" --reload
