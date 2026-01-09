import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";

export function buildAgentSystemPrompt(params: {
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  reasoningTagHint?: boolean;
  toolNames?: string[];
  modelAliasLines?: string[];
  userTimezone?: string;
  userTime?: string;
  contextFiles?: EmbeddedContextFile[];
  heartbeatPrompt?: string;
  runtimeInfo?: {
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
  };
  sandboxInfo?: {
    enabled: boolean;
    workspaceDir?: string;
    workspaceAccess?: "none" | "ro" | "rw";
    agentWorkspaceMount?: string;
    browserControlUrl?: string;
    browserNoVncUrl?: string;
  };
}) {
  const toolSummaries: Record<string, string> = {
    read: "Read file contents",
    write: "Create or overwrite files",
    edit: "Make precise edits to files",
    grep: "Search file contents for patterns",
    find: "Find files by glob pattern",
    ls: "List directory contents",
    bash: "Run shell commands",
    process: "Manage background bash sessions",
    whatsapp_login: "Generate and wait for WhatsApp QR login",
    browser: "Control web browser",
    canvas: "Present/eval/snapshot the Canvas",
    nodes: "List/describe/notify/camera/screen on paired nodes",
    cron: "Manage cron jobs and wake events",
    gateway:
      "Restart, apply config, or run updates on the running Clawdbot process",
    agents_list: "List agent ids allowed for sessions_spawn",
    sessions_list: "List other sessions (incl. sub-agents) with filters/last",
    sessions_history: "Fetch history for another session/sub-agent",
    sessions_send: "Send a message to another session/sub-agent",
    sessions_spawn: "Spawn a sub-agent session",
    image: "Analyze an image with the configured image model",
    discord: "Send Discord reactions/messages and manage threads",
    slack: "Send Slack messages and manage channels",
    telegram: "Send Telegram reactions",
    whatsapp: "Send WhatsApp reactions",
  };

  const toolOrder = [
    "read",
    "write",
    "edit",
    "grep",
    "find",
    "ls",
    "bash",
    "process",
    "whatsapp_login",
    "browser",
    "canvas",
    "nodes",
    "cron",
    "gateway",
    "agents_list",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "image",
    "discord",
    "slack",
    "telegram",
    "whatsapp",
  ];

  const normalizedTools = (params.toolNames ?? [])
    .map((tool) => tool.trim().toLowerCase())
    .filter(Boolean);
  const availableTools = new Set(normalizedTools);
  const extraTools = Array.from(
    new Set(normalizedTools.filter((tool) => !toolOrder.includes(tool))),
  );
  const enabledTools = toolOrder.filter((tool) => availableTools.has(tool));
  const toolLines = enabledTools.map((tool) => {
    const summary = toolSummaries[tool];
    return summary ? `- ${tool}: ${summary}` : `- ${tool}`;
  });
  for (const tool of extraTools.sort()) {
    toolLines.push(`- ${tool}`);
  }

  const hasGateway = availableTools.has("gateway");
  const extraSystemPrompt = params.extraSystemPrompt?.trim();
  const ownerNumbers = (params.ownerNumbers ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  const ownerLine =
    ownerNumbers.length > 0
      ? `Owner numbers: ${ownerNumbers.join(", ")}. Treat messages from these numbers as the user.`
      : undefined;
  const reasoningHint = params.reasoningTagHint
    ? [
        "ALL internal reasoning MUST be inside <think>...</think>.",
        "Do not output any analysis outside <think>.",
        "Format every reply as <think>...</think> then <final>...</final>, with no other text.",
        "Only the final user-visible reply may appear inside <final>.",
        "Only text inside <final> is shown to the user; everything else is discarded and never seen by the user.",
        "Example:",
        "<think>Short internal reasoning.</think>",
        "<final>Hey there! What would you like to do next?</final>",
      ].join(" ")
    : undefined;
  const userTimezone = params.userTimezone?.trim();
  const userTime = params.userTime?.trim();
  const heartbeatPrompt = params.heartbeatPrompt?.trim();
  const heartbeatPromptLine = heartbeatPrompt
    ? `Heartbeat prompt: ${heartbeatPrompt}`
    : "Heartbeat prompt: (configured)";
  const runtimeInfo = params.runtimeInfo;

  const lines = [
    "You are a personal assistant running inside Clawdbot.",
    "",
    "## Tooling",
    "Tool availability (filtered by policy):",
    toolLines.length > 0
      ? toolLines.join("\n")
      : [
          "Pi lists the standard tools above. This runtime enables:",
          "- grep: search file contents for patterns",
          "- find: find files by glob pattern",
          "- ls: list directory contents",
          "- bash: run shell commands (supports background via yieldMs/background)",
          "- process: manage background bash sessions",
          "- whatsapp_login: generate a WhatsApp QR code and wait for linking",
          "- browser: control clawd's dedicated browser",
          "- canvas: present/eval/snapshot the Canvas",
          "- nodes: list/describe/notify/camera/screen on paired nodes",
          "- cron: manage cron jobs and wake events",
          "- sessions_list: list sessions",
          "- sessions_history: fetch session history",
          "- sessions_send: send to another session",
        ].join("\n"),
    "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
    "If a task is more complex or takes longer, spawn a sub-agent. It will do the work for you and ping you when it's done. You can always check up on it.",
    "",
    "## Skills",
    `Skills provide task-specific instructions. Use \`read\` to load from ${params.workspaceDir}/skills/<name>/SKILL.md when needed.`,
    "",
    hasGateway ? "## Clawdbot Self-Update" : "",
    hasGateway
      ? [
          "Get Updates (self-update) is ONLY allowed when the user explicitly asks for it.",
          "Do not run config.apply or update.run unless the user explicitly requests an update or config change; if it's not explicit, ask first.",
          "Actions: config.get, config.schema, config.apply (validate + write full config, then restart), update.run (update deps or git, then restart).",
          "After restart, Clawdbot pings the last active session automatically.",
        ].join("\n")
      : "",
    hasGateway ? "" : "",
    "",
    params.modelAliasLines && params.modelAliasLines.length > 0
      ? "## Model Aliases"
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0
      ? "Prefer aliases when specifying model overrides; full provider/model is also accepted."
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0
      ? params.modelAliasLines.join("\n")
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 ? "" : "",
    "## Workspace",
    `Your working directory is: ${params.workspaceDir}`,
    "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.",
    "",
    params.sandboxInfo?.enabled ? "## Sandbox" : "",
    params.sandboxInfo?.enabled
      ? [
          "Tool execution is isolated in a Docker sandbox.",
          "Some tools may be unavailable due to sandbox policy.",
          params.sandboxInfo.workspaceDir
            ? `Sandbox workspace: ${params.sandboxInfo.workspaceDir}`
            : "",
          params.sandboxInfo.workspaceAccess
            ? `Agent workspace access: ${params.sandboxInfo.workspaceAccess}${
                params.sandboxInfo.agentWorkspaceMount
                  ? ` (mounted at ${params.sandboxInfo.agentWorkspaceMount})`
                  : ""
              }`
            : "",
          params.sandboxInfo.browserControlUrl
            ? `Sandbox browser control URL: ${params.sandboxInfo.browserControlUrl}`
            : "",
          params.sandboxInfo.browserNoVncUrl
            ? `Sandbox browser observer (noVNC): ${params.sandboxInfo.browserNoVncUrl}`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    params.sandboxInfo?.enabled ? "" : "",
    ownerLine ? "## User Identity" : "",
    ownerLine ?? "",
    ownerLine ? "" : "",
    "## Workspace Files (injected)",
    "These user-editable files are loaded by Clawdbot and included below in Project Context.",
    "",
    userTimezone || userTime
      ? `Time: assume UTC unless stated. User TZ=${userTimezone ?? "unknown"}. Current user time (converted)=${userTime ?? "unknown"}.`
      : "",
    userTimezone || userTime ? "" : "",
    "## Reply Tags",
    "To request a native reply/quote on supported surfaces, include one tag in your reply:",
    "- [[reply_to_current]] replies to the triggering message.",
    "- [[reply_to:<id>]] replies to a specific message id when you have it.",
    "Whitespace inside the tag is allowed (e.g. [[ reply_to_current ]] / [[ reply_to: 123 ]]).",
    "Tags are stripped before sending; support depends on the current provider config.",
    "",
    "## Messaging",
    "- Reply in current session → automatically routes to the source provider (Signal, Telegram, etc.)",
    "- Cross-session messaging → use sessions_send(sessionKey, message)",
    "- Never use bash/curl for provider messaging; Clawdbot handles all routing internally.",
    "",
  ];

  if (extraSystemPrompt) {
    lines.push("## Group Chat Context", extraSystemPrompt, "");
  }
  if (reasoningHint) {
    lines.push("## Reasoning Format", reasoningHint, "");
  }

  const contextFiles = params.contextFiles ?? [];
  if (contextFiles.length > 0) {
    lines.push(
      "# Project Context",
      "",
      "The following project context files have been loaded:",
      "",
    );
    for (const file of contextFiles) {
      lines.push(`## ${file.path}`, "", file.content, "");
    }
  }

  lines.push(
    "## Heartbeats",
    heartbeatPromptLine,
    "If you receive a heartbeat poll (a user message matching the heartbeat prompt above), and there is nothing that needs attention, reply exactly:",
    "HEARTBEAT_OK",
    'Clawdbot treats a leading/trailing "HEARTBEAT_OK" as a heartbeat ack (and may discard it).',
    'If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.',
    "",
    "## Runtime",
    `Runtime: ${[
      runtimeInfo?.host ? `host=${runtimeInfo.host}` : "",
      runtimeInfo?.os
        ? `os=${runtimeInfo.os}${runtimeInfo?.arch ? ` (${runtimeInfo.arch})` : ""}`
        : runtimeInfo?.arch
          ? `arch=${runtimeInfo.arch}`
          : "",
      runtimeInfo?.node ? `node=${runtimeInfo.node}` : "",
      runtimeInfo?.model ? `model=${runtimeInfo.model}` : "",
      `thinking=${params.defaultThinkLevel ?? "off"}`,
    ]
      .filter(Boolean)
      .join(" | ")}`,
  );

  return lines.filter(Boolean).join("\n");
}
