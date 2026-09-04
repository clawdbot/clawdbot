import {
  embeddedAgentLog,
  formatErrorMessage,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { CodexAppServerRpcError } from "./client.js";
import { neutralizeCodexExplicitMentionSigils } from "./context-engine-projection.js";
import { isJsonObject } from "./protocol.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
} from "./session-binding.js";
import type { CodexAppServerThreadLifecycleBinding } from "./thread-lifecycle.js";

export async function clearCodexBindingAfterInvalidImagePayload(
  bindingStore: CodexAppServerBindingStore,
  identity: CodexAppServerBindingIdentity,
  fields: { phase: string; threadId?: string; turnId?: string; error?: string },
  expected?: EmbeddedRunAttemptParams["expectedSessionRuntimeOwnership"],
): Promise<void> {
  const currentBinding = bindingStore.read(identity);
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
  if (expected || currentBinding?.connectionScope === "supervision") {
    embeddedAgentLog.warn(
      "codex app-server image payload error detected for native-owned thread; preserving binding",
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
