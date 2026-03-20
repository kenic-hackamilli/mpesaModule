import { redis } from "../config/redis.js";

const PREFIX = "mpesa:idempotency:stkpush:";
const IN_FLIGHT = "__inflight__";

export type IdempotencyRecord<T> = {
  data: T;
  createdAt: number;
};

export const getIdempotency = async <T>(key: string) => {
  const raw = await redis.get(`${PREFIX}${key}`);
  if (!raw) return null;
  if (raw === IN_FLIGHT) return "IN_FLIGHT" as const;
  try {
    return JSON.parse(raw) as IdempotencyRecord<T>;
  } catch {
    return null;
  }
};

export const acquireIdempotency = async (key: string, ttlSeconds: number) => {
  const res = await redis.set(
    `${PREFIX}${key}`,
    IN_FLIGHT,
    "EX",
    ttlSeconds,
    "NX"
  );
  return res === "OK";
};

export const setIdempotency = async <T>(
  key: string,
  value: T,
  ttlSeconds: number
) => {
  const record: IdempotencyRecord<T> = {
    data: value,
    createdAt: Date.now(),
  };
  await redis.set(
    `${PREFIX}${key}`,
    JSON.stringify(record),
    "EX",
    ttlSeconds
  );
};
