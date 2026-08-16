---
summary: "Twilio SMS/MMS setup, access controls, webhooks, and delivery status"
read_when:
  - You want to connect OpenClaw to SMS or MMS through Twilio
  - You need SMS/MMS webhook or allowlist setup
title: "SMS"
---

OpenClaw receives and sends SMS/MMS through a Twilio phone number or Messaging Service. The Gateway registers a webhook route (default `/webhooks/sms`), validates Twilio request signatures by default, sends replies through Twilio's Messages API, and records outbound delivery callbacks.

Status: official plugin, installed separately. SMS text and MMS attachments, direct messages only.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Default DM policy for SMS is pairing.
  </Card>
  <Card title="Gateway security" icon="shield" href="/gateway/security">
    Review webhook exposure and sender access controls.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Cross-channel diagnostics and repair playbooks.
  </Card>
</CardGroup>

## Before you begin

You need:

- The official SMS plugin installed with `openclaw plugins install @openclaw/sms`.
- A Twilio account with an SMS-capable phone number, or a Twilio Messaging Service. MMS requires an MMS-capable sender; native MMS delivery also depends on the destination country and carrier.
- The Twilio Account SID and Auth Token.
- A public HTTPS URL that reaches your OpenClaw Gateway.
- A sender policy choice: `pairing` (default) for private use, `allowlist` for preapproved phone numbers, or `open` only for intentionally public SMS access.

One Twilio number can serve both SMS and [Voice Call](/plugins/voice-call) if it has both capabilities. The SMS webhook and Voice webhook are configured separately in Twilio and use separate Gateway paths; this page only covers the SMS webhook.

## US A2P / 10DLC delivery

SMS and MMS sent by an application from a US local 10DLC number to US recipients require US A2P 10DLC registration. Toll-free numbers and short codes use separate verification processes. This is separate from OpenClaw channel setup: webhook signature validation, pairing, and outbound credentials can all be correct while carriers still block or filter delivery.

Before relying on a US 10DLC sender, confirm in Twilio that:

- The account is paid; Twilio trial accounts cannot register for A2P 10DLC.
- A Primary or Secondary Compliance Profile is approved in Twilio Trust Hub.
- The Brand and Campaign are registered and approved.
- The Twilio phone number has A2P status `REGISTERED` and is in the Sender Pool of the Messaging Service associated with the approved Campaign, or the `messagingServiceSid` you configure here is that approved service.
- The Campaign describes the real OpenClaw message use case and includes matching sample messages.
- Every website, keyword, offline, paper, or QR-code opt-in path is described completely. If the flow is not publicly visible, provide publicly accessible screenshots or other evidence.
- Messaging consent is voluntary and separate from required service terms, account creation, or purchase, with the privacy policy, terms, frequency, rates, and opt-out disclosures Twilio requires.
- You retain proof of consent, identify the sender, honor standard one-step opt-out keywords, and do not buy, rent, sell, or transfer consent. After an opt-out, send only one confirmation unless the recipient opts in again.

Use Twilio as the source of truth for current requirements: [A2P 10DLC overview](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc), [registration quickstart](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart), and [required business and campaign information](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/collect-business-info). This section is setup guidance, not legal advice.

If Twilio rejects the Brand or Campaign during registration review, fix that in Twilio before using the sender with OpenClaw. [`30909`](https://www.twilio.com/docs/api/errors/30909) means the message flow or call to action is incomplete or unverifiable. [`30923`](https://www.twilio.com/docs/api/errors/30923) means messaging consent is required as a condition of service, account creation, or purchase, or is bundled with service terms. [`30893`](https://www.twilio.com/docs/api/errors/30893) means the sample messages do not match the declared use case.

## Quick Setup

<Steps>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install @openclaw/sms
    ```
  </Step>
  <Step title="Create or choose a Twilio sender">
    In Twilio, open **Phone Numbers > Manage > Active numbers** and choose an SMS-capable number. To send attachments, choose one that is also MMS-capable. Save:

    - Account SID, for example `ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
    - Auth Token
    - Sender phone number, for example `+15551234567`

    If you use a Messaging Service instead of a fixed sender number, save the Messaging Service SID, for example `MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.

  </Step>

  <Step title="Configure the SMS channel">

Save this as `sms.patch.json5` and change the placeholders:

```json5
{
  channels: {
    sms: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio-auth-token",
      fromNumber: "+15551234567",
      publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
      dmPolicy: "pairing",
    },
  },
}
```

Apply it:

```bash
openclaw config patch --file ./sms.patch.json5 --dry-run
openclaw config patch --file ./sms.patch.json5
```

  </Step>

  <Step title="Point Twilio at the Gateway webhook">
    In the Twilio phone number settings, open **Messaging** and set **A message comes in** to:

```text
https://gateway.example.com/webhooks/sms
```

    Use HTTP `POST`. The default local path is `/webhooks/sms`; change `channels.sms.webhookPath` if you need a different route.

  </Step>

  <Step title="Expose the exact SMS webhook path">
    Your public URL must route the SMS path to the Gateway process (default port `18789`). The same path serves inbound Twilio webhooks and short-lived, tokenized attachments when OpenClaw sends MMS. If you use Tailscale Funnel for local testing, expose `/webhooks/sms` explicitly:

```bash
tailscale funnel --bg --set-path /webhooks/sms http://127.0.0.1:<gateway-port>/webhooks/sms
tailscale funnel status
```

    Voice Call and SMS use separate webhook paths. If the same Twilio number handles both, keep both routes configured in Twilio and in your tunnel.

  </Step>

  <Step title="Start the Gateway and approve first sender">

```bash
openclaw gateway
```

Send a text message to the Twilio number. The first message creates a pairing request. Approve it:

```bash
openclaw pairing list sms
openclaw pairing approve sms <CODE>
```

    Pairing codes expire after 1 hour.

  </Step>
</Steps>

## Configuration Examples

All keys live under `channels.sms` (and per account under `channels.sms.accounts.<id>`):

| Key                                     | Default         | Purpose                                                                                |
| --------------------------------------- | --------------- | -------------------------------------------------------------------------------------- |
| `enabled`                               | `true`          | Enable or disable the channel/account.                                                 |
| `accountSid`                            | —               | Twilio Account SID (`AC...`).                                                          |
| `authToken`                             | —               | Twilio Auth Token; plaintext string or SecretRef.                                      |
| `fromNumber`                            | —               | E.164 sender number.                                                                   |
| `messagingServiceSid`                   | —               | Messaging Service SID (`MG...`) used when no `fromNumber` resolves.                    |
| `defaultTo`                             | —               | Default destination when a send flow omits an explicit target.                         |
| `webhookPath`                           | `/webhooks/sms` | Gateway HTTP path for inbound Twilio webhooks.                                         |
| `publicWebhookUrl`                      | —               | Public Twilio webhook URL; required for signature validation and outbound MMS hosting. |
| `dangerouslyDisableSignatureValidation` | `false`         | Skip `X-Twilio-Signature` checks; local tunnel testing only.                           |
| `dmPolicy`                              | `"pairing"`     | `pairing`, `allowlist`, `open`, or `disabled`.                                         |
| `allowFrom`                             | `[]`            | Allowed sender numbers in E.164, or `"*"` with `dmPolicy: "open"`.                     |
| `textChunkLimit`                        | `1500`          | Maximum characters per outbound SMS chunk.                                             |
| `accounts`, `defaultAccount`            | —               | Multi-account map and default account id.                                              |

### Config file

Use config-file setup when you want the channel definition to travel with the Gateway config:

```json5
{
  channels: {
    sms: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio-auth-token",
      fromNumber: "+15551234567",
      publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
      dmPolicy: "pairing",
    },
  },
}
```

### Environment variables

Environment variables apply to the default account only; config values take precedence over env values.

| Variable                                        | Maps to                                            |
| ----------------------------------------------- | -------------------------------------------------- |
| `TWILIO_ACCOUNT_SID`                            | `accountSid`                                       |
| `TWILIO_AUTH_TOKEN`                             | `authToken`                                        |
| `TWILIO_PHONE_NUMBER` (alias `TWILIO_SMS_FROM`) | `fromNumber`                                       |
| `TWILIO_MESSAGING_SERVICE_SID`                  | `messagingServiceSid`                              |
| `SMS_PUBLIC_WEBHOOK_URL`                        | `publicWebhookUrl`                                 |
| `SMS_WEBHOOK_PATH`                              | `webhookPath`                                      |
| `SMS_ALLOWED_USERS`                             | `allowFrom` (comma-separated)                      |
| `SMS_TEXT_CHUNK_LIMIT`                          | `textChunkLimit`                                   |
| `SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION`  | `dangerouslyDisableSignatureValidation` (`"true"`) |

```bash
export TWILIO_ACCOUNT_SID="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export TWILIO_AUTH_TOKEN="<twilio-auth-token>"
export TWILIO_PHONE_NUMBER="+15551234567"
export SMS_PUBLIC_WEBHOOK_URL="https://gateway.example.com/webhooks/sms"
```

Then enable the channel in config:

```json5
{
  channels: {
    sms: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

### SecretRef auth token

`authToken` can be a SecretRef (`source: "env" | "file" | "exec" | "store"`). Use this when the Gateway should resolve the Twilio Auth Token from the OpenClaw secrets runtime instead of storing plaintext config:

```json5
{
  channels: {
    sms: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: { source: "env", provider: "default", id: "TWILIO_AUTH_TOKEN" },
      fromNumber: "+15551234567",
      publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
      dmPolicy: "pairing",
    },
  },
}
```

The referenced environment variable or secret provider must be visible to the Gateway runtime. Restart managed Gateway processes after changing host environment variables.

### Messaging Service sender

Use `messagingServiceSid` instead of `fromNumber` when Twilio should choose the sender through a Messaging Service:

```json5
{
  channels: {
    sms: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio-auth-token",
      messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
      dmPolicy: "pairing",
    },
  },
}
```

If both `fromNumber` and `messagingServiceSid` are present after config and env resolution, `fromNumber` is used.

### Default outbound target

Set `defaultTo` when automation or agent-initiated delivery should have a default destination if a send flow omits an explicit target:

```json5
{
  channels: {
    sms: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio-auth-token",
      fromNumber: "+15551234567",
      defaultTo: "+15557654321",
      publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
    },
  },
}
```

## Access control

`channels.sms.dmPolicy` controls direct SMS access:

- `pairing` (default): unknown senders get a pairing code; approve with `openclaw pairing approve sms <CODE>`.
- `allowlist`: only senders in `allowFrom` are processed. An empty `allowFrom` rejects every sender (the Gateway logs a startup warning).
- `open`: config validation requires `allowFrom` to include `"*"`. Without the wildcard, only listed numbers can chat.
- `disabled`: all inbound DMs are dropped.

`allowFrom` entries should be E.164 phone numbers such as `+15551234567`. `sms:` and `twilio-sms:` prefixes are accepted and normalized. For a private assistant, prefer `dmPolicy: "allowlist"` with explicit phone numbers:

```json5
{
  channels: {
    sms: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio-auth-token",
      fromNumber: "+15551234567",
      publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
      dmPolicy: "allowlist",
      allowFrom: ["+15557654321"],
    },
  },
}
```

## Sending SMS

With the SMS channel selected, targets accept bare E.164 numbers or the `sms:` prefix:

```bash
openclaw message send --channel sms --target sms:+15551234567 --message "hello"
```

When channel selection is implicit, the `twilio-sms:` prefix selects this channel without taking over the `sms:` service prefix, which iMessage uses to pick carrier SMS delivery for its own targets:

```bash
openclaw message send --target twilio-sms:+15551234567 --message "hello"
```

The CLI requires an explicit `--target`. `defaultTo` is for automation and agent-initiated delivery paths where the target can be resolved from channel config.

Agent replies from inbound SMS conversations automatically go back to the sender through the configured Twilio sender.

SMS output is plain text. OpenClaw strips markdown, flattens fenced code blocks, rewrites links as `label (url)`, and splits long replies into chunks of at most `textChunkLimit` characters (default 1500) before sending them through Twilio.

### Sending MMS

Use the normal structured media field or the CLI `--media` option:

```bash
openclaw message send \
  --channel sms \
  --target sms:+15551234567 \
  --message "photo" \
  --media ./photo.jpg
```

OpenClaw loads the attachment through the shared outbound-media policy, stores it temporarily in plugin-scoped SQLite state, and gives Twilio a tokenized HTTPS URL on the configured `publicWebhookUrl` path. Media-only sends are supported.

The generated media URL is a bearer capability that expires after 10 minutes. Treat its full query string as a secret: configure reverse-proxy and access logs to omit the query string or redact every query value. OpenClaw Gateway route diagnostics record only the pathname, but cannot control upstream proxy logs.

Outbound OpenClaw deliveries attach one media item. OpenClaw caps JPEG, JPG, PNG, and GIF attachments at 5,000,000 bytes; other supported media types are capped at 500,000 bytes. `application/vcard` attachments must be media-only; Twilio does not accept them with a caption. Destination carriers may enforce smaller limits or reject unsupported formats. Twilio must be able to fetch the generated URL without HTTP authentication, so `publicWebhookUrl` cannot contain embedded userinfo; query-based reverse-proxy tokens are preserved.

For incoming MMS, OpenClaw processes at most 10 attachments and downloads at most 5 MiB total. Any additional or unavailable attachments produce a visible unavailable-media notice instead of discarding the signed message or silently delivering an empty turn. Downloads happen only after sender authorization, with Twilio authentication and an `api.twilio.com` host restriction.

### Delivery status

After each successful outbound send, OpenClaw stores the initial Twilio API status when the response includes one. When `publicWebhookUrl` is valid, every outbound message also gives Twilio a derived `StatusCallback` URL that preserves its base URL and connection overrides while adding the required delivery-callback retry settings. Invalid or oversized derived URLs are omitted.

Later delivery callbacks update the same plugin-scoped SQLite record. Semantic retries are deduplicated, older transitions cannot regress a terminal state, and conflicting terminal observations are reported as `conflicted` instead of choosing a false winner. Records contain message SIDs, status/error metadata, and timestamps, but not message bodies or phone-number addresses. Each record is retained for up to 30 days after its latest observation, subject to the plugin-wide 5,000-message cap and oldest-record eviction.

## Verify Setup

After the Gateway starts:

1. Confirm the Gateway log shows the SMS webhook route.
2. Run a Twilio-side probe (checks the configured Twilio webhook URL/method, recent inbound errors, and the most recent stored outbound delivery state):

```bash
openclaw channels capabilities --channel sms
openclaw channels status --channel sms --probe --json
```

3. Send an SMS to the Twilio number from your phone.
4. Run `openclaw pairing list sms`.
5. Approve the pairing code with `openclaw pairing approve sms <CODE>`.
6. Send another SMS and confirm the agent replies.

For outbound-only testing, use:

```bash
openclaw message send --channel sms --target sms:+15557654321 --message "OpenClaw SMS test"
```

### End-to-end test from macOS iMessage/SMS

On a Mac that can send carrier SMS through Messages, you can use `imsg` to drive the sender side without touching your phone:

```bash
imsg send --to "+15551234567" --service sms --text "OpenClaw SMS E2E $(date -u +%Y%m%dT%H%M%SZ)" --json
openclaw pairing list sms
openclaw pairing approve sms <CODE>
imsg send --to "+15551234567" --service sms --text "reply exactly SMS pong" --json
```

The first message should create a pairing request. The second message should receive the agent reply through Twilio.

## Webhook security

By default, OpenClaw validates `X-Twilio-Signature` using `publicWebhookUrl` and `authToken`. Keep the endpoint portion of `publicWebhookUrl` byte-for-byte aligned with the URL configured in Twilio, including scheme, host, path, and query string. OpenClaw excludes Twilio [connection-override](https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides) fragments (`#...`) from signature computation, as Twilio requires.

The webhook route also enforces, independent of signature validation:

- `POST` only.
- Failed-request budget of 300 requests per minute per SMS account, webhook route, and resolved client address. All requests count toward this budget, but HTTP 429 is applied only after body parsing or Twilio signature validation fails.
- Signed delivery callbacks are classified before inbound sender quotas and commit to bounded, plugin-scoped SQLite state before HTTP 200. They do not consume inbound dispatch quotas: those quotas protect raw inbound message admission and downstream agent dispatch. Delivery persistence instead has a separate 3,000-callback-per-minute safety fuse per SMS account route and returns HTTP 503 without the durable-acceptance marker above that limit. This is fail-closed overload protection, not lossless backpressure. With signature validation disabled, delivery callbacks first use the stricter 30/minute resolved-client-address cap before persistence.
- Dispatchable callback rate limit of 30 accepted callbacks per minute per SMS account, webhook route, and validated sender after body parsing and signature validation pass (HTTP 429 above that). The sender key is the canonicalized, signature-covered `From` value, so equivalent SMS/RCS address forms share one budget, one flooding sender exhausts only its own budget, and callbacks from other senders behind Twilio's shared egress addresses remain dispatchable. Invalid or missing sender values share a separate empty-sender budget.
- Aggregate validated-callback ceiling of 300 accepted callbacks per minute per SMS account and webhook route. This bounds durable-ingress pressure from many distinct signed senders without recreating shared-egress cross-throttling. If signature validation is disabled, nothing authenticates `From`; the stricter 30/min resolved-client-address dispatch cap applies instead of the validated sender and aggregate policy.
- Client addresses are resolved through the shared Gateway trusted-proxy rules. If `gateway.trustedProxies` contains the reverse proxy that forwards Twilio callbacks, OpenClaw keys the address-based limits from the forwarded client address; otherwise it falls back to the direct socket address.
- Inbound payloads must carry a nonempty `AccountSid` that exactly matches the configured `accountSid`. Direct-number callbacks must target the configured `fromNumber`; Messaging Service callbacks must carry the configured `MessagingServiceSid`. The raw callback is first committed to the durable ingress queue and acknowledged; an identity mismatch is then marked as a permanent invalid-payload failure during drain and is never dispatched or allowed to download media.
- Delivery callbacks with a missing or different `AccountSid` are acknowledged, logged, and intentionally not stored.
- Replayed `MessageSid` values are deduplicated by the durable ingress queue. Completed-message tombstones are retained for 24 hours (up to 20,000 entries per account); permanent-failure tombstones are retained for 30 days (up to 1,000 entries).
- Delivery observations use a semantic, non-PII fingerprint of source, message SID, normalized status, error code, and carrier completion date. Multiple states for one outbound message remain distinct. Records expire 30 days after their latest observation, while the 5,000-message cap can evict older records sooner.
- Request bodies over 32 KB are rejected.

OpenClaw adds the `5xx` retry policy and a retry count to generated delivery `StatusCallback` URLs so Twilio can retry a failed SQLite commit or an overloaded delivery-state route. Twilio does not retry HTTP 429 by default. The `#rp=4xx` and `#rp=all` connection overrides opt into 4xx retries, but Twilio caps the complete retry transaction at 15 seconds. Neither a 429 nor a delivery-state 503 guarantees later recovery; use reconciliation when final-state completeness matters. Missed intermediate transitions cannot be reconstructed.

For completeness-sensitive workflows, persist Message SIDs and reconcile stale nonterminal records by polling Twilio's Message resource. Twilio's [delivery logging guidance](https://www.twilio.com/docs/messaging/guides/outbound-message-logging) recommends polling when a message has not reached `delivered` or `undelivered` within 12 hours because a status callback may not have arrived. The SMS fallback URL is not a substitute: it only handles failures retrieving or executing the [inbound SMS TwiML webhook](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource).

For local tunnel testing only, you can set:

```json5
{
  channels: {
    sms: {
      dangerouslyDisableSignatureValidation: true,
    },
  },
}
```

Do not use disabled signature validation on a public Gateway.

## Multi-account config

Use `accounts` when you operate more than one Twilio number:

```json5
{
  channels: {
    sms: {
      accounts: {
        support: {
          enabled: true,
          accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          authToken: "twilio-auth-token",
          fromNumber: "+15551234567",
          publicWebhookUrl: "https://gateway.example.com/webhooks/sms/support",
          webhookPath: "/webhooks/sms/support",
          dmPolicy: "allowlist",
          allowFrom: ["+15557654321"],
        },
      },
    },
  },
}
```

Each account must use a distinct `webhookPath`; the Gateway refuses to register a webhook route whose path is already owned by another account. `TWILIO_*`/`SMS_*` environment fallbacks apply only to the default account; set `defaultAccount` to change which account that is.

## Troubleshooting

### Twilio returns 403 or OpenClaw rejects the webhook

Check that `publicWebhookUrl` exactly matches the URL configured in Twilio, including scheme, host, path, and query string. Twilio signs the public URL string, so proxy rewrites and alternate hostnames can break signature validation.

If Twilio receives a durable acknowledgement but no pairing request appears, check the Gateway log for a permanent invalid-payload failure. Confirm the callback's `AccountSid` and `To` match the configured account and `fromNumber`, or that its `MessagingServiceSid` matches the configured Messaging Service.

### No pairing request appears

Check the Twilio number's **Messaging** webhook URL and method. It must point to the SMS webhook URL and use `POST`. Also confirm the Gateway is reachable from the public internet or through your tunnel.

If the Twilio message log shows error `11200`, Twilio accepted the inbound SMS but could not reach your webhook. Check:

- Twilio **Messaging > A message comes in** points at `publicWebhookUrl`.
- The method is `POST`.
- The tunnel or reverse proxy exposes the exact `webhookPath`; for Tailscale Funnel, run `tailscale funnel status` and confirm `/webhooks/sms` is listed.
- `publicWebhookUrl` uses the same scheme, host, path, and query string Twilio sends, so signature validation can reproduce the signed URL.

`openclaw channels status --channel sms --probe` surfaces both mismatched Twilio webhook settings and recent `11200` errors.

### Outbound sends fail

Confirm `accountSid`, `authToken`, and either `fromNumber` or `messagingServiceSid` are resolved. Twilio trial accounts can send only to verified recipients in the account's sign-up country and must use Twilio's predefined content; custom SMS bodies are not supported. Trial accounts also cannot register for A2P 10DLC, so upgrade before registering a US 10DLC sender.

### Twilio accepts the send but delivery later fails

Start with OpenClaw's stored delivery observation:

```bash
openclaw channels status --channel sms --probe --json
```

If the recent outbound status is `failed` or `undelivered`, use its `messageSid` to inspect the final Message status and error code in Twilio. [`30034`](https://www.twilio.com/docs/api/errors/30034) means the sender is unregistered or is not in the Sender Pool of the Messaging Service associated with the approved Campaign. [`30035`](https://www.twilio.com/docs/api/errors/30035) means Twilio is still registering, deregistering, or reassigning the number; wait until its status is `REGISTERED` before sending.

### Messages arrive but the agent does not answer

Check `dmPolicy` and `allowFrom`. With the default `pairing` policy, the sender must be approved before normal agent turns are processed.
