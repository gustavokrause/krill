import type { Config } from "drizzle-kit";
import { resolve } from "node:path";

const dbPath = process.env.DB_PATH ?? "data/tasks.db";

export default {
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: resolve(process.cwd(), dbPath),
  },
  strict: true,
  verbose: true,
} satisfies Config;
