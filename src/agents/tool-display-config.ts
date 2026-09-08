/**
 * Tool display metadata registry.
 *
 * Agent UIs use this config to map tool names/actions to stable titles,
 * icons, and detail keys without embedding presentation data in tool handlers.
 */
import type { ToolDisplaySpec as ToolDisplaySpecBase } from "./tool-display-common.js";
import { MESSAGE_TOOL_DISPLAY_SPEC } from "./tool-display-message-config.js";

type ToolDisplaySpec = ToolDisplaySpecBase & {
  emoji?: string;
};

type ToolDisplayConfig = {
  version: number;
  fallback: ToolDisplaySpec;
  tools: Record<string, ToolDisplaySpec>;
};

function displayAction(label: string, detailKeys?: string[]) {
  return detailKeys === undefined ? { label } : { label, detailKeys };
}

/** Static display metadata for known tools plus fallback detail-key selection. */
export const TOOL_DISPLAY_CONFIG: ToolDisplayConfig = {
  version: 1,
  fallback: {
    emoji: "🧩",
    detailKeys: [
      "command",
      "path",
      "url",
      "targetUrl",
      "targetId",
      "ref",
      "element",
      "node",
      "nodeId",
      "id",
      "requestId",
      "to",
      "channelId",
      "guildId",
      "userId",
      "name",
      "query",
      "pattern",
      "messageId",
    ],
  },
  tools: {
    bash: {
      emoji: "🛠️",
      title: "Bash",
      detailKeys: ["command"],
    },
    computer: {
      emoji: "🖱️",
      title: "Computer",
      detailKeys: ["action", "coordinate", "text", "node", "nodeId", "screenIndex"],
    },
    mobile_ui: {
      emoji: "📱",
      title: "Mobile UI",
      detailKeys: ["action", "mobileAction", "snapshotId", "node", "nodeId"],
    },
    screen: {
      emoji: "🖥️",
      title: "Screen",
      detailKeys: ["action", "sessionKey", "dock"],
    },
    terminal: {
      emoji: "⌨️",
      title: "Terminal",
      detailKeys: ["action", "sessionId", "command", "cwd"],
    },
    portal: {
      emoji: "🌐",
      title: "Portal",
      detailKeys: ["action", "port", "id", "title", "path"],
    },
    process: {
      emoji: "🧰",
      title: "Process",
      detailKeys: ["sessionId"],
    },
    gateway_process: {
      emoji: "🧰",
      title: "Background Shell",
      detailKeys: ["action", "sessionId"],
    },
    read: {
      emoji: "📖",
      title: "Read",
      detailKeys: ["path"],
    },
    write: {
      emoji: "✍️",
      title: "Write",
      detailKeys: ["path"],
    },
    edit: {
      emoji: "📝",
      title: "Edit",
      detailKeys: ["path"],
    },
    attach: {
      emoji: "📎",
      title: "Attach",
      detailKeys: ["path", "url", "fileName"],
    },
    api: {
      emoji: "🌐",
      title: "API",
      detailKeys: ["url", "endpoint", "path", "method", "name"],
    },
    browser: {
      emoji: "🌐",
      title: "Browser",
      actions: {
        status: displayAction("status"),
        start: displayAction("start"),
        stop: displayAction("stop"),
        tabs: displayAction("tabs"),
        open: displayAction("open", ["targetUrl"]),
        focus: displayAction("focus", ["targetId"]),
        close: displayAction("close", ["targetId"]),
        snapshot: displayAction("snapshot", ["targetUrl", "targetId", "ref", "element", "format"]),
        screenshot: displayAction("screenshot", ["targetUrl", "targetId", "ref", "element"]),
        navigate: displayAction("navigate", ["targetUrl", "targetId"]),
        console: displayAction("console", ["level", "targetId"]),
        pdf: displayAction("pdf", ["targetId"]),
        upload: displayAction("upload", ["paths", "ref", "inputRef", "element", "targetId"]),
        dialog: displayAction("dialog", ["accept", "promptText", "targetId"]),
        act: displayAction("act", [
          "request.kind",
          "request.ref",
          "request.selector",
          "request.text",
          "request.value",
        ]),
      },
    },
    canvas: {
      emoji: "🖼️",
      title: "Canvas",
      actions: {
        present: displayAction("present", ["target", "node", "nodeId"]),
        hide: displayAction("hide", ["node", "nodeId"]),
        navigate: displayAction("navigate", ["url", "node", "nodeId"]),
      },
    },
    dashboard: {
      emoji: "📋",
      title: "Dashboard",
      detailKeys: ["action", "tabId", "name", "title"],
    },
    nodes: {
      emoji: "📱",
      title: "Nodes",
      actions: {
        status: displayAction("status"),
        describe: displayAction("describe", ["node", "nodeId"]),
        pending: displayAction("pending"),
        approve: displayAction("approve", ["requestId"]),
        reject: displayAction("reject", ["requestId"]),
        notify: displayAction("notify", ["node", "nodeId", "title", "body"]),
        camera_snap: displayAction("camera snap", ["node", "nodeId", "facing", "deviceId"]),
        camera_list: displayAction("camera list", ["node", "nodeId"]),
        camera_clip: displayAction("camera clip", [
          "node",
          "nodeId",
          "facing",
          "duration",
          "durationMs",
        ]),
        camera_ptz: displayAction("camera PTZ", ["ptzOperation", "node", "nodeId", "deviceId"]),
        screen_record: displayAction("screen record", [
          "node",
          "nodeId",
          "duration",
          "durationMs",
          "fps",
          "screenIndex",
        ]),
        screen_snapshot: displayAction("screen snapshot", [
          "node",
          "nodeId",
          "screenIndex",
          "maxWidth",
        ]),
      },
    },
    cron: {
      emoji: "⏰",
      title: "Cron",
      actions: {
        status: displayAction("status"),
        list: displayAction("list"),
        add: displayAction("add", ["job.name", "job.id", "job.schedule", "job.cron"]),
        update: displayAction("update", ["id"]),
        remove: displayAction("remove", ["id"]),
        run: displayAction("run", ["id"]),
        runs: displayAction("runs", ["id"]),
        wake: displayAction("wake", ["text", "mode"]),
      },
    },
    get_goal: {
      emoji: "🎯",
      title: "Get Goal",
      detailKeys: [],
    },
    create_goal: {
      emoji: "🎯",
      title: "Create Goal",
      detailKeys: ["objective", "token_budget"],
    },
    update_goal: {
      emoji: "🎯",
      title: "Update Goal",
      detailKeys: ["status"],
    },
    progress_card: {
      emoji: "🗺️",
      title: "Progress Card",
    },
    ask_user: {
      emoji: "❓",
      title: "Ask User",
      detailKeys: ["questions.0.question"],
    },
    secrets: {
      emoji: "🔑",
      title: "Secrets",
      detailKeys: ["action", "name", "kind"],
    },
    suggest_task: {
      emoji: "✨",
      title: "Suggest Task",
      detailKeys: ["title", "tldr", "cwd"],
    },
    dismiss_task: {
      emoji: "🗑️",
      title: "Dismiss Task",
      detailKeys: ["task_id", "reason"],
    },
    skill_workshop: {
      emoji: "🧰",
      title: "Skill Workshop",
      detailKeys: ["action", "name", "proposal_id"],
    },
    openclaw: {
      emoji: "🦀",
      title: "OpenClaw",
      detailKeys: ["action", "path", "model"],
    },
    gateway: {
      emoji: "🔌",
      title: "Gateway",
      detailKeys: ["action", "path"],
    },
    exec: {
      emoji: "🛠️",
      title: "Exec",
      detailKeys: ["command"],
    },
    tool_call: {
      emoji: "🧰",
      title: "Tool Call",
      detailKeys: [],
    },
    tool_call_update: {
      emoji: "🧰",
      title: "Tool Call",
      detailKeys: [],
    },
    session_status: {
      emoji: "📊",
      title: "Session Status",
      detailKeys: ["sessionKey", "model"],
    },
    github_publish: {
      emoji: "🔀",
      title: "GitHub Publish",
      detailKeys: ["title"],
    },
    github_identity_status: {
      emoji: "🔐",
      title: "GitHub Identity Status",
      detailKeys: [],
    },
    sessions: {
      emoji: "🗂️",
      title: "Session Settings",
      actions: {
        patch: displayAction("update", [
          "sessionKey",
          "label",
          "pinned",
          "archived",
          "model",
          "thinkingLevel",
        ]),
        group_list: displayAction("groups"),
        group_set: displayAction("set groups", ["names"]),
        group_rename: displayAction("rename group", ["name", "to"]),
        group_delete: displayAction("delete group", ["name"]),
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
        start: displayAction("start", [
          "sessionId",
          "title",
          "providerId",
          "accountId",
          "guildId",
          "channelId",
          "meetingUrl",
        ]),
        stop: displayAction("stop", ["sessionId"]),
        status: displayAction("status"),
        import: displayAction("import", [
          "sessionId",
          "title",
          "providerId",
          "meetingUrl",
          "speakerLabel",
        ]),
        summarize: displayAction("summarize", ["sessionId"]),
      },
    },
    sessions_spawn: {
      emoji: "🧑‍🔧",
      title: "Sub-agent",
      detailKeys: ["label", "task", "agentId", "model", "thinking", "runTimeoutSeconds", "cleanup"],
    },
    agents_wait: { emoji: "⏳", title: "Wait for Agents", detailKeys: ["ids", "timeoutSeconds"] },
    structured_output: { emoji: "🧾", title: "Structured Output", detailKeys: ["result"] },
    subagents: {
      emoji: "🤖",
      title: "Subagents",
      actions: {
        list: displayAction("list", ["recentMinutes"]),
        kill: displayAction("kill", ["target"]),
        steer: displayAction("steer", ["target"]),
      },
    },
    agents_list: {
      emoji: "🧭",
      title: "Agents",
      detailKeys: [],
    },
    memory_search: {
      emoji: "🧠",
      title: "Memory Search",
      detailKeys: ["query"],
    },
    memory_get: {
      emoji: "📓",
      title: "Memory Get",
      detailKeys: ["path", "from", "lines"],
    },
    web_search: {
      emoji: "🔎",
      title: "Web Search",
      detailKeys: ["query", "count"],
    },
    web_fetch: {
      emoji: "📄",
      title: "Web Fetch",
      detailKeys: ["url", "extractMode", "maxChars"],
    },
    code_execution: {
      emoji: "🧮",
      title: "Code Execution",
      detailKeys: ["task"],
    },
    message: MESSAGE_TOOL_DISPLAY_SPEC,
    apply_patch: {
      emoji: "🩹",
      title: "Apply Patch",
      detailKeys: [],
    },
    // Historical transcripts retain the old name. This display-only entry
    // preserves their presentation without restoring a runtime tool alias.
    image: {
      emoji: "🖼️",
      title: "Image",
      detailKeys: ["path", "paths", "url", "urls", "prompt", "model"],
    },
    view_image: {
      emoji: "🖼️",
      title: "View Image",
      detailKeys: ["path", "paths", "url", "urls", "prompt", "model"],
    },
    image_generate: {
      emoji: "🎨",
      title: "Image Generation",
      actions: {
        generate: displayAction("generate", [
          "prompt",
          "model",
          "count",
          "resolution",
          "aspectRatio",
        ]),
        list: displayAction("list", ["provider", "model"]),
      },
    },
    music_generate: {
      emoji: "🎵",
      title: "Music Generation",
      actions: {
        generate: displayAction("generate", [
          "prompt",
          "model",
          "durationSeconds",
          "format",
          "instrumental",
        ]),
        list: displayAction("list", ["provider", "model"]),
      },
    },
    video_generate: {
      emoji: "🎬",
      title: "Video Generation",
      actions: {
        generate: displayAction("generate", [
          "prompt",
          "model",
          "durationSeconds",
          "resolution",
          "aspectRatio",
          "audio",
          "watermark",
        ]),
        list: displayAction("list", ["provider", "model"]),
      },
    },
    pdf: {
      emoji: "📑",
      title: "PDF",
      detailKeys: ["path", "paths", "url", "urls", "prompt", "pageRange", "model"],
    },
    sessions_yield: { emoji: "⏸️", title: "Yield" },
    tts: { emoji: "🔊", title: "TTS", detailKeys: ["text", "channel"] },
  },
};
