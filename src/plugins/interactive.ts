// Resolves interactive plugin entries from registry metadata.
import {
  resolvePluginInteractiveRegistrationsMatch,
  type RegisteredInteractiveHandler,
} from "./interactive-registry.js";
import {
  claimPluginInteractiveCallbackDedupe,
  commitPluginInteractiveCallbackDedupe,
  releasePluginInteractiveCallbackDedupe,
} from "./interactive-state.js";
import { getActivePluginRegistry } from "./runtime.js";

type InteractiveDispatchResult<TResult = unknown> =
  | { matched: false; handled: false; duplicate: false }
  | { matched: true; handled: boolean; duplicate: boolean; result?: TResult };

type PluginInteractiveDispatchRegistration = {
  channel: string;
  namespace: string;
};

/** Resolved interactive handler match passed to plugin callback dispatch. */
type PluginInteractiveMatch<TRegistration extends PluginInteractiveDispatchRegistration> = {
  registration: RegisteredInteractiveHandler & TRegistration;
  namespace: string;
  payload: string;
};

export {
  clearPluginInteractiveHandlers,
  registerPluginInteractiveHandler,
} from "./interactive-registry.js";

function resolveActivePluginInteractiveNamespaceMatch(channel: string, data: string) {
  return resolvePluginInteractiveRegistrationsMatch(
    getActivePluginRegistry()?.interactiveHandlers ?? [],
    channel,
    data,
  );
}

/** Dispatches one interactive callback payload to a matching plugin handler. */
export async function dispatchPluginInteractiveHandler<
  TRegistration extends PluginInteractiveDispatchRegistration,
  TResult extends { handled?: boolean } | void = { handled?: boolean } | void,
>(params: {
  channel: TRegistration["channel"];
  data: string;
  dedupeId?: string;
  onMatched?: () => Promise<void> | void;
  invoke: (match: PluginInteractiveMatch<TRegistration>) => Promise<TResult> | TResult;
  afterInvoke?: (result: TResult) => Promise<void> | void;
}): Promise<InteractiveDispatchResult<TResult>> {
  const match = resolveActivePluginInteractiveNamespaceMatch(params.channel, params.data);
  if (!match) {
    return { matched: false, handled: false, duplicate: false };
  }

  const dedupeKey = params.dedupeId?.trim();
  if (dedupeKey && !claimPluginInteractiveCallbackDedupe(dedupeKey)) {
    return { matched: true, handled: true, duplicate: true };
  }

  try {
    await params.onMatched?.();
    const resolved = await params.invoke(match as PluginInteractiveMatch<TRegistration>);
    // Channel post-processing stays inside the dedupe claim. Committing first
    // would swallow a retry after a retryable post-handler failure.
    await params.afterInvoke?.(resolved);
    if (dedupeKey) {
      commitPluginInteractiveCallbackDedupe(dedupeKey);
    }
    const shouldExposeResult =
      Boolean(resolved) &&
      typeof resolved === "object" &&
      Object.keys(resolved as Record<string, unknown>).some((key) => key !== "handled");

    return {
      matched: true,
      handled: resolved?.handled ?? true,
      duplicate: false,
      ...(shouldExposeResult ? { result: resolved } : {}),
    };
  } catch (error) {
    if (dedupeKey) {
      releasePluginInteractiveCallbackDedupe(dedupeKey);
    }
    throw error;
  }
}
