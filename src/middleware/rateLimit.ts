import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { redis } from "../config/redis.js";

const USER_WINDOW_SECONDS = 90;
const USER_MAX_REQUESTS = 10;

export const registerRateLimit = async (app: FastifyInstance) => {
  await app.register(rateLimit, {
    max: 60,
    timeWindow: "1 minute",
    redis,
    allowList: [],
  });
};

export const rateLimitPerUser = async (
  req: FastifyRequest,
  reply: FastifyReply
) => {
  const headerKey = req.headers["x-user-id"] ?? req.headers["x-session-id"];
  const body = req.body as any;
  const phone = body?.phoneNumber ?? body?.phone_number;

  const identifier =
    (typeof headerKey === "string" && headerKey.trim())
      ? headerKey.trim()
      : (typeof phone === "string" && phone.trim())
        ? phone.trim()
        : null;

  if (!identifier) return;

  const key = `ratelimit:user:${identifier}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, USER_WINDOW_SECONDS);
    }

    if (count > USER_MAX_REQUESTS) {
      return reply.status(429).send({ error: "Rate limit exceeded" });
    }
  } catch {
    // If Redis is unavailable, do not block the request.
  }
};
