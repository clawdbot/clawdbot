---
summary: "Per-recipient Matrix push rules for quiet finalized preview edits"
read_when:
  - Setting up Matrix quiet streaming for self-hosted Synapse or Tuwunel
  - Users want notifications only on finished blocks, not on every preview edit
title: "Matrix push rules for quiet previews"
---

When `channels.matrix.streaming` is `"quiet"`, OpenClaw edits a single preview event in place and marks the finalized edit with a custom content flag. Matrix clients notify on the final edit only if a per-user push rule matches that flag. This page is for operators who self-host Matrix and want to install that rule for each recipient account.

If you only want stock Matrix notification behavior, use `streaming: "partial"` or leave streaming off. See [Matrix channel setup](/channels/matrix#streaming-previews).

## Prerequisites

- recipient user = the person who should receive the notification
- bot user = the OpenClaw Matrix account that sends the reply
- use the recipient user's access token for the API calls below
- match `sender` in the push rule against the bot user's full MXID
- the recipient account must already have working pushers — quiet preview rules only work when normal Matrix push delivery is healthy

## Steps

<Steps>
  <Step title="Configure quiet previews">

```json5
{
  channels: {
    matrix: {
      streaming: "quiet",
    },
  },
}
```

  </Step>

  <Step title="Get the recipient's access token">
    Reuse an existing client session token where possible. To mint a fresh one:

```bash
curl -sS -X POST \
  "https://matrix.example.org/_matrix/client/v3/login" \
  -H "Content-Type: application/json" \
  --data '{
    "type": "m.login.password",
    "identifier": { "type": "m.id.user", "user": "@alice:example.org" },
    "password": "REDACTED"
  }'
```

  </Step>

  <Step title="Verify pushers exist">

```bash
curl -sS \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  "https://matrix.example.org/_matrix/client/v3/pushers"
```

If no pushers come back, fix normal Matrix push delivery for this account before continuing.

  </Step>

  <Step title="Install the override push rule">
    OpenClaw marks finalized text-only preview edits with `content["com.openclaw.finalized_preview"] = true`. Install a rule that matches that marker plus the bot MXID as sender:

```bash
curl -sS -X PUT \
  "https://matrix.example.org/_matrix/client/v3/pushrules/global/override/openclaw-finalized-preview-botname" \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "conditions": [
      { "kind": "event_match", "key": "type", "pattern": "m.room.message" },
      {
        "kind": "event_property_is",
        "key": "content.m\\.relates_to.rel_type",
        "value": "m.replace"
      },
      {
        "kind": "event_property_is",
        "key": "content.com\\.openclaw\\.finalized_preview",
        "value": true
      },
      { "kind": "event_match", "key": "sender", "pattern": "@bot:example.org" }
    ],
    "actions": [
      "notify",
      { "set_tweak": "sound", "value": "default" },
      { "set_tweak": "highlight", "value": false }
    ]
  }'
```

    Replace before running:

    - `https://matrix.example.org`: your homeserver base URL
    - `$USER_ACCESS_TOKEN`: the recipient user's access token
    - `openclaw-finalized-preview-botname`: a rule ID unique per bot per recipient (pattern: `openclaw-finalized-preview-<botname>`)
    - `@bot:example.org`: your OpenClaw bot MXID, not the recipient's

  </Step>

  <Step title="Verify">

```bash
curl -sS \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  "https://matrix.example.org/_matrix/client/v3/pushrules/global/override/openclaw-finalized-preview-botname"
```

Then test a streamed reply. In quiet mode the room shows a quiet draft preview and notifies once the block or turn finishes.

  </Step>
</Steps>

To remove the rule later, `DELETE` the same rule URL with the recipient's token.

## Multi-bot notes

Push rules are keyed by `ruleId`: re-running `PUT` against the same ID updates a single rule. For multiple OpenClaw bots notifying the same recipient, create one rule per bot with a distinct sender match.

New user-defined `override` rules are inserted ahead of default suppress rules, so no extra ordering parameter is needed. The rule only affects text-only preview edits that can be finalized in place; media fallbacks and stale-preview fallbacks use normal Matrix delivery.

## Homeserver notes

<AccordionGroup>
  <Accordion title="Synapse">
    No special `homeserver.yaml` change is required. If normal Matrix notifications already reach this user, the recipient token + `pushrules` call above is the main setup step.

    If you run Synapse behind a reverse proxy or workers, make sure `/_matrix/client/.../pushrules/` reaches Synapse correctly. Push delivery is handled by the main process or `synapse.app.pusher` / configured pusher workers — ensure those are healthy.

    The rule uses the `event_property_is` push-rule condition (MSC3758, push rule v1.10), which was added to Synapse in 2023. Older Synapse releases accept the `PUT pushrules/...` call but silently never match the condition — upgrade Synapse if no notification arrives on a finalized preview edit.

  </Accordion>

  <Accordion title="Tuwunel">
    Same flow as Synapse; no Tuwunel-specific config is needed for the finalized preview marker.

    If notifications disappear while the user is active on another device, check whether `suppress_push_when_active` is enabled. Tuwunel added this option in 1.4.2 (September 2025) and it can intentionally suppress pushes to other devices while one device is active.

  </Accordion>
</AccordionGroup>

## Related

- [Matrix channel setup](/channels/matrix)
- [Streaming concepts](/concepts/streaming)
