---
summary: "Route channel accounts and conversations to the right OpenClaw agent"
title: "Agent bindings"
read_when:
  - Routing channel accounts to different agents
  - Sending one conversation to a specialized agent
  - Deciding whether the default agent is sufficient
---

When a message arrives on a channel, OpenClaw has to decide which agent answers it. By default that is easy: the agent marked `default: true` gets everything. An agent binding overrides that decision for a slice of your traffic — each binding names an `agentId` and matches channel facts such as the account, peer, guild, team, or Discord roles, and the matched agent owns the resulting session.

Bindings only pick the agent. They do not create channel accounts and they do not grant access — a binding is consulted only after the channel has already accepted the message through its normal pairing, allowlist, and account rules.

## When to use a binding

If every conversation can share one workspace, one model policy, and one session boundary, you do not need bindings — the default agent is the right answer. Reach for bindings when you want a stable split, for example:

- one channel account per agent
- a support inbox routed to a support workspace
- one direct message or group routed to a specialist
- a guild, team, or Discord role routed differently from the rest of an account

Configure the channel account first, then bind it. A binding pointing at an account the channel never accepts does nothing.

## Route an account to an agent

This example keeps `main` as the fallback and routes the Discord account named `support` to its own agent and workspace:

```json5
{
  agents: {
    entries: {
      main: {
        default: true,
        workspace: "~/.openclaw/workspace",
      },
      support: {
        workspace: "~/.openclaw/workspace-support",
      },
    },
  },
  bindings: [
    {
      agentId: "support",
      comment: "Route the support bot account to the support agent",
      match: {
        channel: "discord",
        accountId: "support",
      },
    },
  ],
}
```

Messages on the `support` account now resolve to `agentId: "support"`; every other Discord account and every other channel keeps using `main` unless another binding matches.

Routing config is read at startup, so restart the Gateway, then verify the roster and channel accounts:

```bash
openclaw agents list --bindings
openclaw channels status --probe
```

## Match a specific conversation

Add `match.peer` when only one direct message, group, or channel should reach the specialized agent:

```json5
{
  bindings: [
    {
      agentId: "support",
      match: {
        channel: "discord",
        accountId: "default",
        peer: {
          kind: "channel",
          id: "123456789012345678",
        },
      },
    },
  ],
}
```

`peer.kind` accepts `direct`, `group`, or `channel`. Use the channel's canonical peer ID, not a display name.

## Match fields and precedence

Every binding requires `agentId` and `match.channel`. The optional route-match fields:

- `accountId`: one configured account. Omitting it matches only the channel's default account; `"*"` is an explicit channel-wide fallback.
- `peer`: a concrete or wildcard direct, group, or channel peer
- `guildId` and `teamId`: channel-specific group-space constraints
- `roles`: Discord role IDs, evaluated together with the guild constraint
- `session.dmScope`: an optional session-scoping override for matched direct messages

Precedence is by specificity: concrete conversation and group-space matches win over account and channel fallbacks. Within the same tier, the first binding in config order wins — put narrow rules before broad ones when they share a tier.

Top-level `bindings` also accepts `type: "acp"` entries for persistent ACP conversations. Those require a concrete `match.peer.id` and follow the ACP conversation identity contract instead of ordinary route precedence; see [ACP agents](/tools/acp-agents) when that is what you need.

## Common mistakes

### Omitting accountId to mean every account

An omitted `accountId` matches only the channel's default account. If you want a channel-wide fallback, say so explicitly with `accountId: "*"`.

### Binding to an unknown agent

The `agentId` must exist under `agents.entries`, and exactly one entry should be marked `default: true`. A binding that references a missing agent misroutes silently.

### Treating bindings as access control

Bindings choose an agent for messages that were already admitted. Pairing, `dmPolicy`, group policy, and allowlists are separate controls — configure them independently.

## Related

- [Multi-agent routing](/concepts/multi-agent)
- [Agent configuration](/gateway/config-agents)
- [Channel routing](/channels/channel-routing)
