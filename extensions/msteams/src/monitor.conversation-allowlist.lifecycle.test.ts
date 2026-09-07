// Provider startup must preserve Teams thread identities in group-only allowlists.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsActivityHandler } from "./monitor-handler.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import { getMSTeamsIngressMockState } from "./monitor-ingress-mock.test-support.js";
import type { MSTeamsPollStore } from "./polls.js";

type FakeServer = EventEmitter & {
  close: (callback?: (err?: Error | null) => void) => void;
  setTimeout: (msecs: number) => FakeServer;
  requestTimeout: number;
  headersTimeout: number;
};

type MSTeamsUserResolution = { input: string; resolved: boolean; id?: string };
type ResolveMSTeamsUserAllowlistMock = (params: {
  cfg: unknown;
  entries: string[];
}) => Promise<MSTeamsUserResolution[]>;
type RegisterMSTeamsHandlersMock = (
  handler: MSTeamsActivityHandler,
  deps: MSTeamsMessageHandlerDeps,
) => MSTeamsActivityHandler;
type MockExpressFn = ReturnType<typeof vi.fn>;
type MockExpressApp = MockExpressFn & {
  use: MockExpressFn;
  post: MockExpressFn;
  listen: MockExpressFn;
};

const isDangerousNameMatchingEnabled = vi.hoisted(() => vi.fn());
const keepHttpServerTaskAliveMock = vi.hoisted(() =>
  vi.fn(async (params: { abortSignal?: AbortSignal; onAbort?: () => Promise<void> | void }) => {
    await new Promise<void>((resolve) => {
      if (params.abortSignal?.aborted) {
        resolve();
        return;
      }
      params.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
    await params.onAbort?.();
  }),
);

vi.mock("../runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime-api.js")>();
  return {
    ...actual,
    isDangerousNameMatchingEnabled,
    keepHttpServerTaskAlive: keepHttpServerTaskAliveMock,
    summarizeMapping: vi.fn(),
  };
});

vi.mock("express", () => ({
  default: () => {
    const app = vi.fn() as MockExpressApp;
    app.use = vi.fn();
    app.post = vi.fn();
    app.listen = vi.fn((_port: number, callback?: (error?: Error) => void) => {
      const server = new EventEmitter() as FakeServer;
      server.setTimeout = vi.fn((_msecs: number) => server);
      server.requestTimeout = 0;
      server.headersTimeout = 0;
      server.close = (closeCallback?: (err?: Error | null) => void) => {
        queueMicrotask(() => {
          server.emit("close");
          closeCallback?.(null);
        });
      };
      queueMicrotask(() => callback?.());
      return server;
    });
    return app;
  },
  json: vi.fn(
    () => (_request: unknown, _response: unknown, next?: (error?: unknown) => void) => next?.(),
  ),
}));

const registerMSTeamsHandlers = vi.hoisted(() =>
  vi.fn<RegisterMSTeamsHandlersMock>((handler) => handler),
);
const resolveMSTeamsUserAllowlist = vi.hoisted(() =>
  vi.fn<ResolveMSTeamsUserAllowlistMock>(async () => []),
);
const loadMSTeamsSdkWithAuth = vi.hoisted(() =>
  vi.fn(async (_creds?: unknown, _options?: unknown) => ({
    app: {
      on: vi.fn(),
      event: vi.fn(),
      onTokenExchange: vi.fn(async () => ({ status: 200 })),
      onVerifyState: vi.fn(async () => ({ status: 200 })),
      initialize: vi.fn(async () => {}),
      tokenManager: {
        getBotToken: vi.fn(async () => ({ toString: (): string => "bot-token" })),
        getGraphToken: vi.fn(async () => ({ toString: (): string => "graph-token" })),
      },
    },
  })),
);

vi.mock("@microsoft/teams.apps", () => ({ ExpressAdapter: vi.fn() }));
vi.mock("./monitor-handler.js", () => ({
  isCardActionInvokeAuthorized: vi.fn(async () => true),
  isSigninInvokeAuthorized: vi.fn(async () => true),
  registerMSTeamsHandlers,
}));
vi.mock("./file-consent-invoke.js", () => ({
  runMSTeamsFileConsentInvokeHandler: vi.fn(async () => {}),
}));
vi.mock("./resolve-allowlist.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resolve-allowlist.js")>()),
  resolveMSTeamsTeamsConfig: vi.fn(async (params: { teams: Record<string, unknown> }) => ({
    teams: params.teams,
    mapping: [],
    unresolved: [],
  })),
  resolveMSTeamsUserAllowlist,
}));
vi.mock("./sdk.js", () => ({
  loadMSTeamsSdkWithAuth: (creds?: unknown, options?: unknown) =>
    loadMSTeamsSdkWithAuth(creds, options),
  createMSTeamsTokenProvider: () => ({
    getAccessToken: vi.fn().mockResolvedValue("mock-token"),
  }),
  createMSTeamsExpressAdapter: vi.fn().mockResolvedValue({
    registerRoute: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: () => ({
    logging: {
      getChildLogger: () => ({
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      }),
    },
    channel: { text: { resolveTextChunkLimit: () => 4000 } },
  }),
}));
vi.mock("./sso-token-store.js", () => ({
  createMSTeamsSsoTokenStoreFs: () => ({
    get: vi.fn(async () => null),
    save: vi.fn(async () => {}),
    remove: vi.fn(async () => false),
  }),
}));

import { monitorMSTeamsProvider } from "./monitor.js";

function createConfig(patch: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      msteams: {
        enabled: true,
        appId: "app-id",
        appPassword: "app-password", // pragma: allowlist secret
        tenantId: "tenant-id",
        webhook: { port: 0, path: "/api/messages" },
        ...patch,
      },
    },
  } as OpenClawConfig;
}

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
}

function requireRegisteredMSTeamsConfig(): OpenClawConfig {
  const registered = registerMSTeamsHandlers.mock.calls[0]?.[1];
  if (!registered?.cfg) {
    throw new Error("expected registered MSTeams handler config");
  }
  return registered.cfg;
}

async function withStartedProvider(
  cfg: OpenClawConfig,
  verify: (registeredCfg: OpenClawConfig) => void,
): Promise<void> {
  const abort = new AbortController();
  const task = monitorMSTeamsProvider({
    cfg,
    runtime: createRuntime(),
    abortSignal: abort.signal,
    conversationStore: {} as MSTeamsConversationStore,
    pollStore: {} as MSTeamsPollStore,
  });
  try {
    await vi.waitFor(() => expect(registerMSTeamsHandlers).toHaveBeenCalled(), { interval: 1 });
    verify(requireRegisteredMSTeamsConfig());
  } finally {
    abort.abort();
    await task;
  }
}

describe("monitorMSTeamsProvider group conversation allowlist lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
    isDangerousNameMatchingEnabled.mockReset().mockReturnValue(false);
    resolveMSTeamsUserAllowlist.mockReset().mockResolvedValue([]);
    getMSTeamsIngressMockState().instances.length = 0;
  });

  it.each([false, true])(
    "preserves stable thread allowlists without widening DMs (name matching: %s)",
    async (dangerouslyAllowNameMatching) => {
      isDangerousNameMatchingEnabled.mockReturnValue(dangerouslyAllowNameMatching);
      const cfg = createConfig({
        dangerouslyAllowNameMatching,
        allowFrom: ["19:group@thread.tacv2", "user:40a1a0ed-4ff2-4164-a219-55518990c197"],
        groupAllowFrom: [
          "19:group@thread.tacv2;messageid=1740123456789",
          "19:MiXeD-group@thread.tacv2;messageid=1740123456789",
          "19:modern-group@thread.v2;messageid=1740123456789",
          "19:legacy@thread.skype",
          "msteams:user:50a1a0ed-4ff2-4164-a219-55518990c198",
        ],
      });

      await withStartedProvider(cfg, (registeredCfg) => {
        expect(registeredCfg.channels?.msteams?.allowFrom).toEqual([
          "40a1a0ed-4ff2-4164-a219-55518990c197",
        ]);
        expect(registeredCfg.channels?.msteams?.groupAllowFrom).toEqual([
          "19:group@thread.tacv2",
          "19:MiXeD-group@thread.tacv2",
          "19:modern-group@thread.v2",
          "19:legacy@thread.skype",
          "50a1a0ed-4ff2-4164-a219-55518990c198",
        ]);
        expect(resolveMSTeamsUserAllowlist).not.toHaveBeenCalled();
      });
    },
  );

  it.each([false, true])(
    "preserves fallback thread allowlists without widening DMs (name matching: %s)",
    async (dangerouslyAllowNameMatching) => {
      isDangerousNameMatchingEnabled.mockReturnValue(dangerouslyAllowNameMatching);
      const cfg = createConfig({
        dangerouslyAllowNameMatching,
        allowFrom: [
          "19:fallback-group@thread.v2;messageid=1740123456789",
          "user:40a1a0ed-4ff2-4164-a219-55518990c197",
        ],
      });

      await withStartedProvider(cfg, (registeredCfg) => {
        expect(registeredCfg.channels?.msteams?.allowFrom).toEqual([
          "40a1a0ed-4ff2-4164-a219-55518990c197",
        ]);
        expect(registeredCfg.channels?.msteams?.groupAllowFrom).toEqual([
          "19:fallback-group@thread.v2",
          "40a1a0ed-4ff2-4164-a219-55518990c197",
        ]);
        expect(resolveMSTeamsUserAllowlist).not.toHaveBeenCalled();
      });
    },
  );

  it("preserves Graph-resolved sender identities in the group fallback", async () => {
    isDangerousNameMatchingEnabled.mockReturnValue(true);
    resolveMSTeamsUserAllowlist.mockResolvedValueOnce([
      { input: "Alice", resolved: true, id: "alice-aad" },
    ]);
    const cfg = createConfig({
      dangerouslyAllowNameMatching: true,
      allowFrom: ["19:fallback-group@thread.v2;messageid=1740123456789", "Alice"],
    });

    await withStartedProvider(cfg, (registeredCfg) => {
      expect(registeredCfg.channels?.msteams?.allowFrom).toEqual(["alice-aad"]);
      expect(registeredCfg.channels?.msteams?.groupAllowFrom).toEqual([
        "19:fallback-group@thread.v2",
        "alice-aad",
      ]);
      expect(resolveMSTeamsUserAllowlist).toHaveBeenCalledExactlyOnceWith({
        cfg,
        entries: ["Alice"],
      });
    });
  });
});
