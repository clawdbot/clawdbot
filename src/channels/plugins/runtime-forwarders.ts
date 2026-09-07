import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import type { ChannelDirectoryAdapter, ChannelOutboundAdapter } from "./types.adapters.js";

type MaybePromise<T> = T | Promise<T>;

type DirectoryMethod = "self" | "listPeersLive" | "listGroupsLive" | "listGroupMembers";
type OutboundMethod = "renderPresentation" | "sendPayload" | "sendText" | "sendMedia" | "sendPoll";

type RuntimeForwarderParams<Runtime, Fn> = {
  getRuntime: () => MaybePromise<Runtime>;
  resolve: (runtime: Runtime) => Fn | null | undefined;
  notDispatched?: boolean;
  unavailableMessage?: string;
};

async function resolveForwardedMethod<Runtime, Fn>(
  params: RuntimeForwarderParams<Runtime, Fn>,
): Promise<Fn> {
  try {
    const runtime = await params.getRuntime();
    const method = params.resolve(runtime);
    if (method) {
      return method;
    }
    // Fail at call time instead of registration time so optional runtime methods
    // can stay absent until the caller actually invokes that capability.
    throw new Error(params.unavailableMessage ?? "Runtime method is unavailable");
  } catch (error) {
    if (!params.notDispatched || error instanceof PlatformMessageNotDispatchedError) {
      throw error;
    }
    const message =
      params.unavailableMessage ??
      (error instanceof Error && error.message.trim()
        ? error.message
        : "Runtime method is unavailable");
    throw new PlatformMessageNotDispatchedError(message, { cause: error });
  }
}

function createRuntimeForwarder<Runtime, Context, Result>(
  resolveParams: () => RuntimeForwarderParams<Runtime, (ctx: Context) => MaybePromise<Result>>,
) {
  // Read current callbacks on every call. Sender failures stay outside the
  // resolution catch because dispatch may already have begun.
  return async (ctx: Context) => await (await resolveForwardedMethod(resolveParams()))(ctx);
}

/**
 * Creates a directory adapter whose methods forward to a lazily resolved runtime.
 */
export function createRuntimeDirectoryLiveAdapter<Runtime>(
  params: { getRuntime: () => MaybePromise<Runtime> } & {
    [Method in DirectoryMethod]?: (
      runtime: Runtime,
    ) => ChannelDirectoryAdapter[Method] | null | undefined;
  },
): Pick<ChannelDirectoryAdapter, DirectoryMethod> {
  const adapter: Pick<ChannelDirectoryAdapter, DirectoryMethod> = {};
  if (params.self) {
    adapter.self = createRuntimeForwarder(() => ({
      getRuntime: params.getRuntime,
      resolve: params.self!,
    }));
  }
  if (params.listPeersLive) {
    adapter.listPeersLive = createRuntimeForwarder(() => ({
      getRuntime: params.getRuntime,
      resolve: params.listPeersLive!,
    }));
  }
  if (params.listGroupsLive) {
    adapter.listGroupsLive = createRuntimeForwarder(() => ({
      getRuntime: params.getRuntime,
      resolve: params.listGroupsLive!,
    }));
  }
  if (params.listGroupMembers) {
    adapter.listGroupMembers = createRuntimeForwarder(() => ({
      getRuntime: params.getRuntime,
      resolve: params.listGroupMembers!,
    }));
  }
  return adapter;
}

/**
 * Creates outbound delegates whose methods forward to a lazily resolved runtime.
 */
export function createRuntimeOutboundDelegates<Runtime>(
  params: { getRuntime: () => MaybePromise<Runtime> } & {
    [Method in OutboundMethod]?: {
      resolve: (runtime: Runtime) => ChannelOutboundAdapter[Method] | null | undefined;
      unavailableMessage?: string;
    };
  },
): Pick<ChannelOutboundAdapter, OutboundMethod> {
  return {
    renderPresentation: params.renderPresentation
      ? createRuntimeForwarder(() => ({
          getRuntime: params.getRuntime,
          resolve: params.renderPresentation!.resolve,
          unavailableMessage: params.renderPresentation!.unavailableMessage,
        }))
      : undefined,
    sendPayload: params.sendPayload
      ? createRuntimeForwarder(() => ({
          getRuntime: params.getRuntime,
          notDispatched: true,
          resolve: params.sendPayload!.resolve,
          unavailableMessage: params.sendPayload!.unavailableMessage,
        }))
      : undefined,
    sendText: params.sendText
      ? createRuntimeForwarder(() => ({
          getRuntime: params.getRuntime,
          notDispatched: true,
          resolve: params.sendText!.resolve,
          unavailableMessage: params.sendText!.unavailableMessage,
        }))
      : undefined,
    sendMedia: params.sendMedia
      ? createRuntimeForwarder(() => ({
          getRuntime: params.getRuntime,
          notDispatched: true,
          resolve: params.sendMedia!.resolve,
          unavailableMessage: params.sendMedia!.unavailableMessage,
        }))
      : undefined,
    sendPoll: params.sendPoll
      ? createRuntimeForwarder(() => ({
          getRuntime: params.getRuntime,
          notDispatched: true,
          resolve: params.sendPoll!.resolve,
          unavailableMessage: params.sendPoll!.unavailableMessage,
        }))
      : undefined,
  };
}
