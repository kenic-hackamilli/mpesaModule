-- Historical compatibility migration.
-- Do not drop existing objects here because some environments may already
-- have these names bound to unique constraints, and this migration is replayed
-- every time the current migration runner executes.

CREATE UNIQUE INDEX IF NOT EXISTS mpesa_transactions_checkout_uidx
  ON mpesa_transactions (checkout_request_id);

CREATE UNIQUE INDEX IF NOT EXISTS mpesa_transactions_idempotency_uidx
  ON mpesa_transactions (idempotency_key);
