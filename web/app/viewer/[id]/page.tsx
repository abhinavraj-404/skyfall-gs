"use client";

import { use, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  type Job,
  getJob,
  resolveUrl,
  statusLabel,
  formatBytes,
} from "@/app/lib/api";

const SplatViewer = dynamic(() => import("@/app/components/SplatViewer"), {
  ssr: false,
});

export default function ViewerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJob(id)
      .then(setJob)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load job"));
  }, [id]);

  const ply = job?.outputs.find((o) => o.kind === "ply");

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-black/10 px-5 py-3 dark:border-white/10">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-blue-600 hover:underline">
            ← Back
          </Link>
          <h1 className="font-semibold">{job?.name || id.slice(0, 8)}</h1>
          {job && (
            <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">
              {statusLabel(job.status)}
            </span>
          )}
        </div>
        {ply && (
          <a
            href={resolveUrl(ply.url)}
            download
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
          >
            ↓ Download .ply ({formatBytes(ply.size)})
          </a>
        )}
      </header>

      <div className="flex-1 p-4">
        {error && (
          <div className="flex h-full items-center justify-center text-sm text-red-500">
            {error}
          </div>
        )}
        {!error && !ply && job && (
          <div className="flex h-full items-center justify-center text-sm text-foreground/50">
            This job has no viewable model yet (status: {statusLabel(job.status)}).
          </div>
        )}
        {!error && !job && (
          <div className="flex h-full items-center justify-center text-sm text-foreground/50">
            Loading…
          </div>
        )}
        {ply && (
          <div className="h-full w-full">
            <SplatViewer url={resolveUrl(ply.url)} />
          </div>
        )}
      </div>
    </main>
  );
}
