import { query } from "../config/db.js";
import { logger } from "../config/logger.js";
import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { recordAuditEvent } from "./auditService.js";
import {
  acquireIdempotency,
  getIdempotency,
  setIdempotency,
} from "./idempotencyService.js";
import { stkPush, stkQuery } from "../integrations/mpesa/mpesaClient.js";
import type { MpesaStkQueryResponse } from "../integrations/mpesa/mpesaClient.js";
import { normalizePhone } from "../utils/validation.js";
import { getDomainBookingResponse } from "./domainBookingService.js";

const IDEMPOTENCY_TTL_SECONDS = 60 * 30; // 30 minutes
const FINAL_STATUSES = ["success", "failed", "cancelled"] as const;
const STATUS_MIN_INTERVAL_MS = Math.max(1000, env.MPESA_STATUS_MIN_INTERVAL_MS);
const STATUS_CACHE_TTL_SECONDS = Math.max(60, env.MPESA_STATUS_CACHE_TTL_SECONDS);
const STATUS_CACHE_PREFIX = `mpesa:status:${env.MPESA_ENV}:`;
const STATUS_LOCK_PREFIX = `mpesa:status:lock:${env.MPESA_ENV}:`;
const STATUS_LOCK_TTL_SECONDS = Math.max(
  1,
  Math.ceil(STATUS_MIN_INTERVAL_MS / 1000)
);

type ExistingByKeyRow = {
  checkout_request_id: string | null;
  raw_initiation: any;
  status: string | null;
  result_code: number | null;
  result_desc: string | null;
  mpesa_receipt: string | null;
  callback_received_at?: string | null;
  phone_number?: string | null;
  amount?: string | number | null;
  account_reference?: string | null;
  transaction_desc?: string | null;
  payment_context?: unknown;
  booking_status?: string | null;
  booking_error?: string | null;
  booking_saved_at?: string | null;
  supabase_booking_id?: string | null;
};

type StatusCacheEntry = {
  checkedAt: number;
  payload: MpesaStkQueryResponse;
};

const statusCacheKey = (checkoutId: string) =>
  `${STATUS_CACHE_PREFIX}${checkoutId}`;
const statusLockKey = (checkoutId: string) =>
  `${STATUS_LOCK_PREFIX}${checkoutId}`;

const readStatusCache = async (checkoutId: string) => {
  try {
    const raw = await redis.get(statusCacheKey(checkoutId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StatusCacheEntry;
    if (!parsed.checkedAt || !parsed.payload) return null;
    return parsed;
  } catch {
    return null;
  }
};

const writeStatusCache = async (checkoutId: string, entry: StatusCacheEntry) => {
  try {
    await redis.set(
      statusCacheKey(checkoutId),
      JSON.stringify(entry),
      "EX",
      STATUS_CACHE_TTL_SECONDS
    );
  } catch {
    // If Redis is unavailable, skip caching.
  }
};

const acquireStatusLock = async (checkoutId: string) => {
  try {
    const res = await redis.set(
      statusLockKey(checkoutId),
      "1",
      "EX",
      STATUS_LOCK_TTL_SECONDS,
      "NX"
    );
    return res === "OK";
  } catch {
    // If Redis is unavailable, proceed without throttling.
    return true;
  }
};

const getNextPollAfterMs = (checkedAt: number) =>
  Math.max(1000, STATUS_MIN_INTERVAL_MS - (Date.now() - checkedAt));

const buildStatusPayload = (
  checkoutId: string,
  payload: MpesaStkQueryResponse | null,
  status: string,
  options?: { nextPollAfterMs?: number; rateLimited?: boolean }
) => {
  const base = payload ? { ...payload } : {};
  return {
    ...base,
    CheckoutRequestID: checkoutId,
    status,
    pending: status === "pending",
    ...(options?.nextPollAfterMs !== undefined
      ? { nextPollAfterMs: options.nextPollAfterMs }
      : {}),
    ...(options?.rateLimited ? { rateLimited: true } : {}),
  };
};

const buildFallbackPayload = (
  checkoutId: string,
  cached: StatusCacheEntry | null,
  stored?: { result_code: number | null; result_desc: string | null }
) => {
  const base = cached?.payload ?? {};
  const resultCode = base.ResultCode ?? stored?.result_code ?? undefined;
  const resultDesc =
    base.ResultDesc ??
    (resultCode !== undefined ? stored?.result_desc ?? "Payment is still processing." : undefined);

  return {
    ...base,
    CheckoutRequestID: checkoutId,
    ...(resultCode !== undefined ? { ResultCode: resultCode } : {}),
    ...(resultDesc ? { ResultDesc: resultDesc } : {}),
  };
};

const buildIdempotentPayload = (existing: ExistingByKeyRow) => {
  const data = { ...(existing.raw_initiation ?? {}) } as Record<string, any>;
  if (existing.checkout_request_id && !data.CheckoutRequestID) {
    data.CheckoutRequestID = existing.checkout_request_id;
  }
  if (existing.result_code !== null && data.ResultCode === undefined) {
    data.ResultCode = existing.result_code;
  }
  if (existing.result_desc && data.ResultDesc === undefined) {
    data.ResultDesc = existing.result_desc;
  }
  if (existing.mpesa_receipt && data.MpesaReceiptNumber === undefined) {
    data.MpesaReceiptNumber = existing.mpesa_receipt;
  }
  if (existing.status && data.status === undefined) {
    data.status = existing.status;
  }

  return {
    ...data,
    ...getDomainBookingResponse(existing),
  };
};

const isFinalStatus = (existing: ExistingByKeyRow) => {
  if (!existing.status) return false;
  if (!FINAL_STATUSES.includes(existing.status as (typeof FINAL_STATUSES)[number])) {
    return false;
  }
  return Boolean(existing.callback_received_at);
};

export type InitiatePaymentInput = {
  phoneNumber: string;
  amount: number;
  accountReference: string;
  transactionDesc: string;
  idempotencyKey: string;
  userRef?: string;
  paymentContext?: unknown;
  ipAddress?: string | null;
};

const stringifyContext = (value: unknown) => JSON.stringify(value ?? null);

// Initiates an STK push and persists the initiation state for later callback reconciliation.
export const initiatePayment = async (input: InitiatePaymentInput) => {
  const normalizedPhone = normalizePhone(input.phoneNumber);
  if (!normalizedPhone) {
    return {
      ok: false,
      status: 400,
      data: { error: "Invalid phone number." },
    };
  }

  const cached = await getIdempotency<any>(input.idempotencyKey);
  if (cached && cached !== "IN_FLIGHT") {
    return {
      ok: true,
      status: 200,
      data: cached.data,
      idempotent: true,
    };
  }

  if (!cached) {
    const existingByKey = await query<ExistingByKeyRow>(
      `SELECT checkout_request_id,
              raw_initiation,
              status,
              result_code,
              result_desc,
              mpesa_receipt,
              phone_number,
              amount,
              account_reference,
              transaction_desc,
              payment_context,
              booking_status,
              booking_error,
              booking_saved_at,
              supabase_booking_id,
              callback_received_at
       FROM mpesa_transactions
       WHERE idempotency_key = $1 AND environment = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.idempotencyKey, env.MPESA_ENV]
    );

    if (existingByKey.length) {
      const existing = existingByKey[0];
      const amountMatches = Number(existing.amount ?? 0) === Number(input.amount);
      const phoneMatches = (existing.phone_number ?? "") === normalizedPhone;
      const accountMatches =
        (existing.account_reference ?? "") === input.accountReference;
      const descMatches =
        (existing.transaction_desc ?? "") === input.transactionDesc;
      const contextMatches =
        stringifyContext(existing.payment_context) === stringifyContext(input.paymentContext);

      if (
        !amountMatches ||
        !phoneMatches ||
        !accountMatches ||
        !descMatches ||
        !contextMatches
      ) {
        await recordAuditEvent({
          eventType: "idempotency_conflict",
          checkoutRequestId: existing.checkout_request_id ?? null,
          idempotencyKey: input.idempotencyKey,
          payload: {
            incoming: {
              phoneNumber: normalizedPhone,
              amount: input.amount,
              accountReference: input.accountReference,
              transactionDesc: input.transactionDesc,
              paymentContext: input.paymentContext ?? null,
            },
            existing: {
              phoneNumber: existing.phone_number,
              amount: existing.amount,
              accountReference: existing.account_reference,
              transactionDesc: existing.transaction_desc,
              checkoutId: existing.checkout_request_id,
              paymentContext: existing.payment_context ?? null,
            },
          },
        });

        return {
          ok: false,
          status: 409,
          data: {
            error: "Idempotency key already used for a different payment.",
            code: "IDEMPOTENCY_KEY_CONFLICT",
            checkoutId: existing.checkout_request_id ?? null,
          },
        };
      }

      const data = buildIdempotentPayload(existing);

      await setIdempotency(input.idempotencyKey, data, IDEMPOTENCY_TTL_SECONDS);

      await recordAuditEvent({
        eventType: "idempotency_cached",
        checkoutRequestId: existing.checkout_request_id ?? null,
        idempotencyKey: input.idempotencyKey,
        payload: {
          status: existing.status,
          resultCode: existing.result_code,
          resultDesc: existing.result_desc,
        },
      });

      return {
        ok: true,
        status: 200,
        data,
        idempotent: true,
      };
    }
  }

  const acquired = await acquireIdempotency(
    input.idempotencyKey,
    IDEMPOTENCY_TTL_SECONDS
  );
  if (!acquired) {
    // Re-check in case another request completed between the first read and NX lock.
    const latest = await getIdempotency<any>(input.idempotencyKey);
    if (latest && latest !== "IN_FLIGHT") {
      return {
        ok: true,
        status: 200,
        data: latest.data,
        idempotent: true,
      };
    }

    // Short wait to let the first request persist the final idempotency payload.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const settled = await getIdempotency<any>(input.idempotencyKey);
      if (settled && settled !== "IN_FLIGHT") {
        return {
          ok: true,
          status: 200,
          data: settled.data,
          idempotent: true,
        };
      }
    }

    // Best-effort lookup to return a checkoutId for websocket subscription.
    const existing = await query<ExistingByKeyRow>(
      `SELECT checkout_request_id,
              raw_initiation,
              status,
              result_code,
              result_desc,
              mpesa_receipt,
              payment_context,
              booking_status,
              booking_error,
              booking_saved_at,
              supabase_booking_id,
              callback_received_at
       FROM mpesa_transactions
       WHERE idempotency_key = $1 AND environment = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.idempotencyKey, env.MPESA_ENV]
    );
    const existingRow = existing[0];
    const checkoutId = existingRow?.checkout_request_id ?? null;

    if (existingRow) {
      const data = buildIdempotentPayload(existingRow);
      const finalStatus = isFinalStatus(existingRow);

      await recordAuditEvent({
        eventType: "idempotency_in_flight",
        checkoutRequestId: checkoutId,
        idempotencyKey: input.idempotencyKey,
        payload: {
          status: existingRow.status,
          resultCode: existingRow.result_code,
          resultDesc: existingRow.result_desc,
          finalStatus,
        },
      });

      if (finalStatus) {
        await setIdempotency(input.idempotencyKey, data, IDEMPOTENCY_TTL_SECONDS);
        return {
          ok: true,
          status: 200,
          data,
          idempotent: true,
        };
      }
    }

    return {
      ok: true,
      status: 202,
      data: {
        error: "Payment already in progress. Please wait.",
        code: "PAYMENT_IN_PROGRESS",
        checkoutId,
        status: existingRow?.status ?? "pending",
      },
    };
  }

  let response: Awaited<ReturnType<typeof stkPush>>;
  try {
    response = await stkPush({
      phoneNumber: normalizedPhone,
      amount: input.amount,
      accountReference: input.accountReference,
      transactionDesc: input.transactionDesc,
    });
  } catch (err) {
    logger.error({ err }, "STK push failed");
    return {
      ok: false,
      status: 503,
      data: { error: "Payment service temporarily unavailable. Please retry." },
    };
  }

  const payload = response.data ?? {};
  const checkoutId = payload.CheckoutRequestID ?? null;

  await recordAuditEvent({
    eventType: "stk_initiate",
    checkoutRequestId: checkoutId,
    idempotencyKey: input.idempotencyKey,
    payload: {
      request: {
        phoneNumber: normalizedPhone,
        amount: input.amount,
        accountReference: input.accountReference,
        transactionDesc: input.transactionDesc,
        paymentContext: input.paymentContext ?? null,
      },
      response: payload,
      status: response.status,
    },
  });

  if (checkoutId) {
    await query(
      `INSERT INTO mpesa_transactions
        (environment, idempotency_key, merchant_request_id, checkout_request_id, phone_number, amount, account_reference, transaction_desc, status, raw_initiation, user_ref, ip_address, payment_context, booking_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (checkout_request_id) DO NOTHING`,
      [
        env.MPESA_ENV,
        input.idempotencyKey,
        payload.MerchantRequestID ?? null,
        checkoutId,
        normalizedPhone,
        input.amount,
        input.accountReference,
        input.transactionDesc,
        "initiated",
        payload,
        input.userRef ?? null,
        input.ipAddress ?? null,
        input.paymentContext ?? null,
        input.paymentContext ? "pending" : null,
      ]
    );
  } else {
    logger.warn({ payload, status: response.status }, "STK push missing checkoutId");
  }

  const data = payload && Object.keys(payload).length > 0
    ? {
        ...payload,
        ...getDomainBookingResponse({
          payment_context: input.paymentContext,
          booking_status: input.paymentContext ? "pending" : null,
        }),
      }
    : { error: "M-Pesa did not return a valid response." };

  await setIdempotency(input.idempotencyKey, data, IDEMPOTENCY_TTL_SECONDS);

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
};

export const queryPaymentStatus = async (checkoutRequestId: string) => {
  const existing = await query<{
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
    `SELECT status,
            result_code,
            result_desc,
            mpesa_receipt,
            callback_received_at,
            payment_context,
            booking_status,
            booking_error,
            booking_saved_at,
            supabase_booking_id
     FROM mpesa_transactions WHERE checkout_request_id = $1`,
    [checkoutRequestId]
  );

  const stored = existing[0];
  const isFinal =
    stored &&
    FINAL_STATUSES.includes((stored.status ?? "") as (typeof FINAL_STATUSES)[number]) &&
    stored.callback_received_at;

  if (isFinal) {
    return {
      ok: true,
      status: 200,
      data: {
        ...buildStatusPayload(
          checkoutRequestId,
          {
            CheckoutRequestID: checkoutRequestId,
            ResultCode: stored.result_code ?? undefined,
            ResultDesc: stored.result_desc ?? undefined,
            MpesaReceiptNumber: stored.mpesa_receipt ?? undefined,
          },
          stored.status ?? "success"
        ),
        ...getDomainBookingResponse(stored),
      },
      raw: null,
    };
  }

  const cachedStatus = await readStatusCache(checkoutRequestId);
  if (cachedStatus) {
    const ageMs = Date.now() - cachedStatus.checkedAt;
    if (ageMs < STATUS_MIN_INTERVAL_MS) {
      const status = mapResultCode(cachedStatus.payload.ResultCode);
      const nextPollAfterMs =
        status === "pending" ? getNextPollAfterMs(cachedStatus.checkedAt) : undefined;
      return {
        ok: true,
        status: 200,
        data: {
          ...buildStatusPayload(
            checkoutRequestId,
            cachedStatus.payload,
            status,
            nextPollAfterMs !== undefined ? { nextPollAfterMs } : undefined
          ),
          ...getDomainBookingResponse(stored ?? {}),
        },
        raw: null,
      };
    }
  }

  const lockAcquired = await acquireStatusLock(checkoutRequestId);
  if (!lockAcquired) {
    const fallbackPayload = buildFallbackPayload(checkoutRequestId, cachedStatus, stored);
    const nextPollAfterMs = cachedStatus
      ? getNextPollAfterMs(cachedStatus.checkedAt)
      : STATUS_MIN_INTERVAL_MS;

    return {
      ok: true,
      status: 200,
      data: {
        ...buildStatusPayload(checkoutRequestId, fallbackPayload, "pending", {
          nextPollAfterMs,
        }),
        ...getDomainBookingResponse(stored ?? {}),
      },
      raw: null,
    };
  }

  let response: Awaited<ReturnType<typeof stkQuery>>;
  try {
    response = await stkQuery(checkoutRequestId);
  } catch (err) {
    logger.error({ err }, "STK query failed");
    const fallbackPayload = buildFallbackPayload(checkoutRequestId, cachedStatus, stored);
    await writeStatusCache(checkoutRequestId, {
      checkedAt: Date.now(),
      payload: fallbackPayload,
    });
    return {
      ok: true,
      status: 200,
      data: {
        ...buildStatusPayload(checkoutRequestId, fallbackPayload, "pending", {
          nextPollAfterMs: STATUS_MIN_INTERVAL_MS,
        }),
        ...getDomainBookingResponse(stored ?? {}),
      },
      raw: null,
    };
  }

  const payload = response.data ?? {};
  const resultCode = payload.ResultCode;
  const resultDesc = payload.ResultDesc;
  const status = mapResultCode(resultCode);

  if (response.ok && checkoutRequestId) {
    await query(
      `UPDATE mpesa_transactions
       SET status = $1,
           result_code = $2,
           result_desc = $3,
           updated_at = now()
       WHERE checkout_request_id = $4`,
      [status, resultCode ?? null, resultDesc ?? null, checkoutRequestId]
    );
  }

  if (!response.ok && (response.status === 429 || response.status === 0 || response.status >= 500)) {
    const fallbackPayload = buildFallbackPayload(checkoutRequestId, cachedStatus, stored);
    await writeStatusCache(checkoutRequestId, {
      checkedAt: Date.now(),
      payload: fallbackPayload,
    });

    return {
      ok: true,
      status: 200,
      data: {
        ...buildStatusPayload(checkoutRequestId, fallbackPayload, "pending", {
          nextPollAfterMs: STATUS_MIN_INTERVAL_MS,
          rateLimited: response.status === 429,
        }),
        ...getDomainBookingResponse(stored ?? {}),
      },
      raw: response.raw ?? null,
    };
  }

  const payloadWithId: MpesaStkQueryResponse = {
    ...payload,
    CheckoutRequestID: checkoutRequestId,
  };
  await writeStatusCache(checkoutRequestId, {
    checkedAt: Date.now(),
    payload: payloadWithId,
  });

  return {
    ...response,
    data: {
      ...buildStatusPayload(
        checkoutRequestId,
        payloadWithId,
        status,
        status === "pending" ? { nextPollAfterMs: STATUS_MIN_INTERVAL_MS } : undefined
      ),
      ...getDomainBookingResponse(stored ?? {}),
    },
  };
};

export const mapResultCode = (code: number | undefined) => {
  if (code === 0) return "success";
  if (code === 1032) return "cancelled";
  if (code === 4999) return "pending";
  if (typeof code === "number") return "failed";
  return "pending";
};
