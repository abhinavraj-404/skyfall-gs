"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  type Job,
  type JobStatus,
  deleteJob,
  formatBytes,
  getJob,
  isTerminal,
  resolveUrl,
  statusLabel,
} from "@/app/lib/api";

const STATUS_COLORS: Record<JobStatus, string> = {
  queued: "bg-gray-400",
  preprocessing: "bg-amber-500",
  training_stage1: "bg-blue-500",
  training_stage2: "bg-indigo-500",
  fusing: "bg-violet-500",
  done: "bg-green-500",
  failed: "bg-red-500",
};

function JobCard({ job: initial, onRemoved }: { job: Job; onRemoved: (id: string) => void }) {
  const [job, setJob] = useState<Job>(initial);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    setJob(initial);
  }, [initial]);

  useEffect(() => {
    if (isTerminal(job.status)) return;
    let active = true;
    const tick = async () => {
      try {
        const fresh = await getJob(job.id);
        if (active) setJob(fresh);
      } catch {
        /* keep last known state */
      }
    };
    const interval = setInterval(tick, 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [job.id, job.status]);

  const ply = job.outputs.find((o) => o.kind === "ply");

  return (
    <div className="rounded-xl border border-black/10 bg-white/70 p-4 shadow-sm dark:border-white/10 dark:bg-white/5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{job.name || job.id.slice(0, 8)}</h3>
          <p className="text-xs text-foreground/50">
            {job.num_images} images · {new Date(job.created_at).toLocaleString()}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-black/5 px-2.5 py-1 text-xs font-medium dark:bg-white/10">
          <span className={`h-2 w-2 rounded-full ${STATUS_COLORS[job.status]} ${!isTerminal(job.status) ? "animate-pulse" : ""}`} />
          {statusLabel(job.status)}
        </span>
      </div>

      {!isTerminal(job.status) && (
        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
            <div
              className="h-full rounded-full bg-blue-600 transition-all"
              style={{ width: `${Math.max(4, Math.round(job.progress * 100))}%` }}
            />
          </div>
          {job.stage && <p className="mt-1.5 text-xs text-foreground/50">{job.stage}</p>}
        </div>
      )}

      {job.status === "failed" && job.error && (
        <p className="mt-3 rounded-lg bg-red-500/10 p-2 text-xs text-red-500">{job.error}</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {ply && (
          <Link
            href={`/viewer/${job.id}`}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
          >
            View in 3D
          </Link>
        )}
        {job.outputs.map((o) => (
          <a
            key={o.url}
            href={resolveUrl(o.url)}
            download
            className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-medium hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
          >
            ↓ {o.name} ({formatBytes(o.size)})
          </a>
        ))}
        {job.log_tail && job.log_tail.length > 0 && (
          <button
            onClick={() => setShowLog((s) => !s)}
            className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-medium hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
          >
            {showLog ? "Hide log" : "Log"}
          </button>
        )}
        <button
          onClick={async () => {
            if (!confirm("Delete this job and its files?")) return;
            try {
              await deleteJob(job.id);
              onRemoved(job.id);
            } catch {
              /* ignore */
            }
          }}
          className="ml-auto rounded-lg px-2 py-1.5 text-xs text-foreground/40 hover:text-red-500"
        >
          Delete
        </button>
      </div>

      {showLog && job.log_tail && (
        <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-black/90 p-3 text-[11px] leading-relaxed text-green-300">
          {job.log_tail.join("\n")}
        </pre>
      )}
    </div>
  );
}

export default function JobList({
  jobs,
  onRemoved,
}: {
  jobs: Job[];
  onRemoved: (id: string) => void;
}) {
  if (jobs.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-black/15 p-8 text-center text-sm text-foreground/40 dark:border-white/15">
        No jobs yet. Upload images above to create your first 3D model.
      </p>
    );
  }
  return (
    <div className="grid gap-3">
      {jobs.map((j) => (
        <JobCard key={j.id} job={j} onRemoved={onRemoved} />
      ))}
    </div>
  );
}
