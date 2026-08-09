import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

const progressFinalDeliveryHint = {
  label: "Mattermost Progress Final Delivery",
  help: 'Use "in-place" (default) to replace the progress post with the final answer, or "separate" to send a normal final post and delete the progress post only after delivery succeeds.',
} satisfies ChannelConfigUiHint;

export const mattermostChannelConfigUiHints = {
  "": {
    label: "Mattermost",
    help: "Mattermost channel provider configuration for bot auth, access policy, slash commands, and preview streaming.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "Mattermost",
    dmPolicy: { channelKey: "mattermost" },
    implicitMentions: true,
    streaming: {
      "": 'Unified Mattermost stream preview mode: "off" | "partial" | "block" | "progress". "progress" keeps a single editable progress draft until final delivery.',
      mode: 'Canonical Mattermost preview mode: "off" | "partial" | "block" | "progress".',
      "block.enabled":
        'Enable chunked block-style Mattermost preview delivery when channels.mattermost.streaming.mode="block".',
      "block.coalesce": "Merge streamed Mattermost block replies before final delivery.",
      "preview.toolProgress":
        "Show tool/progress activity in the live draft preview post (default: true). Set false to hide interim tool updates while the draft preview stays active.",
      "preview.commandText":
        'Command/exec detail in preview tool-progress lines: "status" is the safe default; "raw" opts into command text.',
    },
    progress: {},
  }),
  "streaming.progress.finalDelivery": progressFinalDeliveryHint,
  "accounts.*.streaming.progress.finalDelivery": progressFinalDeliveryHint,
} satisfies Record<string, ChannelConfigUiHint>;
