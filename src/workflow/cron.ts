import type { ScheduledTask } from "node-cron";
import cron from "node-cron";
import { runEscalationResolver } from "./escalation";
import { runStuckScanner } from "./stuck";
import { tick } from "./tick";
import type { Stage } from "./types";

// Process-global registration flag. Cannot rely on module-scoped state in
// Next.js dev — webpack re-evaluates the module on each route compilation,
// and node-cron's scheduler is process-wide so duplicate cron.schedule()
// calls accumulate jobs.
type CronState = {
  tasks: ScheduledTask[];
  inflight: Set<Stage>;
};

function getState(): CronState {
  const g = globalThis as unknown as { __ai_auto_cron?: CronState };
  if (!g.__ai_auto_cron) {
    g.__ai_auto_cron = { tasks: [], inflight: new Set() };
  }
  return g.__ai_auto_cron;
}

function isRegistered(): boolean {
  return (
    (globalThis as unknown as { __ai_auto_cron_registered?: boolean })
      .__ai_auto_cron_registered === true
  );
}

function markRegistered(): void {
  (
    globalThis as unknown as { __ai_auto_cron_registered?: boolean }
  ).__ai_auto_cron_registered = true;
}

// Stagger per OVERVIEW.md so stages do not fire on the same wall-second.
// 6-field cron with seconds: "<sec> <min> <hour> <dom> <mon> <dow>".
const SCHEDULES: Array<{ stage: Stage; expr: string }> = [
  { stage: "todo_picker", expr: "*/30 * * * * *" }, // every 30s on :00 and :30
  { stage: "ai_review", expr: "5 * * * * *" }, // every 60s at :05
  { stage: "planning", expr: "15 * * * * *" }, // every 60s at :15
  { stage: "publishing", expr: "25 * * * * *" }, // every 60s at :25
  { stage: "verify", expr: "35 * * * * *" }, // every 60s at :35
  { stage: "implementing", expr: "45 * * * * *" }, // every 60s at :45
];

async function safeDispatch(stage: Stage): Promise<void> {
  const s = getState();
  if (s.inflight.has(stage)) {
    return;
  }
  s.inflight.add(stage);
  try {
    const result = await tick(stage);
    if (result.ran) {
      console.log(`[cron:${stage}] picked task=${result.taskId}`);
    } else if (result.reason !== "no_task") {
      console.log(`[cron:${stage}] skipped reason=${result.reason}`);
    }
  } catch (err) {
    console.error(`[cron:${stage}] handler threw:`, err);
  } finally {
    s.inflight.delete(stage);
  }
}

export function registerCrons(): void {
  if (isRegistered()) return;
  markRegistered();
  const s = getState();

  for (const { stage, expr } of SCHEDULES) {
    s.tasks.push(
      cron.schedule(expr, () => {
        void safeDispatch(stage);
      }),
    );
  }

  s.tasks.push(
    cron.schedule("0 * * * * *", () => {
      try {
        runStuckScanner();
      } catch (err) {
        console.error("[cron:stuck] scanner threw:", err);
      }
    }),
  );

  // Escalation auto-resolver: a higher-effort pass on open question-escalations.
  // A background worker (not a pipeline stage), staggered off the stage ticks.
  s.tasks.push(
    cron.schedule("50 * * * * *", () => {
      void runEscalationResolver().catch((err) =>
        console.error("[cron:resolver] escalation resolver threw:", err),
      );
    }),
  );

  const shutdown = () => { stopCrons(); process.exit(0); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  console.log(
    `[cron] registered ${s.tasks.length} schedules (6 stages + stuck scanner + escalation resolver)`,
  );
}

export function stopCrons(): void {
  const s = getState();
  for (const t of s.tasks) t.stop();
  s.tasks = [];
  s.inflight.clear();
  (
    globalThis as unknown as { __ai_auto_cron_registered?: boolean }
  ).__ai_auto_cron_registered = false;
}
