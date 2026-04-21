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
  dmPolicy: {
    label: "Telegram DM Policy",
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.telegram.allowFrom=["*"].',
  },
  configWrites: {
    label: "Telegram Config Writes",
    help: "Allow Telegram to write config in response to channel events/commands (default: true).",
  },
  "commands.native": {
    label: "Telegram Native Commands",
    help: 'Override native commands for Telegram (bool or "auto").',
  },
  "commands.nativeSkills": {
    label: "Telegram Native Skill Commands",
    help: 'Override native skill commands for Telegram (bool or "auto").',
  },
  streaming: {
    label: "Telegram Streaming Mode",
    help: 'Unified Telegram stream preview mode: "off" | "partial" | "block" | "progress" (default: "partial"). "progress" maps to "partial" on Telegram. Legacy boolean/streamMode keys are auto-mapped.',
  },
  "streaming.mode": {
    label: "Telegram Streaming Mode",
    help: 'Canonical Telegram preview mode: "off" | "partial" | "block" | "progress" (default: "partial"). "progress" maps to "partial" on Telegram.',
  },
  "streaming.chunkMode": {
    label: "Telegram Chunk Mode",
    help: 'Chunking mode for outbound Telegram text delivery: "length" (default) or "newline".',
  },
  "streaming.block.enabled": {
    label: "Telegram Block Streaming Enabled",
    help: 'Enable chunked block-style Telegram preview delivery when channels.telegram.streaming.mode="block".',
  },
  "streaming.block.coalesce": {
    label: "Telegram Block Streaming Coalesce",
    help: "Merge streamed Telegram block replies before sending final delivery.",
  },
  "streaming.preview.chunk.minChars": {
    label: "Telegram Draft Chunk Min Chars",
    help: 'Minimum chars before emitting a Telegram block preview chunk when channels.telegram.streaming.mode="block".',
  },
  "streaming.preview.chunk.maxChars": {
    label: "Telegram Draft Chunk Max Chars",
    help: 'Target max size for a Telegram block preview chunk when channels.telegram.streaming.mode="block".',
  },
  "streaming.preview.chunk.breakPreference": {
    label: "Telegram Draft Chunk Break Preference",
    help: "Preferred breakpoints for Telegram draft chunks (paragraph | newline | sentence).",
  },
  "retry.attempts": {
    label: "Telegram Retry Attempts",
    help: "Max retry attempts for outbound Telegram API calls (default: 3).",
  },
  "retry.minDelayMs": {
    label: "Telegram Retry Min Delay (ms)",
    help: "Minimum retry delay in ms for Telegram outbound calls.",
  },
  "retry.maxDelayMs": {
    label: "Telegram Retry Max Delay (ms)",
    help: "Maximum retry delay cap in ms for Telegram outbound calls.",
  },
  "retry.jitter": {
    label: "Telegram Retry Jitter",
    help: "Jitter factor (0-1) applied to Telegram retry delays.",
  },
  "network.autoSelectFamily": {
    label: "Telegram autoSelectFamily",
    help: "Override Node autoSelectFamily for Telegram (true=enable, false=disable).",
  },
  "network.dangerouslyAllowPrivateNetwork": {
    label: "Telegram Dangerously Allow Private Network",
    help: "Dangerous opt-in for trusted fake-IP or transparent-proxy environments where Telegram media downloads resolve api.telegram.org to private/internal/special-use addresses.",
  },
  timeoutSeconds: {
    label: "Telegram API Timeout (seconds)",
    help: "Max seconds before Telegram API requests are aborted (default: 500 per grammY).",
  },
  pollingStallThresholdMs: {
    label: "Telegram Polling Stall Threshold (ms)",
    help: "Milliseconds without completed Telegram getUpdates liveness before the polling watchdog restarts the polling runner. Default: 120000.",
  },
  silentErrorReplies: {
    label: "Telegram Silent Error Replies",
    help: "When true, Telegram bot replies marked as errors are sent silently (no notification sound). Default: false.",
  },
  apiRoot: {
    label: "Telegram API Root URL",
    help: "Custom Telegram Bot API root URL. Use for self-hosted Bot API servers (https://github.com/tdlib/telegram-bot-api) or reverse proxies in regions where api.telegram.org is blocked.",
  },
  trustedLocalFileRoots: {
    label: "Telegram Trusted Local File Roots",
    help: "Trusted local filesystem roots for self-hosted Telegram Bot API absolute file_path values. Only absolute paths inside these roots are read directly; all other absolute paths are rejected.",
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
    help: "Telegram user IDs allowed to approve exec requests for this bot account. Use numeric Telegram user IDs. If you leave this unset, OpenClaw falls back to numeric owner IDs inferred from channels.telegram.allowFrom and direct-message defaultTo when possible.",
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
    help: "Enable Telegram conversation binding features (/focus, /unfocus, /agents, and /session idle|max-age). Overrides session.threadBindings.enabled when set.",
  },
  "threadBindings.idleHours": {
    label: "Telegram Thread Binding Idle Timeout (hours)",
    help: "Inactivity window in hours for Telegram bound sessions. Set 0 to disable idle auto-unfocus (default: 24). Overrides session.threadBindings.idleHours when set.",
  },
  "threadBindings.maxAgeHours": {
    label: "Telegram Thread Binding Max Age (hours)",
    help: "Optional hard max age in hours for Telegram bound sessions. Set 0 to disable hard cap (default: 0). Overrides session.threadBindings.maxAgeHours when set.",
  },
  "threadBindings.spawnSubagentSessions": {
    label: "Telegram Thread-Bound Subagent Spawn",
    help: "Allow subagent spawns with thread=true to auto-bind Telegram current conversations when supported.",
  },
  "threadBindings.spawnAcpSessions": {
    label: "Telegram Thread-Bound ACP Spawn",
    help: "Allow ACP spawns with thread=true to auto-bind Telegram current conversations when supported.",
  },
} satisfies Record<string, ChannelConfigUiHint>;
