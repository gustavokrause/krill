/**
 * Per-process identity, used as the orphaned-claim signal.
 *
 * A stage worker is an in-process async task awaiting a spawned `claude` child —
 * it cannot die on its own (a dead child rejects the await; a hung one is caught
 * by max_stage_duration/timeout). The only way a claim is orphaned is the krill
 * process itself dying. So a held claim whose `claim_gen` ≠ the current id was
 * made by a now-dead process: its worker is gone and the task is stranded until
 * the claim TTL lapses. The UI uses this to surface a "worker dead" state + a
 * manual Recover.
 *
 * Identity = `process.pid`. It is stable for the life of the Node process and —
 * crucially — survives Next.js dev recompiles, which tear down the module graph
 * and globalThis but never fork a new process. A real restart (`next start`,
 * crash recovery) spawns a new pid, so the id rotates exactly when it should.
 *
 * (The previous implementation cached a randomUUID on globalThis. That assumed
 * globalThis survives dev HMR — it does not survive a server recompile, so the
 * id rotated on every code change and falsely flagged every in-flight task as
 * "worker dead" even though the process never restarted. pid has no such gap.)
 */
export function getBootId(): string {
  return `pid-${process.pid}`;
}
