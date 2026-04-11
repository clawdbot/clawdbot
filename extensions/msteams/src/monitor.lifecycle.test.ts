import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsPollStore } from "./polls.js";

type FakeServer = EventEmitter & {
  close: (callback?: (err?: Error | null) => void) => void;
  setTimeout: (msecs: number) => FakeServer;
  requestTimeout: number;
  headersTimeout: number;
};

const expressControl = vi.hoisted(() => ({
  mode: { value: "listening" as "listening" | "error" },
  apps: [] as Array<{
    use: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    listen: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../runtime-api.js", () => ({
  DEFAULT_WEBHOOK_MAX_BODY_BYTES: 1024 * 1024,
  normalizeSecretInputString: (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined,
  hasConfiguredSecretInput: (value: unknown) =>
    typeof value === "string" && value.trim().length > 0,
  normalizeResolvedSecretInputString: (params: { value?: unknown }) =>
    typeof params?.value === "string" && params.value.trim() ? params.value.trim() : undefined,
  keepHttpServerTaskAlive: vi.fn(
    async (params: { abortSignal?: AbortSignal; onAbort?: () => Promise<void> | void }) => {
      await new Promise<void>((resolve) => {
        if (params.abortSignal?.aborted) {
          resolve();
          return;
        }
        params.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await params.onAbort?.();
    },
  ),
  mergeAllowlist: (params: { existing?: string[]; additions?: string[] }) =>
    Array.from(new Set([...(params.existing ?? []), ...(params.additions ?? [])])),
  summarizeMapping: vi.fn(),
}));

vi.mock("express", () => {
  const json = vi.fn(() => {
    return (_req: unknown, _res: unknown, next?: (err?: unknown) => void) => {
      next?.();
    };
  });

  const factory = () => ({
    use: vi.fn(),
    post: vi.fn(),
    listen: vi.fn((_port: number) => {
      const server = new EventEmitter() as FakeServer;
      server.setTimeout = vi.fn((_msecs: number) => server);
      server.requestTimeout = 0;
      server.headersTimeout = 0;
      server.close = (callback?: (err?: Error | null) => void) => {
        queueMicrotask(() => {
          server.emit("close");
          callback?.(null);
        });
      };
      queueMicrotask(() => {
        if (expressControl.mode.value === "error") {
          server.emit("error", new Error("listen EADDRINUSE"));
          return;
        }
        server.emit("listening");
      });
      return server;
    }),
  });

  const wrappedFactory = () => {
    const app = factory();
    expressControl.apps.push(app);
    return app;
  };

  return {
    default: wrappedFactory,
    json,
  };
});

const registerMSTeamsHandlers = vi.hoisted(() =>
  vi.fn(() => ({
    run: vi.fn(async () => {}),
  })),
);
const createMSTeamsAdapter = vi.hoisted(() =>
  vi.fn(() => ({
    process: vi.fn(async () => {}),
  })),
);
const jwtValidate = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const loadMSTeamsSdkWithAuth = vi.hoisted(() =>
  vi.fn(async () => ({
    sdk: {
      ActivityHandler: function ActivityHandler() {},
      MsalTokenProvider: function MsalTokenProvider() {},
      authorizeJWT:
        () => (_req: unknown, _res: unknown, next: ((err?: unknown) => void) | undefined) =>
          next?.(),
    },
    authConfig: {},
  })),
);

vi.mock("./monitor-handler.js", () => ({
  registerMSTeamsHandlers: () => registerMSTeamsHandlers(),
}));

vi.mock("./resolve-allowlist.js", () => ({
  resolveMSTeamsChannelAllowlist: vi.fn(async () => []),
  resolveMSTeamsUserAllowlist: vi.fn(async () => []),
}));

vi.mock("./sdk.js", () => ({
  createMSTeamsAdapter: () => createMSTeamsAdapter(),
  loadMSTeamsSdkWithAuth: () => loadMSTeamsSdkWithAuth(),
  createMSTeamsTokenProvider: () => ({
    getAccessToken: vi.fn().mockResolvedValue("mock-token"),
  }),
  createBotFrameworkJwtValidator: vi.fn().mockResolvedValue({
    validate: jwtValidate,
  }),
}));

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: () => ({
    logging: {
      getChildLogger: () => ({
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    },
    channel: {
      text: {
        resolveTextChunkLimit: () => 4000,
      },
    },
  }),
}));

import { monitorMSTeamsProvider } from "./monitor.js";

function createConfig(port: number): OpenClawConfig {
  return {
    channels: {
      msteams: {
        enabled: true,
        appId: "app-id",
        appPassword: "app-password", // pragma: allowlist secret
        tenantId: "tenant-id",
        webhook: {
          port,
          path: "/api/messages",
        },
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

function createStores() {
  return {
    conversationStore: {} as MSTeamsConversationStore,
    pollStore: {} as MSTeamsPollStore,
  };
}

describe("monitorMSTeamsProvider lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
    expressControl.mode.value = "listening";
    expressControl.apps.length = 0;
    jwtValidate.mockReset().mockResolvedValue(true);
  });

  it("stays active until aborted", async () => {
    const abort = new AbortController();
    const stores = createStores();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(0),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: stores.conversationStore,
      pollStore: stores.pollStore,
    });

    const early = await Promise.race([
      task.then(() => "resolved"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    expect(early).toBe("pending");

    abort.abort();
    const result = await task;
    expect(result.app).not.toBeNull();
    await expect(result.shutdown()).resolves.toBeUndefined();
  });

  it("rejects startup when webhook port is already in use", async () => {
    expressControl.mode.value = "error";
    await expect(
      monitorMSTeamsProvider({
        cfg: createConfig(3978),
        runtime: createRuntime(),
        abortSignal: new AbortController().signal,
        conversationStore: createStores().conversationStore,
        pollStore: createStores().pollStore,
      }),
    ).rejects.toThrow(/EADDRINUSE/);
  });

  it("runs JWT validation before JSON body parsing", async () => {
    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(0),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const app = expressControl.apps.at(-1);
    expect(app).toBeDefined();
    expect(app!.use).toHaveBeenCalledTimes(4);

    const jsonMiddleware = vi.mocked((await import("express")).json).mock.results[0]?.value;
    expect(jsonMiddleware).toBeDefined();
    expect(app!.use.mock.calls[1]?.[0]).not.toBe(jsonMiddleware);
    expect(app!.use.mock.calls[2]?.[0]).toBe(jsonMiddleware);

    const jwtMiddleware = app!.use.mock.calls[1]?.[0] as (
      req: Request,
      res: Response,
      next: (err?: unknown) => void,
    ) => void;
    const next = vi.fn();
    jwtMiddleware(
      { headers: { authorization: "Bearer token" } } as Request,
      {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response,
      next,
    );

    await vi.waitFor(() => {
      expect(jwtValidate).toHaveBeenCalledWith("Bearer token");
      expect(next).toHaveBeenCalledTimes(1);
    });

    abort.abort();
    await task;
  });
});
