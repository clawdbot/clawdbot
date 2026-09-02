---
summary: "Share selected OpenClaw sessions read-only with a paired team Gateway"
read_when:
  - Sharing personal OpenClaw sessions with a team Gateway
  - Pairing a node that exposes only session listings and transcripts
  - Configuring attribution for sessions from another Gateway
title: "Session Share plugin"
---

The bundled `session-share` plugin lets teammates read selected sessions from another OpenClaw Gateway in the Control UI. The source operator chooses session groups to publish. A node host on the source machine reads those sessions and connects to the receiver Gateway as a paired device.

Session Share is disabled by default. It publishes a read-only **OpenClaw sessions** catalog, not a second way to run agents on the source machine. For sanitized snapshots of external coding sessions without a paired node, see [Beam](/plugins/beam).

## Before you begin

Both machines need OpenClaw with the Session Share plugin. Run the source node host as the same OS user and with the same `OPENCLAW_STATE_DIR` as the source Gateway. The receiver needs a reachable, authenticated Gateway endpoint and permission to approve device pairing.

Use the command allowlist below for a sessions-only connection. Without an allowlist, a normal node host can advertise other capabilities.

## Choose sessions on the source

Enable the plugin on the source and choose the exact session group names to publish:

```json5
{
  plugins: {
    entries: {
      "session-share": {
        enabled: true,
        config: {
          share: { groups: ["Team"] },
        },
      },
    },
  },
}
```

In the source Control UI, move the sessions you want to share into the **Team** group. Group names match the session category exactly. An omitted or empty `share.groups` publishes nothing. Incognito sessions, drafts, and adopted rows from other session catalogs are never published, even when they belong to a selected group.

Restart the source Gateway after enabling the plugin. Start or restart the source node host after changing plugin configuration. Moving a session out of a shared group revokes new transcript reads immediately; a receiver that already read text may retain that text.

## Enable the receiver and pair the source

On the receiver Gateway:

```bash
openclaw plugins enable session-share
openclaw gateway restart
openclaw devices join-code
```

Keep the join URL private. On the source machine, use that URL with exactly the two read-only commands:

```bash
openclaw connect <join-url> --service \
  --commands openclaw.sessions.list.v1,openclaw.sessions.read.v1
```

Omit `--service` to run in the foreground. With `--service`, the allowlist is saved in the source node's durable machine state and remains in effect when the service restarts.

Approve the source device on the receiver:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw nodes list
```

Check that the pairing request and connected node declare only `openclaw.sessions.list.v1` and `openclaw.sessions.read.v1`, with the `openclaw-sessions` capability. The catalog only recognizes nodes advertising both commands. See [Connect](/cli/connect) for join-code expiry and [Nodes](/nodes#restrict-the-node-command-surface) for the command allowlist.

## Read shared sessions

Open the receiver Control UI. Shared rows appear under the source node's heading in **OpenClaw sessions**. Selecting a row opens its transcript view-only. The receiver can read user messages, assistant text, reasoning, tool summaries, and bounded tool results, but cannot continue, archive, or open a terminal for that session.

Publication is shared with the receiver's permitted viewers, not just the named owner. Viewers need `operator.read`; on role-restricted Gateways, their profile's role must also permit viewing others' sessions (`sessions.others: "view"`, `"suggest"`, or `"write"`). Owner-only and unprofiled restricted viewers cannot see published rows. See [Operator scopes](/gateway/operator-scopes).

The catalog refreshes by polling, not a live transcript stream. The source node must remain connected for listings and reads. Long transcripts are paginated; individual text fields are redacted and clipped when necessary.

## Attribute the source node

Receiver-side identity settings are optional and keyed by the node ID shown by `openclaw nodes list`:

```json5
{
  plugins: {
    entries: {
      "session-share": {
        enabled: true,
        config: {
          nodes: {
            "<nodeId>": {
              owner: "github:octocat",
              linkGitHubIdentities: true,
            },
          },
        },
      },
    },
  },
}
```

`owner` accepts `github:<login>` or `profile:<profileId>`. A GitHub login resolves case-insensitively to a local profile with a verified GitHub identity. The bound owner provides default attribution when a row has no portable human creator; it does not overwrite a portable human identity or grant ownership-based access.

`linkGitHubIdentities` defaults to `false`. When enabled, remote creators and message senders with a verified numeric GitHub account ID are displayed as the receiver's local profile with the same verified account ID. Login text alone is not enough to link a remote sender. Unmatched identities remain remote with their display labels.

Without node-specific settings, attribution stays remote. Source-local profile IDs are namespaced as remote identities, never interpreted directly as profiles on the receiver. Source and receiver settings may coexist in one plugin configuration.

## Security boundary

The source chooses what to publish; the receiver trusts the paired device for the identity claims attached to that publication. Attribution is display metadata and never grants access.

With the two-command allowlist, the node exposes no shell execution, filesystem browsing, terminal uploads, plugin tools, MCP servers, skills, worker hosting, or computer use. Both commands are read-only, and every transcript read rechecks whether the session is still shared. The receiver does not need access to the source Gateway's HTTP endpoint or authentication credentials.

Sharing a session exposes its visible text and catalog metadata, which may include workspace paths or branch names. Redaction masks known credential patterns; it does not make arbitrary conversation content safe to publish. Choose groups deliberately and treat received transcripts as untrusted text.

## Troubleshooting

To undo the sessions-only setup, use `openclaw node run --all-commands` in the foreground or `openclaw node install --force --all-commands` for the service; this forgets the saved allowlist and restores the full default node surface.

**The source node fails with no allowed commands**

Enable `session-share` on the source, set a non-empty `share.groups`, restart the node host, and check the exact command IDs. Unknown or unavailable commands are not advertised.

**The node connects but no OpenClaw sessions host appears**

Enable the plugin on the receiver and restart its Gateway. Check `openclaw nodes list`: the source must declare both session commands and be approved for them.

**The host appears but a session is missing**

Check its group on the source, the exact `share.groups` spelling, and whether it is incognito, a draft, or adopted from another catalog. Verify that the source node uses the same user and state directory as the source Gateway. On a role-restricted receiver, check the viewer's profile and permission to view others' sessions.

**A transcript read fails after a row was visible**

Refresh the catalog. The source may be offline, the session may have been deleted, or its group may no longer be shared. Reconnect the source node for an offline-host error; do not broaden its command allowlist.

**Names do not link to local profiles**

Check the configured node ID and `linkGitHubIdentities`. Both profiles need the same verified numeric GitHub account ID; matching names or unverified logins do not link them.

## Related

- [Connect a node](/cli/connect)
- [Node command allowlists](/nodes#restrict-the-node-command-surface)
- [Team setup](/start/teams)
- [Beam](/plugins/beam)
- [User model](/concepts/user-model)
