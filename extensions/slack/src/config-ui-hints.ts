import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const slackChannelConfigUiHints = {
  "": {
    label: "Slack",
    help: "Slack channel provider configuration for bot/app tokens, streaming behavior, and DM policy controls. Keep token handling and thread behavior explicit to avoid noisy workspace interactions.",
  },
  postAs: {
    label: "Slack Identity",
    help: 'Select "bot" (default) for the classic Slack app/bot identity or "user" to post as the authorizing human through a user token while the app carries event transport.',
  },
  ...createChannelConfigUiHints({
    channelLabel: "Slack",
    dmPolicy: { channelKey: "slack" },
    configWrites: true,
    mentionPatterns: {
      targetDescription: "Slack channel IDs",
      policyNote: "Native Slack @mentions still trigger even when regex patterns are denied.",
      denyNote: "Native @mentions still trigger.",
    },
    nativeCommands: true,
    implicitMentions: true,
    streaming: {
      "": 'Unified Slack stream preview mode: "off" | "partial" | "block" | "progress" (default). Legacy boolean/streamMode keys are auto-mapped.',
      mode: 'Canonical Slack preview mode: "off" | "partial" | "block" | "progress" (default).',
      chunkMode: 'Chunking mode for outbound Slack text delivery: "length" (default) or "newline".',
      "block.enabled":
        'Enable chunked block-style Slack preview delivery when channels.slack.streaming.mode="block".',
      "block.coalesce": "Merge streamed Slack block replies before final delivery.",
      nativeTransport:
        "Enable native Slack text streaming (chat.startStream/chat.appendStream/chat.stopStream) when channels.slack.streaming.mode is partial (default: true). Native streaming and Slack assistant thread status require a reply thread target; top-level DMs can still use draft post-and-edit preview streaming.",
      "preview.toolProgress":
        "Show tool/progress activity in the live draft preview message (default: true). Set false to hide interim tool updates while the draft preview stays active.",
      "preview.commandText":
        'Command/exec detail in preview tool-progress lines: "status" is the safe default; "raw" opts into command text.',
      "progress.style":
        'Slack progress presentation: "card" (default) uses structured task/session cards; "compact" keeps one editable text draft that the final answer replaces in place when Slack can safely edit it.',
      "progress.nativeTaskCards":
        'Slack native task-card progress updates when channels.slack.streaming.mode="progress", progress.style="card", and streaming.nativeTransport is enabled. Set false to fall back to the Block Kit progress card. Default: true.',
    },
    progress: { labels: "openclaw" },
  }),
  joinIntro: {
    label: "Slack Channel Join Introduction",
    help: "Post one brief, room-specific introduction when the bot joins an allowed Slack channel (default: true). Account settings override the channel-wide setting.",
  },
  allowBots: {
    label: "Slack Allow Bot Messages",
    help: "Allow bot-authored messages to trigger Slack replies (default: false).",
  },
  botLoopProtection: {
    label: "Slack Bot Loop Protection",
    help: "Sliding-window guard for Slack bot-to-bot loops. Default is enabled whenever allowBots lets bot-authored messages reach dispatch.",
  },
  "botLoopProtection.enabled": {
    label: "Slack Bot Loop Protection Enabled",
    help: 'Enable the bot-pair loop guard. Defaults to true when allowBots is true or "mentions", and false when bot messages are ignored.',
  },
  "botLoopProtection.maxEventsPerWindow": {
    label: "Slack Bot Loop Events per Window",
    help: "Maximum accepted bot-pair messages within the sliding window before suppression starts. Default: 20.",
  },
  "botLoopProtection.windowSeconds": {
    label: "Slack Bot Loop Window Seconds",
    help: "Sliding window length for counting bot-pair messages. Default: 60.",
  },
  "botLoopProtection.cooldownSeconds": {
    label: "Slack Bot Loop Cooldown Seconds",
    help: "How long to suppress the bot pair after it exceeds the budget. Default: 60.",
  },
  relay: {
    label: "Slack Relay Mode",
    help: 'Relay-delivered Slack events. Use with mode="relay" when openclaw-slack-router owns the Slack Socket Mode connection.',
  },
  "relay.url": {
    label: "Slack Relay URL",
    help: "Full websocket URL for openclaw-slack-router. Include the route path, for example ws://127.0.0.1:8081/gateway/ws.",
  },
  "relay.authToken": {
    label: "Slack Relay Auth Token",
    help: "Bearer token used by this gateway to authenticate its reverse websocket connection to openclaw-slack-router.",
  },
  "relay.gatewayId": {
    label: "Slack Relay Gateway ID",
    help: "Destination id that openclaw-slack-router uses when routing user-group mentions to this gateway.",
  },
  botToken: {
    label: "Slack Bot Token",
    help: "Slack bot token used for standard chat actions in the configured workspace. Keep this credential scoped and rotate if workspace app permissions change.",
  },
  appToken: {
    label: "Slack App Token",
    help: "Slack app-level token used for Socket Mode connections and event transport when enabled. Use least-privilege app scopes and store this token as a secret.",
  },
  userToken: {
    label: "Slack User Token",
    help: "Optional Slack user token for workflows requiring user-context API access beyond bot permissions. Use sparingly and audit scopes because this token can carry broader authority.",
  },
  userTokenReadOnly: {
    label: "Slack User Token Read Only",
    help: "When true, treat configured Slack user token usage as read-only helper behavior where possible. Keep enabled if you only need supplemental reads without user-context writes.",
  },
  execApprovals: {
    label: "Slack Exec Approvals",
    help: "Slack-native exec approval routing and approver authorization. When unset, OpenClaw auto-enables DM-first native approvals if approvers can be resolved for this Slack account.",
  },
  presenceEvents: {
    label: "Slack Presence Events",
    help: 'Poll observed human participants and wake the routed agent on away-to-active transitions. Default: "off".',
  },
  "presenceEvents.mode": {
    label: "Slack Presence Event Mode",
    help: '"off" disables polling; "auto" covers DMs, MPIMs, and recent threads with up to 8 observed people; "on" also covers larger threads and top-level channels.',
  },
  "presenceEvents.prompt": {
    label: "Slack Presence Event Prompt",
    help: "Replace the default greeting guidance appended after presence facts. Use an empty string to omit event-specific guidance and let workspace instructions such as AGENTS.md govern behavior. Maximum: 20,000 characters.",
  },
  "channels.*.presenceEvents.mode": {
    label: "Slack Channel Presence Event Mode",
    help: 'Override presence events for one Slack channel. Use "on" to include large threads or top-level channel sessions.',
  },
  "channels.*.presenceEvents.prompt": {
    label: "Slack Channel Presence Event Prompt",
    help: "Override the account-level presence-event prompt for one Slack channel. Maximum: 20,000 characters.",
  },
  "execApprovals.enabled": {
    label: "Slack Exec Approvals Enabled",
    help: 'Controls Slack native exec approvals for this account: unset or "auto" enables DM-first native approvals when approvers can be resolved, true forces native approvals on, and false disables them.',
  },
  "execApprovals.approvers": {
    label: "Slack Exec Approval Approvers",
    help: "Slack user IDs allowed to approve exec requests for this workspace account. Use Slack user IDs or user targets such as `U123`, `user:U123`, or `<@U123>`. If you leave this unset, OpenClaw falls back to commands.ownerAllowFrom when possible.",
  },
  "execApprovals.agentFilter": {
    label: "Slack Exec Approval Agent Filter",
    help: 'Optional allowlist of agent IDs eligible for Slack exec approvals, for example `["main", "ops-agent"]`. Use this to keep approval prompts scoped to the agents you actually operate from Slack.',
  },
  "execApprovals.sessionFilter": {
    label: "Slack Exec Approval Session Filter",
    help: "Optional session-key filters matched as substring or regex-style patterns before Slack approval routing is used. Use narrow patterns so Slack approvals only appear for intended sessions.",
  },
  "execApprovals.target": {
    label: "Slack Exec Approval Target",
    help: 'Controls where Slack approval prompts are sent: "dm" sends to approver DMs (default), "channel" sends to the originating Slack chat/thread, and "both" sends to both. Channel delivery exposes the command text to the chat, so only use it in trusted channels.',
  },
  "thread.historyScope": {
    label: "Slack Thread History Scope",
    help: 'Scope for Slack thread history context ("thread" isolates per thread; "channel" reuses channel history).',
  },
  "thread.inheritParent": {
    label: "Slack Thread Parent Inheritance",
    help: "If true, Slack thread sessions inherit the parent channel transcript (default: false).",
  },
  "thread.initialHistoryLimit": {
    label: "Slack Thread Initial History Limit",
    help: "Maximum number of existing Slack thread messages to fetch when starting a new thread session (default: 20, set to 0 to disable).",
  },
} satisfies Record<string, ChannelConfigUiHint>;
