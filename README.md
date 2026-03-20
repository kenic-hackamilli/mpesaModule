# M-Pesa Daraja Backend

Production-grade M-Pesa Daraja STK Push integration designed to work with the provided React Native frontends.

**Key features**
- OAuth token caching (Redis)
- STK Push initiation + status query
- Callback handling with idempotency
- Server-side domain booking settlement into Supabase after successful callback
- WebSocket updates for real-time status
- Rate limiting per IP and per user/phone
- Structured logs and audit trail

## Endpoints
- `POST /payapi/stkpush`
- `GET /payapi/payment-status/:checkoutId`
- `GET /payapi/payment-status/by-idempotency/:idempotencyKey`
- `POST /payapi/mpesa/callback`
- `GET /payapi/health`
- WebSocket: `ws://<host>/ws`

## Environment
Copy `.env.example` to `.env` and fill in values.

Required:
- `MPESA_CONSUMER_KEY`
- `MPESA_CONSUMER_SECRET`
- `MPESA_SHORTCODE`
- `MPESA_PASSKEY`
- `MPESA_CALLBACK_URL`
- `MPESA_ENV` (`sandbox` or `production`)
- `MPESA_BASE_URL`
- `REDIS_URL`
- `DATABASE_URL`

Required for server-side domain booking writes:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`

Optional:
- `API_KEY` (if set, `x-api-key` header is required for `/api/stkpush`)
- `MPESA_CALLBACK_IPS` (comma-separated allowlist)
- `CORS_ORIGIN`
- `MPESA_STATUS_MIN_INTERVAL_MS` (minimum interval between upstream status queries, default `15000`)
- `MPESA_STATUS_CACHE_TTL_SECONDS` (status cache TTL in Redis, default `600`)

## Run Locally
1. Install dependencies
```bash
npm install
```

2. Start Postgres + Redis (example using Docker)
```bash
docker compose up -d
```

3. Run migrations
```bash
npm run db:migrate
```

4. Start server
```bash
npm run dev
```

Server defaults to `http://localhost:3000` and WebSocket at `ws://localhost:3000/ws`.

## Frontend Integration
Set these runtime values in your Expo app:
- `STK_API_URL` = `https://<your-domain>/payapi/stkpush`
- `WS_URL` = `wss://<your-domain>/ws`

The frontend uses `buildPaymentStatusUrl` to call `GET /payapi/payment-status/:checkoutId` automatically.

When booking a domain, the frontend now sends:
- `Authorization: Bearer <firebase-id-token>`
- `domainBooking` payload with `full_name`, `phone`, `email`, and `domain_name`

The backend stores that booking intent with the payment, verifies the Firebase user, and only writes to Supabase after the callback confirms settlement.

## Sandbox vs Production
Set:
- `MPESA_ENV=sandbox` and `MPESA_BASE_URL=https://sandbox.safaricom.co.ke` for Sandbox.
- `MPESA_ENV=production` and `MPESA_BASE_URL=https://api.safaricom.co.ke` for Production.

Make sure `MPESA_CALLBACK_URL` is publicly reachable (use an HTTPS tunnel like ngrok during local development).

## Notes
- STK Push requests are idempotent via `Idempotency-Key` / `X-Idempotency-Key` headers.
- If an idempotency key is re-used, the backend returns the original request details instead of creating a new charge.
- In-progress idempotent requests return HTTP 202 with a `checkoutId` when available.
- Callback handling is deduplicated by `checkout_request_id`.
- WebSocket clients should send `{ "checkoutId": "<id>" }` after connection to subscribe.
