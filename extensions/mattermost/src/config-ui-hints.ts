import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
// Mattermost helper module supports config ui hints behavior.
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const mattermostChannelConfigUiHints = {
  "": {
    label: "Mattermost",
    help: "Mattermost channel provider configuration for bot auth, access policy, slash commands, and preview streaming.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "Mattermost",
    dmPolicy: { channelKey: "mattermost" },
    implicitMentions: true,
  }),
  streaming: {
    label: "Mattermost Streaming Mode",
    help: 'Unified Mattermost stream preview mode: "off" | "partial" | "block" | "progress". "progress" keeps a single editable progress draft until final delivery.',
  },
  "streaming.mode": {
    label: "Mattermost Streaming Mode",
    help: 'Canonical Mattermost preview mode: "off" | "partial" | "block" | "progress".',
  },
  ...createChannelConfigUiHints({ channelLabel: "Mattermost", progress: {} }),
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
