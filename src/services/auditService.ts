import { query } from "../config/db.js";

export const recordAuditEvent = async (input: {
  eventType: string;
  checkoutRequestId?: string | null;
  idempotencyKey?: string | null;
  payload: any;
}) => {
  await query(
    `INSERT INTO payment_audit_logs (event_type, checkout_request_id, idempotency_key, payload)
     VALUES ($1, $2, $3, $4)` ,
    [input.eventType, input.checkoutRequestId ?? null, input.idempotencyKey ?? null, input.payload]
  );
};
