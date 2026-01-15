---
summary: "CLI reference for `clawdbot voicecall` (voice-call plugin command surface)"
read_when:
  - You use the voice-call plugin and want the CLI entry points
  - You want quick examples for `voicecall call|continue|status|tail|expose`
---

# `clawdbot voicecall`

`voicecall` is a plugin-provided command. It only appears if the voice-call plugin is installed and enabled.

Primary doc:
- Voice-call plugin: [Voice Call](/plugins/voice-call)

## Common commands

```bash
clawdbot voicecall status --call-id <id>
clawdbot voicecall call --to "+15555550123" --message "Hello" --mode notify
clawdbot voicecall continue --call-id <id> --message "Any questions?"
clawdbot voicecall end --call-id <id>
```

## Exposing webhooks (Tailscale)

```bash
clawdbot voicecall expose --mode serve
clawdbot voicecall expose --mode funnel
clawdbot voicecall unexpose
```

Security note: only expose the webhook endpoint to networks you trust. Prefer Tailscale Serve over Funnel when possible.

