import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { db, sql } from "./client";

const migrationsFolder = resolve(process.cwd(), "src/db/migrations");
const dbPath = resolve(process.cwd(), process.env.DB_PATH ?? "data/tasks.db");
const BACKUPS_TO_KEEP = 10;

/**
 * Snapshot the DB before applying migrations. drizzle's SQLite strategy rebuilds
 * a table by DROP+recreate; a FK-cascade bug once wiped the comments table this
 * way (migration 0010). A migration is destructive and not always reversible —
 * always take a recoverable copy first.
 *
 * Checkpoints the WAL into the main file so the plain copy is a consistent
 * snapshot, writes to data/backups/, and prunes to the newest BACKUPS_TO_KEEP.
 */
function backupBeforeMigrate(): void {
  if (!existsSync(dbPath)) return; // fresh DB — nothing to lose

  try {
    sql.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // Non-fatal: the copy below is still a valid (if WAL-lagged) snapshot.
  }

  const dir = resolve(dirname(dbPath), "backups");
  mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prefix = `${basename(dbPath)}.`;
  const dest = resolve(dir, `${prefix}${stamp}.bak`);
  copyFileSync(dbPath, dest);
  console.log(`pre-migration backup → ${dest}`);

  const stale = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".bak"))
    .map((f) => ({ f, t: statSync(resolve(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(BACKUPS_TO_KEEP);
  for (const { f } of stale) rmSync(resolve(dir, f));
}

backupBeforeMigrate();

// CRITICAL: disable foreign-key enforcement for the migration run.
//
// drizzle's SQLite ALTER strategy rebuilds a table by DROP TABLE + recreate.
// The connection enables `foreign_keys = ON` (client.ts), and a `DROP TABLE
// tasks` then CASCADES to every `ON DELETE CASCADE` child (comments) — silently
// deleting their rows. The generated migration tries to guard this with an
// in-file `PRAGMA foreign_keys=OFF`, but that pragma is a NO-OP inside a
// transaction, and the migrator wraps each migration in one. So it must be set
// on the connection here, before any transaction begins. (This already cost us
// the comments table once — migration 0010.)
sql.pragma("foreign_keys = OFF");
migrate(db, { migrationsFolder });
sql.pragma("foreign_keys = ON");

console.log(`migrations applied (${migrationsFolder})`);
