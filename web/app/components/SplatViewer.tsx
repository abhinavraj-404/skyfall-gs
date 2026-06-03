"use client";

import { useEffect, useRef, useState } from "react";

interface SplatViewerProps {
  /** Absolute URL to a Gaussian-splat .ply / .splat / .ksplat file. */
  url: string;
  /** Up vector — Skyfall-GS recommends 0,0,1. */
  cameraUp?: [number, number, number];
  /** Initial camera position — Skyfall-GS recommends 0,0,200. */
  initialCameraPosition?: [number, number, number];
  sphericalHarmonicsDegree?: number;
}

export default function SplatViewer({
  url,
  cameraUp = [0, 0, 1],
  initialCameraPosition = [0, 0, 200],
  sphericalHarmonicsDegree = 1,
}: SplatViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string>("");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let viewer: any = null;

    (async () => {
      try {
        setStatus("loading");
        setProgress(0);
        const GaussianSplats3D = await import("@mkkellogg/gaussian-splats-3d");

        viewer = new GaussianSplats3D.Viewer({
          rootElement: container,
          cameraUp,
          initialCameraPosition,
          initialCameraLookAt: [0, 0, 0],
          sphericalHarmonicsDegree,
          sharedMemoryForWorkers: false,
        });

        await viewer.addSplatScene(url, {
          showLoadingUI: false,
          progressiveLoad: true,
          splatAlphaRemovalThreshold: 5,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onProgress: (pct: number) => {
            if (!disposed) setProgress(Math.round(pct));
          },
        });

        if (disposed) return;
        viewer.start();
        setStatus("ready");
      } catch (err) {
        if (disposed) return;
        console.error("Splat viewer error:", err);
        setErrorMsg(err instanceof Error ? err.message : "Failed to load splat scene");
        setStatus("error");
      }
    })();

    return () => {
      disposed = true;
      if (viewer) {
        try {
          viewer.stop?.();
          viewer.dispose?.();
        } catch {
          /* ignore */
        }
      }
      // Clear the canvas the library appended.
      while (container.firstChild) container.removeChild(container.firstChild);
    };
  }, [url, cameraUp, initialCameraPosition, sphericalHarmonicsDegree]);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl bg-black">
      <div ref={containerRef} className="h-full w-full" />

      {status === "loading" && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/80">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          <p className="text-sm">Loading 3D scene… {progress > 0 ? `${progress}%` : ""}</p>
        </div>
      )}

      {status === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-red-300">
          <p className="font-medium">Could not load the splat scene.</p>
          <p className="max-w-md text-xs text-red-300/70">{errorMsg}</p>
        </div>
      )}

      {status === "ready" && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs text-white/70 backdrop-blur">
          Drag to orbit · scroll to zoom · right-drag to pan
        </div>
      )}
    </div>
  );
}
