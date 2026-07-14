/**
 * Diagnostic helpers for Codex app-server model calls and plugin-thread config
 * eligibility.
 */
import { createHash } from "node:crypto";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  type DiagnosticModelCallContent,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type { CodexAppServerRuntimeOptions, resolveCodexPluginsPolicy } from "./config.js";

type TrustedDiagnosticEventInput = Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0];

/** Reads a tool schema field in either app-server or OpenClaw naming. */
function readCodexDiagnosticToolParameters(tool: {
  inputSchema?: unknown;
  parameters?: unknown;
}): unknown {
  return tool.inputSchema ?? tool.parameters;
}

/** Builds compact diagnostic tool definitions for trusted private telemetry. */
function buildCodexDiagnosticToolDefinitions(
  tools: readonly {
    name: string;
    description: string;
    inputSchema?: unknown;
    parameters?: unknown;
  }[],
) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: readCodexDiagnosticToolParameters(tool),
  }));
}

/** Returns the serialized UTF-8 byte length for a JSON-compatible value. */
export function utf8JsonByteLength(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

/** Builds a short namespaced fingerprint for sensitive log values. */
function fingerprintCodexLogValue(namespace: string, value: string): string {
  const hash = createHash("sha256");
  hash.update(namespace);
  hash.update("\0");
  hash.update(value);
  return `sha256:${hash.digest("hex").slice(0, 16)}`;
}

/**
 * Builds redacted diagnostics explaining whether plugin thread config was
 * eligible for a Codex app-server attempt.
 */
export function buildCodexPluginThreadConfigEligibilityLogData(params: {
  sessionId: string;
  sessionKey: string;
  pluginThreadConfigRequired: boolean;
  resolvedPluginPolicy: ReturnType<typeof resolveCodexPluginsPolicy> | undefined;
  enabledPluginConfigKeys: string[] | undefined;
  pluginAppCacheKey: string;
  startupAuthProfileId: string | undefined;
  appServer: CodexAppServerRuntimeOptions;
}): Record<string, unknown> {
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    enabled: params.pluginThreadConfigRequired,
    policyConfigured: params.resolvedPluginPolicy?.configured === true,
    policyEnabled: params.resolvedPluginPolicy?.enabled === true,
    allowAllPlugins: params.resolvedPluginPolicy?.allowAllPlugins === true,
    pluginConfigKeys: params.resolvedPluginPolicy?.pluginPolicies
      .map((plugin) => plugin.configKey)
      .toSorted(),
    enabledPluginConfigKeys: params.enabledPluginConfigKeys,
    appCacheKeyFingerprint: fingerprintCodexLogValue(
      "openclaw:codex:plugin-app-cache-key:v1",
      params.pluginAppCacheKey,
    ),
    authProfileId: params.startupAuthProfileId,
    appServerTransport: params.appServer.start.transport,
    appServerCommandSource: params.appServer.start.commandSource,
  };
}

type CodexModelCallFailureKind = "aborted" | "timeout";

type CodexModelCallDiagnosticCapture = {
  inputMessages?: boolean;
  outputMessages?: boolean;
  systemPrompt?: boolean;
  toolDefinitions?: boolean;
};

type CodexModelCallDiagnosticTool = {
  name: string;
  description: string;
  inputSchema?: unknown;
  parameters?: unknown;
};

/**
 * Creates lifecycle emitters for trusted model-call diagnostics with optional
 * private payload capture.
 */
export function createCodexModelCallDiagnosticEmitter(params: {
  baseFields: Record<string, unknown>;
  capture: CodexModelCallDiagnosticCapture;
  tools: readonly CodexModelCallDiagnosticTool[];
  buildInputMessages: () => unknown;
  buildSystemPrompt: () => string | undefined;
  now?: () => number;
  onErrorDiagnostic?: (error: unknown) => void;
}) {
  const now = params.now ?? (() => Date.now());
  const toolDefinitions = params.capture.toolDefinitions
    ? buildCodexDiagnosticToolDefinitions(params.tools)
    : undefined;
  let startedAt = now();
  let started = false;
  let terminalEmitted = false;
  let requestPayloadBytes: number | undefined;

  const privateData = (modelContent: DiagnosticModelCallContent | undefined) =>
    modelContent && Object.keys(modelContent).length > 0 ? { modelContent } : undefined;
  const buildContent = (): DiagnosticModelCallContent | undefined => {
    const modelContent = {
      ...(params.capture.inputMessages ? { inputMessages: params.buildInputMessages() } : {}),
      ...(params.capture.systemPrompt ? { systemPrompt: params.buildSystemPrompt() } : {}),
      ...(toolDefinitions ? { toolDefinitions } : {}),
    };
    return Object.keys(modelContent).length > 0 ? modelContent : undefined;
  };
  const requestPayloadBytesField = () =>
    requestPayloadBytes !== undefined ? { requestPayloadBytes } : {};

  return {
    setRequestPayloadBytes(bytes: number | undefined): void {
      requestPayloadBytes = bytes;
    },
    emitStarted(): void {
      startedAt = now();
      started = true;
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "model.call.started",
          ...params.baseFields,
        } as TrustedDiagnosticEventInput,
        privateData(buildContent()),
      );
    },
    emitCompleted(result: { assistantTexts?: unknown; lastAssistant?: unknown }): void {
      if (!started || terminalEmitted) {
        return;
      }
      terminalEmitted = true;
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "model.call.completed",
          ...params.baseFields,
          durationMs: Math.max(0, now() - startedAt),
          ...requestPayloadBytesField(),
        } as TrustedDiagnosticEventInput,
        privateData({
          ...buildContent(),
          ...(params.capture.outputMessages
            ? {
                outputMessages: result.lastAssistant
                  ? [result.lastAssistant]
                  : result.assistantTexts,
              }
            : {}),
        }),
      );
    },
    emitError(error: unknown, fields: { failureKind?: CodexModelCallFailureKind } = {}): void {
      if (!started || terminalEmitted) {
        return;
      }
      terminalEmitted = true;
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "model.call.error",
          ...params.baseFields,
          durationMs: Math.max(0, now() - startedAt),
          errorCategory: fields.failureKind ?? "error",
          ...(fields.failureKind ? { failureKind: fields.failureKind } : {}),
          ...requestPayloadBytesField(),
        } as TrustedDiagnosticEventInput,
        privateData({
          ...buildContent(),
          ...(params.capture.outputMessages ? { outputMessages: [] } : {}),
        }),
      );
      params.onErrorDiagnostic?.(error);
    },
  };
}

/** Classifies model-call failures into timeout/abort buckets for diagnostics. */
export function classifyCodexModelCallFailureKind(params: {
  error: unknown;
  timedOut: boolean;
  turnCompletionIdleTimedOut: boolean;
  runAborted: boolean;
  abortReason: unknown;
  clientClosedAbort: boolean;
  formatError: (error: unknown) => string;
}): CodexModelCallFailureKind | undefined {
  if (params.timedOut || params.turnCompletionIdleTimedOut) {
    return "timeout";
  }
  const errorMessage = params.error ? params.formatError(params.error).toLowerCase() : "";
  if (errorMessage.includes("timed out") || errorMessage.includes("timeout")) {
    return "timeout";
  }
  if (params.runAborted && !params.clientClosedAbort) {
    const abortReason =
      typeof params.abortReason === "string"
        ? params.abortReason.toLowerCase()
        : params.abortReason
          ? params.formatError(params.abortReason).toLowerCase()
          : "";
    return abortReason.includes("timeout") ? "timeout" : "aborted";
  }
  return errorMessage.includes("aborted") ? "aborted" : undefined;
}
