---
summary: "Copy/paste Gateway configurations that keep the deployment private, paired, and tool-restricted"
read_when:
  - Setting up a new Gateway and wanting a safe starting config
  - Tightening an existing deployment back toward defaults
title: "Hardened baselines"
---

## Hardened baseline in 60 seconds

```json5
{
  gateway: {
    mode: "local",
    bind: "loopback",
    auth: { mode: "token", token: "replace-with-long-random-token" },
  },
  session: {
    dmScope: "per-channel-peer",
  },
  tools: {
    profile: "messaging",
    deny: ["group:automation", "group:runtime", "group:fs", "sessions_spawn", "sessions_send"],
    fs: { workspaceOnly: true },
    exec: { security: "deny", ask: "always" },
    elevated: { enabled: false },
    sessions: { visibility: "agent" },
    agentToAgent: { enabled: false },
  },
  channels: {
    whatsapp: { dmPolicy: "pairing", groups: { "*": { requireMention: true } } },
  },
}
```

Keeps the Gateway local-only, isolates DMs, limits session tools to the agent's own sessions, turns off ordinary cross-agent access, and disables control-plane/runtime tools by default. Re-enable tools selectively per trusted agent from there.

Built-in baseline for chat-driven agent turns: non-owner senders cannot use the `cron` or `gateway` tools regardless of config.

### Requester-scoped controls and prompt context

`tools.toolsBySender`, sender ownership, and owner-only tool inventories are evaluated against the current turn's originating requester. They do not authenticate or sanitize other content in that model prompt, including quoted text, prior shared-room history, forwarded content, fetched content, attachments, tool results, or other prompt inputs. Content from another person can therefore influence an owner-triggered turn when it is included in that turn's context.

Treat these controls as defense in depth that reduces direct capability for a requester, not as hostile multi-user isolation. Use `contextVisibility` to filter supported channel-supplied context, restrict tools and sandbox the agent, and use separate gateways and ideally separate OS users or hosts when participants are mutually adversarial.

## Secure baseline (copy/paste)

```json5
{
  gateway: {
    mode: "local",
    bind: "loopback",
    port: 18789,
    auth: { mode: "token", token: "your-long-random-token" },
  },
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

Keeps the Gateway private, requires DM pairing, and gates group replies behind a mention. Groups are fully supported - sender identity is threaded through to the agent, and per-group settings let one room run different defaults than another - so the goal here is scoping the agent's attention, not avoiding groups. For safer tool execution too, add a sandbox + deny dangerous tools for any non-owner agent (see [Per-agent access profiles](/gateway/security/tool-permissions#per-agent-access-profiles-multi-agent)).

### Separate numbers (WhatsApp, Signal, Telegram)

For phone-number-based channels, consider running the assistant on a separate number from your personal one, so personal conversations stay private and the bot number handles automation with its own boundaries.
