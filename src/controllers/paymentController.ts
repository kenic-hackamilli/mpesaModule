import type { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { stkPushSchema } from "../utils/validation.js";
import { initiatePayment, queryPaymentStatus, mapResultCode } from "../services/paymentService.js";
import { query } from "../config/db.js";
import { rateLimitPerUser } from "../middleware/rateLimit.js";
import { verifyFirebaseIdToken } from "../config/firebaseAdmin.js";
import {
  buildDomainBookingContext,
  getDomainBookingResponse,
} from "../services/domainBookingService.js";

const getUserRef = (req: FastifyRequest) => {
  const header = req.headers["x-user-id"] ?? req.headers["x-session-id"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return undefined;
};

const getBearerToken = (req: FastifyRequest) => {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
};

export const registerPaymentRoutes = async (app: FastifyInstance) => {
  app.post("/payapi/stkpush", { preHandler: rateLimitPerUser }, async (req, reply) => {
    if (env.API_KEY) {
      const apiKey = req.headers["x-api-key"];
      if (apiKey !== env.API_KEY) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
    }

    const parsed = stkPushSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const idempotencyKey =
      (req.headers["idempotency-key"] as string | undefined) ??
      (req.headers["x-idempotency-key"] as string | undefined) ??
      parsed.data.idempotencyKey;

    if (!idempotencyKey) {
      return reply.status(400).send({ error: "Idempotency key required" });
    }

    let verifiedUserId: string | undefined;
    let paymentContext = null;

    if (parsed.data.domainBooking) {
      const token = getBearerToken(req);
      if (!token) {
        return reply.status(401).send({ error: "AUTH_REQUIRED" });
      }

      let verifiedUid: string;
      try {
        const decoded = await verifyFirebaseIdToken(token);
        verifiedUid = decoded.uid;
        verifiedUserId = decoded.uid;
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Invalid auth token";

        const isConfigError =
          message.includes("Missing Firebase credentials") ||
          message.includes("Invalid FIREBASE_SERVICE_ACCOUNT_JSON");

        return reply
          .status(isConfigError ? 500 : 401)
          .send({ error: isConfigError ? message : "AUTH_INVALID" });
      }

      try {
        paymentContext = buildDomainBookingContext({
          userId: verifiedUid,
          paymentPhoneNumber: parsed.data.phoneNumber,
          booking: parsed.data.domainBooking,
        });
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Invalid booking payload";
        return reply.status(400).send({ error: message });
      }
    }

    const result = await initiatePayment({
      ...parsed.data,
      idempotencyKey,
      userRef: verifiedUserId ?? parsed.data.userRef ?? getUserRef(req),
      paymentContext,
      ipAddress: req.ip,
    });

    const payload = result.data;
    const checkoutId =
      (payload as any)?.CheckoutRequestID ?? (payload as any)?.checkoutId ?? null;

    return reply.status(result.status).send({
      ...payload,
      checkoutId,
    });
  });

  app.get("/payapi/payment-status/:checkoutId", async (req, reply) => {
    const { checkoutId } = req.params as { checkoutId: string };
    if (!checkoutId) {
      return reply.status(400).send({ error: "Checkout id required" });
    }

    const response = await queryPaymentStatus(checkoutId);
    const payload = response.data ?? {};

    const stored = await query<{ mpesa_receipt: string | null }>(
      `SELECT mpesa_receipt FROM mpesa_transactions WHERE checkout_request_id = $1`,
      [checkoutId]
    );

    const receipt = stored[0]?.mpesa_receipt ?? null;

    return reply.status(response.status).send({
      ...payload,
      CheckoutRequestID: checkoutId,
      MpesaReceiptNumber: receipt,
      receipt,
      checkoutId,
    });
  });

  app.get("/payapi/payment-status/by-idempotency/:idempotencyKey", async (req, reply) => {
    const { idempotencyKey } = req.params as { idempotencyKey: string };
    if (!idempotencyKey) {
      return reply.status(400).send({ error: "Idempotency key required" });
    }

    const existing = await query<{
      checkout_request_id: string | null;
      status: string | null;
      result_code: number | null;
      result_desc: string | null;
      mpesa_receipt: string | null;
      callback_received_at: string | null;
      payment_context: unknown;
      booking_status: string | null;
      booking_error: string | null;
      booking_saved_at: string | null;
      supabase_booking_id: string | null;
    }>(
      `SELECT checkout_request_id,
              status,
              result_code,
              result_desc,
              mpesa_receipt,
              callback_received_at,
              payment_context,
              booking_status,
              booking_error,
              booking_saved_at,
              supabase_booking_id
       FROM mpesa_transactions
       WHERE idempotency_key = $1 AND environment = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [idempotencyKey, env.MPESA_ENV]
    );

    if (!existing.length) {
      return reply.status(404).send({ error: "No payment found for idempotency key" });
    }

    const row = existing[0];
    const checkoutId = row.checkout_request_id ?? null;
    const receipt = row.mpesa_receipt ?? null;
    const status =
      row.result_code !== null && !row.callback_received_at
        ? mapResultCode(row.result_code)
        : row.status ?? "pending";

    const booking = getDomainBookingResponse(row);

    return reply.status(200).send({
      idempotencyKey,
      CheckoutRequestID: checkoutId,
      checkoutId,
      status,
      ResultCode: row.result_code,
      ResultDesc: row.result_desc,
      MpesaReceiptNumber: receipt,
      receipt,
      callbackReceivedAt: row.callback_received_at,
      ...booking,
    });
  });
};
