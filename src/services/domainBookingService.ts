import { query } from "../config/db.js";
import { getSupabaseAdminClient } from "../config/supabase.js";
import { recordAuditEvent } from "./auditService.js";
import { normalizePhone } from "../utils/validation.js";

type DomainBookingInput = {
  full_name: string;
  phone: string;
  email: string;
  domain_name: string;
};

export type DomainBookingContext = {
  type: "domain_booking";
  userId: string;
  booking: DomainBookingInput;
};

type BookingStateInput = {
  payment_context?: unknown;
  booking_status?: string | null;
  booking_error?: string | null;
  booking_saved_at?: string | null;
  supabase_booking_id?: string | null;
  mpesa_receipt?: string | null;
  result_code?: number | null;
  result_desc?: string | null;
};

type TransactionRow = {
  checkout_request_id: string;
  payment_context: unknown;
  booking_status: string | null;
  booking_error: string | null;
  booking_saved_at: string | null;
  supabase_booking_id: string | null;
  mpesa_receipt: string | null;
  result_code: number | null;
  result_desc: string | null;
};

const cleanText = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const normalizeEmail = (value: unknown) => cleanText(value).toLowerCase();

const normalizeDomainName = (value: unknown) => cleanText(value).toLowerCase();

const readContext = (value: unknown): DomainBookingContext | null => {
  if (!value || typeof value !== "object") return null;

  const raw = value as Record<string, unknown>;
  const type = cleanText(raw.type);
  const userId = cleanText(raw.userId);
  const booking =
    raw.booking && typeof raw.booking === "object"
      ? (raw.booking as Record<string, unknown>)
      : null;

  if (type !== "domain_booking" || !userId || !booking) return null;

  const full_name = cleanText(booking.full_name);
  const phone = cleanText(booking.phone);
  const email = normalizeEmail(booking.email);
  const domain_name = normalizeDomainName(booking.domain_name);

  if (!full_name || !phone || !email || !domain_name) return null;

  return {
    type: "domain_booking",
    userId,
    booking: {
      full_name,
      phone,
      email,
      domain_name,
    },
  };
};

const updateBookingState = async ({
  checkoutId,
  status,
  error,
  supabaseBookingId,
  markSavedAt = false,
}: {
  checkoutId: string;
  status: string;
  error?: string | null;
  supabaseBookingId?: string | null;
  markSavedAt?: boolean;
}) => {
  await query(
    `UPDATE mpesa_transactions
     SET booking_status = $1,
         booking_error = $2,
         supabase_booking_id = COALESCE($3, supabase_booking_id),
         booking_saved_at = CASE
           WHEN $4 THEN COALESCE(booking_saved_at, now())
           ELSE booking_saved_at
         END,
         updated_at = now()
     WHERE checkout_request_id = $5`,
    [status, error ?? null, supabaseBookingId ?? null, markSavedAt, checkoutId]
  );
};

const buildBookingMessage = ({
  status,
  receipt,
  bookingError,
  resultDesc,
  domainName,
}: {
  status: string | null;
  receipt: string | null;
  bookingError: string | null;
  resultDesc: string | null;
  domainName: string | null;
}) => {
  switch (status) {
    case "confirmed":
      return receipt
        ? `Domain booking successful. M-Pesa Ref: ${receipt}.`
        : "Domain booking successful.";
    case "conflict":
      return (
        bookingError ??
        (domainName
          ? `${domainName} was already booked at settlement time. Contact support with your M-Pesa reference.`
          : "The domain was already booked at settlement time. Contact support with your M-Pesa reference.")
      );
    case "failed":
      return bookingError ?? resultDesc ?? "Booking finalization failed.";
    case "pending":
      return "Payment confirmed. Finalizing your domain reservation.";
    default:
      return null;
  }
};

export const buildDomainBookingContext = ({
  userId,
  paymentPhoneNumber,
  booking,
}: {
  userId: string;
  paymentPhoneNumber: string;
  booking: DomainBookingInput;
}): DomainBookingContext => {
  const full_name = cleanText(booking.full_name);
  const email = normalizeEmail(booking.email);
  const domain_name = normalizeDomainName(booking.domain_name);
  const phone =
    normalizePhone(paymentPhoneNumber) ||
    normalizePhone(booking.phone) ||
    cleanText(booking.phone);

  if (!full_name) {
    throw new Error("BOOKING_FULL_NAME_REQUIRED");
  }

  if (!email) {
    throw new Error("BOOKING_EMAIL_REQUIRED");
  }

  if (!phone) {
    throw new Error("BOOKING_PHONE_REQUIRED");
  }

  if (!domain_name) {
    throw new Error("BOOKING_DOMAIN_REQUIRED");
  }

  return {
    type: "domain_booking",
    userId,
    booking: {
      full_name,
      phone,
      email,
      domain_name,
    },
  };
};

export const getDomainBookingResponse = (input: BookingStateInput) => {
  const context = readContext(input.payment_context);
  if (!context) {
    return {
      bookingStatus: null,
      bookingError: null,
      bookingMessage: null,
      bookingSavedAt: null,
      supabaseBookingId: null,
    };
  }

  const bookingStatus = cleanText(input.booking_status).toLowerCase() || "pending";
  const bookingError = cleanText(input.booking_error) || null;
  const bookingSavedAt = cleanText(input.booking_saved_at) || null;
  const supabaseBookingId = cleanText(input.supabase_booking_id) || null;
  const receipt = cleanText(input.mpesa_receipt) || null;
  const resultDesc = cleanText(input.result_desc) || null;

  return {
    bookingStatus,
    bookingError,
    bookingMessage: buildBookingMessage({
      status: bookingStatus,
      receipt,
      bookingError,
      resultDesc,
      domainName: context.booking.domain_name,
    }),
    bookingSavedAt,
    supabaseBookingId,
  };
};

export const finalizeDomainBookingForCheckout = async (checkoutId: string) => {
  const rows = await query<TransactionRow>(
    `SELECT checkout_request_id,
            payment_context,
            booking_status,
            booking_error,
            booking_saved_at,
            supabase_booking_id,
            mpesa_receipt,
            result_code,
            result_desc
     FROM mpesa_transactions
     WHERE checkout_request_id = $1
     LIMIT 1`,
    [checkoutId]
  );

  const row = rows[0];
  if (!row) return null;

  const context = readContext(row.payment_context);
  if (!context) return null;

  const existingState = getDomainBookingResponse(row);
  if (existingState.bookingStatus === "confirmed") {
    return existingState;
  }

  const mpesaReceipt = cleanText(row.mpesa_receipt) || checkoutId;

  try {
    const supabase = getSupabaseAdminClient();

    const { data: existingByReceipt, error: existingByReceiptError } = await supabase
      .from("domain_bookings")
      .select("id")
      .eq("mpesa_transaction_id", mpesaReceipt)
      .maybeSingle();

    if (existingByReceiptError) {
      throw new Error(existingByReceiptError.message);
    }

    if (existingByReceipt) {
      await updateBookingState({
        checkoutId,
        status: "confirmed",
        error: null,
        supabaseBookingId: cleanText(existingByReceipt.id) || null,
        markSavedAt: true,
      });

      return getDomainBookingResponse({
        ...row,
        booking_status: "confirmed",
        booking_error: null,
        booking_saved_at: row.booking_saved_at ?? new Date().toISOString(),
        supabase_booking_id: cleanText(existingByReceipt.id) || null,
        mpesa_receipt: mpesaReceipt,
      });
    }

    const { data: activeBooking, error: activeBookingError } = await supabase
      .from("domain_bookings")
      .select("id,user_id,domain_name,mpesa_transaction_id,expires_at")
      .eq("domain_name", context.booking.domain_name)
      .order("expires_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (activeBookingError) {
      throw new Error(activeBookingError.message);
    }

    const activeExpiry = cleanText(activeBooking?.expires_at);
    const isActive =
      !!activeExpiry && Number.isFinite(new Date(activeExpiry).getTime())
        ? new Date(activeExpiry).getTime() > Date.now()
        : false;

    if (activeBooking && isActive) {
      const alreadyOwnedByUser = cleanText(activeBooking.user_id) === context.userId;
      const message = alreadyOwnedByUser
        ? `You already have an active booking for ${context.booking.domain_name}. Contact support with your M-Pesa reference.`
        : `${context.booking.domain_name} was already booked at settlement time. Contact support with your M-Pesa reference.`;

      await updateBookingState({
        checkoutId,
        status: "conflict",
        error: message,
      });

      await recordAuditEvent({
        eventType: "domain_booking_conflict",
        checkoutRequestId: checkoutId,
        payload: {
          domainName: context.booking.domain_name,
          mpesaReceipt,
          activeBooking,
          userId: context.userId,
        },
      });

      return getDomainBookingResponse({
        ...row,
        booking_status: "conflict",
        booking_error: message,
        mpesa_receipt: mpesaReceipt,
      });
    }

    const { data: insertedBooking, error: insertError } = await supabase
      .from("domain_bookings")
      .insert({
        user_id: context.userId,
        full_name: context.booking.full_name,
        phone: context.booking.phone,
        email: context.booking.email,
        domain_name: context.booking.domain_name,
        mpesa_transaction_id: mpesaReceipt,
        payment_status: "paid",
      })
      .select("id")
      .single();

    if (insertError) {
      throw new Error(insertError.message);
    }

    const { error: notificationError } = await supabase.from("notifications").insert({
      user_id: context.userId,
      title: "Booking Confirmed",
      message: `You booked ${context.booking.domain_name}. M-Pesa Ref: ${mpesaReceipt}`,
      type: "booking_created",
    });

    if (notificationError) {
      await recordAuditEvent({
        eventType: "domain_booking_notification_failed",
        checkoutRequestId: checkoutId,
        payload: {
          userId: context.userId,
          domainName: context.booking.domain_name,
          mpesaReceipt,
          error: notificationError.message,
        },
      });
    }

    await updateBookingState({
      checkoutId,
      status: "confirmed",
      error: null,
      supabaseBookingId: cleanText(insertedBooking.id) || null,
      markSavedAt: true,
    });

    await recordAuditEvent({
      eventType: "domain_booking_confirmed",
      checkoutRequestId: checkoutId,
      payload: {
        userId: context.userId,
        domainName: context.booking.domain_name,
        mpesaReceipt,
        bookingId: insertedBooking.id ?? null,
      },
    });

    return getDomainBookingResponse({
      ...row,
      booking_status: "confirmed",
      booking_error: null,
      booking_saved_at: row.booking_saved_at ?? new Date().toISOString(),
      supabase_booking_id: cleanText(insertedBooking.id) || null,
      mpesa_receipt: mpesaReceipt,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Booking finalization failed.";

    await updateBookingState({
      checkoutId,
      status: "failed",
      error: message,
    });

    await recordAuditEvent({
      eventType: "domain_booking_failed",
      checkoutRequestId: checkoutId,
      payload: {
        userId: context.userId,
        domainName: context.booking.domain_name,
        mpesaReceipt,
        error: message,
      },
    });

    return getDomainBookingResponse({
      ...row,
      booking_status: "failed",
      booking_error: message,
      mpesa_receipt: mpesaReceipt,
    });
  }
};
