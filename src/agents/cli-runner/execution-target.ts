import { createAbortError } from "../../infra/abort-signal.js";
import type { CliBackendExecute } from "../../plugins/cli-backend.types.js";
import { resolveAdmittedRunActiveAssertion } from "../admitted-run-context.js";
import type { CliExecutionTarget, PreparedCliRunContext, RunCliAgentParams } from "./types.js";

/** Capture both the admitted run and any narrower caller-owned execution authority. */
export function createCliRunCurrentAssertion(
  params: PreparedCliRunContext["params"],
  signal = params.abortSignal,
): () => void {
  const assertCallerCurrent = params.assertCurrent;
  const assertAdmitted = resolveAdmittedRunActiveAssertion(params.admittedRunContext, signal);
  return () => {
    assertCallerCurrent?.();
    if (signal?.aborted) {
      throw createAbortError("CLI run aborted");
    }
    if (!assertAdmitted) {
      throw new Error("CLI run authority is no longer active");
    }
    assertAdmitted();
  };
}

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
