---
summary: "Route channel accounts and conversations to the right OpenClaw agent"
title: "Agent bindings"
read_when:
  - Routing channel accounts to different agents
  - Sending one conversation to a specialized agent
  - Deciding whether the default agent is sufficient
---

An agent binding routes an inbound channel conversation to a configured agent. Each binding names an `agentId` and matches channel facts such as the account, peer, guild, team, or Discord roles. Bindings choose the agent that owns the resulting session; they do not create channel accounts or change channel access policy.

## When to use a binding

Use the default agent when every unmatched conversation should share one workspace, model policy, and session boundary. With no matching binding, OpenClaw routes inbound traffic to the agent marked `default: true`.

Add bindings when you need a stable split such as:

- one channel account per agent
- a support inbox routed to a support workspace
- one direct message or group routed to a specialist
- a guild, team, or Discord role routed differently from the rest of an account

Configure the channel account first. A binding only selects an agent after that channel has accepted the inbound message through its normal pairing, allowlist, and account rules.

## Route an account to an agent

This example keeps `main` as the fallback and routes the Discord account named `support` to a separate agent:

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

Messages on the `support` account now resolve to `agentId: "support"`. Other Discord accounts and other channels continue to use `main` unless another binding matches.

Restart the Gateway after changing routing config, then verify the roster and channel accounts:

```bash
openclaw agents list --bindings
openclaw channels status --probe
```

## Match a specific conversation

Add `match.peer` when only one direct message, group, or channel should use the specialized agent:

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

`peer.kind` accepts `direct`, `group`, or `channel`. Use the channel's canonical peer ID rather than a display name.

## Match fields and precedence

Every binding requires `agentId` and `match.channel`. Optional route-match fields are:

- `accountId`: one configured account; omitted matches only the channel's default account, while `"*"` is a channel-wide fallback
- `peer`: a concrete or wildcard direct, group, or channel peer
- `guildId` and `teamId`: channel-specific group-space constraints
- `roles`: Discord role IDs, evaluated with the guild constraint
- `session.dmScope`: an optional session-scoping override for matched direct messages

More specific conversation and group-space matches win before account and channel fallbacks. Within the same match tier, the first binding in config order wins. Put narrow rules before broader rules when they share a tier.

Top-level `bindings` also accepts explicit `type: "acp"` entries for persistent ACP conversations. Those require a concrete `match.peer.id` and follow the ACP conversation identity contract rather than ordinary route precedence. See [ACP agents](/tools/acp-agents) when that is the behavior you need.

## Common mistakes

### Omitting accountId to mean every account

An omitted `accountId` matches only the channel's default account. Use `accountId: "*"` for an intentional channel-wide fallback.

### Binding to an unknown agent

The `agentId` must exist under `agents.entries`. Keep exactly one configured entry marked `default: true`.

### Treating bindings as access control

Bindings choose an agent after a message is admitted. Keep channel pairing, `dmPolicy`, group policy, and allowlists configured independently.

## Related

- [Multi-agent routing](/concepts/multi-agent)
- [Agent configuration](/gateway/config-agents)
- [Channel routing](/channels/channel-routing)
