import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  authenticateMock,
  sseClientMock,
  ingressMock,
  inboundRuntimeMock,
  settingsManagerMock,
  monitorFixture,
} = vi.hoisted(() => ({
  authenticateMock: vi.fn(),
  sseClientMock: {
    scry: vi.fn().mockResolvedValue({}),
    subscribe: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    stopReceiving: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    poke: vi.fn().mockResolvedValue(undefined),
  },
  ingressMock: {
    receive: vi.fn().mockResolvedValue({ kind: "ignored" }),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  },
  inboundRuntimeMock: {
    buildContext: vi.fn().mockReturnValue({ kind: "tlon-inbound-context" }),
    dispatch: vi.fn().mockResolvedValue(undefined),
    resolveAgentRoute: vi.fn(() => ({
      accountId: "default",
      agentId: "main",
      dmScope: "main",
      sessionKey: "agent:main:main",
    })),
    resolveEffectiveMessagesConfig: vi.fn(() => ({ responsePrefix: undefined })),
    shouldComputeCommandAuthorized: vi.fn(() => false),
  },
  settingsManagerMock: {
    load: vi.fn().mockResolvedValue({}),
    onChange: vi.fn().mockReturnValue(() => {}),
    startSubscription: vi.fn().mockResolvedValue(undefined),
  },
  monitorFixture: {
    config: {} as OpenClawConfig,
    url: "https://urbit.example.com",
  },
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveHumanDelayConfig: vi.fn(() => undefined),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  createChannelInboundEnvelopeBuilder: vi.fn(() => vi.fn(() => "tlon-envelope")),
}));

vi.mock("../runtime.js", () => ({
  getTlonRuntime: () => ({
    config: { current: () => monitorFixture.config },
    logging: { getChildLogger: () => ({}) },
    channel: {
      commands: {
        shouldComputeCommandAuthorized: inboundRuntimeMock.shouldComputeCommandAuthorized,
      },
      inbound: {
        buildContext: inboundRuntimeMock.buildContext,
        dispatch: inboundRuntimeMock.dispatch,
      },
      reply: {
        resolveEffectiveMessagesConfig: inboundRuntimeMock.resolveEffectiveMessagesConfig,
      },
      routing: { resolveAgentRoute: inboundRuntimeMock.resolveAgentRoute },
    },
  }),
}));

vi.mock("../urbit/auth.js", () => ({ authenticate: authenticateMock }));
vi.mock("../urbit/sse-client.js", () => ({
  UrbitSSEClient: vi.fn(function () {
    return sseClientMock;
  }),
}));
vi.mock("../settings.js", () => ({
  createSettingsManager: vi.fn(() => settingsManagerMock),
}));
vi.mock("./ingress.js", () => ({
  createTlonIngressMonitor: vi.fn(() => ingressMock),
}));

import { monitorTlonProvider } from "./index.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
  monitorFixture.config = {};
});

describe("monitorTlonProvider history ownership", () => {
  it.each(["restart", "concurrent account"] as const)(
    "fetches current server history for a new monitor after %s",
    async (scenario) => {
      const firstController = new AbortController();
      const nextController = new AbortController();
      const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
      const channelNest = `chat/~zod/history-${scenario.replace(" ", "-")}`;
      const historyPath = `/channels/v4/${channelNest}/posts/newest/50/outline.json`;
      const nextShip = scenario === "restart" ? "~zod" : "~bus";
      monitorFixture.config = {
        channels: {
          tlon: {
            code: "code",
            ship: "~zod",
            url: monitorFixture.url,
            ownerShip: "~nec",
            groupChannels: [channelNest],
            accounts: { secondary: { ship: "~bus" } },
          },
        },
      };
      authenticateMock
        .mockResolvedValueOnce("urbauth-~zod=proof")
        .mockResolvedValueOnce(`urbauth-${nextShip}=proof`);
      settingsManagerMock.load.mockResolvedValue({});
      ingressMock.receive.mockResolvedValue({ kind: "ignored" });
      sseClientMock.scry.mockImplementation(async (path) =>
        path === historyPath
          ? Array.from({ length: 50 }, (_, index) => ({
              essay: {
                author: "~nec",
                content: [{ inline: [`current-server-message-${index}`] }],
                sent: 1_700_000_001_000 + index,
              },
            }))
          : {},
      );

      const channelPost = (text: string, id: string) => ({
        nest: channelNest,
        response: {
          post: {
            id,
            "r-post": {
              set: {
                essay: {
                  author: "~nec",
                  content: [{ inline: [text] }],
                  sent: 1_700_000_000_000,
                },
              },
            },
          },
        },
      });
      const firstMonitor = monitorTlonProvider({
        abortSignal: firstController.signal,
        runtime,
      });
      const monitors = [firstMonitor];
      try {
        await vi.waitFor(() => expect(sseClientMock.connect).toHaveBeenCalledOnce());
        const firstSubscription = sseClientMock.subscribe.mock.calls
          .map(([subscription]) => subscription)
          .find(({ app }) => app === "channels");
        if (!firstSubscription) {
          throw new Error("expected first channel subscription");
        }
        for (let index = 0; index < 50; index += 1) {
          await firstSubscription.event(channelPost(`old-cache-${index}`, `old-${index}`));
        }
        expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
        if (scenario === "restart") {
          firstController.abort();
          await firstMonitor;
        }

        monitors.push(
          monitorTlonProvider({
            accountId: scenario === "restart" ? "default" : "secondary",
            abortSignal: nextController.signal,
            runtime,
          }),
        );
        await vi.waitFor(() => expect(sseClientMock.connect).toHaveBeenCalledTimes(2));
        const nextSubscription = sseClientMock.subscribe.mock.calls
          .map(([subscription]) => subscription)
          .findLast(({ app }) => app === "channels");
        if (!nextSubscription) {
          throw new Error("expected next channel subscription");
        }
        await nextSubscription.event(
          channelPost(`${nextShip} summarize this channel`, "summary-request"),
        );

        expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
        const buildContextCall = inboundRuntimeMock.buildContext.mock.calls[0];
        if (!buildContextCall) {
          throw new Error("expected inbound context call");
        }
        const [contextInput] = buildContextCall;
        expect(contextInput.message.bodyForAgent).toContain("current-server-message-0");
        expect(contextInput.message.bodyForAgent).toContain("current-server-message-49");
        expect(contextInput.message.bodyForAgent).not.toContain("old-cache-");
        expect(sseClientMock.scry).toHaveBeenCalledWith(historyPath);
        expect(runtime.error).not.toHaveBeenCalled();
      } finally {
        firstController.abort();
        nextController.abort();
        await Promise.all(monitors);
        sseClientMock.scry.mockReset().mockResolvedValue({});
      }
    },
  );
});
