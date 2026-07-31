import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
} from "../../code-mode-control-tools.js";
import { CODE_MODE_MODULE_ACCESS_ERROR } from "../../code-mode-errors.js";
import type {
  AfterToolCallResult,
  AfterToolOutcomeContext,
  Agent,
  AgentToolResult,
} from "../../runtime/index.js";

type CodeModeFailurePhase = "input" | "guest" | "bridge" | "host";

type CodeModeFailure = {
  code: string;
  error: string;
  failurePhase: CodeModeFailurePhase;
  bridgeDispatchStarted: boolean;
  bridgeDispatchKnown: boolean;
  sideEffectFree: boolean;
  details: Record<string, unknown>;
};

type RepairClass = "pre-dispatch" | "read-only-bridge";
type RepairState = "ready" | "offered" | "consumed";

function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((entry): entry is Extract<(typeof result.content)[number], { type: "text" }> => {
      return entry.type === "text";
    })
    .map((entry) => entry.text)
    .join("\n")
    .trim();
}

function normalizeFailurePhase(
  value: unknown,
  fallback: CodeModeFailurePhase,
): CodeModeFailurePhase {
  return value === "input" || value === "guest" || value === "bridge" || value === "host"
    ? value
    : fallback;
}

function codeModeFailureFromOutcome(context: AfterToolOutcomeContext): CodeModeFailure | undefined {
  const details = isRecord(context.result.details) ? context.result.details : {};
  if (details.status === "failed") {
    const bridgeDispatchStarted = details.bridgeDispatchStarted === true;
    return {
      code: typeof details.code === "string" ? details.code : "internal_error",
      error:
        typeof details.error === "string"
          ? details.error
          : resultText(context.result) || "code mode execution failed",
      failurePhase: normalizeFailurePhase(
        details.failurePhase,
        bridgeDispatchStarted ? "bridge" : context.executionStarted ? "guest" : "input",
      ),
      bridgeDispatchStarted,
      bridgeDispatchKnown: typeof details.bridgeDispatchStarted === "boolean",
      sideEffectFree: details.sideEffectFree === true,
      details,
    };
  }
  if (!context.isError) {
    return undefined;
  }
  const argumentValidation =
    !context.executionStarted && context.errorKind === "argument-validation";
  return {
    code: argumentValidation ? "invalid_input" : "internal_error",
    error: resultText(context.result) || "code mode execution failed",
    failurePhase: argumentValidation ? "input" : "host",
    bridgeDispatchStarted: context.executionStarted,
    bridgeDispatchKnown: argumentValidation,
    sideEffectFree: false,
    details,
  };
}

function preserveOriginalDispatchEvidence(
  failure: CodeModeFailure | undefined,
  original: CodeModeFailure | undefined,
): CodeModeFailure | undefined {
  if (!failure) {
    return original?.bridgeDispatchStarted ? original : undefined;
  }
  if (!original) {
    return failure;
  }
  const preserved =
    Object.hasOwn(original.details, "output") && !Object.hasOwn(failure.details, "output")
      ? {
          ...failure,
          details: {
            ...failure.details,
            output: original.details.output,
          },
        }
      : failure;
  if (original.bridgeDispatchStarted) {
    return {
      ...preserved,
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
      bridgeDispatchKnown: true,
      sideEffectFree: original.sideEffectFree,
    };
  }
  if (!original.bridgeDispatchKnown || preserved.bridgeDispatchKnown) {
    return preserved;
  }
  return {
    ...preserved,
    failurePhase: original.failurePhase,
    bridgeDispatchStarted: original.bridgeDispatchStarted,
    bridgeDispatchKnown: true,
    sideEffectFree: original.sideEffectFree,
  };
}

function renderFailure(params: {
  failure: CodeModeFailure;
  allowed: boolean;
  remainingAttempts: number;
  reason: string;
  terminate: boolean;
}): AfterToolCallResult {
  const repair = {
    allowed: params.allowed,
    remainingAttempts: params.remainingAttempts,
    reason: params.reason,
  };
  const modelPayload = {
    status: "failed",
    code: params.failure.code,
    error: params.failure.error,
    failurePhase: params.failure.failurePhase,
    bridgeDispatchStarted: params.failure.bridgeDispatchStarted,
    ...(Object.hasOwn(params.failure.details, "output")
      ? { output: params.failure.details.output }
      : {}),
    repair,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(modelPayload) }],
    details: {
      ...params.failure.details,
      status: "failed",
      code: params.failure.code,
      error: params.failure.error,
      failurePhase: params.failure.failurePhase,
      bridgeDispatchStarted: params.failure.bridgeDispatchStarted,
      repair,
    },
    isError: true,
    terminate: params.terminate,
  };
}

function mergePriorOutcome(
  context: AfterToolOutcomeContext,
  prior: AfterToolCallResult | undefined,
): AfterToolOutcomeContext {
  if (!prior) {
    return context;
  }
  return {
    ...context,
    result: {
      ...context.result,
      content: prior.content ?? context.result.content,
      details: prior.details ?? context.result.details,
      terminate:
        context.result.terminate === true || prior.terminate === true
          ? true
          : (prior.terminate ?? context.result.terminate),
    },
    isError: prior.isError ?? context.isError,
  };
}

function hookFailure(
  context: AfterToolOutcomeContext,
  original: CodeModeFailure | undefined,
  error: unknown,
): CodeModeFailure {
  return {
    code: "internal_error",
    error: `Code Mode outcome hook failed: ${error instanceof Error ? error.message : String(error)}`,
    failurePhase: original?.bridgeDispatchStarted
      ? "bridge"
      : context.executionStarted
        ? "host"
        : "input",
    bridgeDispatchStarted: original?.bridgeDispatchStarted ?? context.executionStarted,
    bridgeDispatchKnown: original?.bridgeDispatchKnown ?? !context.executionStarted,
    sideEffectFree: false,
    details: original?.details ?? {},
  };
}

function failureBridgeCallSequence(failure: CodeModeFailure): string[] {
  const telemetry = isRecord(failure.details.telemetry) ? failure.details.telemetry : {};
  return Array.isArray(telemetry.callSequence)
    ? telemetry.callSequence.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function repairReason(failure: CodeModeFailure): string {
  if (failure.details.readOnly === true) {
    return [
      "This recovery attempt is host-enforced read-only because a prior mutation may already have completed.",
      "Do not call write, edit, apply_patch, or any unavailable method, and do not repeat the mutation.",
      "Use the available read-only tools to inspect and verify the requested output or state, then return the user's exact requested answer.",
      'For text results, use `r.field("requested_key")` for key=value or key: value data, replacing the example with the exact requested key, or use `r.content` for raw text.',
      "Retry exec once with corrected JavaScript or TypeScript.",
    ].join(" ");
  }
  if (
    !failure.bridgeDispatchStarted &&
    failure.failurePhase === "input" &&
    failure.error === CODE_MODE_MODULE_ACCESS_ERROR
  ) {
    return [
      "Retry exec once using only Code Mode guest tools.",
      "Do not use import, require, fs, or absolute paths.",
      "Use the original workspace-relative path exactly; do not prepend state/workspaces.",
      "Follow every original step in order in one exec.",
      'Read text with `const source = await tools.read({ path: "input.txt" }); const value = source.field("requested_key");`; replace both examples with the exact path and key from the user. `.field()` returns a string: write `value` unchanged, never the literal key name, and do not use Number/parseInt/parseFloat unless numeric conversion was requested.',
      'For multiple files, call every `tools.read` in this exec. If asked to write/edit and verify, code ending at the mutation is invalid: finish with `return (await tools.read({ path: "output.txt" })).content;`. For read-only work, return `value` or `source.content`.',
      "Do not repeat unchanged input.",
    ].join(" ");
  }
  if (
    failure.bridgeDispatchStarted &&
    failure.sideEffectFree &&
    failureBridgeCallSequence(failure).includes("read")
  ) {
    return [
      "Prior nested calls were read-only.",
      "Complete every remaining original step in order in one corrected exec, using the original workspace-relative path exactly; do not prepend state/workspaces.",
      'For text tool results, use `r.field("requested_key")` for key=value or key: value data, replacing the example with the exact requested key, or use `r.content` for raw text.',
      "When the user asks for a key's value, use the extracted value and never the literal key name.",
      "`.field()` returns a string; preserve it exactly and do not use Number, parseInt, or parseFloat unless numeric conversion was requested.",
      "Do not call `.field()` on `r.content`, and do not use JSON.parse unless the content is actually JSON.",
      "Retry exec once with corrected JavaScript or TypeScript. Do not repeat unchanged input.",
    ].join(" ");
  }
  return failure.bridgeDispatchStarted && failure.sideEffectFree
    ? 'Prior nested calls were read-only. Complete every remaining original step in order in one corrected exec, using the original workspace-relative path exactly; do not prepend state/workspaces. For text reads, use `const r = await tools.read({ path: "input.txt" }); const value = r.field("requested_key");`, replacing both examples with the exact user request. `.field()` returns a string; preserve it exactly and do not use Number, parseInt, or parseFloat unless numeric conversion was requested. Retry exec once with corrected JavaScript or TypeScript. Do not repeat unchanged input.'
    : "Retry exec once with corrected JavaScript or TypeScript. Do not repeat unchanged input.";
}

function repairClass(failure: CodeModeFailure): RepairClass {
  return failure.bridgeDispatchStarted ? "read-only-bridge" : "pre-dispatch";
}

function exhaustedRepairReason(kind: RepairClass): string {
  return kind === "pre-dispatch"
    ? "The Code Mode input repair attempt is exhausted."
    : "The side-effect-free Code Mode execution repair attempt is exhausted.";
}

/** Installs one pre-dispatch repair plus one read-only bridge repair opportunity. */
export function installCodeModeRepairHook(params: { agent: Agent }): void {
  const previousAfterToolOutcome = params.agent.afterToolOutcome?.bind(params.agent);
  const repairStates: Record<RepairClass, RepairState> = {
    "pre-dispatch": "ready",
    "read-only-bridge": "ready",
  };
  let offeredRepair:
    | {
        kind: RepairClass;
        assistantMessage: AfterToolOutcomeContext["assistantMessage"];
      }
    | undefined;

  const consumeAllRepairs = () => {
    repairStates["pre-dispatch"] = "consumed";
    repairStates["read-only-bridge"] = "consumed";
    offeredRepair = undefined;
  };

  const consumeCorrectionAttempt = (
    assistantMessage: AfterToolOutcomeContext["assistantMessage"],
  ) => {
    if (offeredRepair && assistantMessage !== offeredRepair.assistantMessage) {
      repairStates[offeredRepair.kind] = "consumed";
      offeredRepair = undefined;
    }
  };

  params.agent.afterToolOutcome = async (context, signal) => {
    const codeModeTool =
      context.toolCall.name === CODE_MODE_EXEC_TOOL_NAME ||
      context.toolCall.name === CODE_MODE_WAIT_TOOL_NAME;
    const originalFailure = codeModeTool ? codeModeFailureFromOutcome(context) : undefined;
    let prior: AfterToolCallResult | undefined;
    try {
      prior = await previousAfterToolOutcome?.(context, signal);
    } catch (error) {
      if (!codeModeTool) {
        throw error;
      }
      return renderFailure({
        failure: hookFailure(context, originalFailure, error),
        allowed: false,
        remainingAttempts: 0,
        reason: "A Code Mode outcome hook failed, so retry safety cannot be established.",
        terminate: true,
      });
    }
    if (!codeModeTool) {
      return prior;
    }
    if (signal?.aborted && !context.executionStarted) {
      return prior;
    }
    const effective = mergePriorOutcome(context, prior);

    const failure = preserveOriginalDispatchEvidence(
      codeModeFailureFromOutcome(effective),
      originalFailure,
    );
    if (!failure) {
      if (context.result.terminate === true) {
        return { ...prior, terminate: true };
      }
      if (
        effective.toolCall.name === CODE_MODE_EXEC_TOOL_NAME &&
        offeredRepair &&
        effective.assistantMessage !== offeredRepair.assistantMessage
      ) {
        consumeCorrectionAttempt(effective.assistantMessage);
      }
      return prior;
    }

    if (context.result.terminate === true || effective.result.terminate === true) {
      consumeAllRepairs();
      return renderFailure({
        failure,
        allowed: false,
        remainingAttempts: 0,
        reason: "The finalized Code Mode outcome is terminal and cannot be repaired.",
        terminate: true,
      });
    }

    if (
      (failure.bridgeDispatchStarted && !failure.sideEffectFree) ||
      effective.toolCall.name === CODE_MODE_WAIT_TOOL_NAME
    ) {
      consumeAllRepairs();
      return renderFailure({
        failure,
        allowed: false,
        remainingAttempts: 0,
        reason:
          "A Code Mode bridge call already started; do not retry because nested tools may have side effects.",
        terminate: true,
      });
    }

    const repairable =
      failure.bridgeDispatchKnown &&
      (failure.failurePhase === "input" ||
        failure.failurePhase === "guest" ||
        (failure.failurePhase === "bridge" && failure.sideEffectFree)) &&
      (failure.code === "invalid_input" || failure.code === "internal_error");
    if (
      offeredRepair &&
      effective.assistantMessage === offeredRepair.assistantMessage &&
      repairable
    ) {
      return renderFailure({
        failure,
        allowed: true,
        remainingAttempts: 1,
        reason: repairReason(failure),
        terminate: false,
      });
    }

    consumeCorrectionAttempt(effective.assistantMessage);

    if (!repairable) {
      consumeAllRepairs();
      return renderFailure({
        failure,
        allowed: false,
        remainingAttempts: 0,
        reason: "This Code Mode failure is not safely repairable in the current turn.",
        terminate: true,
      });
    }

    const kind = repairClass(failure);
    if (repairStates[kind] !== "ready") {
      consumeAllRepairs();
      return renderFailure({
        failure,
        allowed: false,
        remainingAttempts: 0,
        reason: exhaustedRepairReason(kind),
        terminate: true,
      });
    }

    repairStates[kind] = "offered";
    offeredRepair = {
      kind,
      assistantMessage: effective.assistantMessage,
    };
    return renderFailure({
      failure,
      allowed: true,
      remainingAttempts: 1,
      reason: repairReason(failure),
      terminate: false,
    });
  };
}
