DROP INDEX IF EXISTS mpesa_transactions_checkout_uidx;
DROP INDEX IF EXISTS mpesa_transactions_idempotency_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS mpesa_transactions_checkout_uidx
  ON mpesa_transactions (checkout_request_id);

CREATE UNIQUE INDEX IF NOT EXISTS mpesa_transactions_idempotency_uidx
  ON mpesa_transactions (idempotency_key);
