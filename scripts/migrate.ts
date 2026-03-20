import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const migrationsDir = path.resolve(__dirname, "../db/migrations");

dotenv.config();

const run = async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations.");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      // Run each migration in its own transaction for safety
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
      // eslint-disable-next-line no-console
      console.log(`Applied ${file}`);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
};

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Migration failed", err);
  process.exit(1);
});
