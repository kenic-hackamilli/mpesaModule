import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  MPESA_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  MPESA_BASE_URL: z.string().url().optional(),
  MPESA_CONSUMER_KEY: z.string().min(1),
  MPESA_CONSUMER_SECRET: z.string().min(1),
  MPESA_SHORTCODE: z.string().min(1),
  MPESA_PASSKEY: z.string().min(1),
  MPESA_CALLBACK_URL: z.string().url(),
  MPESA_CALLBACK_IPS: z.string().optional(),
  MPESA_STATUS_MIN_INTERVAL_MS: z.coerce.number().default(15000),
  MPESA_STATUS_CACHE_TTL_SECONDS: z.coerce.number().default(600),

  REDIS_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  API_KEY: z.string().optional(),
  CORS_ORIGIN: z.string().default("*"),

  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment configuration", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const raw = parsed.data;

const defaultBaseUrl = raw.MPESA_ENV === "production"
  ? "https://api.safaricom.co.ke"
  : "https://sandbox.safaricom.co.ke";

export const env = {
  ...raw,
  MPESA_BASE_URL: raw.MPESA_BASE_URL ?? defaultBaseUrl,
  MPESA_CALLBACK_IPS: raw.MPESA_CALLBACK_IPS
    ? raw.MPESA_CALLBACK_IPS.split(",").map((ip) => ip.trim()).filter(Boolean)
    : [],
};

export type Env = typeof env;
