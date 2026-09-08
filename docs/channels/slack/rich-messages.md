---
summary: "Native Block Kit charts and tables, modal submissions, and approval buttons"
read_when:
  - Rendering charts or tables natively in Slack
  - Handling a plugin-owned Slack modal submission
  - Approving exec or plugin requests from Slack
title: "Slack charts, tables, and approvals"
sidebarTitle: "Charts, tables, and approvals"
---

The Block Kit surfaces OpenClaw renders natively in Slack.

## Native charts

Slack's public [`data_visualization` Block Kit block](https://docs.slack.dev/reference/block-kit/blocks/data-visualization-block/)
renders line, bar, area, and pie charts in messages. OpenClaw maps the portable
`presentation` `chart` block to that native shape; no additional OAuth scope,
file upload, image renderer, or Slack configuration is required beyond normal
`chat:write` message access.

```json
{
  "blocks": [
    {
      "type": "chart",
      "chartType": "bar",
      "title": "Quarterly revenue",
      "categories": ["Q1", "Q2"],
      "series": [{ "name": "Revenue", "values": [120, 145] }],
      "xLabel": "Quarter"
    }
  ]
}
```

Slack's limits are enforced before native rendering:

- title and optional axis labels: 50 characters
- pie: 1-12 positive segments
- line/bar/area: 1-12 uniquely named series and 1-20 shared categories
- segment, category, and series labels: 20 characters
- every series must contain one finite value for every category; non-pie values
  may be negative

Every native chart also carries a top-level text representation for screen
readers, notifications, session mirroring, and clients that cannot render the
block. Standard presentation sends to other OpenClaw channels receive that same
deterministic chart data as text unless they advertise native chart support. If
Slack rejects the chart with `invalid_blocks` during a phased rollout, OpenClaw
removes the rejected native data blocks, keeps any sibling controls, and sends
the complete chart representation as visible text.

Slack currently accepts up to two `data_visualization` blocks per message. When
a presentation contains more than two valid charts, OpenClaw keeps their order
and continues native rendering in follow-up messages, with no more than two
charts in each message.

Slack's [developer launch](https://docs.slack.dev/changelog/2026/06/16/block-kit-data-visualization-block/)
documents the block as an app-facing Block Kit feature and publishes no paid
plan restriction. The Business+/Enterprise eligibility language applies to
Slackbot's automatic AI chart generation, which is separate from an app sending
an already-structured Block Kit chart. Charts are message-only blocks, not App
Home, modal, or Canvas content.

## Native tables

Slack's current [`data_table` Block Kit block](https://docs.slack.dev/reference/block-kit/blocks/data-table-block/)
renders structured rows and columns in messages. OpenClaw maps an explicit
portable `presentation` `table` block to `data_table`; it does not use Slack's
legacy [`table` block](https://docs.slack.dev/reference/block-kit/blocks/table-block/).
No additional OAuth scope or Slack configuration is required beyond normal
`chat:write` message access.

```json
{
  "blocks": [
    {
      "type": "table",
      "caption": "Open pipeline",
      "headers": ["Account", "Stage", "ARR"],
      "rows": [
        ["Acme", "Won", 125000],
        ["Globex", "Review", 82000]
      ],
      "rowHeaderColumnIndex": 0
    }
  ]
}
```

OpenClaw maps header and string cells to Slack `raw_text` cells. Numeric cells
map to `raw_number`, with the finite numeric value preserved for native sorting
and filtering. `rowHeaderColumnIndex`, when present, marks that zero-based
column as Slack row headers.

Slack's published `data_table` limits are enforced before native rendering:

- 1-20 columns
- 1-100 data rows, plus the header row
- the same number of cells in every row
- at most 10,000 aggregate characters across all table cells in one message

Multiple valid table blocks can render natively while the message remains
within the aggregate character limit. A table that cannot render within the
native envelope becomes complete deterministic text instead of losing rows or
cells. If that text exceeds one Slack message, sends and slash responses use
ordered text chunks. Table edits fail with an explicit size error instead of
silently truncating rows from an existing message.

Every native table produced from portable presentation also carries a top-level
text representation for screen readers, notifications, session mirroring, and
clients that cannot render the block. Raw chart and table values stay literal
in the fallback, so cell data such as `<@U123>` does not become a Slack mention.
If Slack rejects native chart or table blocks with `invalid_blocks`, OpenClaw
removes every native data block in one bounded recovery step, retains valid
sibling blocks such as buttons and selects, and sends complete visible chart
and table text with Slack formatting disabled. Slash-command delivery
tracks Slack's five-call `response_url` budget across the command. Before each
reply batch, it selects a complete plan that fits the remaining calls or fails
before posting that batch.

Only explicit `presentation` table blocks are promoted to native tables.
Markdown pipe tables remain authored text; OpenClaw does not guess at table
structure or cell types. Existing trusted Slack-native producers can continue
to pass raw blocks through `channelData.slack.blocks`; OpenClaw derives fallback
text from valid raw `data_table` cells, while malformed custom blocks may
degrade to their caption or general Block Kit fallback. Portable agent, CLI,
and plugin output should use `presentation`.

Slack clients can also deliver pasted spreadsheet content as a legacy `table`
block in the message's top-level blocks or attachments. OpenClaw renders those
inbound cells as delimiter-safe TSV for live agent input, thread context, and
Slack `read` actions. Only native table blocks are admitted from ordinary
attachments; link-unfurl and other non-forwarded attachment text remains
excluded.

## Plugin-owned modal submissions

Slack plugins that register an interactive handler can also receive modal
`view_submission` and `view_closed` lifecycle events before OpenClaw compacts
the payload for the agent-visible system event. Use one of these routing
patterns when opening a Slack modal:

- Set `callback_id` to `openclaw:<namespace>:<payload>`.
- Or keep an existing `callback_id` and put `pluginInteractiveData:
"<namespace>:<payload>"` in the modal `private_metadata`.

The handler receives `ctx.interaction.kind` as `view_submission` or
`view_closed`, normalized `inputs`, and the full raw `stateValues` object from
Slack. Callback-id-only routing is enough to invoke the plugin handler; include
the existing modal `private_metadata` user/session routing fields when the
modal should also produce an agent-visible system event. The agent receives a
compact, redacted `Slack interaction: ...` system event. If the handler returns
`systemEvent.summary`, `systemEvent.reference`, or `systemEvent.data`, those
fields are included in that compact event so the agent can reference
plugin-owned storage without seeing the complete form payload.

## Native approvals in Slack

Slack can act as a native approval client with interactive buttons and interactions, instead of falling back to the Web UI or terminal.

- Exec and plugin approvals can render as Slack-native Block Kit prompts.
- `channels.slack.execApprovals.*` remains the native exec approval client enablement and DM/channel routing config.
- Exec approval DMs use `channels.slack.execApprovals.approvers` or `commands.ownerAllowFrom`.
- Plugin approvals use Slack-native buttons when Slack is enabled as a native approval client for the originating session, or when `approvals.plugin` routes to the originating Slack session or a Slack target.
- Plugin approval DMs use Slack plugin approvers from `channels.slack.allowFrom`, named-account `allowFrom`, or the account default route.
- Approver authorization is still enforced: exec-only approvers cannot approve plugin requests unless they are also plugin approvers.

For Enterprise Grid org installs, the originating event's validated workspace
is retained for the approval prompt, approver DM, button callback, and final
message update. Approval delivery fails closed when an org-installed account
does not have that event-owned workspace scope.

This uses the same shared approval button surface as other channels. When `interactivity` is enabled in your Slack app settings, approval prompts render as Block Kit buttons directly in the conversation.
When those buttons are present, they are the primary approval UX; OpenClaw
should only include a manual `/approve` command when the tool result says chat
approvals are unavailable or manual approval is the only path.

Config path:

- `channels.slack.execApprovals.enabled`
- `channels.slack.execApprovals.approvers` (optional; falls back to `commands.ownerAllowFrom` when possible)
- `channels.slack.execApprovals.target` (`dm` | `channel` | `both`, default: `dm`)
- `agentFilter`, `sessionFilter`

Slack native exec approvals require `enabled: true` or `"auto"` and at least one
resolved exec approver. Leaving `enabled` unset or setting it to `false` disables
native exec approval delivery. Slack can also handle native plugin approvals
through this native-client path when Slack plugin approvers resolve and the
request matches its filters. Disabling Slack exec approvals does not disable
native plugin approval delivery enabled through `approvals.plugin`, which uses
Slack plugin approvers instead.

Minimal Slack-native configuration using command owners as approvers:

```json5
{
  channels: {
    slack: {
      execApprovals: { enabled: "auto" },
    },
  },
  commands: {
    ownerAllowFrom: ["slack:U12345678"],
  },
}
```

To override approvers, add filters, or opt into origin-chat delivery:

```json5
{
  channels: {
    slack: {
      execApprovals: {
        enabled: true,
        approvers: ["U12345678"],
        target: "both",
      },
    },
  },
}
```

Shared `approvals.exec` forwarding is separate. Use it only when exec approval prompts must also
route to other chats or explicit out-of-band targets. Shared `approvals.plugin` forwarding is also
separate; Slack native delivery suppresses that fallback only when Slack can handle the plugin
approval request natively.

Same-chat `/approve` also works in Slack channels and DMs that already support commands. See [Exec approvals](/tools/exec-approvals) for the full approval forwarding model.
