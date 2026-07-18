import type { ToolDisplaySpec } from "./tool-display-common.js";

type ContinuationToolDisplaySpec = ToolDisplaySpec & {
  emoji?: string;
};

export const CONTINUATION_TOOL_DISPLAY_CONFIG = {
  continue_delegate: {
    emoji: "🔄",
    title: "Continue Delegate",
    detailKeys: ["task", "mode", "delaySeconds"],
  },
  continue_work: {
    emoji: "⏩",
    title: "Continue Work",
    detailKeys: ["reason", "delaySeconds"],
  },
  request_compaction: {
    emoji: "📦",
    title: "Request Compaction",
    detailKeys: ["reason"],
  },
} satisfies Record<string, ContinuationToolDisplaySpec>;
