import { vi, type Mock } from "vitest";

type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type BuildTelegramMessageContextForTest =
  typeof import("./bot-message-context.test-harness.js").buildTelegramMessageContextForTest;
type BuildTelegramMessageContextForTestParams = Parameters<BuildTelegramMessageContextForTest>[0];
type TelegramTestSessionRuntime = NonNullable<
  import("./bot-message-context.types.js").BuildTelegramMessageContextParams["sessionRuntime"]
>;

const hoisted = vi.hoisted((): { recordInboundSessionMock: AsyncUnknownMock } => ({
  recordInboundSessionMock: vi.fn().mockResolvedValue(undefined),
}));

export const recordInboundSessionMock: AsyncUnknownMock = hoisted.recordInboundSessionMock;
const finalizeInboundContextForTest = ((ctx) => {
  const next = ctx as Record<string, unknown>;
  const body = typeof next.Body === "string" ? next.Body : "";
  next.Body = body;
  next.BodyForAgent =
    typeof next.BodyForAgent === "string"
      ? next.BodyForAgent
      : typeof next.RawBody === "string"
        ? next.RawBody
        : body;
  next.BodyForCommands =
    typeof next.BodyForCommands === "string"
      ? next.BodyForCommands
      : typeof next.CommandBody === "string"
        ? next.CommandBody
        : typeof next.RawBody === "string"
          ? next.RawBody
          : body;
  next.CommandAuthorized = Boolean(next.CommandAuthorized);
  return next;
}) as NonNullable<TelegramTestSessionRuntime["finalizeInboundContext"]>;
const recordInboundSessionForTest: NonNullable<
  TelegramTestSessionRuntime["recordInboundSession"]
> = async (params) => {
  await recordInboundSessionMock(params);
};

export const telegramRouteTestSessionRuntime = {
  finalizeInboundContext: finalizeInboundContextForTest,
  readSessionUpdatedAt: () => undefined,
  recordInboundSession: recordInboundSessionForTest,
  resolveInboundLastRouteSessionKey: ({ route, sessionKey }) =>
    route.lastRoutePolicy === "main" ? route.mainSessionKey : sessionKey,
  resolvePinnedMainDmOwnerFromAllowlist: () => null,
  resolveStorePath: () => "/tmp/openclaw/session-store.json",
} satisfies TelegramTestSessionRuntime;

export async function loadTelegramMessageContextRouteHarness() {
  const [
    { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot },
    { buildTelegramMessageContextForTest },
  ] = await Promise.all([
    import("../../../src/config/config.js"),
    import("./bot-message-context.test-harness.js"),
  ]);
  const buildTelegramMessageContextForRouteTest = (
    params: BuildTelegramMessageContextForTestParams,
  ) =>
    buildTelegramMessageContextForTest({
      ...params,
      sessionRuntime: {
        ...telegramRouteTestSessionRuntime,
        ...params.sessionRuntime,
      },
    });
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
