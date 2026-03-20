import { env } from "../../config/env.js";
import { redis } from "../../config/redis.js";
import { fetchJson } from "../../utils/http.js";
import { runWithCircuitBreaker } from "../../utils/circuitBreaker.js";
import { nowTimestamp } from "../../utils/time.js";

export type MpesaStkPushResponse = {
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  ResponseCode?: string;
  ResponseDescription?: string;
  CustomerMessage?: string;
  errorMessage?: string;
  errorCode?: string;
};

export type MpesaStkQueryResponse = {
  ResponseCode?: string;
  ResponseDescription?: string;
  ResultCode?: number;
  ResultDesc?: string;
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  MpesaReceiptNumber?: string;
};

const tokenCacheKey = `mpesa:token:${env.MPESA_ENV}`;
const baseUrl = env.MPESA_BASE_URL.replace(/\/+$/, "");
let inMemoryToken: { token: string; expiresAt: number } | null = null;

const getCachedToken = async () => {
  if (inMemoryToken && inMemoryToken.expiresAt > Date.now() + 5000) {
    return inMemoryToken.token;
  }

  const cached = await redis.get(tokenCacheKey);
  if (!cached) return null;

  try {
    const parsed = JSON.parse(cached) as { token: string; expiresAt: number };
    if (parsed.expiresAt > Date.now() + 5000) {
      inMemoryToken = parsed;
      return parsed.token;
    }
  } catch {
    return null;
  }

  return null;
};

const setCachedToken = async (token: string, expiresIn: number) => {
  const expiresAt = Date.now() + Math.max(0, expiresIn - 60) * 1000;
  inMemoryToken = { token, expiresAt };
  await redis.set(
    tokenCacheKey,
    JSON.stringify(inMemoryToken),
    "EX",
    Math.max(30, expiresIn - 30)
  );
};

export const getAccessToken = async (): Promise<string> => {
  const cached = await getCachedToken();
  if (cached) return cached;

  const auth = Buffer.from(
    `${env.MPESA_CONSUMER_KEY}:${env.MPESA_CONSUMER_SECRET}`
  ).toString("base64");

  const url = `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`;
  const response = await fetchJson<{ access_token?: string; expires_in?: string }>(
    url,
    {
      method: "GET",
      headers: { Authorization: `Basic ${auth}` },
      timeoutMs: 10000,
    }
  );

  if (!response.ok || !response.data?.access_token) {
    const message = response.data?.access_token
      ? "M-Pesa token missing"
      : `M-Pesa auth failed (${response.status})`;
    throw new Error(message);
  }

  const expiresIn = Number(response.data.expires_in ?? 3600);
  await setCachedToken(response.data.access_token, expiresIn);

  return response.data.access_token;
};

export const stkPush = async (payload: {
  phoneNumber: string;
  amount: number;
  accountReference: string;
  transactionDesc: string;
}) => {
  return runWithCircuitBreaker(
    "mpesa:stkpush",
    async () => {
      const token = await getAccessToken();
      const timestamp = nowTimestamp();
      const password = Buffer.from(
        `${env.MPESA_SHORTCODE}${env.MPESA_PASSKEY}${timestamp}`
      ).toString("base64");

      const body = {
        BusinessShortCode: env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: payload.amount,
        PartyA: payload.phoneNumber,
        PartyB: env.MPESA_SHORTCODE,
        PhoneNumber: payload.phoneNumber,
        CallBackURL: env.MPESA_CALLBACK_URL,
        AccountReference: payload.accountReference,
        TransactionDesc: payload.transactionDesc,
      };

      const url = `${baseUrl}/mpesa/stkpush/v1/processrequest`;
      return fetchJson<MpesaStkPushResponse>(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body,
        timeoutMs: 15000,
      });
    },
    (result) => !result.ok
  );
};

export const stkQuery = async (checkoutRequestId: string) => {
  return runWithCircuitBreaker(
    "mpesa:stkquery",
    async () => {
      const token = await getAccessToken();
      const timestamp = nowTimestamp();
      const password = Buffer.from(
        `${env.MPESA_SHORTCODE}${env.MPESA_PASSKEY}${timestamp}`
      ).toString("base64");

      const body = {
        BusinessShortCode: env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId,
      };

      const url = `${baseUrl}/mpesa/stkpushquery/v1/query`;
      return fetchJson<MpesaStkQueryResponse>(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body,
        timeoutMs: 12000,
      });
    },
    (result) => !result.ok && result.status !== 429
  );
};
