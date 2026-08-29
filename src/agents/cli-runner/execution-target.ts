import type { CliBackendExecute } from "../../plugins/cli-backend.types.js";
import type { RunCliAgentParams } from "./types.js";

export type NodeClaudePlacement = { nodeId: string; cwd?: string };

export type CliExecutionTarget =
  | { kind: "node"; placement: NodeClaudePlacement }
  | { kind: "plugin"; execute: CliBackendExecute }
  | { kind: "process" };

/** Preparation and execution must agree on the owner of private prompt context. */
export function resolveCliExecutionTarget(context: {
  params: Pick<RunCliAgentParams, "sessionEntry" | "controlOperation">;
  backendId: string;
  execute?: CliBackendExecute;
}): CliExecutionTarget {
  const entry = context.params.sessionEntry;
  // Claude placement owns its CLI, auth, transcript, and exec tools together.
  if (context.backendId === "claude-cli" && entry?.execHost === "node") {
    const nodeId = entry.execNode?.trim();
    if (!nodeId) {
      throw new Error("node-placed Claude CLI session is missing execNode");
    }
    return {
      kind: "node",
      placement: { nodeId, ...(entry.execCwd?.trim() ? { cwd: entry.execCwd.trim() } : {}) },
    };
  }
  return context.execute && context.params.controlOperation !== "compact"
    ? { kind: "plugin", execute: context.execute }
    : { kind: "process" };
}
