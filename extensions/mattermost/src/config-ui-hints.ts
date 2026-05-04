import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const mattermostChannelConfigUiHints = {
  "": {
    label: "Mattermost",
    help: "Mattermost channel provider configuration for bot auth, access policy, slash commands, and preview streaming.",
  },
  dmPolicy: {
    label: "Mattermost DM Policy",
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.mattermost.allowFrom=["*"].',
  },
  streaming: {
    label: "Mattermost Streaming Mode",
    help: 'Unified Mattermost stream preview mode: "off" | "partial" | "block" | "progress". "progress" keeps a single editable progress draft until final delivery.',
  },
  "streaming.mode": {
    label: "Mattermost Streaming Mode",
    help: 'Canonical Mattermost preview mode: "off" | "partial" | "block" | "progress".',
  },
  "streaming.progress.label": {
    label: "Mattermost Progress Label",
    help: 'Initial progress draft title. Use "auto" for built-in single-word labels, a custom string, or false to hide the title.',
  },
  "streaming.progress.labels": {
    label: "Mattermost Progress Label Pool",
    help: 'Candidate labels for streaming.progress.label="auto". Leave unset to use OpenClaw built-in progress labels.',
  },
  "streaming.progress.maxLines": {
    label: "Mattermost Progress Max Lines",
    help: "Maximum number of compact progress lines to keep below the draft label (default: 8).",
  },
  "streaming.progress.toolProgress": {
    label: "Mattermost Progress Tool Lines",
    help: "Show compact tool/progress lines in progress draft mode (default: true). Set false to keep only the label until final delivery.",
  },
  "streaming.progress.commandText": {
    label: "Mattermost Progress Command Text",
    help: 'Command/exec detail in progress draft lines: "raw" preserves released behavior; "status" shows only the tool label.',
  },
  "streaming.preview.toolProgress": {
    label: "Mattermost Draft Tool Progress",
    help: "Show tool/progress activity in the live draft preview post (default: true). Set false to hide interim tool updates while the draft preview stays active.",
  },
  "streaming.preview.commandText": {
    label: "Mattermost Draft Command Text",
    help: 'Command/exec detail in preview tool-progress lines: "raw" preserves released behavior; "status" shows only the tool label.',
  },
  "streaming.block.enabled": {
    label: "Mattermost Block Streaming Enabled",
    help: 'Enable chunked block-style Mattermost preview delivery when channels.mattermost.streaming.mode="block".',
  },
  "streaming.block.coalesce": {
    label: "Mattermost Block Streaming Coalesce",
    help: "Merge streamed Mattermost block replies before final delivery.",
  },
} satisfies Record<string, ChannelConfigUiHint>;
