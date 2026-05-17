import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const msTeamsChannelConfigUiHints = {
  "": {
    label: "MS Teams",
    help: "Microsoft Teams channel provider configuration and provider-specific policy toggles. Use this section to isolate Teams behavior from other enterprise chat providers.",
  },
  configWrites: {
    label: "MS Teams Config Writes",
    help: "Allow Microsoft Teams to write config in response to channel events/commands (default: true).",
  },
  streaming: {
    label: "MS Teams Streaming",
    help: 'Microsoft Teams preview/progress streaming mode: "off" | "partial" | "block" | "progress". Personal chats use Teams native streaminfo progress when available.',
  },
  "streaming.progress.label": {
    label: "MS Teams Progress Label",
    help: 'Initial progress title. Use "auto" for built-in single-word labels, a custom string, or false to hide the title.',
  },
  "streaming.progress.labels": {
    label: "MS Teams Progress Label Pool",
    help: 'Candidate labels for streaming.progress.label="auto". Leave unset to use OpenClaw built-in progress labels.',
  },
  "streaming.progress.maxLines": {
    label: "MS Teams Progress Max Lines",
    help: "Maximum number of compact progress lines to keep below the progress title (default: 8).",
  },
  "streaming.progress.maxLineChars": {
    label: "MS Teams Progress Max Line Chars",
    help: "Maximum characters per compact progress line before truncation (default: 120). Prose cuts at word boundaries; commands and paths keep useful suffixes.",
  },
  "streaming.progress.toolProgress": {
    label: "MS Teams Progress Tool Lines",
    help: "Show compact tool/progress lines in progress mode (default: true). Set false to keep only the title until final delivery.",
  },
  "streaming.progress.commandText": {
    label: "MS Teams Progress Command Text",
    help: 'Command/exec detail in progress lines: "raw" preserves released behavior; "status" shows only the tool label.',
  },
} satisfies Record<string, ChannelConfigUiHint>;
