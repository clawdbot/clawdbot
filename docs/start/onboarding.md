---
summary: "First-run setup flow for OpenClaw (macOS app)"
read_when:
  - Designing the macOS onboarding assistant
  - Implementing auth or identity setup
title: "Onboarding (macOS app)"
sidebarTitle: "Onboarding: macOS App"
---

This doc describes the **current** first‑run setup flow. The goal is a
smooth “day 0” experience: pick where the Gateway runs, connect auth, run the
wizard, and let the agent bootstrap itself.
For a general overview of onboarding paths, see [Onboarding Overview](/start/onboarding-overview).

<Steps>
<Step title="Approve macOS warning">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Approve find local networks">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Welcome and security notice">
<Frame caption="Read the security notice displayed and decide accordingly">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>

Security trust model:

- By default, OpenClaw is a personal agent: one trusted operator boundary.
- Shared/multi-user setups require lock-down (split trust boundaries, keep tool access minimal, and follow [Security](/gateway/security)).
- Local onboarding now defaults new configs to `tools.profile: "coding"` so fresh local setups keep filesystem/runtime tools without forcing the unrestricted `full` profile.
- If hooks/webhooks or other untrusted content feeds are enabled, use a strong modern model tier and keep strict tool policy/sandboxing.

</Step>
<Step title="Local vs Remote">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

Where does the **Gateway** run?

- **This Mac (Local only):** onboarding can configure auth and write credentials
  locally.
- **Remote (over SSH/Tailnet):** onboarding does **not** configure local auth;
  credentials must exist on the gateway host.
- **Configure later:** skip setup and leave the app unconfigured.

<Tip>
**Gateway auth tip:**

- The wizard now generates a **token** even for loopback, so local WS clients must authenticate.
- If you disable auth, any local process can connect; use that only on fully trusted machines.
- Use a **token** for multi‑machine access or non‑loopback binds.

</Tip>
</Step>
<Step title="Permissions">
<Frame caption="Choose what permissions do you want to give OpenClaw">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

Onboarding requests TCC permissions needed for:

- Automation (AppleScript)
- Notifications
- Accessibility
- Screen Recording
- Microphone
- Speech Recognition
- Camera
- Location

</Step>
<Step title="CLI">
  <Info>This step is optional</Info>
  The app can install the global `openclaw` CLI via npm, pnpm, or bun.
  It prefers npm first, then pnpm, then bun if that is the only detected
  package manager. For the Gateway runtime, Node remains the recommended path.
</Step>
<Step title="Onboarding Chat (dedicated session)">
  After setup, the app opens a dedicated onboarding chat session so the agent can
  introduce itself and guide next steps. This keeps first‑run guidance separate
  from your normal conversation. See [Bootstrapping](/start/bootstrapping) for
  what happens on the gateway host during the first agent run.
</Step>
</Steps>

## Related

- [Onboarding overview](/start/onboarding-overview)
- [Getting started](/start/getting-started)
