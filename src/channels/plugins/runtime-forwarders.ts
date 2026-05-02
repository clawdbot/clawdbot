import type { ChannelDirectoryAdapter, ChannelOutboundAdapter } from "./types.adapters.js";

type MaybePromise<T> = T | Promise<T>;

type DirectoryMethod = "self" | "listPeersLive" | "listGroupsLive" | "listGroupMembers";
type OutboundMethod = "sendText" | "sendMedia" | "sendPoll";

type DirectorySelfParams = Parameters<NonNullable<ChannelDirectoryAdapter["self"]>>[0];
type DirectoryListParams = Parameters<NonNullable<ChannelDirectoryAdapter["listPeersLive"]>>[0];
type DirectoryGroupMembersParams = Parameters<
  NonNullable<ChannelDirectoryAdapter["listGroupMembers"]>
>[0];
type SendTextParams = Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0];
type SendMediaParams = Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0];
type SendPollParams = Parameters<NonNullable<ChannelOutboundAdapter["sendPoll"]>>[0];

async function resolveForwardedMethod<Runtime, Fn>(params: {
  getRuntime: () => MaybePromise<Runtime>;
  resolve: (runtime: Runtime) => Fn | null | undefined;
  unavailableMessage?: string;
}): Promise<Fn> {
  const runtime = await params.getRuntime();
  const method = params.resolve(runtime);
  if (method) {
    return method;
  }
  throw new Error(params.unavailableMessage ?? "Runtime method is unavailable");
}

export function createRuntimeDirectoryLiveAdapter<Runtime>(params: {
  getRuntime: () => MaybePromise<Runtime>;
  self?: (runtime: Runtime) => ChannelDirectoryAdapter["self"] | null | undefined;
  listPeersLive?: (runtime: Runtime) => ChannelDirectoryAdapter["listPeersLive"] | null | undefined;
  listGroupsLive?: (
    runtime: Runtime,
  ) => ChannelDirectoryAdapter["listGroupsLive"] | null | undefined;
  listGroupMembers?: (
    runtime: Runtime,
  ) => ChannelDirectoryAdapter["listGroupMembers"] | null | undefined;
}): Pick<ChannelDirectoryAdapter, DirectoryMethod> {
  const adapter: Pick<ChannelDirectoryAdapter, DirectoryMethod> = {};
  if (params.self) {
    adapter.self = async (ctx: DirectorySelfParams) =>
      await (
        await resolveForwardedMethod({
          getRuntime: params.getRuntime,
          resolve: params.self!,
        })
      )(ctx);
  }
  if (params.listPeersLive) {
    adapter.listPeersLive = async (ctx: DirectoryListParams) =>
      await (
        await resolveForwardedMethod({
          getRuntime: params.getRuntime,
          resolve: params.listPeersLive!,
        })
      )(ctx);
  }
  if (params.listGroupsLive) {
    adapter.listGroupsLive = async (ctx: DirectoryListParams) =>
      await (
        await resolveForwardedMethod({
          getRuntime: params.getRuntime,
          resolve: params.listGroupsLive!,
        })
      )(ctx);
  }
  if (params.listGroupMembers) {
    adapter.listGroupMembers = async (ctx: DirectoryGroupMembersParams) =>
      await (
        await resolveForwardedMethod({
          getRuntime: params.getRuntime,
          resolve: params.listGroupMembers!,
        })
      )(ctx);
  }
  return adapter;
}

export function createRuntimeOutboundDelegates<Runtime>(params: {
  getRuntime: () => MaybePromise<Runtime>;
  sendText?: {
    resolve: (runtime: Runtime) => ChannelOutboundAdapter["sendText"] | null | undefined;
    unavailableMessage?: string;
  };
  sendMedia?: {
    resolve: (runtime: Runtime) => ChannelOutboundAdapter["sendMedia"] | null | undefined;
    unavailableMessage?: string;
  };
  sendPoll?: {
    resolve: (runtime: Runtime) => ChannelOutboundAdapter["sendPoll"] | null | undefined;
    unavailableMessage?: string;
  };
}): Pick<ChannelOutboundAdapter, OutboundMethod> {
  return {
    sendText: params.sendText
      ? async (ctx: SendTextParams) =>
          await (
            await resolveForwardedMethod({
              getRuntime: params.getRuntime,
              resolve: params.sendText!.resolve,
              unavailableMessage: params.sendText!.unavailableMessage,
            })
          )(ctx)
      : undefined,
    sendMedia: params.sendMedia
      ? async (ctx: SendMediaParams) =>
          await (
            await resolveForwardedMethod({
              getRuntime: params.getRuntime,
              resolve: params.sendMedia!.resolve,
              unavailableMessage: params.sendMedia!.unavailableMessage,
            })
          )(ctx)
      : undefined,
    sendPoll: params.sendPoll
      ? async (ctx: SendPollParams) =>
          await (
            await resolveForwardedMethod({
              getRuntime: params.getRuntime,
              resolve: params.sendPoll!.resolve,
              unavailableMessage: params.sendPoll!.unavailableMessage,
            })
          )(ctx)
      : undefined,
  };
}
