import { randomUUID } from "node:crypto";

/**
 * Per-process boot id. Generated once per krill process and cached on
 * globalThis, so every claim made by this process shares it; a fresh process
 * (restart/crash recovery) gets a new one.
 *
 * This is the orphaned-claim signal. A stage worker is an in-process async task
 * awaiting a spawned `claude` child — it cannot die on its own (a dead child
 * rejects the await; a hung one is caught by max_stage_duration/timeout). The
 * only way a claim is orphaned is the krill process itself dying. So a held
 * claim whose `claim_gen` ≠ the current boot id was made by a now-dead process:
 * its worker is gone and the task is stranded until the claim TTL lapses. The
 * UI uses this to surface a "worker dead" state + a manual Recover.
 *
 * (globalThis survives dev HMR — intentional: hot reloads aren't a real restart.
 * A production `next start` is a fresh process, so the id rotates as intended.)
 */
export function getBootId(): string {
  const g = globalThis as unknown as { __krill_boot_id?: string };
  if (!g.__krill_boot_id) g.__krill_boot_id = randomUUID().slice(0, 8);
  return g.__krill_boot_id;
}
