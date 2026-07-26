import type { ToolDisplayRegistry } from "./tool-display-config.types.js";

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
} satisfies ToolDisplayRegistry;
