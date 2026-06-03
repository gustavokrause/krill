"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[ui] uncaught error:", error);
  }, [error]);

  return (
    <main className="flex-1 px-4 sm:px-6 lg:px-8 py-12 flex flex-col items-center">
      <div className="max-w-md border border-dashed border-border rounded-sm p-6 w-full">
        <h1 className="text-lg font-bold text-danger">Something broke</h1>
        <p className="text-sm text-text-2 mt-1">
          {error.message || "An unexpected error occurred."}
        </p>
        {error.digest ? (
          <p className="text-xs font-mono text-text-3 mt-2">{error.digest}</p>
        ) : null}
        <div className="flex items-center gap-2 mt-5">
          <button
            type="button"
            onClick={reset}
            className="h-9 px-4 rounded bg-primary text-white text-sm font-medium hover:opacity-90"
          >
            Try again
          </button>
          <Link
            href="/"
            className="h-9 px-4 inline-flex items-center rounded bg-surface border border-border text-sm font-medium hover:bg-border"
          >
            Back to board
          </Link>
        </div>
      </div>
    </main>
  );
}
