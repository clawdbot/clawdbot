// Process-local bridge from the plugin-bound facade to the active Gateway owner.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginExternalVerificationCompletionResult } from "./external-verification-approval-types.js";

type CompletionHandler = (
  owner: object,
  pluginId: string,
  completion: { attemptId: string; outcome: "succeeded" | "failed" },
) => Promise<PluginExternalVerificationCompletionResult>;

type CompletionRuntimeState = {
  owner: object | null;
  handler: CompletionHandler | null;
};

const completionRuntimeStateKey = Symbol.for(
  "openclaw.plugin-external-verification-completion-runtime",
);

function getCompletionRuntimeState(): CompletionRuntimeState {
  return resolveGlobalSingleton<CompletionRuntimeState>(completionRuntimeStateKey, () => ({
    owner: null,
    handler: null,
  }));
}

export function setExternalVerificationCompletionRuntime(
  owner: object,
  handler: CompletionHandler,
): void {
  const state = getCompletionRuntimeState();
  state.owner = owner;
  state.handler = handler;
}

export function clearExternalVerificationCompletionRuntime(owner: object): void {
  const state = getCompletionRuntimeState();
  if (state.owner !== owner) {
    return;
  }
  state.owner = null;
  state.handler = null;
}

export async function completeExternalVerificationForPlugin(
  owner: object,
  pluginId: string,
  completion: { attemptId: string; outcome: "succeeded" | "failed" },
): Promise<PluginExternalVerificationCompletionResult> {
  const handler = getCompletionRuntimeState().handler;
  if (!handler) {
    throw new Error("external verification approval runtime is not available");
  }
  return await handler(owner, pluginId, completion);
}
