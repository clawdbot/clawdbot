import type { ExecAsk, ExecMode, ExecSecurity } from "../infra/exec-approvals.js";

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
  execPolicy: {
    mode: ExecMode;
    security: ExecSecurity;
    ask: ExecAsk;
  };
};

export function toWorkerExecConfig(policy: WorkerToolAuthority["execPolicy"]): {
  host: "gateway";
  mode?: "auto";
  security: ExecSecurity;
  ask: ExecAsk;
} {
  return {
    host: "gateway",
    security: policy.security,
    ask: policy.ask,
    // Auto needs its mode identity; replaying other modes would overwrite stricter resolved pairs.
    ...(policy.mode === "auto" ? { mode: "auto" as const } : {}),
  };
}
