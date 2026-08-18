import {
  embeddedAgentLog,
  formatErrorMessage,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asBoolean,
  asFiniteNumber,
  hasNonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { CodexAppServerRpcError } from "./client.js";
import { neutralizeCodexExplicitMentionSigils } from "./context-engine-projection.js";
import { isJsonObject, type CodexServerNotification } from "./protocol.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
} from "./session-binding.js";
import type { CodexAppServerThreadLifecycleBinding } from "./thread-lifecycle.js";

export async function clearCodexBindingAfterInvalidImagePayload(
  bindingStore: CodexAppServerBindingStore,
  identity: CodexAppServerBindingIdentity,
  fields: { phase: string; threadId?: string; turnId?: string; error?: string },
): Promise<void> {
  const currentBinding = await bindingStore.read(identity);
  const expectedThreadId = fields.threadId ?? currentBinding?.threadId;
  if (!expectedThreadId) {
    return;
  }
  if (currentBinding && currentBinding.threadId !== expectedThreadId) {
    embeddedAgentLog.warn(
      "codex app-server image payload error detected for unbound thread; preserving thread binding",
      { ...fields, boundThreadId: currentBinding.threadId },
    );
    return;
  }
  if (currentBinding?.connectionScope === "supervision") {
    embeddedAgentLog.warn(
      "codex app-server image payload error detected for supervised thread; preserving native binding",
      fields,
    );
    return;
  }
  embeddedAgentLog.warn(
    "codex app-server image payload error detected; clearing thread binding",
    fields,
  );
  await bindingStore.mutate(identity, { kind: "clear", threadId: expectedThreadId });
}

export async function markCodexAppServerBindingCoveredThroughTurn(params: {
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  threadId: string;
  continuityCalibration?: { promptChars: number; inputTokens: number };
}): Promise<void> {
  await params.bindingStore.mutate(params.identity, {
    kind: "patch",
    threadId: params.threadId,
    patch: {
      historyCoveredThrough: new Date().toISOString(),
      ...(params.continuityCalibration
        ? { continuityCalibration: params.continuityCalibration }
        : {}),
    },
  });
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function shouldUseFreshCodexThreadAfterContextEngineOverflow(params: {
  error: unknown;
  contextEngineActive: boolean;
  thread: CodexAppServerThreadLifecycleBinding;
}): boolean {
  if (!params.contextEngineActive || params.thread.lifecycle.action !== "resumed") {
    return false;
  }
  const message = formatErrorMessage(params.error);
  return (
    /ran out of room in the model'?s context window/iu.test(message) ||
    /context window/iu.test(message) ||
    /context length/iu.test(message) ||
    /maximum context/iu.test(message) ||
    /too many tokens/iu.test(message)
  );
}

export function isCodexActiveCompactTurnError(error: unknown): boolean {
  if (!(error instanceof CodexAppServerRpcError)) {
    return false;
  }
  const data = isJsonObject(error.data) ? error.data : undefined;
  const codexErrorInfo = isJsonObject(data?.codexErrorInfo) ? data.codexErrorInfo : undefined;
  const activeTurn = isJsonObject(codexErrorInfo?.activeTurnNotSteerable)
    ? codexErrorInfo.activeTurnNotSteerable
    : undefined;
  return activeTurn?.turnKind === "compact";
}

export function readCodexFinalizationHookNotification(
  notification: CodexServerNotification,
  threadId: string,
  turnId: string,
):
  | { phase: "started"; runId: string }
  | { phase: "completed"; runId: string; status: string | undefined }
  | undefined {
  if (notification.method !== "hook/started" && notification.method !== "hook/completed") {
    return undefined;
  }
  const params = isJsonObject(notification.params) ? notification.params : undefined;
  const run = params && isJsonObject(params.run) ? params.run : undefined;
  // Codex selects exactly one of Stop or SubagentStop from the turn's session
  // source, so these event names share aggregation state but cannot coexist.
  if (
    params?.threadId !== threadId ||
    params.turnId !== turnId ||
    (run?.eventName !== "stop" && run?.eventName !== "subagentStop") ||
    typeof run.id !== "string" ||
    !run.id
  ) {
    return undefined;
  }
  if (notification.method === "hook/started") {
    return { phase: "started", runId: run.id };
  }
  return {
    phase: "completed",
    runId: run.id,
    status: typeof run.status === "string" ? run.status : undefined,
  };
}

export function joinPresentSections(...sections: Array<string | undefined>): string {
  return sections.filter((section): section is string => Boolean(section?.trim())).join("\n\n");
}

export function prependCurrentInboundContext(
  prompt: string,
  context: EmbeddedRunAttemptParams["currentInboundContext"],
): string {
  // Inbound context carries quoted replies and room backlog, not the raw
  // current request; Codex must not resolve explicit mentions from it.
  const text = context?.text.trim();
  return text
    ? [neutralizeCodexExplicitMentionSigils(text), prompt].filter(Boolean).join("\n\n")
    : prompt;
}

export function waitForCodexNotificationDispatchTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export function buildCodexAppServerTimeoutDiagnostics(params: {
  idleMs?: number;
  timeoutMs?: number;
  lastActivityReason?: string;
  details?: Record<string, unknown>;
}): NonNullable<EmbeddedRunAttemptResult["codexAppServerFailure"]>["diagnostics"] {
  const readNonBlankDetailString = (key: string) => {
    const value = params.details?.[key];
    return hasNonEmptyString(value) ? value : undefined;
  };
  const activeAppServerTurnRequests = asFiniteNumber(params.details?.activeAppServerTurnRequests);
  const activeTurnItemCount = asFiniteNumber(params.details?.activeTurnItemCount);
  const terminalTurnNotificationQueued = asBoolean(params.details?.terminalTurnNotificationQueued);
  const completionIdleWatchArmed = asBoolean(params.details?.completionIdleWatchArmed);
  const assistantCompletionIdleWatchArmed = asBoolean(
    params.details?.assistantCompletionIdleWatchArmed,
  );
  const terminalIdleWatchArmed = asBoolean(params.details?.terminalIdleWatchArmed);
  return {
    ...(params.idleMs !== undefined ? { idleMs: params.idleMs } : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.lastActivityReason ? { lastActivityReason: params.lastActivityReason } : {}),
    ...(readNonBlankDetailString("lastNotificationMethod")
      ? { lastNotificationMethod: readNonBlankDetailString("lastNotificationMethod") }
      : {}),
    ...(readNonBlankDetailString("lastNotificationItemId")
      ? { lastNotificationItemId: readNonBlankDetailString("lastNotificationItemId") }
      : {}),
    ...(readNonBlankDetailString("lastNotificationItemType")
      ? { lastNotificationItemType: readNonBlankDetailString("lastNotificationItemType") }
      : {}),
    ...(readNonBlankDetailString("lastNotificationItemRole")
      ? { lastNotificationItemRole: readNonBlankDetailString("lastNotificationItemRole") }
      : {}),
    ...(readNonBlankDetailString("lastAssistantTextPreview")
      ? { lastAssistantTextPreview: readNonBlankDetailString("lastAssistantTextPreview") }
      : {}),
    ...(activeAppServerTurnRequests !== undefined ? { activeAppServerTurnRequests } : {}),
    ...(activeTurnItemCount !== undefined ? { activeTurnItemCount } : {}),
    ...(terminalTurnNotificationQueued !== undefined ? { terminalTurnNotificationQueued } : {}),
    ...(completionIdleWatchArmed !== undefined ? { completionIdleWatchArmed } : {}),
    ...(assistantCompletionIdleWatchArmed !== undefined
      ? { assistantCompletionIdleWatchArmed }
      : {}),
    ...(terminalIdleWatchArmed !== undefined ? { terminalIdleWatchArmed } : {}),
  };
}
