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
  "portal",
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
