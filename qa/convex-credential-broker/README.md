# QA Convex Credential Broker (v1)

Standalone Convex project for shared `qa-lab` live credentials with lease locking.
Keep private operator notes in `~/Projects/manager/docs/`, not in public docs.

This broker exposes:

- `POST /qa-credentials/v1/acquire`
- `POST /qa-credentials/v1/payload-chunk`
- `POST /qa-credentials/v1/heartbeat`
- `POST /qa-credentials/v1/release`
- `POST /qa-credentials/v1/admin/add`
- `POST /qa-credentials/v1/admin/remove`
- `POST /qa-credentials/v1/admin/list`
- `POST /qa-credentials/v1/admin/telegram-fixtures`

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
  --kind buzz \
  --payload-file qa/buzz-credential.json

pnpm openclaw qa credentials add \
  --kind discord \
  --payload-file qa/discord-credential.json

pnpm openclaw qa credentials add \
  --kind telegram \
  --payload-file qa/telegram-credential.json

pnpm openclaw qa credentials list --kind telegram

pnpm openclaw qa credentials remove --credential-id <credential-id>
```

Admin endpoints require `OPENCLAW_QA_CONVEX_SECRET_MAINTAINER`.

## Update persistent Telegram fixtures

After verifying a dedicated normal group and forum group with the QA user and
SUT bot, call `POST /qa-credentials/v1/admin/telegram-fixtures` with the
maintainer bearer secret and this JSON body:

```json
{
  "credentialId": "<existing-credential-id>",
  "actorId": "local-maintainer",
  "sutBotId": "123",
  "testerUserId": "456",
  "expectedGroupId": "-123",
  "groupId": "-456",
  "forumGroupId": "-100789"
}
```

Include `expectedForumGroupId` when the current payload has a forum reference.
The operation accepts only active `telegram-test-userbot` credentials with
schema version 1 and environment `test`. Both new references must be distinct
negative group IDs. The caller verifies actual Telegram group types,
membership and topic permissions before publishing these references.

The broker compares the expected bot, tester and current references inside the
same transaction that updates storage. A live lease returns `LEASE_ACTIVE`;
changed references return `FIXTURE_CONFLICT`; changed identities return
`IDENTITY_MISMATCH`. Read the current record and resolve the conflict before
trying a changed request. The operation never replaces or enables a credential.

Successful responses contain `status: "ok"`, `changed` and a redacted
credential summary. Matching current references produce `changed: false`.
As with the other broker operations, inspect the JSON status even for HTTP 200.
Authentication and request-validation errors use HTTP 401/403 and 400.

Only the logical `groupId` and `forumGroupId` payload fields change. Large
payloads are repacked atomically through the existing chunk format; their
session archives and other logical values remain unchanged. Row identity,
status, notes and lease-selection history are preserved. Disabled and
untargeted records and chunks are untouched. Normal lease consumers receive
the updated pair without a new payload protocol.

## Synthetic broker tests

The HTTP integration suite uses a disposable anonymous local Convex backend,
never a cloud deployment or pool credentials. In a fresh copy of this folder:

```bash
npm install
CONVEX_AGENT_MODE=anonymous npx convex dev --once --tail-logs disable --start \
  'npx convex env set OPENCLAW_QA_CONVEX_SECRET_MAINTAINER synthetic-maintainer && npx convex env set OPENCLAW_QA_CONVEX_SECRET_CI synthetic-ci && npm test'
```

Inspect the Node test result as well as the outer CLI exit status. The suite
covers inline/chunked round trips, authorization, conflicts, active leases,
concurrent acquisition, no-op updates and preservation of untargeted records.
Delete the disposable backend state after retaining the test output.

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

For `kind: "telegram-test-userbot"`, broker `admin/add` accepts only Test
Server schema version 1 with numeric chat, bot, and tester ids; a bot token and
username; a base64 TDLib archive and SHA-256 hash; and a TDLib version.

For `kind: "buzz"`, broker `admin/add` validates that payload includes:

- `relayUrl` as a `wss://` URL, or `ws://` only for a loopback relay
- `roomId` as a channel UUID
- valid, distinct `driverPrivateKey` and `sutPrivateKey` values in nsec or
  64-character hex form
- optional `driverAuthTag` and `sutAuthTag` values matching the four-string
  Buzz authorization tag JSON shape

Use dedicated QA identities only. Never add a human owner or admin private key
to the shared pool.

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
