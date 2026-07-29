import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
} from "../../code-mode-control-tools.js";
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
  details: Record<string, unknown>;
};

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
    details: original?.details ?? {},
  };
}

/** Installs one bounded, side-effect-aware Code Mode repair opportunity. */
export function installCodeModeRepairHook(params: { agent: Agent }): void {
  const previousAfterToolOutcome = params.agent.afterToolOutcome?.bind(params.agent);
  let repairState: RepairState = "ready";
  let repairOfferedBy: AfterToolOutcomeContext["assistantMessage"] | undefined;

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
        repairState === "offered" &&
        effective.assistantMessage !== repairOfferedBy
      ) {
        repairState = "consumed";
      }
      return prior;
    }

    if (context.result.terminate === true || effective.result.terminate === true) {
      repairState = "consumed";
      return renderFailure({
        failure,
        allowed: false,
        remainingAttempts: 0,
        reason: "The finalized Code Mode outcome is terminal and cannot be repaired.",
        terminate: true,
      });
    }

    if (failure.bridgeDispatchStarted || effective.toolCall.name === CODE_MODE_WAIT_TOOL_NAME) {
      repairState = "consumed";
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
      (failure.failurePhase === "input" || failure.failurePhase === "guest") &&
      (failure.code === "invalid_input" || failure.code === "internal_error");
    if (repairState === "offered" && effective.assistantMessage === repairOfferedBy && repairable) {
      return renderFailure({
        failure,
        allowed: true,
        remainingAttempts: 1,
        reason:
          "Retry exec once with corrected JavaScript or TypeScript. Do not repeat unchanged input.",
        terminate: false,
      });
    }

    if (repairState === "offered" || repairState === "consumed") {
      repairState = "consumed";
      return renderFailure({
        failure,
        allowed: false,
        remainingAttempts: 0,
        reason: "The single Code Mode repair attempt is exhausted.",
        terminate: true,
      });
    }

    if (!repairable) {
      repairState = "consumed";
      return renderFailure({
        failure,
        allowed: false,
        remainingAttempts: 0,
        reason: "This Code Mode failure is not safely repairable in the current turn.",
        terminate: true,
      });
    }

    repairState = "offered";
    repairOfferedBy = effective.assistantMessage;
    return renderFailure({
      failure,
      allowed: true,
      remainingAttempts: 1,
      reason:
        "Retry exec once with corrected JavaScript or TypeScript. Do not repeat unchanged input.",
      terminate: false,
    });
  };
}
