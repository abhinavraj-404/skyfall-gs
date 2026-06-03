# Skyfall-GS Studio

A web app to upload images of an object/place, reconstruct a **3D Gaussian-splat
model** with [Skyfall-GS](https://github.com/jayin92/Skyfall-GS), and then view
it in the browser or download the `.ply`.

- **`web/`** — Next.js (App Router, TS, Tailwind) frontend: image upload, live
  job progress, in-browser Gaussian-splat viewer, and download links.
- **`backend/`** — FastAPI service that drives the real Skyfall-GS pipeline on a
  GPU machine (preprocess → Stage 1 → Stage 2 / IDU → fused `.ply`).

```
┌────────────┐  upload images   ┌─────────────┐  subprocess   ┌────────────┐
│  Next.js   │ ───────────────▶ │  FastAPI    │ ────────────▶ │ Skyfall-GS │
│  (web/)    │ ◀─ poll status ─ │  (backend/) │ ◀─ logs/ply ─ │  (GPU)     │
└────────────┘  view / download └─────────────┘               └────────────┘
```

> **Important:** Skyfall-GS requires an **NVIDIA GPU + CUDA 12.8** and trains for
> **hours** per scene. Run `backend/` on the GPU box; `web/` can run anywhere.

---

## 1. Backend (GPU machine)

### a. Clone & install Skyfall-GS

Follow the [official instructions](https://github.com/jayin92/Skyfall-GS#installation):

```bash
git clone --recurse-submodules https://github.com/jayin92/Skyfall-GS.git
cd Skyfall-GS
conda create -y -n skyfall-gs python=3.10
conda activate skyfall-gs
conda install -y cuda-toolkit=12.8 cuda-nvcc=12.8 -c nvidia
pip install -r requirements.txt
pip install --force-reinstall torch torchvision torchaudio
pip install submodules/diff-gaussian-rasterization-depth submodules/simple-knn submodules/fused-ssim
```

### b. Install & run the API

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # then edit SKYFALL_REPO etc.
cd ..
./backend/run.sh              # serves on :8000
```

Set at least `SKYFALL_REPO` in `backend/.env` to point at the cloned repo.
Check it loaded correctly: `curl http://localhost:8000/` → `"repo_present": true`.

### Configuration (`backend/.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `SKYFALL_REPO` | `../Skyfall-GS` | Path to the cloned repo |
| `SKYFALL_WORK_DIR` | `backend/workspace` | Where job data/outputs are stored |
| `SKYFALL_CMD_PREFIX` | `conda run -n skyfall-gs` | Activates the env per command |
| `SKYFALL_CORS_ORIGINS` | `*` | Allowed frontend origins |
| `SKYFALL_SKIP_PREPROCESS` | `0` | Skip COLMAP/SfM (data already prepared) |
| `SKYFALL_SKIP_STAGE2` | `0` | Run only Stage 1 (faster, lower quality) |

Each pipeline stage is a **command template** in [backend/config.py](backend/config.py)
(`SKYFALL_STAGE1_CMD`, `SKYFALL_STAGE2_CMD`, `SKYFALL_FUSE_CMD`, ...) defaulting
to the exact commands from the Skyfall-GS README. Override any via env vars.

> **Data note:** Skyfall-GS expects a dataset with `images/`,
> `transforms_train.json`, and `points3D.txt`. Plain photos must be preprocessed
> first (COLMAP for ground/object photos, or
> [SatelliteSfM](https://github.com/jayin92/SatelliteSfM) for satellite imagery).
> The default `colmap` preprocessing runs the repo's `convert.py`; adapt
> `SKYFALL_PREPROCESS_COLMAP_CMD` to your data if needed. If your uploads are
> already in Skyfall-GS format, set `SKYFALL_SKIP_PREPROCESS=1`.

## 2. Frontend

```bash
cd web
cp .env.example .env.local    # set NEXT_PUBLIC_API_BASE to your backend URL
npm install
npm run dev                   # http://localhost:3000
```

Set `NEXT_PUBLIC_API_BASE` to the backend URL (e.g. `http://your-gpu-host:8000`).

## How it works

1. Upload images on the home page → `POST /jobs` to the backend.
2. The backend queues the job (one GPU job at a time) and runs the pipeline,
   streaming logs and progress. The UI polls `GET /jobs/{id}` every few seconds.
3. When done, the fused `.ply` is served at `/jobs/{id}/files/...`. Click
   **View in 3D** to open the in-browser splat viewer, or **Download .ply**.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Health / config info |
| `POST` | `/jobs` | Create a job (`images[]`, `name`, `source`) |
| `GET` | `/jobs` | List jobs |
| `GET` | `/jobs/{id}` | Job detail (poll for progress) |
| `DELETE` | `/jobs/{id}` | Delete a job and its files |
| `GET` | `/jobs/{id}/files/{name}` | Download an output file |

## License

Skyfall-GS is Apache-2.0. This wrapper app is provided as-is.
