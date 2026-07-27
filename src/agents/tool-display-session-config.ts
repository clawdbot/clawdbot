import type { ToolDisplayRegistry } from "./tool-display-config.types.js";

export const SESSION_TOOL_DISPLAY_CONFIG = {
  session_status: {
    emoji: "📊",
    title: "Session Status",
    detailKeys: ["sessionKey", "model"],
  },
  sessions: {
    emoji: "🗂️",
    title: "Session Settings",
    actions: {
      patch: {
        label: "update",
        detailKeys: ["sessionKey", "label", "pinned", "archived", "model", "thinkingLevel"],
      },
      group_list: { label: "groups" },
      group_set: { label: "set groups", detailKeys: ["names"] },
      group_rename: { label: "rename group", detailKeys: ["name", "to"] },
      group_delete: { label: "delete group", detailKeys: ["name"] },
    },
  },
  sessions_list: {
    emoji: "🗂️",
    title: "Sessions",
    detailKeys: [
      "kinds",
      "label",
      "agentId",
      "search",
      "limit",
      "activeMinutes",
      "includeDerivedTitles",
      "includeLastMessage",
      "messageLimit",
    ],
  },
  conversations_list: {
    emoji: "💬",
    title: "Conversations",
    detailKeys: ["channel", "limit"],
  },
  conversations_send: {
    emoji: "📨",
    title: "Conversation Send",
    detailKeys: ["conversationRef"],
  },
  conversations_turn: {
    emoji: "↔️",
    title: "Conversation Turn",
    detailKeys: ["conversationRef", "timeoutSeconds"],
  },
  sessions_send: {
    emoji: "📨",
    title: "Session Send",
    detailKeys: ["label", "sessionKey", "agentId", "timeoutSeconds"],
  },
  sessions_history: {
    emoji: "🧾",
    title: "Session History",
    detailKeys: ["sessionKey", "limit", "includeTools"],
  },
  sessions_search: {
    emoji: "🔎",
    title: "Session Search",
    detailKeys: ["query", "sessionKey", "limit"],
  },
  transcripts: {
    emoji: "🎙️",
    title: "Transcripts",
    actions: {
      start: {
        label: "start",
        detailKeys: [
          "sessionId",
          "title",
          "providerId",
          "accountId",
          "guildId",
          "channelId",
          "meetingUrl",
        ],
      },
      stop: {
        label: "stop",
        detailKeys: ["sessionId"],
      },
      status: {
        label: "status",
      },
      import: {
        label: "import",
        detailKeys: ["sessionId", "title", "providerId", "meetingUrl", "speakerLabel"],
      },
      summarize: {
        label: "summarize",
        detailKeys: ["sessionId"],
      },
    },
  },
  sessions_spawn: {
    emoji: "🧑‍🔧",
    title: "Sub-agent",
    detailKeys: ["label", "task", "agentId", "model", "thinking", "runTimeoutSeconds", "cleanup"],
  },
  delegate_artifacts_publish: {
    emoji: "📦",
    title: "Publish Delegate Artifacts",
    detailKeys: [],
  },
  delegate_artifacts: {
    emoji: "📦",
    title: "Delegate Artifacts",
    actions: {
      list: { label: "list" },
      inspect: { label: "inspect", detailKeys: ["claimId"] },
      materialize: {
        label: "materialize",
        detailKeys: ["claimId", "destination"],
      },
      discard: { label: "discard", detailKeys: ["claimId"] },
    },
  },
  agents_wait: { emoji: "⏳", title: "Wait for Agents", detailKeys: ["ids", "timeoutSeconds"] },
  structured_output: { emoji: "🧾", title: "Structured Output", detailKeys: ["result"] },
  subagents: {
    emoji: "🤖",
    title: "Subagents",
    actions: {
      list: {
        label: "list",
        detailKeys: ["recentMinutes"],
      },
      kill: {
        label: "kill",
        detailKeys: ["target"],
      },
      steer: {
        label: "steer",
        detailKeys: ["target"],
      },
    },
  },
  agents_list: {
    emoji: "🧭",
    title: "Agents",
    detailKeys: [],
  },
} satisfies ToolDisplayRegistry;
