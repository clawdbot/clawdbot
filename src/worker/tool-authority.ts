export const WORKER_LOCAL_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
] as const;

export type WorkerLocalToolName = (typeof WORKER_LOCAL_TOOL_NAMES)[number];

const WORKER_LOCAL_TOOL_NAME_SET = new Set<string>(WORKER_LOCAL_TOOL_NAMES);

export function isWorkerLocalToolName(value: unknown): value is WorkerLocalToolName {
  return typeof value === "string" && WORKER_LOCAL_TOOL_NAME_SET.has(value);
}

export type WorkerToolAuthority = {
  allowedToolNames: WorkerLocalToolName[];
};
