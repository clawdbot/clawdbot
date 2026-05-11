import { buildChannelTurnContext } from "openclaw/plugin-sdk/channel-inbound";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { vi, type Mock } from "vitest";

type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type BuildTelegramMessageContextForTest =
  typeof import("./bot-message-context.test-harness.js").buildTelegramMessageContextForTest;
type BuildTelegramMessageContextForTestParams = Parameters<BuildTelegramMessageContextForTest>[0];
type BuildTelegramMessageContextParams =
  import("./bot-message-context.types.js").BuildTelegramMessageContextParams;

const hoisted = vi.hoisted((): { recordInboundSessionMock: AsyncUnknownMock } => ({
  recordInboundSessionMock: vi.fn().mockResolvedValue(undefined),
}));

export const recordInboundSessionMock: AsyncUnknownMock = hoisted.recordInboundSessionMock;
const recordInboundSessionForTest: NonNullable<
  NonNullable<BuildTelegramMessageContextParams["sessionRuntime"]>["recordInboundSession"]
> = async (params) => {
  await recordInboundSessionMock(params);
};

export const telegramRouteTestSessionRuntime: NonNullable<
  BuildTelegramMessageContextParams["sessionRuntime"]
> = {
  buildChannelTurnContext,
  readSessionUpdatedAt: () => undefined,
  recordInboundSession: recordInboundSessionForTest,
  resolveInboundLastRouteSessionKey: ({ route, sessionKey }) =>
    route.lastRoutePolicy === "main" ? route.mainSessionKey : sessionKey,
  resolvePinnedMainDmOwnerFromAllowlist: () => null,
  resolveStorePath: () => "/tmp/openclaw/session-store.json",
};

export async function loadTelegramMessageContextRouteHarness() {
  const { buildTelegramMessageContextForTest } =
    await import("./bot-message-context.test-harness.js");
  const buildTelegramMessageContextForRouteTest = async (
    params: BuildTelegramMessageContextForTestParams,
  ) => {
    const ctx = await buildTelegramMessageContextForTest({
      ...params,
      sessionRuntime: {
        ...telegramRouteTestSessionRuntime,
        ...params.sessionRuntime,
      },
    });
    if (ctx) {
      await recordInboundSessionMock({
        updateLastRoute: ctx.turn.record.updateLastRoute,
      });
    }
    return ctx;
  };
  return {
    clearRuntimeConfigSnapshot,
    setRuntimeConfigSnapshot,
    buildTelegramMessageContextForTest: buildTelegramMessageContextForRouteTest,
  };
}

export function getRecordedUpdateLastRoute(callIndex = -1): unknown {
  const callArgs =
    callIndex === -1
      ? (recordInboundSessionMock.mock.calls.at(-1)?.[0] as
          | { updateLastRoute?: unknown }
          | undefined)
      : (recordInboundSessionMock.mock.calls[callIndex]?.[0] as
          | { updateLastRoute?: unknown }
          | undefined);
  return callArgs?.updateLastRoute;
}
