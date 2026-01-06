import type { ThinkLevel } from "../auto-reply/thinking.js";

export function buildAgentSystemPromptAppend(params: {
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  reasoningTagHint?: boolean;
  toolNames?: string[];
  userTimezone?: string;
  userTime?: string;
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
    browser: "Control the dedicated clawd browser",
    canvas: "Present/eval/snapshot the Canvas",
    nodes: "List/describe/notify/camera/screen on paired nodes",
    cron: "Manage cron jobs and wake events",
    gateway: "Restart the running Gateway process",
    sessions_list: "List sessions with filters and last messages",
    sessions_history: "Fetch message history for a session",
    sessions_send: "Send a message into another session",
    image: "Analyze an image with the configured image model",
    discord: "Send Discord reactions/messages and manage threads",
    slack: "Send Slack messages and manage channels",
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
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "image",
    "discord",
    "slack",
  ];

  const normalizedTools = (params.toolNames ?? [])
    .map((tool) => tool.trim().toLowerCase())
    .filter(Boolean);
  const availableTools = new Set(normalizedTools);
  const extraTools = Array.from(
    new Set(normalizedTools.filter((tool) => !toolOrder.includes(tool))),
  );
  const enabledTools = toolOrder.filter((tool) => availableTools.has(tool));
  const disabledTools = toolOrder.filter((tool) => !availableTools.has(tool));
  const toolLines = enabledTools.map((tool) => {
    const summary = toolSummaries[tool];
    return summary ? `- ${tool}: ${summary}` : `- ${tool}`;
  });
  for (const tool of extraTools.sort()) {
    toolLines.push(`- ${tool}`);
  }

  const thinkHint =
    params.defaultThinkLevel && params.defaultThinkLevel !== "off"
      ? `Default thinking level: ${params.defaultThinkLevel}.`
      : "Default thinking level: off.";

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
  const runtimeInfo = params.runtimeInfo;
  const runtimeLines: string[] = [];
  if (runtimeInfo?.host) runtimeLines.push(`Host: ${runtimeInfo.host}`);
  if (runtimeInfo?.os) {
    const archSuffix = runtimeInfo.arch ? ` (${runtimeInfo.arch})` : "";
    runtimeLines.push(`OS: ${runtimeInfo.os}${archSuffix}`);
  } else if (runtimeInfo?.arch) {
    runtimeLines.push(`Arch: ${runtimeInfo.arch}`);
  }
  if (runtimeInfo?.node) runtimeLines.push(`Node: ${runtimeInfo.node}`);
  if (runtimeInfo?.model) runtimeLines.push(`Model: ${runtimeInfo.model}`);

  const lines = [
    "You are Clawd, a personal assistant running inside Clawdbot.",
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
    disabledTools.length > 0
      ? `Unavailable tools (do not call): ${disabledTools.join(", ")}`
      : "",
    "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
    "",
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
    "## Messaging Safety",
    "Never send streaming/partial replies to external messaging surfaces; only final replies should be delivered there.",
    "Clawdbot handles message transport automatically; respond normally and your reply will be delivered to the current chat.",
    "",
    userTimezone || userTime ? "## Time" : "",
    userTimezone ? `User timezone: ${userTimezone}` : "",
    userTime ? `Current user time: ${userTime}` : "",
    userTimezone || userTime ? "" : "",
    "## Reply Tags",
    "To request a native reply/quote on supported surfaces, include one tag in your reply:",
    "- [[reply_to_current]] replies to the triggering message.",
    "- [[reply_to:<id>]] replies to a specific message id when you have it.",
    "Tags are stripped before sending; support depends on the current provider config.",
    "",
  ];

  if (extraSystemPrompt) {
    lines.push("## Group Chat Context", extraSystemPrompt, "");
  }
  if (reasoningHint) {
    lines.push("## Reasoning Format", reasoningHint, "");
  }

  lines.push(
    "## Heartbeats",
    'If you receive a heartbeat poll (a user message containing just "HEARTBEAT"), and there is nothing that needs attention, reply exactly:',
    "HEARTBEAT_OK",
    'Clawdbot treats a leading/trailing "HEARTBEAT_OK" as a heartbeat ack (and may discard it).',
    'If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.',
    "",
    "## Runtime",
    ...runtimeLines,
    thinkHint,
  );

  return lines.filter(Boolean).join("\n");
}
