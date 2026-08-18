import type { SessionPermissionMode } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import { resolveSessionPermissionCoreToolPolicy } from "../agents/session-permission-exec-mode.js";

export const WORKER_REQUIRED_LOCAL_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
] as const;

const WORKER_OPTIONAL_LOCAL_TOOL_NAMES = ["browser"] as const;

export const WORKER_LOCAL_TOOL_NAMES = [
  ...WORKER_REQUIRED_LOCAL_TOOL_NAMES,
  ...WORKER_OPTIONAL_LOCAL_TOOL_NAMES,
] as const;

/** Gateway-proxied tools exposed through the closed worker protocol. */
export const WORKER_SESSION_TOOL_NAMES = [
  "sessions_spawn",
  "sessions_send",
  "github_publish",
] as const;

export const WORKER_TOOL_NAMES = [
  ...WORKER_LOCAL_TOOL_NAMES,
  ...WORKER_SESSION_TOOL_NAMES,
] as const;

export type WorkerOptionalLocalToolName = (typeof WORKER_OPTIONAL_LOCAL_TOOL_NAMES)[number];
export type WorkerSessionToolName = (typeof WORKER_SESSION_TOOL_NAMES)[number];
export type WorkerToolName = (typeof WORKER_TOOL_NAMES)[number];

const WORKER_TOOL_NAME_SET = new Set<string>(WORKER_TOOL_NAMES);

export function isWorkerToolName(value: unknown): value is WorkerToolName {
  return typeof value === "string" && WORKER_TOOL_NAME_SET.has(value);
}

export type WorkerToolAuthority = {
  allowedToolNames: WorkerToolName[];
};

// A denied exec tool is not delegable authority; process can control commands started elsewhere.
// Remove both from the actual read-only surface so a name-only child cap cannot restore them.
const READ_ONLY_WORKER_TOOL_DENY = new Set<WorkerToolName>([
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
]);

/** Resolve the concrete worker surface after session permission mode is applied. */
export function resolveWorkerPermissionToolAuthority(params: {
  allowedToolNames: readonly WorkerToolName[];
  permissionMode?: SessionPermissionMode;
}) {
  const permissionToolPolicy = params.permissionMode
    ? resolveSessionPermissionCoreToolPolicy({ mode: params.permissionMode })
    : undefined;
  const allowed = new Set(params.allowedToolNames);
  return {
    allowedToolNames: WORKER_TOOL_NAMES.filter(
      (name) =>
        allowed.has(name) &&
        !(permissionToolPolicy?.readOnly && READ_ONLY_WORKER_TOOL_DENY.has(name)),
    ),
    permissionToolPolicy,
  };
}
