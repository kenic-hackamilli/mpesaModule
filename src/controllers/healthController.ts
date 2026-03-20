import type { FastifyInstance } from "fastify";

export const registerHealthRoutes = async (app: FastifyInstance) => {
  app.get("/payapi/health", async () => ({ ok: true }));
};
