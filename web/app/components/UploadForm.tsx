"use client";

import { useCallback, useRef, useState } from "react";
import { createJob, type Job } from "@/app/lib/api";

interface UploadFormProps {
  onCreated: (job: Job) => void;
}

export default function UploadForm({ onCreated }: UploadFormProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState("");
  const [source, setSource] = useState<"colmap" | "satellite">("colmap");
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const imgs = Array.from(incoming).filter((f) => f.type.startsWith("image/"));
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.name + f.size));
      const merged = [...prev];
      for (const f of imgs) {
        if (!seen.has(f.name + f.size)) merged.push(f);
      }
      return merged;
    });
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const removeFile = (idx: number) =>
    setFiles((prev) => prev.filter((_, i) => i !== idx));

  const submit = async () => {
    if (files.length === 0) {
      setError("Add at least a few images first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const job = await createJob(files, { name: name.trim() || undefined, source });
      setFiles([]);
      setName("");
      onCreated(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-2xl border border-black/10 bg-white/60 p-5 shadow-sm dark:border-white/10 dark:bg-white/5">
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground/70">Scene name (optional)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My building"
            className="rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-white/15 dark:bg-black/30"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground/70">Image source</span>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as "colmap" | "satellite")}
            className="rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-white/15 dark:bg-black/30"
          >
            <option value="colmap">Ground / object photos (COLMAP)</option>
            <option value="satellite">Satellite imagery (SatelliteSfM)</option>
          </select>
        </label>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
          dragging
            ? "border-blue-500 bg-blue-500/5"
            : "border-black/15 hover:border-blue-400 dark:border-white/15"
        }`}
      >
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" className="text-foreground/40">
          <path d="M12 16V4m0 0L8 8m4-4l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <p className="text-sm font-medium">Drag & drop images, or click to browse</p>
        <p className="text-xs text-foreground/50">
          Many overlapping photos work best — 30+ recommended.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
      </div>

      {files.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between text-xs text-foreground/60">
            <span>{files.length} image{files.length > 1 ? "s" : ""} selected</span>
            <button onClick={() => setFiles([])} className="hover:text-red-500">
              Clear all
            </button>
          </div>
          <div className="grid max-h-44 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6 md:grid-cols-8">
            {files.map((f, i) => (
              <div key={f.name + i} className="group relative aspect-square overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={URL.createObjectURL(f)}
                  alt={f.name}
                  className="h-full w-full object-cover"
                  onLoad={(e) => URL.revokeObjectURL((e.target as HTMLImageElement).src)}
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFile(i);
                  }}
                  className="absolute right-1 top-1 hidden rounded-full bg-black/60 px-1.5 text-xs text-white group-hover:block"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

      <button
        onClick={submit}
        disabled={submitting || files.length === 0}
        className="mt-4 w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Uploading…" : "Generate 3D model"}
      </button>
    </div>
  );
}
