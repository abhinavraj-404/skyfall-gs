"use client";

import { useEffect, useState } from "react";
import UploadForm from "@/app/components/UploadForm";
import JobList from "@/app/components/JobList";
import { listJobs, type Job } from "@/app/lib/api";

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const data = await listJobs();
      setJobs(data);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Cannot reach backend");
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10">
      <header className="mb-8">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🛰️</span>
          <h1 className="text-2xl font-bold tracking-tight">Skyfall-GS Studio</h1>
        </div>
        <p className="mt-1 text-sm text-foreground/60">
          Upload images of an object or place, reconstruct a 3D Gaussian-splat model, then
          view it in your browser or download the <code className="text-xs">.ply</code>.
        </p>
      </header>

      <UploadForm onCreated={(job) => setJobs((prev) => [job, ...prev])} />

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground/50">
            Jobs
          </h2>
          <button onClick={refresh} className="text-xs text-blue-600 hover:underline">
            Refresh
          </button>
        </div>

        {loadError && (
          <p className="mb-3 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-600">
            {loadError}. Make sure the backend is running and{" "}
            <code>NEXT_PUBLIC_API_BASE</code> points to it.
          </p>
        )}

        <JobList
          jobs={jobs}
          onRemoved={(id) => setJobs((prev) => prev.filter((j) => j.id !== id))}
        />
      </section>
    </main>
  );
}
