CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS mpesa_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  environment text NOT NULL,
  idempotency_key text,
  merchant_request_id text,
  checkout_request_id text,
  phone_number text,
  amount numeric(12,2),
  account_reference text,
  transaction_desc text,
  status text NOT NULL,
  result_code integer,
  result_desc text,
  mpesa_receipt text,
  raw_initiation jsonb,
  raw_callback jsonb,
  user_ref text,
  ip_address inet,
  callback_received_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS mpesa_transactions_checkout_uidx
  ON mpesa_transactions (checkout_request_id);

CREATE UNIQUE INDEX IF NOT EXISTS mpesa_transactions_idempotency_uidx
  ON mpesa_transactions (idempotency_key);

CREATE INDEX IF NOT EXISTS mpesa_transactions_phone_idx
  ON mpesa_transactions (phone_number);

CREATE INDEX IF NOT EXISTS mpesa_transactions_status_idx
  ON mpesa_transactions (status);

CREATE INDEX IF NOT EXISTS mpesa_transactions_receipt_idx
  ON mpesa_transactions (mpesa_receipt);

CREATE TABLE IF NOT EXISTS payment_audit_logs (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL,
  checkout_request_id text,
  idempotency_key text,
  payload jsonb
);

CREATE INDEX IF NOT EXISTS payment_audit_logs_checkout_idx
  ON payment_audit_logs (checkout_request_id);
