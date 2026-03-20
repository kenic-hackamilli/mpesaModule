import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { handleCallback } from "../services/callbackService.js";
import type { WebsocketHub } from "../services/websocketHub.js";

export const registerCallbackRoutes = async (
  app: FastifyInstance,
  hub: WebsocketHub
) => {
  app.post(
    "/payapi/mpesa/callback",
    { config: { rateLimit: false } },
    async (req, reply) => {
      if (env.MPESA_CALLBACK_IPS.length) {
        const ip = req.ip;
        if (!env.MPESA_CALLBACK_IPS.includes(ip)) {
          return reply.status(403).send({ error: "Forbidden" });
        }
      }

      const result = await handleCallback(req.body, hub);
      if (!result.ok) {
        return reply.status(400).send({ ResultCode: 1, ResultDesc: result.error });
      }

      return reply.status(200).send({ ResultCode: 0, ResultDesc: "Accepted" });
    }
  );
};
