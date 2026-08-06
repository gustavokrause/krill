"use client";

import * as React from "react";

type VersionInfo = {
  version: string;
  latest: string | null;
  updateAvailable: boolean;
  checkEnabled: boolean;
};

export function VersionChip() {
  const [info, setInfo] = React.useState<VersionInfo | null>(null);

  React.useEffect(() => {
    let alive = true;
    fetch("/api/version", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d) setInfo(d);
      })
      .catch(() => {
        /* footer chip is best-effort */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!info) return null;
  return (
    <span className="font-mono">
      v{info.version}
      {info.updateAvailable && (
        <span className="ml-1.5 text-warning" title="A newer tag exists on the upstream repo — pull and rebuild.">
          v{info.latest} available
        </span>
      )}
    </span>
  );
}
