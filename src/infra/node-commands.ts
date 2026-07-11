// Node tool command names shared by routing, auth, and approval surfaces.
export const NODE_SYSTEM_RUN_COMMANDS = [
  "system.run.prepare",
  "system.run",
  "system.which",
] as const;

export const NODE_SYSTEM_NOTIFY_COMMAND = "system.notify";
export const NODE_BROWSER_PROXY_COMMAND = "browser.proxy";
export const NODE_MCP_TOOLS_CALL_COMMAND = "mcp.tools.call.v1";
export const NODE_MCP_TOOL_CALL_TIMEOUT_MS = 120_000;
export const NODE_MCP_TOOL_CALL_GATEWAY_TIMEOUT_MS = NODE_MCP_TOOL_CALL_TIMEOUT_MS + 5_000;

export const NODE_EXEC_APPROVALS_COMMANDS = [
  "system.execApprovals.get",
  "system.execApprovals.set",
] as const;
