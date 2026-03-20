import pino from "pino";
import { env } from "./env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-api-key']",
      "req.headers['idempotency-key']",
      "req.headers['x-idempotency-key']",
      "body.MPESA_CONSUMER_SECRET",
      "body.MPESA_PASSKEY",
      "body.passkey",
    ],
    remove: true,
  },
});
