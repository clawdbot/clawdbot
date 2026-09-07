---
summary: "Who can reach the agent: DM policy, allowlists, DM session isolation, context visibility, and command authorization"
read_when:
  - Deciding who can DM or trigger the bot
  - Isolating DM sessions for a shared or multi-user inbox
  - Limiting which supplemental context reaches the model
title: "Access control and allowlists"
sidebarTitle: "Access control"
---

## DM access: pairing, allowlist, open, disabled

Every DM-capable channel supports `dmPolicy` (or `*.dm.policy`), which gates inbound DMs before the message is processed:

| Policy      | Behavior                                                                                                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pairing`   | Default. Unknown senders get a pairing code; bot ignores them until approved. Codes expire after 1 hour; repeated DMs do not resend a code until a new request is created. Pending requests capped at 3 per channel. |
| `allowlist` | Unknown senders blocked, no pairing handshake.                                                                                                                                                                       |
| `open`      | Anyone can DM (public). Requires the channel allowlist to include `"*"` (explicit opt-in).                                                                                                                           |
| `disabled`  | Inbound DMs ignored entirely.                                                                                                                                                                                        |

```bash
openclaw pairing list <channel>
openclaw pairing approve <channel> <code>
```

Details + files on disk: [Pairing](/channels/pairing)

Prefer pairing + allowlists for DMs. For groups, decide by membership, not by channel type: a private room whose members you trust - your team, family, or friends - is a normal deployment for `groupPolicy: "open"` (any member can trigger the bot). Keep sender allowlists or mention gating on rooms where strangers can join or post, and treat `dmPolicy="open"` as a deliberate opt-in.

### Allowlists (two layers)

- **DM allowlist** (`allowFrom` / `channels.discord.allowFrom` / `channels.slack.allowFrom`; legacy: `channels.discord.dm.allowFrom`, `channels.slack.dm.allowFrom`): who can DM the bot. When `dmPolicy="pairing"`, approvals write to `~/.openclaw/credentials/<channel>-allowFrom.json` (default account) or `<channel>-<accountId>-allowFrom.json` (non-default accounts), merged with config allowlists.
- **Group allowlist** (channel-specific): which groups/channels/guilds the bot accepts at all.
  - `channels.whatsapp.groups`, `channels.telegram.groups`, `channels.imessage.groups`: per-group defaults like `requireMention`; when set, also acts as a group allowlist (include `"*"` to keep allow-all behavior). Customize mention triggers with `agents.entries.*.groupChat.mentionPatterns` (for example `["@openclaw", "@mybot"]`) so `requireMention` gates on your own bot names.
  - `groupPolicy="allowlist"` + `groupAllowFrom`: restrict who can trigger the bot inside a group session (WhatsApp/Telegram/Signal/iMessage/Microsoft Teams).
  - `channels.discord.guilds` / `channels.slack.channels`: per-surface allowlists + mention defaults.
  - Check order: `groupPolicy`/group allowlists first, then mention/reply activation. Replying to a bot message (implicit mention) does **not** bypass `groupAllowFrom`.

Details: [Configuration](/gateway/configuration) and [Groups](/channels/groups)

### DM session isolation (multi-user mode)

By default, OpenClaw routes all DMs into the main session for cross-device continuity. If multiple people can DM the bot (open DMs or a multi-person allowlist), isolate DM sessions:

```json5
{ session: { dmScope: "per-channel-peer" } }
```

`session.dmScope` values:

| Value                      | Scope                                                                  |
| -------------------------- | ---------------------------------------------------------------------- |
| `main` (config default)    | All DMs share one session.                                             |
| `per-channel-peer`         | Each channel+sender pair gets an isolated DM context (secure DM mode). |
| `per-account-channel-peer` | Like above, split further by account (multi-account channels).         |
| `per-peer`                 | Each sender gets one session across all channels of the same type.     |

Local CLI onboarding preserves an explicit `session.dmScope` and otherwise leaves it unset, so the `"main"` default applies: all direct messages across channels share the agent's rolling main session (the personal-agent default). For shared or multi-user inboxes, set `session.dmScope: "per-channel-peer"`; `openclaw security audit` recommends isolation when it detects multi-user DM traffic.

This is a messaging-context boundary, not a host-admin boundary. If users are mutually adversarial and share the same Gateway host/config, run separate gateways per trust boundary instead.

If the same person contacts you on multiple channels, use `session.identityLinks` to collapse those DM sessions into one canonical identity. See [Session Management](/concepts/session) and [Configuration](/gateway/configuration).

## Context visibility vs trigger authorization

Two separate concepts:

- **Trigger authorization**: who can trigger the agent (`dmPolicy`, `groupPolicy`, allowlists, mention gates).
- **Context visibility**: what supplemental context reaches the model (reply body, quoted text, thread history, forwarded metadata).

`contextVisibility` controls the second:

- `"all"` (default): supplemental context kept as received.
- `"allowlist"`: supplemental context filtered to senders allowed by active allowlist checks.
- `"allowlist_quote"`: like `allowlist`, but still keeps one explicit quoted reply.

Set per channel or per room/conversation - see [Groups](/channels/groups#context-visibility-and-allowlists). Reports that only show "model can see quoted/historical text from non-allowlisted senders" are hardening findings addressable with `contextVisibility`, not auth or sandbox bypasses by themselves; a security-impacting report still needs a demonstrated trust-boundary bypass.

## Command authorization

Slash commands and directives are honored only for authorized senders. Configure an explicit per-provider `commands.allowFrom` list, or let command authorization follow channel allowlists and pairing state. Access-group entries referenced by channel allowlists are resolved automatically; there is no opt-in toggle. If a channel allowlist is empty or includes `"*"`, commands are effectively open for that channel. See [Access groups](/channels/access-groups) and [Slash commands](/tools/slash-commands).

`/exec` is a session-only convenience for authorized operators - it does not write config or change other sessions.
