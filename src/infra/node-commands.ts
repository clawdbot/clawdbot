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
const NODE_BROWSER_PROXY_COMMAND = "browser.proxy";
const NODE_BROWSER_PROXY_UPLOAD_COMMAND = "browser.proxy.upload.v1";
export const NODE_BROWSER_PROXY_COMMANDS = [
  NODE_BROWSER_PROXY_COMMAND,
  NODE_BROWSER_PROXY_UPLOAD_COMMAND,
] as const;
export const NODE_MCP_TOOLS_CALL_COMMAND = "mcp.tools.call.v1";
export const NODE_AGENT_CLI_CLAUDE_RUN_COMMAND = "agent.cli.claude.run.v1";
export const NODE_DEVICE_APPS_COMMAND = "device.apps";

export const NODE_WORKER_BUNDLE_INSTALL_COMMAND = "worker.bundle.install.v1";
export const NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND = "worker.launch.v1";
export const NODE_WORKER_SUPERVISOR_STATUS_COMMAND = "worker.status.v1";
export const NODE_WORKER_SUPERVISOR_CANCEL_COMMAND = "worker.cancel.v1";
export const NODE_WORKER_WORKSPACE_EXEC_COMMAND = "worker.workspace.exec.v1";
export const NODE_WORKER_WORKSPACE_RETAIN_COMMAND = "worker.workspace.retain.v1";
export const NODE_WORKER_DESKTOP_STREAM_COMMAND = "worker.desktop.stream.v1";
export const NODE_WORKER_DESKTOP_LAUNCH_COMMAND = "worker.desktop.launch.v1";
export const NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE = "WORKER_CAPACITY_EXHAUSTED";
export const NODE_WORKER_PRIVATE_COMMANDS = [
  NODE_WORKER_BUNDLE_INSTALL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
  NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
  NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
  NODE_WORKER_DESKTOP_STREAM_COMMAND,
  NODE_WORKER_DESKTOP_LAUNCH_COMMAND,
] as const;

const PRIVATE_NODE_INVOKE_COMMAND_SET = new Set<string>(NODE_WORKER_PRIVATE_COMMANDS);

/** Private node controls are never part of advertised or operator-invocable command surfaces. */
export function isPrivateNodeInvokeCommand(command: unknown): boolean {
  return typeof command === "string" && PRIVATE_NODE_INVOKE_COMMAND_SET.has(command.trim());
}

export function filterPublicNodeCommands(commands: readonly string[]): string[] {
  return commands.filter((command) => !isPrivateNodeInvokeCommand(command));
}

// Node duplex heartbeats must arrive before the Gateway relay declares the
// invoke idle, so both processes share this timeout contract.
export const NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS = 30_000;

export const NODE_EXEC_APPROVALS_COMMANDS = [
  "system.execApprovals.get",
  "system.execApprovals.set",
] as const;

// Direct node.invoke and pairing approval share this admin-only subset.
const NODE_ADMIN_ONLY_INVOKE_COMMANDS = [
  ...NODE_BROWSER_PROXY_COMMANDS,
  NODE_FS_LIST_DIR_COMMAND,
  NODE_TERMINAL_UPLOAD_COMMAND,
] as const;

const NODE_ADMIN_ONLY_INVOKE_COMMAND_SET = new Set<string>(NODE_ADMIN_ONLY_INVOKE_COMMANDS);

/** Returns true when direct node invocation crosses an admin-only host boundary. */
export function isAdminOnlyNodeInvokeCommand(command: unknown): boolean {
  return typeof command === "string" && NODE_ADMIN_ONLY_INVOKE_COMMAND_SET.has(command);
}

/** Returns true for every versioned Browser node proxy command. */
export function isBrowserProxyNodeInvokeCommand(command: unknown): boolean {
  return (
    typeof command === "string" &&
    (NODE_BROWSER_PROXY_COMMANDS as readonly string[]).includes(command)
  );
}

export const NODE_MCP_TOOL_CALL_TIMEOUT_MS = 120_000;
export const NODE_MCP_TOOL_CALL_GATEWAY_TIMEOUT_MS = NODE_MCP_TOOL_CALL_TIMEOUT_MS + 5_000;
