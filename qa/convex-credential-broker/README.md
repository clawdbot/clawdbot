# QA Convex Credential Broker (v1)

Standalone Convex project for shared `qa-lab` live credentials with lease locking.
Keep private operator notes in `~/Projects/manager/docs/`, not in public docs.

This broker exposes:

- `POST /qa-credentials/v1/acquire`
- `POST /qa-credentials/v1/heartbeat`
- `POST /qa-credentials/v1/release`
- `POST /qa-credentials/v1/admin/add`
- `POST /qa-credentials/v1/admin/remove`
- `POST /qa-credentials/v1/admin/list`

The implementation matches the contract documented in
`docs/help/testing.md` for `--credential-source convex`.

## Policy baked in

- Pool partitioning: by `kind` only
- Selection: least-recently-leased (round-robin behavior)
- Secrets: separate maintainer/CI secrets
- Outage behavior: callers fail fast
- Lease event retention: 2 days (hourly cleanup cron)
- Admin event retention: 30 days (hourly cleanup cron)
- App-level encryption: not included in v1

## Quick start

1. Create a Convex deployment and authenticate your CLI.
2. From this folder:

```bash
cd qa/convex-credential-broker
npm install
npx convex dev
```

3. Deploy:

```bash
npx convex deploy
```

4. In Convex deployment environment variables, set:

- `OPENCLAW_QA_CONVEX_SECRET_MAINTAINER`
- `OPENCLAW_QA_CONVEX_SECRET_CI`

Client URL policy:

- `OPENCLAW_QA_CONVEX_SITE_URL` must use `https://` in normal use.
- Local development may use loopback `http://` only when `OPENCLAW_QA_ALLOW_INSECURE_HTTP=1`.

## Manage credentials from qa-lab CLI

Maintainers can manage rows without using the Convex dashboard:

```bash
pnpm openclaw qa credentials add \
  --kind telegram \
  --payload-file qa/telegram-credential.json

pnpm openclaw qa credentials add \
  --kind discord \
  --payload-file qa/discord-credential.json

pnpm openclaw qa credentials list --kind telegram

pnpm openclaw qa credentials remove --credential-id <credential-id>
```

Admin endpoints require `OPENCLAW_QA_CONVEX_SECRET_MAINTAINER`.

## Local request examples

Replace `<site-url>` with your Convex site URL and `<token>` with a configured secret.

Acquire:

```bash
curl -sS -X POST "<site-url>/qa-credentials/v1/acquire" \
  -H "authorization: Bearer <token>" \
  -H "content-type: application/json" \
  -d '{
    "kind":"telegram",
    "ownerId":"local-dev",
    "actorRole":"maintainer",
    "leaseTtlMs":1200000,
    "heartbeatIntervalMs":30000
  }'
```

Heartbeat:

```bash
curl -sS -X POST "<site-url>/qa-credentials/v1/heartbeat" \
  -H "authorization: Bearer <token>" \
  -H "content-type: application/json" \
  -d '{
    "kind":"telegram",
    "ownerId":"local-dev",
    "actorRole":"maintainer",
    "credentialId":"<credential-id>",
    "leaseToken":"<lease-token>",
    "leaseTtlMs":1200000
  }'
```

Release:

```bash
curl -sS -X POST "<site-url>/qa-credentials/v1/release" \
  -H "authorization: Bearer <token>" \
  -H "content-type: application/json" \
  -d '{
    "kind":"telegram",
    "ownerId":"local-dev",
    "actorRole":"maintainer",
    "credentialId":"<credential-id>",
    "leaseToken":"<lease-token>"
  }'
```

Admin add (maintainer token only):

```bash
curl -sS -X POST "<site-url>/qa-credentials/v1/admin/add" \
  -H "authorization: Bearer <maintainer-token>" \
  -H "content-type: application/json" \
  -d '{
    "kind":"telegram",
    "actorId":"local-maintainer",
    "payload":{
      "groupId":"-100123",
      "driverToken":"driver-token",
      "sutToken":"sut-token"
    }
  }'
```

For `kind: "telegram"`, broker `admin/add` validates that payload includes:

- `groupId` as a numeric chat id string
- non-empty `driverToken`
- non-empty `sutToken`

For `kind: "discord"`, broker `admin/add` validates that payload includes:

- `guildId` as a Discord snowflake string
- `channelId` as a Discord snowflake string
- non-empty `driverBotToken`
- non-empty `sutBotToken`
- `sutApplicationId` as a Discord snowflake string

For `kind: "whatsapp"`, broker `admin/add` validates that payload includes:

- `driverPhoneE164` as an E.164 phone number string
- `sutPhoneE164` as a distinct E.164 phone number string
- non-empty `driverAuthArchiveBase64`
- non-empty `sutAuthArchiveBase64`
- optional `groupJid`

Other kinds are currently accepted as pass-through payloads. Add broker-side
validation before treating a new kind as a hardened shared pool.

Admin list (default redacted):

```bash
curl -sS -X POST "<site-url>/qa-credentials/v1/admin/list" \
  -H "authorization: Bearer <maintainer-token>" \
  -H "content-type: application/json" \
  -d '{
    "kind":"telegram",
    "status":"all"
  }'
```

Admin remove (soft disable, fails when lease is active):

```bash
curl -sS -X POST "<site-url>/qa-credentials/v1/admin/remove" \
  -H "authorization: Bearer <maintainer-token>" \
  -H "content-type: application/json" \
  -d '{
    "credentialId":"<credential-id>",
    "actorId":"local-maintainer"
  }'
```
