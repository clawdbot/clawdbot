import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const matrixChannelConfigUiHints = {
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
