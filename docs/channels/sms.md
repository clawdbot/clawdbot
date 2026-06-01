---
summary: "Twilio SMS channel setup, access controls, and webhook configuration"
read_when:
  - You want to connect OpenClaw to SMS through Twilio
  - You need SMS webhook or allowlist setup
title: "SMS"
---

OpenClaw can receive and send SMS through a Twilio phone number or Messaging Service. The Gateway registers an inbound webhook route, validates Twilio request signatures by default, and sends replies back through Twilio's Messages API.

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

- A Twilio account with an SMS-capable phone number, or a Twilio Messaging Service.
- The Twilio Account SID and Auth Token.
- A public HTTPS URL that reaches your OpenClaw Gateway.
- A sender policy choice: `pairing` for private use, `allowlist` for preapproved phone numbers, or `open` only for intentionally public SMS access.

Use one Twilio number for both SMS and Voice Call if the number has both capabilities. Configure the SMS webhook and Voice webhook separately in Twilio; this page only covers the SMS webhook.

## Quick Setup

<Steps>
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
    Your public URL must route the SMS path to the Gateway process. If you use Tailscale Funnel for local testing, expose `/webhooks/sms` explicitly:

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

Use env setup for single-account deployments where secrets come from the host environment:

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

`TWILIO_SMS_FROM` is accepted as an alias for `TWILIO_PHONE_NUMBER`. Use `TWILIO_MESSAGING_SERVICE_SID` instead of a phone-number sender when Twilio should choose the sender from a Messaging Service.

### SecretRef auth token

`authToken` can be a SecretRef. Use this when the Gateway should resolve the Twilio Auth Token from the OpenClaw secrets runtime instead of storing plaintext config:

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

### Allowlist-only private number

Use `allowlist` when only known phone numbers should be able to talk to the agent:

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

- `pairing` (default)
- `allowlist` (requires at least one sender in `allowFrom`)
- `open` (requires `allowFrom` to include `"*"`)
- `disabled`

`allowFrom` entries should be E.164 phone numbers such as `+15551234567`. `sms:` prefixes are accepted and normalized. For a private assistant, prefer `dmPolicy: "allowlist"` with explicit phone numbers.

## Sending SMS

Outbound SMS targets use the `sms:` service prefix with the SMS channel selected:

```bash
openclaw message send --channel sms --target sms:+15551234567 --message "hello"
```

When channel selection is implicit, `twilio-sms:+15551234567` selects this channel without taking over the existing channel-owned `sms:` service prefix used by iMessage.

```bash
openclaw message send --target twilio-sms:+15551234567 --message "hello"
```

The CLI requires an explicit `--target`. `defaultTo` is for automation and agent-initiated delivery paths where the target can be resolved from channel config.

Agent replies from inbound SMS conversations automatically go back to the sender through the configured Twilio sender.

SMS output is plain text. OpenClaw strips markdown, flattens fenced code blocks, preserves readable links, and chunks long replies before sending them through Twilio.

## Verify Setup

After the Gateway starts:

1. Confirm the Gateway log shows the SMS webhook route.
2. Run a Twilio-side probe:

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

By default, OpenClaw validates `X-Twilio-Signature` using `publicWebhookUrl` and `authToken`. Keep `publicWebhookUrl` byte-for-byte aligned with the URL configured in Twilio, including scheme, host, path, and query string.

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

Each account should use a distinct `webhookPath`.

## Troubleshooting

### Twilio returns 403 or OpenClaw rejects the webhook

Check that `publicWebhookUrl` exactly matches the URL configured in Twilio, including scheme, host, path, and query string. Twilio signs the public URL string, so proxy rewrites and alternate hostnames can break signature validation.

### No pairing request appears

Check the Twilio number's **Messaging** webhook URL and method. It must point to the SMS webhook URL and use `POST`. Also confirm the Gateway is reachable from the public internet or through your tunnel.

If the Twilio message log shows error `11200`, Twilio accepted the inbound SMS but could not reach your webhook. Check:

- Twilio **Messaging > A message comes in** points at `publicWebhookUrl`.
- The method is `POST`.
- The tunnel or reverse proxy exposes the exact `webhookPath`; for Tailscale Funnel, run `tailscale funnel status` and confirm `/webhooks/sms` is listed.
- `publicWebhookUrl` uses the same scheme, host, path, and query string Twilio sends, so signature validation can reproduce the signed URL.

### Outbound sends fail

Confirm `accountSid`, `authToken`, and either `fromNumber` or `messagingServiceSid` are resolved. If you use a trial Twilio account, the destination number may need to be verified in Twilio before outbound SMS will send.

### Messages arrive but the agent does not answer

Check `dmPolicy` and `allowFrom`. With the default `pairing` policy, the sender must be approved before normal agent turns are processed.
