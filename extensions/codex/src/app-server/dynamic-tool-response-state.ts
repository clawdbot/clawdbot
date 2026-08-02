import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  CodexDynamicToolCallResponse,
  CodexDynamicToolDiagnosticTerminalReason,
} from "./protocol.js";

/** OpenClaw-only dynamic-tool facts that never cross into the Codex protocol. */
export type CodexDynamicToolRuntimeResponse = CodexDynamicToolCallResponse & {
  executionStarted?: boolean;
  executedArguments?: Record<string, unknown>;
  transcriptDetails?: { mcpAppPreview: unknown };
  terminalResolution?: ReturnType<NonNullable<EmbeddedRunAttemptParams["observeToolTerminal"]>>;
};

/** Retains the host-owned app preview without adding it to Codex's response payload. */
export function withDynamicToolTranscriptDetails<T extends CodexDynamicToolRuntimeResponse>(
  response: T,
  details: unknown,
): T {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return response;
  }
  const mcpAppPreview = (details as Record<string, unknown>).mcpAppPreview;
  if (!mcpAppPreview || typeof mcpAppPreview !== "object" || Array.isArray(mcpAppPreview)) {
    return response;
  }
  Object.defineProperty(response, "transcriptDetails", {
    configurable: true,
    enumerable: false,
    value: { mcpAppPreview },
  });
  return response;
}

export function withDynamicToolTerminalResolution<T extends CodexDynamicToolRuntimeResponse>(
  response: T,
  terminalResolution: T["terminalResolution"],
): T {
  if (terminalResolution) {
    Object.defineProperties(response, {
      terminalResolution: {
        configurable: true,
        enumerable: false,
        value: terminalResolution,
      },
      executionStarted: {
        configurable: true,
        enumerable: false,
        value: terminalResolution.executionStarted,
      },
      ...(terminalResolution.executedArguments
        ? {
            executedArguments: {
              configurable: true,
              enumerable: false,
              value: terminalResolution.executedArguments,
            },
          }
        : {}),
    });
    withDynamicToolSideEffectEvidence(response, terminalResolution.sideEffectEvidence);
  }
  return response;
}

export function withDynamicToolExecutionState<T extends CodexDynamicToolRuntimeResponse>(
  response: T,
  state: {
    executedArguments: Record<string, unknown>;
    executionStarted: boolean;
    sideEffectEvidence?: boolean;
  },
): T {
  // Keep post-hook arguments non-enumerable so only OpenClaw terminal-outcome
  // bookkeeping sees them; Codex receives contentItems + success.
  Object.defineProperties(response, {
    executedArguments: {
      configurable: true,
      enumerable: false,
      value: state.executedArguments,
    },
    executionStarted: {
      configurable: true,
      enumerable: false,
      value: state.executionStarted,
    },
  });
  return withDynamicToolSideEffectEvidence(response, state.sideEffectEvidence === true);
}

function withDynamicToolSideEffectEvidence<T extends CodexDynamicToolRuntimeResponse>(
  response: T,
  sideEffectEvidence: boolean,
): T {
  if (!sideEffectEvidence) {
    delete response.sideEffectEvidence;
    return response;
  }
  Object.defineProperty(response, "sideEffectEvidence", {
    configurable: true,
    enumerable: false,
    value: true,
  });
  return response;
}

export function createFailedDynamicToolResponse(
  message: string,
  options?: {
    executedArguments?: Record<string, unknown>;
    executionStarted?: boolean;
    sideEffectEvidence?: boolean;
    terminalReason?: CodexDynamicToolDiagnosticTerminalReason;
  },
): CodexDynamicToolRuntimeResponse {
  const response: CodexDynamicToolRuntimeResponse = {
    contentItems: [{ type: "inputText", text: message }],
    success: false,
  };
  Object.defineProperties(response, {
    diagnosticTerminalReason: {
      configurable: true,
      enumerable: false,
      value: options?.terminalReason ?? "failed",
    },
    diagnosticTerminalType: {
      configurable: true,
      enumerable: false,
      value: "error",
    },
  });
  if (options?.executionStarted !== undefined) {
    Object.defineProperty(response, "executionStarted", {
      configurable: true,
      enumerable: false,
      value: options.executionStarted,
    });
  }
  if (options?.executedArguments !== undefined) {
    Object.defineProperty(response, "executedArguments", {
      configurable: true,
      enumerable: false,
      value: options.executedArguments,
    });
  }
  return withDynamicToolSideEffectEvidence(response, options?.sideEffectEvidence === true);
}
