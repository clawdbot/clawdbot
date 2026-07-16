// Node tool command names shared by routing, auth, and approval surfaces.
export const NODE_SYSTEM_RUN_COMMANDS = [
  "system.run.prepare",
  "system.run",
  "system.which",
] as const;

export const NODE_SYSTEM_NOTIFY_COMMAND = "system.notify";
export const NODE_FS_LIST_DIR_COMMAND = "fs.listDir";
export const NODE_TERMINAL_UPLOAD_COMMAND = "terminal.upload";
export const NODE_FILE_COMMANDS = [NODE_FS_LIST_DIR_COMMAND, NODE_TERMINAL_UPLOAD_COMMAND];
export const NODE_BROWSER_PROXY_COMMAND = "browser.proxy";
export const NODE_MCP_TOOLS_CALL_COMMAND = "mcp.tools.call.v1";
export const NODE_AGENT_CLI_CLAUDE_RUN_COMMAND = "agent.cli.claude.run.v1";

// Node duplex heartbeats must arrive before the Gateway relay declares the
// invoke idle, so both processes share this timeout contract.
export const NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS = 30_000;

export const NODE_EXEC_APPROVALS_COMMANDS = [
  "system.execApprovals.get",
  "system.execApprovals.set",
] as const;

// Direct node.invoke and pairing approval share this admin-only subset.
export const NODE_ADMIN_ONLY_INVOKE_COMMANDS = [
  NODE_BROWSER_PROXY_COMMAND,
  NODE_FS_LIST_DIR_COMMAND,
  NODE_TERMINAL_UPLOAD_COMMAND,
] as const;

// Pairing also protects commands whose execution uses a separate gated path.
export const NODE_ADMIN_PAIR_APPROVAL_COMMANDS = [
  ...NODE_SYSTEM_RUN_COMMANDS,
  ...NODE_ADMIN_ONLY_INVOKE_COMMANDS,
  ...NODE_EXEC_APPROVALS_COMMANDS,
] as const;

export const NODE_MCP_TOOL_CALL_TIMEOUT_MS = 120_000;
export const NODE_MCP_TOOL_CALL_GATEWAY_TIMEOUT_MS = NODE_MCP_TOOL_CALL_TIMEOUT_MS + 5_000;
