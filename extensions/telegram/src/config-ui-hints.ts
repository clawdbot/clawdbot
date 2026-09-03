import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-config-ui-hints";
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const telegramChannelConfigUiHints = {
  "": {
    label: "Telegram",
    help: "Telegram channel provider configuration including auth tokens, retry behavior, and message rendering controls. Use this section to tune bot behavior for Telegram-specific API semantics.",
  },
  customCommands: {
    label: "Telegram Custom Commands",
    help: "Additional Telegram bot menu commands (merged with native; conflicts ignored).",
  },
  botToken: {
    label: "Telegram Bot Token",
    help: "Telegram bot token used to authenticate Bot API requests for this account/provider config. Use secret/env substitution and rotate tokens if exposure is suspected.",
  },
  joinIntro: {
    label: "Telegram Group Join Introduction",
    help: "Send one room-aware introduction when the bot joins an allowed group or supergroup (default: true). Telegram cannot provide message history from before the bot joined.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "Telegram",
    dmPolicy: { channelKey: "telegram" },
    configWrites: true,
    mentionPatterns: {
      targetDescription: "Telegram group chat IDs or chatId:topic:threadId topic IDs",
      policyNote: "Native Telegram bot mentions still trigger even when regex patterns are denied.",
      denyNote: "Native bot mentions still trigger.",
    },
    nativeCommands: true,
    streaming: {
      "": 'Unified Telegram stream preview mode: "off" | "partial" | "block" | "progress" (default: "progress"). "progress" keeps a single editable progress draft until final delivery. Legacy boolean/streamMode keys are detected; run doctor --fix to migrate.',
      mode: 'Canonical Telegram preview mode: "off" | "partial" | "block" | "progress" (default: "progress").',
      chunkMode:
        'Chunking mode for outbound Telegram text delivery: "length" (default) or "newline".',
      "block.enabled":
        "Enable normal Telegram block replies. This takes precedence over editable preview delivery.",
      "block.coalesce": "Merge streamed Telegram block replies before sending final delivery.",
      "preview.chunk.minChars":
        'Minimum chars before emitting a Telegram block preview chunk when channels.telegram.streaming.mode="block".',
      "preview.chunk.maxChars":
        'Target max size for a Telegram block preview chunk when channels.telegram.streaming.mode="block".',
      "preview.chunk.breakPreference":
        "Preferred breakpoints for Telegram draft chunks (paragraph | newline | sentence).",
      "preview.toolProgress":
        "Show tool/progress activity in the live draft preview message (default: true when preview streaming is active). Set false to keep tool updates out of the edited Telegram preview.",
      "preview.commandText":
        'Command/exec detail in preview tool-progress lines: "status" is the safe default; "raw" opts into command text.',
    },
    progress: { includeCommentary: true, commentaryOrder: "after-command" },
  }),
  richMessages: {
    label: "Telegram Rich Messages",
    help: "Opt into Bot API 10.3 rich text sends and edits, including native tables and rich media. Default: false because some current Telegram clients render these messages as unsupported.",
  },
  "network.autoSelectFamily": {
    label: "Telegram autoSelectFamily",
    help: "Override Node autoSelectFamily for Telegram (true=enable, false=disable).",
  },
  "network.dangerouslyAllowPrivateNetwork": {
    label: "Telegram Dangerously Allow Private Network",
    help: "Dangerous opt-in for trusted fake-IP or transparent-proxy environments where Telegram media downloads resolve api.telegram.org to private/internal/special-use addresses.",
  },
  silentErrorReplies: {
    label: "Telegram Silent Error Replies",
    help: "When true, Telegram bot replies marked as errors are sent silently (no notification sound). Default: false.",
  },
  apiRoot: {
    label: "Telegram API Root URL",
    help: "Custom Telegram Bot API root URL. Use the API root only (for example https://api.telegram.org), not a full /bot<TOKEN> endpoint. Use for self-hosted Bot API servers (https://github.com/tdlib/telegram-bot-api) or reverse proxies in regions where api.telegram.org is blocked.",
  },
  trustedLocalFileRoots: {
    label: "Telegram Trusted Local File Roots",
    help: "Trusted local filesystem roots for self-hosted Telegram Bot API file_path values. Exact in-root paths are read directly; container paths under /var/lib/telegram-bot-api can map into a host volume mount. Other absolute paths are rejected.",
  },
  autoTopicLabel: {
    label: "Telegram Auto Topic Label",
    help: "Auto-rename DM forum topics on first message using LLM. Default: true. Set to false to disable, or use object form { enabled: true, prompt: '...' } for custom prompt.",
  },
  "autoTopicLabel.enabled": {
    label: "Telegram Auto Topic Label Enabled",
    help: "Whether auto topic labeling is enabled. Default: true.",
  },
  "autoTopicLabel.prompt": {
    label: "Telegram Auto Topic Label Prompt",
    help: "Custom prompt for LLM-based topic naming. The user message is appended after the prompt.",
  },
  "capabilities.inlineButtons": {
    label: "Telegram Inline Buttons",
    help: "Enable Telegram inline button components for supported command and interaction surfaces. Disable if your deployment needs plain-text-only compatibility behavior.",
  },
  execApprovals: {
    label: "Telegram Exec Approvals",
    help: "Telegram-native exec approval routing and approver authorization. When unset, OpenClaw auto-enables DM-first native approvals if approvers can be resolved for the selected bot account.",
  },
  "execApprovals.enabled": {
    label: "Telegram Exec Approvals Enabled",
    help: 'Controls Telegram native exec approvals for this account: unset or "auto" enables DM-first native approvals when approvers can be resolved, true forces native approvals on, and false disables them.',
  },
  "execApprovals.approvers": {
    label: "Telegram Exec Approval Approvers",
    help: "Telegram user IDs allowed to approve exec requests for this bot account. Use numeric Telegram user IDs. If you leave this unset, OpenClaw falls back to numeric owner IDs inferred from commands.ownerAllowFrom when possible.",
  },
  "execApprovals.agentFilter": {
    label: "Telegram Exec Approval Agent Filter",
    help: 'Optional allowlist of agent IDs eligible for Telegram exec approvals, for example `["main", "ops-agent"]`. Use this to keep approval prompts scoped to the agents you actually operate from Telegram.',
  },
  "execApprovals.sessionFilter": {
    label: "Telegram Exec Approval Session Filter",
    help: "Optional session-key filters matched as substring or regex-style patterns before Telegram approval routing is used. Use narrow patterns so Telegram approvals only appear for intended sessions.",
  },
  "execApprovals.target": {
    label: "Telegram Exec Approval Target",
    help: 'Controls where Telegram approval prompts are sent: "dm" sends to approver DMs (default), "channel" sends to the originating Telegram chat/topic, and "both" sends to both. Channel delivery exposes the command text to the chat, so only use it in trusted groups/topics.',
  },
  "threadBindings.enabled": {
    label: "Telegram Thread Binding Enabled",
    help: "Enable Telegram conversation-bound session spawning, routing, and delivery. Manage bindings with /agents and /session unbind|idle|max-age. Overrides session.threadBindings.enabled when set.",
  },
  "threadBindings.idleHours": {
    label: "Telegram Thread Binding Idle Timeout (hours)",
    help: "Inactivity window in hours for Telegram bound sessions. Set 0 to disable idle expiry (default: 24). Overrides session.threadBindings.idleHours when set.",
  },
  "threadBindings.maxAgeHours": {
    label: "Telegram Thread Binding Max Age (hours)",
    help: "Optional hard max age in hours for Telegram bound sessions. Set 0 to disable hard cap (default: 0). Overrides session.threadBindings.maxAgeHours when set.",
  },
  "threadBindings.spawnSessions": {
    label: "Telegram Thread-Bound Session Spawn",
    help: "Allow sessions_spawn(thread=true) and ACP thread spawns to auto-bind Telegram current conversations when supported.",
  },
  "threadBindings.defaultSpawnContext": {
    label: "Telegram Thread Spawn Context",
    help: 'Default native subagent context for thread-bound spawns. "fork" starts from the requester transcript; "isolated" starts clean. Default: "fork".',
  },
} satisfies Record<string, ChannelConfigUiHint>;
