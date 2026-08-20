// Resolves interactive plugin entries from registry metadata.
import { createInteractiveConversationBindingHelpers } from "./interactive-binding-helpers.js";
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
import type { PluginInteractiveRegistration } from "./types.js";

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

type ChannelInteractivePayload = { data: string; namespace: string; payload: string };
type ChannelInteractiveDispatchPayload<T> = T extends ChannelInteractivePayload
  ? Omit<T, keyof ChannelInteractivePayload>
  : never;
type ChannelInteractiveDispatchBase = {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  senderId?: string;
  threadId?: string | number;
  auth: { isAuthorizedSender: boolean };
};
type ChannelInteractiveHandlerContext<
  TChannel extends string,
  TInteractiveKey extends PropertyKey,
> = ChannelInteractiveDispatchBase & {
  channel: TChannel;
  respond: unknown;
} & Record<TInteractiveKey, ChannelInteractivePayload>;
type ChannelInteractiveOwnedContextKey<TInteractiveKey> =
  | TInteractiveKey
  | "respond"
  | "channel"
  | "requestConversationBinding"
  | "detachConversationBinding"
  | "getCurrentConversationBinding";
type ChannelInteractiveDispatchContext<
  TContext,
  TInteractiveKey extends keyof TContext,
  TDispatchInteractiveKey extends PropertyKey,
> = Omit<TContext, ChannelInteractiveOwnedContextKey<TInteractiveKey>> &
  ChannelInteractiveDispatchBase &
  Record<TDispatchInteractiveKey, ChannelInteractiveDispatchPayload<TContext[TInteractiveKey]>>;

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

/** Creates a channel dispatcher for plugin-owned interactive callbacks. */
export function createChannelInteractiveDispatcher<
  TChannel extends string,
  TInteractiveKey extends PropertyKey,
  TContext extends ChannelInteractiveHandlerContext<TChannel, TInteractiveKey>,
  TResult extends { handled?: boolean } | void = { handled?: boolean } | void,
  TDispatchInteractiveKey extends PropertyKey = TInteractiveKey,
>(config: {
  channel: TChannel;
  interactiveKey: TInteractiveKey;
  dispatchInteractiveKey?: TDispatchInteractiveKey;
}) {
  type Registration = PluginInteractiveRegistration<TContext, TChannel, TResult>;
  type DispatchContext = ChannelInteractiveDispatchContext<
    TContext,
    TInteractiveKey,
    TDispatchInteractiveKey
  >;
  return async (params: {
    data: string;
    dedupeId: string;
    ctx: DispatchContext;
    respond: TContext["respond"];
    conversation?: Parameters<
      typeof createInteractiveConversationBindingHelpers
    >[0]["conversation"];
    onMatched?: () => Promise<void> | void;
    afterInvoke?: (result: TResult) => Promise<void> | void;
  }) =>
    await dispatchPluginInteractiveHandler<Registration, TResult>({
      channel: config.channel,
      data: params.data,
      dedupeId: params.dedupeId,
      onMatched: params.onMatched,
      afterInvoke: params.afterInvoke,
      invoke: ({ registration, namespace, payload }) => {
        const dispatchInteractiveKey = config.dispatchInteractiveKey ?? config.interactiveKey;
        const { [dispatchInteractiveKey]: interactiveContext, ...handlerContext } = params.ctx;
        const conversation = params.conversation ?? {
          channel: config.channel,
          accountId: params.ctx.accountId,
          conversationId: params.ctx.conversationId,
          parentConversationId: params.ctx.parentConversationId,
          threadId: params.ctx.threadId,
        };
        const senderId = params.ctx.senderId?.trim();
        const accountId = params.ctx.accountId.trim();
        const conversationId = params.ctx.conversationId.trim();

        // Unauthorized or unbound senders never receive pluginRoot, so binding helpers fail closed.
        const bindingRegistration =
          params.ctx.auth.isAuthorizedSender && senderId && accountId && conversationId
            ? registration
            : { ...registration, pluginRoot: undefined };
        const bindingHelpers = createInteractiveConversationBindingHelpers({
          registration: bindingRegistration,
          senderId: params.ctx.senderId,
          conversation,
        });

        return (registration as Registration).handler({
          ...handlerContext,
          channel: config.channel,
          [config.interactiveKey]: {
            ...interactiveContext,
            data: params.data,
            namespace,
            payload,
          },
          respond: params.respond,
          ...bindingHelpers,
        } as unknown as TContext);
      },
    });
}
