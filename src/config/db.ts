import { Pool } from "pg";
import { env } from "./env.js";
import { logger } from "./logger.js";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

pool.on("error", (err: unknown) => {
  logger.error({ err }, "Unexpected PostgreSQL error");
});

export const query = async <T = any>(text: string, params?: any[]): Promise<T[]> => {
  const res = await pool.query(text, params);
  return res.rows as T[];
};
