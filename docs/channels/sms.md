---
summary: "Twilio SMS channel setup, access controls, and webhook configuration"
read_when:
  - You want to connect OpenClaw to SMS through Twilio
  - You need SMS webhook or allowlist setup
title: "SMS"
---

OpenClaw receives and sends SMS through a Twilio phone number or Messaging Service. The Gateway registers an inbound webhook route (default `/webhooks/sms`), validates Twilio request signatures by default, and sends replies back through Twilio's Messages API.

Status: official plugin, installed separately. Text only: no MMS/media, direct messages only.

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
- A Twilio account with an SMS-capable phone number, or a Twilio Messaging Service.
- The Twilio Account SID and Auth Token.
- A public HTTPS URL that reaches your OpenClaw Gateway.
- A sender policy choice: `pairing` (default) for private use, `allowlist` for preapproved phone numbers, or `open` only for intentionally public SMS access.

One Twilio number can serve both SMS and [Voice Call](/plugins/voice-call) if it has both capabilities. The SMS webhook and Voice webhook are configured separately in Twilio and use separate Gateway paths; this page only covers the SMS webhook.

## Quick Setup

<Steps>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install @openclaw/sms
    ```
  </Step>
  <Step title="Create or choose a Twilio sender">
    In Twilio, open **Phone Numbers > Manage > Active numbers** and choose an SMS-capable number. Save:

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
    Your public URL must route the SMS path to the Gateway process (default port `18789`). If you use Tailscale Funnel for local testing, expose `/webhooks/sms` explicitly:

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

| Key                                     | Default         | Purpose                                                             |
| --------------------------------------- | --------------- | ------------------------------------------------------------------- |
| `enabled`                               | `true`          | Enable or disable the channel/account.                              |
| `accountSid`                            | —               | Twilio Account SID (`AC...`).                                       |
| `authToken`                             | —               | Twilio Auth Token; plaintext string or SecretRef.                   |
| `fromNumber`                            | —               | E.164 sender number.                                                |
| `messagingServiceSid`                   | —               | Messaging Service SID (`MG...`) used when no `fromNumber` resolves. |
| `defaultTo`                             | —               | Default destination when a send flow omits an explicit target.      |
| `webhookPath`                           | `/webhooks/sms` | Gateway HTTP path for inbound Twilio webhooks.                      |
| `publicWebhookUrl`                      | —               | Public URL configured in Twilio; required for signature validation. |
| `dangerouslyDisableSignatureValidation` | `false`         | Skip `X-Twilio-Signature` checks; local tunnel testing only.        |
| `dmPolicy`                              | `"pairing"`     | `pairing`, `allowlist`, `open`, or `disabled`.                      |
| `allowFrom`                             | `[]`            | Allowed sender numbers in E.164, or `"*"` with `dmPolicy: "open"`.  |
| `textChunkLimit`                        | `1500`          | Maximum characters per outbound SMS chunk.                          |
| `accounts`, `defaultAccount`            | —               | Multi-account map and default account id.                           |

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

`authToken` can be a SecretRef (`source: "env" | "file" | "exec"`). Use this when the Gateway should resolve the Twilio Auth Token from the OpenClaw secrets runtime instead of storing plaintext config:

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

## Verify Setup

After the Gateway starts:

1. Confirm the Gateway log shows the SMS webhook route.
2. Run a Twilio-side probe (checks the configured Twilio webhook URL/method and recent inbound errors):

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
- Dispatchable callback rate limit of 30 accepted callbacks per minute per SMS account, webhook route, and validated sender after body parsing and signature validation pass (HTTP 429 above that). The sender key is the canonicalized, signature-covered `From` value, so equivalent SMS/RCS address forms share one budget, one flooding sender exhausts only its own budget, and callbacks from other senders behind Twilio's shared egress addresses remain dispatchable. Invalid or missing sender values share a separate empty-sender budget.
- Aggregate validated-callback ceiling of 300 accepted callbacks per minute per SMS account and webhook route. This bounds durable-ingress pressure from many distinct signed senders without recreating shared-egress cross-throttling. If signature validation is disabled, nothing authenticates `From`; the stricter 30/min resolved-client-address dispatch cap applies instead of the validated sender and aggregate policy.
- Client addresses are resolved through the shared Gateway trusted-proxy rules. If `gateway.trustedProxies` contains the reverse proxy that forwards Twilio callbacks, OpenClaw keys the address-based limits from the forwarded client address; otherwise it falls back to the direct socket address.
- The payload `AccountSid` must match the configured `accountSid`. The raw callback is first committed to the durable ingress queue and acknowledged; a mismatch is then marked as a permanent invalid-payload failure during drain and is never dispatched.
- Replayed `MessageSid` values are deduplicated by the durable ingress queue. Completed-message tombstones are retained for 24 hours (up to 20,000 entries per account); permanent-failure tombstones are retained for 30 days (up to 1,000 entries).
- Request bodies over 32 KB are rejected.

Twilio does not retry HTTP 429 by default. The `#rp=4xx` and `#rp=all` connection overrides opt into 4xx retries, but Twilio caps the complete retry transaction at 15 seconds. Configure a fallback URL when another handler must receive failed deliveries; treat a 429 as a fail-closed rejection, not reliable backpressure.

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

A 403 with `Invalid account` means the inbound payload's `AccountSid` does not match the configured `accountSid`; check that the webhook points at the account that owns the number.

### No pairing request appears

Check the Twilio number's **Messaging** webhook URL and method. It must point to the SMS webhook URL and use `POST`. Also confirm the Gateway is reachable from the public internet or through your tunnel.

If the Twilio message log shows error `11200`, Twilio accepted the inbound SMS but could not reach your webhook. Check:

- Twilio **Messaging > A message comes in** points at `publicWebhookUrl`.
- The method is `POST`.
- The tunnel or reverse proxy exposes the exact `webhookPath`; for Tailscale Funnel, run `tailscale funnel status` and confirm `/webhooks/sms` is listed.
- `publicWebhookUrl` uses the same scheme, host, path, and query string Twilio sends, so signature validation can reproduce the signed URL.

`openclaw channels status --channel sms --probe` surfaces both mismatched Twilio webhook settings and recent `11200` errors.

### Outbound sends fail

Confirm `accountSid`, `authToken`, and either `fromNumber` or `messagingServiceSid` are resolved. If you use a trial Twilio account, the destination number may need to be verified in Twilio before outbound SMS will send.

### Messages arrive but the agent does not answer

Check `dmPolicy` and `allowFrom`. With the default `pairing` policy, the sender must be approved before normal agent turns are processed.
