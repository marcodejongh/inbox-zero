# Fastmail self-hosted deployment

This fork supports Fastmail mail through JMAP API tokens and calendars through CalDAV app passwords. Authelia provides login; connecting mail is a separate step. Generic IMAP, Fastmail OAuth client registration, and native desktop/mobile certification are outside this release.

## Configure and start

1. Copy `apps/web/.env.example` to a private environment file. Configure the database, AI provider, public HTTPS base URL, and encryption keys. Keep `EMAIL_ENCRYPT_SECRET` and `EMAIL_ENCRYPT_SALT` unchanged when upgrading: existing credentials depend on them.
2. Set `NEXT_PUBLIC_FASTMAIL_ENABLED=true`, `QUEUE_BACKEND=bullmq`, `REDIS_URL=redis://redis:6379`, and the Redis HTTP bridge settings. Generate separate `INTERNAL_API_KEY`, `FASTMAIL_WEBHOOK_SECRET`, `CRON_SECRET`, and `AUTH_SECRET` values with `openssl rand -hex 32`. Set `NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS=true` for self-hosted use.
3. For Authelia, set `NEXT_PUBLIC_AUTHELIA_ENABLED=true`, `AUTHELIA_CLIENT_ID`, `AUTHELIA_CLIENT_SECRET`, and `AUTHELIA_ISSUER_URL`. Register the web app's `/api/auth/callback/authelia` URL in Authelia, with `openid profile email` scopes and PKCE enabled. The login button appears only when the server has the complete configuration. Google/Microsoft credentials are optional.
4. Pin `INBOX_ZERO_IMAGE` and `FASTMAIL_DAEMON_IMAGE` to matching release tags from your fork. For a local build, build the web image with `docker build -f docker/Dockerfile.prod -t inbox-zero:fastmail .` and the daemon with `docker build -f apps/fastmail-eventsource-daemon/Dockerfile -t inbox-zero-fastmail-daemon:fastmail .`. Set those image names in the environment file.
5. Back up PostgreSQL before upgrading. Run Compose from the repository root with `docker compose --env-file /path/to/private.env --profile all up -d`. Use `--pull never` for locally built images. The web image runs Prisma migrations at startup; verify migration success in its logs before using the app. The worker, cron, Redis, and daemon must remain running.

The additive Fastmail migration creates durable incoming-message work and draft identity tables, account leases/recovery cursors, and encrypted calendar credential storage. It does not process old mail automatically. Existing installations using a custom `WORKER_QUEUES` value must add `fastmail-sync`.

## Connect accounts

Sign in with Authelia, then open Accounts → Add Fastmail. Generate a Fastmail **API token** with mail read/write and sending access; include contacts access for recipient autocomplete. Reconnect using a token for the same Fastmail account if a token is revoked or rotated. Tokens remain encrypted in PostgreSQL.

Open Calendars → Add Fastmail Calendar and supply your Fastmail email plus a separate **app password with calendar access**. API tokens cannot authenticate CalDAV. Reconnecting refreshes the calendar list while preserving enabled/disabled selections. Shared read-only calendars contribute to availability but cannot be booking destinations. Use a custom meeting URL, phone number, or location; Fastmail cannot create Google Meet or Teams conference links.

## Delivery and recovery

Fastmail notifications use **Server-Sent Events**, not WebSockets. The daemon consumes the JMAP session's EventSource URL, refreshes account tokens every minute, and requests synchronization on connection and Email state changes. A webhook acknowledges only after BullMQ accepts its job. No public incoming webhook or daemon database connection is needed.

A separate cron poll enqueues all connected Fastmail accounts every five minutes, including accounts without AI rules. The web worker holds an account lease, commits discovered message IDs and the JMAP state in one transaction, then processes pending messages. Failures remain pending for retry. Expired history triggers a bounded recovery scan from the account's automation start date. This provides at-least-once processing: external effects cannot be made exactly-once across a provider/network failure. Check Sent before manually retrying an ambiguous send.

Assistant settings → Email Sync shows the latest successful check and pending/retry counts. “Check for new mail” queues an immediate recovery job. If counts persist, inspect web/worker logs and verify Redis and internal authentication. The daemon logs connection counts without message contents or tokens.

Auto-archive sender filters created here are Inbox Zero rules stored in this application's database. They require the worker and polling/SSE services to run. They do not edit or enumerate filters configured in Fastmail itself. Native forwarding settings, provider categories, and folder colors are unavailable through this integration; mailbox assessment leaves the forwarding count unknown.

## Live release gate

Use a dedicated test mailbox before updating a personal production deployment:

- Link, revoke, and reconnect a mail token; verify aliases, contacts, attachment/inline-image send, reply, forward, drafts, labels, trash, spam, and split-inbox queries.
- Stop the daemon, receive mail, and verify five-minute recovery. Restart it and verify catch-up. Stop/restart the worker and confirm pending mail survives without silent cursor advancement. Repeat with expired JMAP history.
- Verify an application-managed sender filter, read state, and web mailbox updates across two browser sessions. Check concurrent draft edits and ambiguous send handling.
- Connect a calendar app password; verify read-only calendars, recurring/all-day events across DST, availability, booking creation/rescheduling/cancellation, and accepted/tentative/declined invitation responses. Confirm an ETag conflict asks for a reload.
- Run the image on both amd64 and arm64, verify Authelia-only login, migrations, health logs, and backups. These live-account and image checks require real credentials and a Docker runtime; unit tests do not certify them.

## Protocol references

[Fastmail's developer documentation](https://www.fastmail.com/dev/) documents mail and contacts over JMAP, calendar access over CalDAV, API tokens for JMAP, and app passwords for other protocols. It still describes public JMAP calendar access as forthcoming. [RFC 8620](https://www.rfc-editor.org/rfc/rfc8620.html#section-7) defines both PushSubscription and EventSource; this release uses the existing outbound SSE path plus polling because it fits private self-hosted deployments. PushSubscription is a possible future transport, not a prerequisite for correctness.
