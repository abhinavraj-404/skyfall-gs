// Client + server helpers for talking to the Skyfall-GS backend.

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE?.replace(/\/$/, "") || "http://localhost:8000";

export type JobStatus =
  | "queued"
  | "preprocessing"
  | "training_stage1"
  | "training_stage2"
  | "fusing"
  | "done"
  | "failed";

export interface JobOutput {
  name: string;
  url: string;
  size: number;
  kind: "ply" | "video" | "other";
}

export interface Job {
  id: string;
  name: string;
  source: "colmap" | "satellite";
  status: JobStatus;
  stage: string;
  progress: number; // 0..1
  num_images: number;
  created_at: string;
  updated_at: string;
  error?: string | null;
  log_tail?: string[];
  outputs: JobOutput[];
}

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: "Queued",
  preprocessing: "Estimating camera poses",
  training_stage1: "Training · Stage 1 (reconstruction)",
  training_stage2: "Training · Stage 2 (synthesis)",
  fusing: "Fusing PLY",
  done: "Done",
  failed: "Failed",
};

export function statusLabel(status: JobStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export function isTerminal(status: JobStatus): boolean {
  return status === "done" || status === "failed";
}

/** Resolve a possibly-relative URL from the backend into an absolute URL. */
export function resolveUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${API_BASE}${url.startsWith("/") ? "" : "/"}${url}`;
}

export async function createJob(
  files: File[],
  opts: { name?: string; source?: "colmap" | "satellite" } = {}
): Promise<Job> {
  const form = new FormData();
  if (opts.name) form.append("name", opts.name);
  form.append("source", opts.source ?? "colmap");
  for (const f of files) form.append("images", f, f.name);

  const res = await fetch(`${API_BASE}/jobs`, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(await readError(res));
  }
  return res.json();
}

export async function listJobs(): Promise<Job[]> {
  const res = await fetch(`${API_BASE}/jobs`, { cache: "no-store" });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

export async function getJob(id: string): Promise<Job> {
  const res = await fetch(`${API_BASE}/jobs/${id}`, { cache: "no-store" });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

export async function deleteJob(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/jobs/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await readError(res));
}

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data?.detail || data?.error || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}
