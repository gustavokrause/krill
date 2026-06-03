/**
 * Cron bootstrap. Imported by any API route — Node runtime by default,
 * so webpack does not have to bundle the workflow graph for edge.
 *
 * Side-effect on first module load: registerCrons() runs once
 * (idempotent thanks to globalThis state in `cron.ts`). Skip when
 * CRON_DISABLED=1 so /api/tick spike walks can drive ticks manually
 * without a competing background loop.
 */
import { registerCrons } from "./cron";

if (process.env.CRON_DISABLED !== "1") {
  registerCrons();
}
