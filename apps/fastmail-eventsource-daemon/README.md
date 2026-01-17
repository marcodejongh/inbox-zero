# Fastmail EventSource Daemon

A lightweight daemon that connects to Fastmail's JMAP EventSource API for real-time email notifications and forwards state changes to the main Inbox Zero application.

## Overview

This daemon implements [JMAP EventSource](https://www.rfc-editor.org/rfc/rfc8620.html#section-7.3) (RFC 8620 section 7.3) to receive real-time push notifications from Fastmail when emails arrive or change state.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Self-Hosted Deployment                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                 EventSource Daemon                           │ │
│  │                 (this service)                               │ │
│  │                                                              │ │
│  │  For each Fastmail account:                                  │ │
│  │  1. Connect to Fastmail EventSource                          │ │
│  │  2. On state change → POST to webhook                        │ │
│  └──────────────────────────┬──────────────────────────────────┘ │
│                             │                                     │
│                             │ POST /api/fastmail/webhook          │
│                             │ { emailAccountId, newState }        │
│                             ▼                                     │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                 Next.js Application                          │ │
│  │                                                              │ │
│  │  /api/fastmail/webhook  ─────► pollFastmailAccount()        │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Requirements

- Node.js 20+
- Access to the same PostgreSQL database as the main Inbox Zero app
- Network access to the main Inbox Zero app webhook endpoint

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
# Required: Same database as main app
DATABASE_URL=postgresql://user:password@localhost:5432/inbox_zero

# Required: Main app URL
MAIN_APP_URL=http://localhost:3000

# Required: Shared secret (must match FASTMAIL_WEBHOOK_SECRET in main app)
# Generate with: openssl rand -hex 32
FASTMAIL_WEBHOOK_SECRET=your-secret-here

# Required for OAuth token refresh
FASTMAIL_CLIENT_ID=your-fastmail-client-id
FASTMAIL_CLIENT_SECRET=your-fastmail-client-secret

# Optional: Refresh interval (default: 5 minutes)
ACCOUNT_REFRESH_INTERVAL=300000

# Optional: Enable debug logging
DEBUG=false
```

## Running

### Development

```bash
pnpm install
pnpm dev
```

### Production

```bash
pnpm install
pnpm start
```

### Docker

```bash
docker build -t inbox-zero-fastmail-daemon .
docker run -e DATABASE_URL=... -e MAIN_APP_URL=... -e FASTMAIL_WEBHOOK_SECRET=... inbox-zero-fastmail-daemon
```

### Docker Compose

Add to your `docker-compose.yml`:

```yaml
services:
  fastmail-daemon:
    build: ./apps/fastmail-eventsource-daemon
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - MAIN_APP_URL=http://web:3000
      - FASTMAIL_WEBHOOK_SECRET=${FASTMAIL_WEBHOOK_SECRET}
      - FASTMAIL_CLIENT_ID=${FASTMAIL_CLIENT_ID}
      - FASTMAIL_CLIENT_SECRET=${FASTMAIL_CLIENT_SECRET}
    depends_on:
      - web
      - postgres
    restart: unless-stopped
```

## How It Works

1. **Startup**: The daemon queries the database for all Fastmail accounts with:
   - Valid access token
   - At least one enabled automation rule
   - Premium tier with AI access (or self-hosted bypass)

2. **Per Account**: For each account, it:
   - Fetches the JMAP session to get the EventSource URL
   - Opens a Server-Sent Events (SSE) connection to Fastmail
   - Subscribes to Email state changes

3. **On State Change**: When Fastmail sends a state change event:
   - The daemon POSTs to `/api/fastmail/webhook` on the main app
   - The main app triggers `pollFastmailAccount()` with `forceSync: true`
   - Emails are processed through the rule engine

4. **Periodic Refresh**: Every 5 minutes (configurable), the daemon:
   - Re-queries the database for accounts
   - Starts connections for new accounts
   - Closes connections for removed/ineligible accounts

## Error Handling

- **Connection errors**: Exponential backoff reconnection (1s, 2s, 4s... up to 5 min)
- **Token expiration (401)**: Automatic token refresh using OAuth refresh token
- **Webhook failures**: Retry with exponential backoff
- **Database errors**: Logged and continued (existing connections maintained)

## Future: PushSubscription

When Fastmail adds support for JMAP PushSubscription (RFC 8620 section 7.2),
this daemon will become unnecessary. Fastmail will be able to POST directly
to the `/api/fastmail/webhook` endpoint, which is already designed to handle this.

The webhook endpoint in the main app is compatible with both:
1. This EventSource daemon (current)
2. Future Fastmail PushSubscription webhooks

## Logs

The daemon logs to stdout/stderr. In production, capture logs with your container orchestrator or process manager.

Example output:
```
╔═══════════════════════════════════════════════════════════════╗
║           Fastmail EventSource Daemon                          ║
║                                                                ║
║  Connects to Fastmail for real-time email notifications        ║
║  and forwards state changes to the main app webhook.           ║
╚═══════════════════════════════════════════════════════════════╝

Main App URL: http://localhost:3000
Debug Mode: disabled

[2024-01-15T10:30:00.000Z] [AccountManager] Starting account manager
[2024-01-15T10:30:00.100Z] [AccountManager] Found 3 eligible Fastmail accounts
[2024-01-15T10:30:00.200Z] [AccountManager] Adding connection for user@example.com
[2024-01-15T10:30:00.500Z] [AccountManager] Connected: abc123
[Stats] Connections: 3/3 active
```
