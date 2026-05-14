import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const matrixChannelConfigUiHints = {
  allowBots: {
    label: "Matrix Allow Bot Messages",
    help: 'Allow messages from other configured Matrix bot accounts to trigger replies (default: false). Set "mentions" to require a visible room mention.',
  },
  botLoopProtection: {
    label: "Matrix Bot Loop Protection",
    help: "Sliding-window guard for accepted Matrix configured-bot loops. Default is enabled whenever allowBots lets configured bot messages reach dispatch.",
  },
  "botLoopProtection.enabled": {
    label: "Matrix Bot Loop Protection Enabled",
    help: 'Enable the bot-pair loop guard. Defaults to true when allowBots is true or "mentions", and false when configured bot messages are ignored.',
  },
  "botLoopProtection.maxEventsPerWindow": {
    label: "Matrix Bot Loop Events per Window",
    help: "Maximum accepted bot-pair messages within the sliding window before suppression starts. Default: 20.",
  },
  "botLoopProtection.windowSeconds": {
    label: "Matrix Bot Loop Window Seconds",
    help: "Sliding window length for counting bot-pair messages. Default: 60.",
  },
  "botLoopProtection.cooldownSeconds": {
    label: "Matrix Bot Loop Cooldown Seconds",
    help: "How long to suppress the bot pair after it exceeds the budget. Default: 60.",
  },
  dangerouslyAllowNameMatching: {
    label: "Matrix Display Name Matching",
    help: "Compatibility opt-in for resolving Matrix display names and joined room names in allowlists. Prefer full @user:server IDs and room IDs or aliases because names are mutable.",
  },
  "streaming.progress.label": {
    label: "Matrix Progress Label",
    help: 'Initial progress draft title. Use "auto" for built-in single-word labels, a custom string, or false to hide the title.',
  },
  "streaming.progress.labels": {
    label: "Matrix Progress Label Pool",
    help: 'Candidate labels for streaming.progress.label="auto". Leave unset to use OpenClaw built-in progress labels.',
  },
  "streaming.progress.maxLines": {
    label: "Matrix Progress Max Lines",
    help: "Maximum number of compact progress lines to keep below the draft label (default: 8).",
  },
  "streaming.progress.toolProgress": {
    label: "Matrix Progress Tool Lines",
    help: "Show compact tool/progress lines in progress draft mode (default: true). Set false to keep only the label until final delivery.",
  },
  "streaming.progress.commandText": {
    label: "Matrix Progress Command Text",
    help: 'Command/exec detail in progress draft lines: "raw" preserves released behavior; "status" shows only the tool label.',
  },
} satisfies Record<string, ChannelConfigUiHint>;
