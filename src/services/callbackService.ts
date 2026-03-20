import { query } from "../config/db.js";
import { env } from "../config/env.js";
import { recordAuditEvent } from "./auditService.js";
import { WebsocketHub } from "./websocketHub.js";
import {
  finalizeDomainBookingForCheckout,
  getDomainBookingResponse,
} from "./domainBookingService.js";

export type MpesaCallback = {
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  ResultCode?: number;
  ResultDesc?: string;
  CallbackMetadata?: {
    Item?: Array<{ Name: string; Value?: string | number }>;
  };
};

const readItemValue = (
  items: Array<{ Name: string; Value?: string | number }> | undefined,
  name: string
) => {
  if (!items) return null;
  for (const item of items) {
    if (item.Name === name) {
      return item.Value ?? null;
    }
  }
  return null;
};

export const handleCallback = async (payload: any, hub: WebsocketHub) => {
  // Callback is the source of truth for final settlement and receipt number.
  const stkCallback = payload?.Body?.stkCallback as MpesaCallback | undefined;

  if (!stkCallback || !stkCallback.CheckoutRequestID) {
    return { ok: false, error: "Invalid callback payload" };
  }

  const items = stkCallback.CallbackMetadata?.Item ?? [];
  const receipt = readItemValue(items, "MpesaReceiptNumber")?.toString() ?? null;
  const amount = Number(readItemValue(items, "Amount") ?? 0) || null;
  const phoneNumber = readItemValue(items, "PhoneNumber")?.toString() ?? null;

  const checkoutId = stkCallback.CheckoutRequestID;
  const resultCode = stkCallback.ResultCode ?? null;
  const resultDesc = stkCallback.ResultDesc ?? null;

  const existing = await query<{ callback_received_at: string | null }>(
    `SELECT callback_received_at FROM mpesa_transactions WHERE checkout_request_id = $1`,
    [checkoutId]
  );

  if (existing.length && existing[0].callback_received_at) {
    await recordAuditEvent({
      eventType: "stk_callback_duplicate",
      checkoutRequestId: checkoutId,
      payload,
    });

    return { ok: true, duplicate: true };
  }

  const status = resultCode === 0
    ? "success"
    : resultCode === 1032
      ? "cancelled"
      : "failed";

  if (existing.length === 0) {
    await query(
      `INSERT INTO mpesa_transactions
        (environment, checkout_request_id, merchant_request_id, phone_number, amount, status, result_code, result_desc, mpesa_receipt, raw_callback, callback_received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       ON CONFLICT (checkout_request_id) DO NOTHING`,
      [
        env.MPESA_ENV,
        checkoutId,
        stkCallback.MerchantRequestID ?? null,
        phoneNumber,
        amount,
        status,
        resultCode,
        resultDesc,
        receipt,
        payload,
      ]
    );
  } else {
    await query(
      `UPDATE mpesa_transactions
       SET status = $1,
           result_code = $2,
           result_desc = $3,
           mpesa_receipt = $4,
           raw_callback = $5,
           booking_status = CASE
             WHEN payment_context IS NULL THEN booking_status
             WHEN $2 = 0 THEN booking_status
             ELSE 'failed'
           END,
           booking_error = CASE
             WHEN payment_context IS NULL THEN booking_error
             WHEN $2 = 0 THEN booking_error
             ELSE $3
           END,
           callback_received_at = now(),
           updated_at = now()
       WHERE checkout_request_id = $6`,
      [status, resultCode, resultDesc, receipt, payload, checkoutId]
    );
  }

  await recordAuditEvent({
    eventType: "stk_callback",
    checkoutRequestId: checkoutId,
    payload,
  });

  const booking =
    resultCode === 0
      ? await finalizeDomainBookingForCheckout(checkoutId)
      : getDomainBookingResponse({
          payment_context:
            (
              await query<{ payment_context: unknown }>(
                `SELECT payment_context
                 FROM mpesa_transactions
                 WHERE checkout_request_id = $1
                 LIMIT 1`,
                [checkoutId]
              )
            )[0]?.payment_context,
          booking_status: "failed",
          booking_error: resultDesc,
          result_desc: resultDesc,
          mpesa_receipt: receipt,
        });

  hub.publish(checkoutId, {
    CheckoutRequestID: checkoutId,
    ResultCode: resultCode,
    ResultDesc: resultDesc,
    CallbackMetadata: {
      Item: [
        { Name: "MpesaReceiptNumber", Value: receipt },
        { Name: "Amount", Value: amount },
        { Name: "PhoneNumber", Value: phoneNumber },
      ].filter((item) => item.Value !== null),
    },
    ...(booking ?? {}),
  });

  return { ok: true };
};
