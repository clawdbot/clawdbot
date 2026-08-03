// Slack presentation limits shared by the hot channel facade and lazy renderer.
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";

export const SLACK_ACTION_BLOCK_ELEMENTS_MAX = 25;
export const SLACK_ACTION_LABEL_MAX = 75;
export const SLACK_BUTTON_VALUE_MAX = 2000;
export const SLACK_HEADER_TEXT_MAX = 150;
export const SLACK_OPTION_VALUE_MAX = 150;
export const SLACK_SECTION_TEXT_MAX = 3000;
export const SLACK_STATIC_SELECT_OPTIONS_MAX = 100;

export const SLACK_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  selects: true,
  context: true,
  divider: true,
  charts: true,
  tables: true,
  limits: {
    actions: {
      maxActionsPerRow: SLACK_ACTION_BLOCK_ELEMENTS_MAX,
      maxValueBytes: SLACK_BUTTON_VALUE_MAX,
      supportsStyles: true,
    },
    selects: {
      maxOptions: SLACK_STATIC_SELECT_OPTIONS_MAX,
      maxValueBytes: SLACK_OPTION_VALUE_MAX,
    },
    text: {
      encoding: "characters",
      markdownDialect: "slack-mrkdwn",
      supportsEdit: true,
    },
  },
} satisfies ChannelOutboundAdapter["presentationCapabilities"];
