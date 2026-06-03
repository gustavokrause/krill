import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { resolve } from "node:path";
import { db } from "./client";

const migrationsFolder = resolve(process.cwd(), "src/db/migrations");

migrate(db, { migrationsFolder });

console.log(`migrations applied (${migrationsFolder})`);
