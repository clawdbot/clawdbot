---
name: facetime
description: "Inspect FaceTime internal stages, place an approved call to a configured owner handle, and request hangup through facetime_call."
metadata:
  { "openclaw": { "emoji": "📞", "requires": { "config": ["plugins.entries.facetime.enabled"] } } }
allowed-tools: facetime_call
---

# FaceTime

Use only `facetime_call`. Do not use shell commands or another call tool.

- Use `get_status` or `check_readiness` for read-only inspection. Report the
  returned fields as internal stages. Never infer that a remote participant
  answered, heard audio, or can hear audio from readiness flags.
- Use `initiate_call` only for the exact owner handle the user requested.
  Default to `audio`; use `video` only on an explicit request. OpenClaw obtains
  one-shot approval before dialing.
- Report only the returned `pending` or `ringing` state. Do not invent a later
  carrier state.
- Use `end_call` to request hangup. A successful tool result means the request
  entered the carrier lifecycle; report stronger closure only when a later
  status result contains no active or pending call.
- If a call or dial is already present, do not start another.
- Never install/update/uninstall the driver, change SIP or developer-tools
  policy, grant permissions, edit `ownerHandles`, or operate System Settings.
  Those are explicit operator-admin actions.
