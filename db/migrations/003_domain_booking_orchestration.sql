ALTER TABLE mpesa_transactions
  ADD COLUMN IF NOT EXISTS payment_context jsonb,
  ADD COLUMN IF NOT EXISTS booking_status text,
  ADD COLUMN IF NOT EXISTS booking_error text,
  ADD COLUMN IF NOT EXISTS booking_saved_at timestamptz,
  ADD COLUMN IF NOT EXISTS supabase_booking_id text;

CREATE INDEX IF NOT EXISTS mpesa_transactions_booking_status_idx
  ON mpesa_transactions (booking_status);
