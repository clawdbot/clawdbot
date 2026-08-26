import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export type TelegramTestContext = Record<string, unknown>;
export type TelegramTestMiddleware = (
  ctx: TelegramTestContext,
  next: () => Promise<void>,
) => Promise<void> | void;

type MiddlewareUseSpy = {
  mock: { calls: unknown[][] };
};

type ChannelInboundModule = typeof import("openclaw/plugin-sdk/channel-inbound");
type ChannelInboundRunParams = Parameters<ChannelInboundModule["runChannelInboundEvent"]>[0];
type BufferedReplyDispatcher =
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;

export function makeTelegramKeyedStoreTestMock<Value>(
  overrides: Partial<PluginStateKeyedStore<Value>> = {},
): PluginStateKeyedStore<Value> {
  const unexpectedCall = async (operation: string): Promise<never> => {
    throw new Error(`unexpected Telegram keyed-store ${operation} call`);
  };
  return {
    register: () => unexpectedCall("register"),
    registerIfAbsent: () => unexpectedCall("registerIfAbsent"),
    lookup: () => unexpectedCall("lookup"),
    consume: () => unexpectedCall("consume"),
    delete: () => unexpectedCall("delete"),
    entries: () => unexpectedCall("entries"),
    clear: () => unexpectedCall("clear"),
    ...overrides,
  };
}

export async function runTelegramChannelInboundEventWithHarness(
  actual: ChannelInboundModule,
  params: ChannelInboundRunParams,
  dispatchReply: BufferedReplyDispatcher,
) {
  const resolveTurn = params.adapter.resolveTurn;
  return await actual.runChannelInboundEvent({
    ...params,
    adapter: {
      ...params.adapter,
      resolveTurn: async (input, eventClass, preflight) => {
        const resolved = await resolveTurn(input, eventClass, preflight);
        if (!("route" in resolved) || "runDispatch" in resolved) {
          return resolved;
        }
        const plan =
          resolved as unknown as import("openclaw/plugin-sdk/channel-inbound").ChannelInboundTurnPlan<"provider_message_sending">;
        return {
          ...plan,
          runDispatch: async () =>
            await dispatchReply({
              ctx: plan.ctxPayload,
              cfg: plan.cfg,
              dispatcherOptions: {
                ...plan.dispatcherOptions,
                deliver: (payload, info) =>
                  plan.delivery.deliverWithProviderMessageSending(payload, {
                    ...info,
                    onPlatformSendDispatch: info.onPlatformSendDispatch ?? (async () => undefined),
                  }),
                onError: plan.delivery.onError,
              },
              toolsAllow: plan.toolsAllow,
              replyOptions: plan.replyOptions,
              replyResolver: plan.replyResolver,
            }),
          runDispatchLifecycle: {
            turnAdoptionLifecycle: params.turnAdoptionLifecycle,
            onDispatchSkipped: () => params.turnAdoptionLifecycle?.onAbandoned?.(),
          },
        };
      },
    },
  });
}

export function createTelegramCallbackContext(params: {
  id: string;
  data: string;
  from?: Record<string, unknown>;
  message?: Record<string, unknown>;
  updateId?: number;
  update?: Record<string, unknown>;
}): TelegramTestContext {
  const callbackQuery = {
    id: params.id,
    data: params.data,
    from: params.from ?? { id: 9, first_name: "Ada", username: "ada_bot" },
    message: {
      chat: { id: 1234, type: "private" },
      date: 1_736_380_800,
      message_id: 10,
      ...params.message,
    },
  };
  return {
    ...(params.update
      ? { update: params.update }
      : params.updateId === undefined
        ? {}
        : { update: { update_id: params.updateId, callback_query: callbackQuery } }),
    callbackQuery,
    me: { username: "openclaw_bot" },
    getFile: async () => ({ download: async () => new Uint8Array() }),
  };
}

export function createTelegramReactionContext(params: {
  updateId: number;
  reaction?: Record<string, unknown>;
}): TelegramTestContext {
  return {
    update: { update_id: params.updateId },
    messageReaction: {
      chat: { id: 1234, type: "private" },
      message_id: 42,
      user: { id: 9, first_name: "Ada" },
      date: 1_736_380_800,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👍" }],
      ...params.reaction,
    },
  };
}

export async function runTelegramTestMiddlewareChain(
  middlewareUseSpy: MiddlewareUseSpy,
  ctx: TelegramTestContext,
  finalHandler: (ctx: TelegramTestContext) => Promise<void>,
): Promise<void> {
  const middlewares = middlewareUseSpy.mock.calls
    .map((call) => call[0])
    .filter((fn): fn is TelegramTestMiddleware => typeof fn === "function");
  let index = -1;
  const dispatch = async (nextIndex: number): Promise<void> => {
    if (nextIndex <= index) {
      throw new Error("middleware dispatch called multiple times");
    }
    index = nextIndex;
    const middleware = middlewares[nextIndex];
    if (!middleware) {
      await finalHandler(ctx);
      return;
    }
    await middleware(ctx, async () => dispatch(nextIndex + 1));
  };
  await dispatch(0);
}
