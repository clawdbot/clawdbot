---
summary: "How session ownership and presence work when several people operate one agent"
read_when:
  - You share one OpenClaw agent with other operators
  - You need to understand session owner and presence indicators
  - You are deciding whether one shared agent provides enough isolation
title: "Multi-user mode"
---

Multi-user mode lets several trusted people operate the same OpenClaw agent. It adds session ownership, live presence, and creator filtering so a team can tell who started work and who is currently watching it.

## Trust boundary

Everyone who can operate an agent can make it do anything that agent can do. Session ownership, visibility in the sidebar, and presence indicators are usability features, not security boundaries.

If people must not access each other's sessions, tools, credentials, or files, give them separate agents or separate gateway/host trust boundaries. Do not rely on owner avatars or filters for isolation.

## Ownership and presence

New sessions record their creator when the Gateway has a trusted identity available. Trusted-proxy identity takes priority; otherwise OpenClaw uses the paired device's operator label or display name. Older sessions and sessions created without either identity have no owner stamp.

The web app keeps ownership and presence visually distinct:

- A solid owner avatar is permanent for the lifetime of that session.
- Ringed or translucent presence avatars show people who are currently connected or watching.
- The sidebar's person filter shows sessions created by one identity while preserving the existing custom groups.

When fewer than two distinct creators appear in the loaded session list, OpenClaw hides all ownership and person-filter chrome. A single-user gateway therefore looks unchanged.

## Turn attribution

Turn sender attribution is best-effort. Steering can merge input into an active turn, so the transcript cannot always represent each person's contribution as a separate turn.

## Related

- [The main session](/concepts/main-session)
- [Session management](/concepts/session)
- [Presence](/concepts/presence)
- [Gateway security](/gateway/security)
