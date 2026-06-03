"use client";

import { useCallback, useEffect, useState } from "react";
import type { GlobalConfig, StageEnabled } from "@/db/schema";
import { api, type HealthSnapshot } from "@/lib/client/api";
import { useEventSource } from "@/lib/client/use-event-source";
import { Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import {
  Bot,
  Circle,
  Code2,
  GitMerge,
  Pencil,
  Upload,
  type LucideIcon,
} from "lucide-react";

const STAGE_ICON: Record<keyof StageEnabled, LucideIcon> = {
  todo_picker: Circle,
  planning: Pencil,
  implementing: Code2,
  ai_review: Bot,
  publishing: Upload,
};

const STAGE_COLOR: Record<keyof StageEnabled, string> = {
  todo_picker: "text-info",
  planning: "text-info",
  implementing: "text-info",
  ai_review: "text-warning",
  publishing: "text-info",
};

const STAGE_MODEL: Record<keyof StageEnabled, string> = {
  todo_picker: "SQL",
  planning: "Opus",
  implementing: "Sonnet",
  ai_review: "Opus",
  publishing: "shell",
};

const STAGE_LABEL: Record<keyof StageEnabled, string> = {
  todo_picker: "TODO picker",
  planning: "PLANNING",
  implementing: "IMPLEMENTING",
  ai_review: "AI-REVIEW",
  publishing: "PUBLISHING",
};

const STAGE_BADGE_CLASS: Record<keyof StageEnabled, string> = {
  todo_picker: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  planning: "bg-ai/10 text-ai",
  implementing: "bg-ai/10 text-ai",
  ai_review: "bg-ai/10 text-ai",
  publishing: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
};

function humanBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function Settings({ initial }: { initial: GlobalConfig }) {
  const [config, setConfig] = useState(initial);
  const [pauseConfirmOpen, setPauseConfirmOpen] = useState(false);
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const toast = useToast();

  useEventSource({
    "config.changed": (e) => e.type === "config.changed" && setConfig(e.config),
  });

  useEffect(() => {
    let cancelled = false;
    api
      .getHealth()
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch(() => {
        // diagnostics absent if endpoint fails — non-fatal
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = useCallback(
    async (body: Record<string, unknown>, label: string) => {
      try {
        const next = await api.patchConfig(body);
        setConfig(next);
        toast.push({ variant: "success", title: label });
      } catch (err) {
        toast.push({
          variant: "danger",
          title: "Save failed",
          description: (err as Error).message,
        });
      }
    },
    [toast],
  );

  return (
    <main className="flex-1 px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6">
          <h1 className="text-xl font-bold">Settings</h1>
          <p className="text-sm text-text-2 mt-0.5">
            Automation, stage switches, and runtime config.
          </p>
        </header>

        <div className="space-y-4">
            <Section
              id="automation"
              title="Automation"
              description="Master kill switch. When off, every stage exits no-op."
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "inline-block h-2.5 w-2.5 rounded-full",
                      config.automation_enabled ? "bg-success" : "bg-muted",
                    )}
                  />
                  <div>
                    <div className="text-sm font-semibold">
                      {config.automation_enabled ? "Running" : "Paused"}
                    </div>
                    <div className="font-mono text-xs text-text-2">
                      automation_enabled = {String(config.automation_enabled)}
                    </div>
                  </div>
                </div>
                <Switch
                  checked={config.automation_enabled}
                  onCheckedChange={(v) => {
                    if (!v) {
                      setPauseConfirmOpen(true);
                      return;
                    }
                    patch({ automation_enabled: true }, "Automation enabled");
                  }}
                />
              </div>
              <ConfirmDialog
                open={pauseConfirmOpen}
                onOpenChange={setPauseConfirmOpen}
                title="Pause automation?"
                description="Every stage will exit no-op. In-flight subprocesses keep running until they finish. You can resume any time."
                confirmLabel="Pause automation"
                busyLabel="Pausing…"
                confirmVariant="danger"
                onConfirm={() =>
                  patch({ automation_enabled: false }, "Automation disabled")
                }
              />
            </Section>

            <Section
              id="stages"
              title="Stage switches"
              description="Pause one stage independently — e.g., disable Opus stages during a rate limit."
              meta={
                <span className="font-mono text-xs text-text-2">
                  {Object.values(config.stage_enabled).filter(Boolean).length} /{" "}
                  {Object.keys(STAGE_LABEL).length} enabled
                </span>
              }
            >
              <ul className="divide-y divide-border">
                {(Object.keys(STAGE_LABEL) as Array<keyof StageEnabled>).map(
                  (s) => {
                    const Icon = STAGE_ICON[s];
                    return (
                      <li
                        key={s}
                        className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <Icon
                              className={cn("h-4 w-4 shrink-0", STAGE_COLOR[s])}
                            />
                            <Label className="font-mono">{STAGE_LABEL[s]}</Label>
                            <span
                              className={cn(
                                "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-medium",
                                STAGE_BADGE_CLASS[s],
                              )}
                            >
                              {STAGE_MODEL[s]}
                            </span>
                          </div>
                          <Switch
                            checked={config.stage_enabled[s]}
                            onCheckedChange={(v) =>
                              patch(
                                {
                                  stage_enabled: {
                                    ...config.stage_enabled,
                                    [s]: v,
                                  },
                                },
                                `${STAGE_LABEL[s]} ${v ? "enabled" : "disabled"}`,
                              )
                            }
                          />
                        </div>
                        {s === "publishing" ? (
                          <div
                            className={cn(
                              "ml-7 rounded border px-3 py-2.5",
                              config.publishing_solve_conflicts
                                ? "border-border bg-surface-2"
                                : "border-warning/30 bg-warning/5",
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex items-start gap-2.5 min-w-0">
                                <GitMerge
                                  className={cn(
                                    "h-3.5 w-3.5 shrink-0 mt-0.5",
                                    config.publishing_solve_conflicts
                                      ? "text-text-2"
                                      : "text-warning",
                                  )}
                                />
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    <Label className="font-mono text-xs">
                                      solve_conflicts
                                    </Label>
                                    <span
                                      className={cn(
                                        "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-medium uppercase",
                                        config.publishing_solve_conflicts
                                          ? "bg-ai/10 text-ai"
                                          : "bg-warning/15 text-warning",
                                      )}
                                    >
                                      {config.publishing_solve_conflicts
                                        ? "Sonnet"
                                        : "off"}
                                    </span>
                                  </div>
                                  <p className="text-[11px] text-text-2 mt-1 leading-snug">
                                    On merge conflict during PUBLISHING:
                                  </p>
                                  <ul className="mt-1 space-y-0.5 text-[11px] text-text-2 leading-snug">
                                    <li>
                                      <span className="font-mono text-ai">on</span>{" "}
                                      — Sonnet attempts auto-resolve in the worktree
                                    </li>
                                    <li>
                                      <span className="font-mono text-warning">
                                        off
                                      </span>{" "}
                                      — force-move NEEDS_REVIEW(conflict); human resolves in GitHub or clicks per-task &ldquo;Solve with Sonnet&rdquo;
                                    </li>
                                  </ul>
                                </div>
                              </div>
                              <Switch
                                checked={config.publishing_solve_conflicts}
                                onCheckedChange={(v) =>
                                  patch(
                                    { publishing_solve_conflicts: v },
                                    `Conflict resolver ${v ? "enabled" : "disabled"}`,
                                  )
                                }
                              />
                            </div>
                          </div>
                        ) : null}
                      </li>
                    );
                  },
                )}
              </ul>
            </Section>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Section
              id="ai-brake"
              title="AI brake"
              description="Caps consecutive AI-driven loops."
            >
              <div className="flex items-end gap-3">
                <div className="text-4xl font-bold font-mono leading-none">
                  {config.max_ai_decline_cycles}
                </div>
                <div className="text-xs text-text-2 pb-1">
                  max decline cycles
                </div>
              </div>
              <p className="text-xs text-text-2 mt-3">
                Edit via API: <code className="font-mono">PATCH /api/config</code>.
              </p>
            </Section>

            <Section
              id="cron"
              title="Cron cadence"
              description="Seconds between ticks per stage. Read-only."
            >
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {Object.entries(config.cron_cadence).map(([k, v]) => (
                  <div
                    key={k}
                    className="rounded border border-border bg-surface-2 px-3 py-2"
                  >
                    <dt className="font-mono text-[11px] text-text-2 truncate">
                      {k}
                    </dt>
                    <dd className="font-mono text-base font-semibold">
                      {v}
                      <span className="text-text-2 text-xs font-normal ml-0.5">
                        s
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            </Section>

            <Section
              id="max-stage-duration"
              title="Max stage duration"
              description="Stuck-task threshold per stage. Beyond this, an unclaimed task is flagged stuck."
            >
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {Object.entries(config.max_stage_duration).map(([k, v]) => (
                  <div
                    key={k}
                    className="rounded border border-border bg-surface-2 px-3 py-2"
                  >
                    <dt className="font-mono text-[11px] text-text-2 truncate">
                      {k}
                    </dt>
                    <dd className="font-mono text-base font-semibold">
                      {v}
                      <span className="text-text-2 text-xs font-normal ml-0.5">
                        s
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            </Section>

            <Section
              id="claim-ttl"
              title="Claim TTL"
              description="Lease duration per stage in seconds. Runner kills Claude 30s before expiry to avoid double-claim."
            >
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {Object.entries(config.claim_ttl).map(([k, v]) => (
                  <div
                    key={k}
                    className="rounded border border-border bg-surface-2 px-3 py-2"
                  >
                    <dt className="font-mono text-[11px] text-text-2 truncate mb-1">
                      {k}
                    </dt>
                    <dd className="flex items-baseline gap-1">
                      <input
                        type="number"
                        min={60}
                        step={60}
                        defaultValue={v}
                        className="w-20 font-mono text-base font-semibold bg-transparent border-b border-border focus:border-accent focus:outline-none"
                        onBlur={(e) => {
                          const next = parseInt(e.currentTarget.value, 10);
                          if (!isNaN(next) && next >= 60 && next !== v) {
                            patch({ claim_ttl: { [k]: next } }, `Claim TTL ${k} → ${next}s`);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                        }}
                      />
                      <span className="text-text-2 text-xs font-normal">s</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </Section>

            <Section
              id="backoff"
              title="Backoff"
              description="API rate-limit backoff config."
            >
              <div className="space-y-4">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-text-2 mb-1.5">
                    Sequence
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {config.api_error_backoff.sequence.map((n, i) => (
                      <span key={i} className="flex items-center gap-1">
                        <span className="font-mono text-xs px-2 py-1 rounded border border-border bg-surface-2">
                          {n}s
                        </span>
                        {i < config.api_error_backoff.sequence.length - 1 ? (
                          <span className="text-text-3 text-xs">→</span>
                        ) : null}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-text-2 mb-1.5">
                    Cap
                  </div>
                  <div className="font-mono text-2xl font-semibold">
                    {config.api_error_backoff.cap}
                    <span className="text-text-2 text-sm font-normal ml-0.5">
                      s
                    </span>
                  </div>
                </div>
              </div>
            </Section>

            <Section
              id="worktrees"
              title="Worktrees root"
              description="Base path where task worktrees are created."
            >
              <code className="block font-mono text-sm rounded border border-border bg-surface-2 px-3 py-2 break-all">
                {config.worktrees_root}
              </code>
            </Section>

            <Section
              id="system"
              title="System"
              description="Runtime diagnostics from /api/health."
            >
              <dl className="space-y-2 text-xs">
                <div className="flex items-start gap-2">
                  <dt className="font-mono text-text-2 w-32 shrink-0">db.path</dt>
                  <dd className="font-mono break-all">
                    {health ? health.db.path : "—"}
                  </dd>
                </div>
                <div className="flex items-start gap-2">
                  <dt className="font-mono text-text-2 w-32 shrink-0">db.size</dt>
                  <dd className="font-mono">
                    {health ? humanBytes(health.db.size_bytes) : "—"}
                  </dd>
                </div>
                <div className="flex items-start gap-2">
                  <dt className="font-mono text-text-2 w-32 shrink-0">
                    claude version
                  </dt>
                  <dd className="font-mono">
                    {health ? health.pinned_claude_version ?? "unpinned" : "—"}
                  </dd>
                </div>
              </dl>
            </Section>
            </div>
        </div>
      </div>
    </main>
  );
}

function Section({
  id,
  title,
  description,
  meta,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-4 rounded-md border border-border bg-surface p-5"
    >
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold">{title}</h2>
          {description ? (
            <p className="text-sm text-text-2 mt-0.5">{description}</p>
          ) : null}
        </div>
        {meta ? <div className="shrink-0">{meta}</div> : null}
      </header>
      {children}
    </section>
  );
}