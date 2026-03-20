import Fastify from "fastify";
import { logger } from "./config/logger.js";
import { registerSecurity } from "./middleware/security.js";
import { registerRateLimit } from "./middleware/rateLimit.js";
import { registerPaymentRoutes } from "./controllers/paymentController.js";
import { registerCallbackRoutes } from "./controllers/callbackController.js";
import { registerHealthRoutes } from "./controllers/healthController.js";
import { env } from "./config/env.js";
import { WebSocketServer } from "ws";
import { WebsocketHub } from "./services/websocketHub.js";

const app: any = Fastify({ logger, trustProxy: true });

const hub = new WebsocketHub();

await registerSecurity(app);
await registerRateLimit(app);
await registerHealthRoutes(app);
await registerPaymentRoutes(app);
await registerCallbackRoutes(app, hub);

app.setErrorHandler((error, _req, reply) => {
  app.log.error({ err: error }, "Unhandled error");
  const status = (error as any).statusCode ?? 500;
  reply.status(status).send({ error: status >= 500 ? "Internal Server Error" : error.message });
});

const start = async () => {
  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });

    const wss = new WebSocketServer({ server: app.server, path: "/ws" });

    wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message?.type === "ping") {
            socket.send(JSON.stringify({ type: "pong" }));
            return;
          }

          const checkoutId =
            message?.checkoutId ??
            message?.CheckoutRequestID ??
            message?.checkoutRequestId ??
            message?.checkoutRequestID;

          if (typeof checkoutId === "string" && checkoutId.trim()) {
            hub.register(checkoutId.trim(), socket);
          }
        } catch {
          // Ignore malformed message
        }
      });

      socket.on("close", () => {
        hub.unregister(socket);
      });

      socket.on("error", () => {
        hub.unregister(socket);
      });
    });

    app.log.info("Server started");
  } catch (err) {
    app.log.error({ err }, "Failed to start server");
    process.exit(1);
  }
};

await start();
