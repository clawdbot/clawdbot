import {
  embeddedAgentLog,
  formatErrorMessage,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { CodexAppServerRpcError } from "./client.js";
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
}): Promise<void> {
  await params.bindingStore.mutate(params.identity, {
    kind: "patch",
    threadId: params.threadId,
    patch: { historyCoveredThrough: new Date().toISOString() },
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
  const text = context?.text.trim();
  return text ? [text, prompt].filter(Boolean).join("\n\n") : prompt;
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
  const readString = (key: string) => {
    const value = params.details?.[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const readNumber = (key: string) => {
    const value = params.details?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  const readBoolean = (key: string) => {
    const value = params.details?.[key];
    return typeof value === "boolean" ? value : undefined;
  };
  return {
    ...(params.idleMs !== undefined ? { idleMs: params.idleMs } : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.lastActivityReason ? { lastActivityReason: params.lastActivityReason } : {}),
    ...(readString("lastNotificationMethod")
      ? { lastNotificationMethod: readString("lastNotificationMethod") }
      : {}),
    ...(readString("lastNotificationItemId")
      ? { lastNotificationItemId: readString("lastNotificationItemId") }
      : {}),
    ...(readString("lastNotificationItemType")
      ? { lastNotificationItemType: readString("lastNotificationItemType") }
      : {}),
    ...(readString("lastNotificationItemRole")
      ? { lastNotificationItemRole: readString("lastNotificationItemRole") }
      : {}),
    ...(readString("lastAssistantTextPreview")
      ? { lastAssistantTextPreview: readString("lastAssistantTextPreview") }
      : {}),
    ...(readNumber("activeAppServerTurnRequests") !== undefined
      ? { activeAppServerTurnRequests: readNumber("activeAppServerTurnRequests") }
      : {}),
    ...(readNumber("activeTurnItemCount") !== undefined
      ? { activeTurnItemCount: readNumber("activeTurnItemCount") }
      : {}),
    ...(readBoolean("terminalTurnNotificationQueued") !== undefined
      ? { terminalTurnNotificationQueued: readBoolean("terminalTurnNotificationQueued") }
      : {}),
    ...(readBoolean("completionIdleWatchArmed") !== undefined
      ? { completionIdleWatchArmed: readBoolean("completionIdleWatchArmed") }
      : {}),
    ...(readBoolean("assistantCompletionIdleWatchArmed") !== undefined
      ? { assistantCompletionIdleWatchArmed: readBoolean("assistantCompletionIdleWatchArmed") }
      : {}),
    ...(readBoolean("terminalIdleWatchArmed") !== undefined
      ? { terminalIdleWatchArmed: readBoolean("terminalIdleWatchArmed") }
      : {}),
  };
}
