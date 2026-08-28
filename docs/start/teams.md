---
summary: "Set up a shared OpenClaw gateway for a team: workspace chat, shared sessions, ownership, and roles"
read_when:
  - Setting up OpenClaw for a team or shared workspace
  - Adding teammates to an existing gateway
  - Deciding between one shared gateway and separate gateways
title: "Team setup"
---

This guide sets up one OpenClaw gateway that a whole team uses: a bot in the workspace chat you already have, shared sessions everyone can open and steer in the Control UI, and roles that bound what each person can do. It is the same product as the [personal assistant setup](/start/openclaw) - team operation is configuration, not a separate edition.

## Before you begin

- A host for the Gateway that stays on: a small VPS, an office Mac, or any [supported install target](/install).
- OpenClaw installed and onboarded on that host - see [Getting started](/start/getting-started).
- A chat workspace the team already uses (Discord, Google Chat, Mattermost, Microsoft Teams, Slack, Telegram, ...) - see [Channels](/channels).
- A strong latest-generation model. Shared gateways see more varied input than a solo setup, and modern models are substantially more resistant to prompt injection - see [Security](/gateway/security#prompt-injection).
- Optional: teammates' GitHub accounts, if you want verified identity and commit credit.

## One trust boundary

A gateway is one trust domain. Everyone who can message a tool-enabled agent shares that agent's delegated tool authority, and everyone with operator access shares one control plane. That is the right model for a team whose members already trust each other - session ownership, presence, and [roles](/gateway/operator-scopes#named-operator-roles) are collaboration guardrails inside the boundary, not isolation between adversaries.

If you need to serve mutually untrusted people or organizations, run one gateway per tenant instead: [Multi-tenant hosting](/gateway/multi-tenant-hosting).

## Step 1: Give the team access to the Gateway

The Gateway binds to loopback by default. Give teammates access through authenticated ingress instead of a public bind:

- **Tailnet (recommended):** put the host on your tailnet and enable [Tailscale Serve](/gateway/tailscale). With `gateway.auth.allowTailscale`, Control UI sign-in can use each person's Tailscale identity - no shared secret to distribute.
- **Trusted proxy:** front the Gateway with an identity-aware proxy such as Cloudflare Access - see [Trusted proxy auth](/gateway/trusted-proxy-auth).
- **Shared secret:** token or password auth works for small teams, but skips per-person identity - see [Authentication](/gateway/authentication).

The identity-backed options are worth the setup: they are what turns "someone did something" into "who did what" in the session UI and commit credit below.

## Step 2: Connect the team chat

Connect the channel your team lives in. Example: a Slack bot, allowed in one team channel, that replies when mentioned:

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "socket",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "allowlist",
      channels: {
        C0123456789: { requireMention: true },
      },
    },
  },
}
```

Group chats are a first-class deployment. The defaults are already team-shaped: group access is allowlisted per room, and replies require a mention, so the bot participates when addressed and stays quiet otherwise. In a private room whose members you trust, that is all the gating you need; for broad or public rooms, add sender allowlists and `contextVisibility` - see [Groups](/channels/groups).

If the same people should be allowed across several channels, define the list once as an [access group](/channels/access-groups) and reference it from each channel's allowlist.

## Step 3: Sign the team in to the Control UI

Each teammate opens the [Control UI](/web/control-ui) through the ingress from step 1 and gets a durable Gateway profile: display name, avatar, and per-person appearance preferences. With Cloudflare Access or Tailscale Serve, GitHub-backed sign-in verifies the account behind the profile - see [User model](/concepts/user-model).

## Step 4: Work in shared sessions

A conversation that starts in the team channel can continue as a session the whole team can open, steer, and take over. [Multi-user mode](/concepts/multi-user) gives every session three layers of attribution - an immutable creator, an assignable owner (assign sessions like GitHub issues from the session context menu), and the history of people who actually prompted - plus live [presence](/concepts/presence): who is viewing, and who is typing, with drafts that never reach the model or the transcript.

For coding work, verified GitHub identity pays off at the commit: with **Git co-author credit** enabled, commits from a shared session carry `Co-authored-by` trailers for the people who steered it, and generated pull requests link back to the session so reviewers can read the conversation that produced the diff.

## Step 5: Bound what each person can do

Named operator roles bind authenticated profiles to a policy: which sessions they can touch, which agents they can use, a maximum set of operator scopes, and whether their new sessions must be sandboxed:

```json5
{
  gateway: {
    roles: {
      default: "guest",
      definitions: {
        maintainer: {
          sessions: { others: "write" },
          agents: ["roboclaw"],
          scopes: ["operator.read", "operator.write", "operator.approvals"],
        },
        guest: {
          sessions: { others: "view" },
          agents: ["roboclaw"],
          scopes: ["operator.read", "operator.write"],
          sandbox: "required",
        },
      },
    },
  },
}
```

Assign roles with the `users.setRole` Gateway method; see [Named operator roles](/gateway/operator-scopes#named-operator-roles) for the full policy surface and [Permission modes](/gateway/permission-modes) for per-session tool posture.

## Verify

- Mention the bot in the allowed team channel and confirm it replies there.
- Open the Control UI as two different people: both should see the session, its owner avatar, and each other's presence.
- Run `openclaw security audit` on the host and resolve anything it flags about inbound access or exposure.

## When to split things up

- **Separate workspaces or personas** (projects that must not share memory or files): use multiple agents on one gateway - see [Multi-agent routing](/concepts/multi-agent).
- **Mutually untrusted users, customers, or organizations:** separate gateways, ideally separate OS users or hosts - see [Multi-tenant hosting](/gateway/multi-tenant-hosting) and [Security](/gateway/security).

## Related

- [Why OpenClaw: working together](/start/why-openclaw#working-together) - the team collaboration surfaces in one place
- [Multi-user mode](/concepts/multi-user) - ownership, participants, and owner filtering in depth
- [Operator scopes](/gateway/operator-scopes) - connection roles, scopes, and role assignment
- [Groups](/channels/groups) - group behavior, mention gating, and context visibility
- [Security](/gateway/security) - the trust model behind the one-boundary rule
