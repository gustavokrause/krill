import { NextResponse } from "next/server";
import pkg from "../../../../package.json";

export const dynamic = "force-dynamic";

// Update check against the upstream repo's tags. Opt-out: KRILL_UPDATE_CHECK=0
// (no external request is ever made when off — the fetch is inside the gate).
// KRILL_UPDATE_REPO overrides the upstream slug for forks.
const UPDATE_REPO = process.env.KRILL_UPDATE_REPO || "gustavokrause/krill";
const CHECK_ENABLED = process.env.KRILL_UPDATE_CHECK !== "0";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type Cache = { at: number; latest: string | null };
const g = globalThis as unknown as { __krillVersionCache?: Cache };

const parse = (v: string): number[] | null => {
  const m = v.trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
};

const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
};

async function latestTag(): Promise<string | null> {
  const cached = g.__krillVersionCache;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.latest;
  let latest: string | null = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/tags?per_page=100`, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (res.ok) {
      const tags = (await res.json()) as { name: string }[];
      let best: number[] | null = null;
      for (const t of tags) {
        const v = parse(t.name);
        if (v && (!best || newer(v, best))) {
          best = v;
          latest = t.name.replace(/^v/, "");
        }
      }
    }
  } catch {
    /* offline / rate-limited — report no update rather than failing the UI */
  }
  g.__krillVersionCache = { at: Date.now(), latest };
  return latest;
}

export async function GET() {
  const version = pkg.version;
  if (!CHECK_ENABLED) {
    return NextResponse.json({ version, latest: null, updateAvailable: false, checkEnabled: false });
  }
  const latest = await latestTag();
  const cur = parse(version);
  const lat = latest ? parse(latest) : null;
  const updateAvailable = Boolean(cur && lat && newer(lat, cur));
  return NextResponse.json({ version, latest, updateAvailable, checkEnabled: true });
}
