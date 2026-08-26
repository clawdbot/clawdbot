// Msteams tests cover monitor.lifecycle plugin behavior.
import { createServer, type Server } from "node:http";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsActivityHandler } from "./monitor-handler.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import {
  getMSTeamsIngressMockState,
  gateIngressAcceptThenDispatch,
} from "./monitor-ingress-mock.test-support.js";
import type { MSTeamsPollStore } from "./polls.js";

type MSTeamsUserResolution = {
  input: string;
  resolved: boolean;
  id?: string;
};

type ResolveMSTeamsTeamsConfigMock = (params: {
  cfg: unknown;
  teamIdMode: "bot-framework" | "graph";
  teams: Record<string, unknown>;
}) => Promise<{
  teams: Record<string, unknown>;
  mapping: string[];
  unresolved: string[];
}>;

type ResolveMSTeamsUserAllowlistMock = (params: {
  cfg: unknown;
  entries: string[];
}) => Promise<MSTeamsUserResolution[]>;

type RegisterMSTeamsHandlersMock = (
  handler: MSTeamsActivityHandler,
  deps: MSTeamsMessageHandlerDeps,
) => MSTeamsActivityHandler;

const keepHttpServerTaskAliveMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime-api.js")>();
  keepHttpServerTaskAliveMock.mockImplementation(actual.keepHttpServerTaskAlive);
  return {
    ...actual,
    keepHttpServerTaskAlive: keepHttpServerTaskAliveMock,
  };
});

const registerMSTeamsHandlers = vi.hoisted(() =>
  vi.fn<RegisterMSTeamsHandlersMock>((handler) => handler),
);
const isSigninInvokeAuthorized = vi.hoisted(() => vi.fn(async () => true));
const isCardActionInvokeAuthorized = vi.hoisted(() => vi.fn(async () => true));
const runMSTeamsFileConsentInvokeHandler = vi.hoisted(() => vi.fn(async () => {}));
const loadMSTeamsSdkWithAuth = vi.hoisted(() =>
  vi.fn(async (_creds?: unknown, options?: Record<string, unknown>) => {
    const app = {
      on: vi.fn(),
      event: vi.fn(),
      onTokenExchange: vi.fn(async () => ({ status: 200 })),
      onVerifyState: vi.fn(async () => ({ status: 200 })),
      initialize: vi.fn(async () => {
        const adapter = options?.httpServerAdapter as
          | {
              registerRoute?: (
                path: string,
                handler: (req: Request, res: Response) => void,
              ) => void;
            }
          | undefined;
        const endpoint = options?.messagingEndpoint;
        if (adapter?.registerRoute && typeof endpoint === "string") {
          adapter.registerRoute(endpoint, (req, res) => {
            res.status(200).json({ url: req.url });
          });
        }
      }),
      tokenManager: {
        getBotToken: vi.fn(async () => ({ toString: (): string => "bot-token" })),
        getGraphToken: vi.fn(async () => ({ toString: (): string => "graph-token" })),
      },
    };
    return { app };
  }),
);

const ssoTokenStore = vi.hoisted(() => ({
  get: vi.fn(async () => null),
  save: vi.fn(async () => {}),
  remove: vi.fn(async () => false),
}));

vi.mock("@microsoft/teams.apps", () => ({
  ExpressAdapter: vi.fn(),
}));

vi.mock("./monitor-handler.js", () => ({
  isCardActionInvokeAuthorized,
  isSigninInvokeAuthorized,
  registerMSTeamsHandlers,
}));

vi.mock("./file-consent-invoke.js", () => ({
  runMSTeamsFileConsentInvokeHandler,
}));

const resolveAllowlistMocks = vi.hoisted(() => ({
  resolveMSTeamsTeamsConfig: vi.fn<ResolveMSTeamsTeamsConfigMock>(async ({ teams }) => ({
    teams,
    mapping: [],
    unresolved: [],
  })),
  resolveMSTeamsUserAllowlist: vi.fn<ResolveMSTeamsUserAllowlistMock>(async () => []),
}));

vi.mock("./resolve-allowlist.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resolve-allowlist.js")>()),
  resolveMSTeamsTeamsConfig: resolveAllowlistMocks.resolveMSTeamsTeamsConfig,
  resolveMSTeamsUserAllowlist: resolveAllowlistMocks.resolveMSTeamsUserAllowlist,
}));

vi.mock("./sdk.js", () => ({
  loadMSTeamsSdkWithAuth: (creds?: unknown, options?: Record<string, unknown>) =>
    loadMSTeamsSdkWithAuth(creds, options),
  createMSTeamsTokenProvider: () => ({
    getAccessToken: vi.fn().mockResolvedValue("mock-token"),
  }),
  createMSTeamsExpressAdapter: vi.fn(
    async (expressApp: { post: (...args: unknown[]) => void }) => ({
      registerRoute: (path: string, handler: (req: Request, res: Response) => void) =>
        expressApp.post(path, handler),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    }),
  ),
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
    channel: {
      text: {
        resolveTextChunkLimit: () => 4000,
      },
    },
  }),
}));

vi.mock("./sso-token-store.js", () => ({
  createMSTeamsSsoTokenStoreFs: () => ssoTokenStore,
}));

import { monitorMSTeamsProvider } from "./monitor.js";

async function waitForMSTeamsTestState(assertion: () => void | Promise<void>): Promise<void> {
  await vi.waitFor(assertion, { interval: 1 });
}

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

function updateMSTeamsConfig(
  cfg: OpenClawConfig,
  patch: NonNullable<NonNullable<OpenClawConfig["channels"]>["msteams"]>,
): void {
  const msteams = cfg.channels?.msteams;
  if (!cfg.channels || !msteams) {
    throw new Error("Expected Microsoft Teams config fixture");
  }
  cfg.channels.msteams = {
    ...msteams,
    ...patch,
  };
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

async function resolveStartedServer(): Promise<Server> {
  await waitForMSTeamsTestState(() => {
    expect(keepHttpServerTaskAliveMock).toHaveBeenCalled();
  });
  const server = keepHttpServerTaskAliveMock.mock.calls.at(-1)?.[0]?.server as Server | undefined;
  if (!server) {
    throw new Error("expected started Microsoft Teams HTTP server");
  }
  return server;
}

function resolveServerUrl(server: Server, path: string): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP server address");
  }
  return `http://127.0.0.1:${address.port}${path}`;
}

function requireRegisteredMSTeamsConfig(): OpenClawConfig {
  const registered = registerMSTeamsHandlers.mock.calls[0]?.[1] as
    | { cfg?: OpenClawConfig }
    | undefined;
  if (!registered?.cfg) {
    throw new Error("expected registered MSTeams handler config");
  }
  return registered.cfg;
}

function requireRegisteredMSTeamsMediaMaxBytes(): number {
  const registered = registerMSTeamsHandlers.mock.calls[0]?.[1];
  if (!registered) {
    throw new Error("expected registered MSTeams handler dependencies");
  }
  return registered.mediaMaxBytes;
}

describe("monitorMSTeamsProvider lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
    resolveAllowlistMocks.resolveMSTeamsTeamsConfig
      .mockReset()
      .mockImplementation(async ({ teams }) => ({ teams, mapping: [], unresolved: [] }));
    resolveAllowlistMocks.resolveMSTeamsUserAllowlist.mockReset().mockResolvedValue([]);
    isSigninInvokeAuthorized.mockReset().mockResolvedValue(true);
    isCardActionInvokeAuthorized.mockReset().mockResolvedValue(true);
    runMSTeamsFileConsentInvokeHandler.mockReset().mockResolvedValue(undefined);
    getMSTeamsIngressMockState().instances.length = 0;
    ssoTokenStore.get.mockClear();
    ssoTokenStore.save.mockClear();
    ssoTokenStore.remove.mockClear();
  });

  it("stays active until aborted", async () => {
    const abort = new AbortController();
    const stores = createStores();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(0),
      accountId: "jimmy",
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: stores.conversationStore,
      pollStore: stores.pollStore,
    });

    let taskSettled = false;
    void task.then(
      () => {
        taskSettled = true;
      },
      () => {
        taskSettled = true;
      },
    );
    await waitForMSTeamsTestState(() => {
      expect(keepHttpServerTaskAliveMock).toHaveBeenCalledTimes(1);
    });
    expect(registerMSTeamsHandlers.mock.calls[0]?.[1]?.accountId).toBe("jimmy");
    expect(getMSTeamsIngressMockState().instances[0]?.options.accountId).toBe("jimmy");
    await Promise.resolve();
    expect(taskSettled).toBe(false);

    abort.abort();
    const result = await task;
    if (!result.app) {
      throw new Error("expected Teams monitor app after startup abort");
    }
  });

  it("prefers the Teams media limit over the agent default", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, { mediaMaxMb: 12 });
    cfg.agents = { defaults: { mediaMaxMb: 3 } };

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      ...createStores(),
    });

    await waitForMSTeamsTestState(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalledTimes(1);
    });
    expect(requireRegisteredMSTeamsMediaMaxBytes()).toBe(12 * 1024 * 1024);

    abort.abort();
    await task;
  });

  it("falls back to the agent media limit when Teams has no override", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    cfg.agents = { defaults: { mediaMaxMb: 3 } };

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      ...createStores(),
    });

    await waitForMSTeamsTestState(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalledTimes(1);
    });
    expect(requireRegisteredMSTeamsMediaMaxBytes()).toBe(3 * 1024 * 1024);

    abort.abort();
    await task;
  });

  it("rejects startup when the webhook port is already in use", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, resolve);
    });

    try {
      const address = blocker.address();
      if (!address || typeof address === "string") {
        throw new Error("expected occupied TCP port");
      }

      const stores = createStores();
      const task = monitorMSTeamsProvider({
        cfg: createConfig(address.port),
        runtime: createRuntime(),
        conversationStore: stores.conversationStore,
        pollStore: stores.pollStore,
      });

      await expect(task).rejects.toMatchObject({ code: "EADDRINUSE" });
      const ingress = getMSTeamsIngressMockState().instances[0];
      if (!ingress) {
        throw new Error("expected Teams ingress");
      }
      expect(ingress.start).toHaveBeenCalledTimes(1);
      expect(ingress.stop).toHaveBeenCalledTimes(1);
      expect(keepHttpServerTaskAliveMock).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("rejects requests without Bearer token before SDK route", async () => {
    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(0),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    const server = await resolveStartedServer();
    const unauthorized = await fetch(resolveServerUrl(server, "/api/messages"), {
      method: "POST",
    });
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({ error: "Unauthorized" });

    const authorized = await fetch(resolveServerUrl(server, "/api/messages"), {
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(authorized.status).toBe(200);

    abort.abort();
    await task;
  });

  it("keeps oversized webhook parse failures JSON-shaped", async () => {
    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(0),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    const server = await resolveStartedServer();
    const response = await fetch(resolveServerUrl(server, "/api/messages"), {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ payload: "x".repeat(1024 * 1024) }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Payload too large" });

    abort.abort();
    await task;
  });

  it("forwards legacy /api/messages requests to a custom webhook path", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, {
      webhook: { port: 0, path: "/teams/events" },
    });
    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    const server = await resolveStartedServer();
    expect(loadMSTeamsSdkWithAuth.mock.calls[0]?.[1]).toMatchObject({
      messagingEndpoint: "/teams/events",
    });
    const response = await fetch(resolveServerUrl(server, "/api/messages"), {
      method: "POST",
      headers: { authorization: "Bearer valid" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ url: "/teams/events" });

    abort.abort();
    await task;
  });

  it("gates SDK SSO invoke routes and persists successful signin events", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, {
      sso: { enabled: true, connectionName: "graph" },
    });

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await waitForMSTeamsTestState(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    expect(loadMSTeamsSdkWithAuth.mock.calls[0]?.[1]).toMatchObject({
      oauthDefaultConnectionName: "graph",
    });

    const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
    if (!sdkResultPromise) {
      throw new Error("expected loadMSTeamsSdkWithAuth result");
    }
    const sdkResult = await sdkResultPromise;
    const app = sdkResult.app;
    expect(app.on).toHaveBeenCalledWith("signin.token-exchange", expect.any(Function));
    expect(app.on).toHaveBeenCalledWith("signin.verify-state", expect.any(Function));
    expect(app.event).toHaveBeenCalledWith("signin", expect.any(Function));

    const tokenExchangeHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "signin.token-exchange",
    )?.[1];
    expect(typeof tokenExchangeHandler).toBe("function");
    if (typeof tokenExchangeHandler !== "function") {
      throw new Error("expected signin token-exchange handler");
    }
    const exchangeResult = await tokenExchangeHandler({
      activity: { from: { id: "29:user", aadObjectId: "aad-user" } },
    });
    expect(exchangeResult).toEqual({ status: 200 });
    expect(app.onTokenExchange).toHaveBeenCalledTimes(1);

    const signinHandler = app.event.mock.calls.find(
      (call: [string, unknown]) => call[0] === "signin",
    )?.[1];
    expect(typeof signinHandler).toBe("function");
    if (typeof signinHandler !== "function") {
      throw new Error("expected signin event handler");
    }

    signinHandler({
      activity: { from: { id: "29:user", aadObjectId: "aad-user" } },
      token: {
        connectionName: "graph",
        token: "delegated-graph-token",
        expiration: "2030-01-01T00:00:00Z",
      },
    });

    await waitForMSTeamsTestState(() => {
      expect(isSigninInvokeAuthorized).toHaveBeenCalledTimes(2);
      expect(ssoTokenStore.save).toHaveBeenCalledTimes(2);
    });
    expect(ssoTokenStore.save).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionName: "graph",
        userId: "29:user",
        token: "delegated-graph-token",
        expiresAt: "2030-01-01T00:00:00Z",
      }),
    );
    expect(ssoTokenStore.save).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionName: "graph",
        userId: "aad-user",
        token: "delegated-graph-token",
        expiresAt: "2030-01-01T00:00:00Z",
      }),
    );

    abort.abort();
    await task;
  });

  it("does not persist SDK SSO signin events when Teams sender policy denies them", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, {
      sso: { enabled: true, connectionName: "graph" },
    });
    isSigninInvokeAuthorized.mockResolvedValueOnce(false);

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await waitForMSTeamsTestState(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
    if (!sdkResultPromise) {
      throw new Error("expected loadMSTeamsSdkWithAuth result");
    }
    const app = (await sdkResultPromise).app;
    const signinHandler = app.event.mock.calls.find(
      (call: [string, unknown]) => call[0] === "signin",
    )?.[1];
    if (typeof signinHandler !== "function") {
      throw new Error("expected signin event handler");
    }

    signinHandler({
      activity: { from: { id: "29:user", aadObjectId: "aad-user" } },
      token: {
        connectionName: "graph",
        token: "delegated-graph-token",
        expiration: "2030-01-01T00:00:00Z",
      },
    });

    await waitForMSTeamsTestState(() => {
      expect(isSigninInvokeAuthorized).toHaveBeenCalledTimes(1);
    });
    expect(ssoTokenStore.save).not.toHaveBeenCalled();

    abort.abort();
    await task;
  });

  it("blocks SDK SSO token exchange before the SDK calls Bot Framework", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, {
      sso: { enabled: true, connectionName: "graph" },
    });
    isSigninInvokeAuthorized.mockResolvedValueOnce(false);

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await waitForMSTeamsTestState(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
    if (!sdkResultPromise) {
      throw new Error("expected loadMSTeamsSdkWithAuth result");
    }
    const app = (await sdkResultPromise).app;
    const tokenExchangeHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "signin.token-exchange",
    )?.[1];
    if (typeof tokenExchangeHandler !== "function") {
      throw new Error("expected signin token-exchange handler");
    }

    const result = await tokenExchangeHandler({
      activity: { from: { id: "29:blocked", aadObjectId: "aad-blocked" } },
    });

    expect(result).toEqual({ status: 200, body: {} });
    expect(isSigninInvokeAuthorized).toHaveBeenCalledTimes(1);
    expect(app.onTokenExchange).not.toHaveBeenCalled();
    expect(ssoTokenStore.save).not.toHaveBeenCalled();

    abort.abort();
    await task;
  });

  it("falls through non-feedback message.submit invokes to activity dispatch", async () => {
    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(0),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await waitForMSTeamsTestState(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
    if (!sdkResultPromise) {
      throw new Error("expected loadMSTeamsSdkWithAuth result");
    }
    const app = (await sdkResultPromise).app;
    const messageSubmitHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "message.submit",
    )?.[1];
    const activityHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "activity",
    )?.[1];
    if (typeof messageSubmitHandler !== "function" || typeof activityHandler !== "function") {
      throw new Error("expected message.submit and activity handlers");
    }

    const activity = {
      type: "invoke",
      name: "message/submitAction",
      value: { actionName: "nonFeedbackAction" },
    };
    const next = vi.fn(async () => {});
    await messageSubmitHandler({ activity, next });
    expect(next).toHaveBeenCalledTimes(1);

    const registeredHandler = registerMSTeamsHandlers.mock.calls[0]?.[0];
    if (!registeredHandler) {
      throw new Error("expected registered Teams handler");
    }
    const run = vi.spyOn(registeredHandler, "run");
    const getTeamDetails = vi.fn(async () => ({ aadGroupId: "activity-aad-group" }));
    await activityHandler({
      activity,
      api: { teams: { getById: getTeamDetails } },
      send: vi.fn(async () => undefined),
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ activity }));
    const adaptedContext = run.mock.calls[0]?.[0] as
      | { getTeamDetails?: (teamId: string) => Promise<{ aadGroupId?: string }> }
      | undefined;
    await expect(adaptedContext?.getTeamDetails?.("activity-team-id")).resolves.toEqual({
      aadGroupId: "activity-aad-group",
    });
    expect(getTeamDetails).toHaveBeenCalledWith("activity-team-id");

    abort.abort();
    await task;
  });

  it("acks file-consent invokes before upload work settles", async () => {
    let releaseUpload: (() => void) | undefined;
    const uploadWork = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    runMSTeamsFileConsentInvokeHandler.mockReturnValueOnce(uploadWork);

    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(0),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await waitForMSTeamsTestState(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
    if (!sdkResultPromise) {
      throw new Error("expected loadMSTeamsSdkWithAuth result");
    }
    const app = (await sdkResultPromise).app;
    const fileConsentHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "file.consent.accept",
    )?.[1];
    if (typeof fileConsentHandler !== "function") {
      throw new Error("expected file consent accept handler");
    }

    expect(fileConsentHandler({ activity: { type: "invoke", name: "fileConsent/invoke" } })).toBe(
      undefined,
    );
    expect(runMSTeamsFileConsentInvokeHandler).toHaveBeenCalledTimes(1);
    releaseUpload?.();
    await uploadWork;

    abort.abort();
    await task;
  });

  it("acks non-poll card actions after durable admission, before agent dispatch settles", async () => {
    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(0),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await waitForMSTeamsTestState(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
    if (!sdkResultPromise) {
      throw new Error("expected loadMSTeamsSdkWithAuth result");
    }
    const app = (await sdkResultPromise).app;
    const cardActionHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "card.action",
    )?.[1];
    if (typeof cardActionHandler !== "function") {
      throw new Error("expected card.action handler");
    }
    const registeredHandler = registerMSTeamsHandlers.mock.calls[0]?.[0];
    if (!registeredHandler) {
      throw new Error("expected registered Teams handler");
    }
    const dispatchWork = new Promise<void>(() => {});
    const run = vi.spyOn(registeredHandler, "run").mockReturnValueOnce(dispatchWork);

    const ingress = getMSTeamsIngressMockState().instances[0];
    if (!ingress) {
      throw new Error("expected Teams ingress");
    }
    let releaseAppend: (() => void) | undefined;
    const appendWork = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    gateIngressAcceptThenDispatch(ingress, appendWork);

    const responseWork = cardActionHandler({
      activity: {
        id: "activity-card-action",
        type: "invoke",
        name: "adaptiveCard/action",
        conversation: { id: "conversation-card-action", conversationType: "personal" },
        value: { action: { data: { action: "nonPoll" } } },
      },
    });

    let responseSettled = false;
    void responseWork.then(() => {
      responseSettled = true;
    });
    await Promise.resolve();
    expect(responseSettled).toBe(false);

    releaseAppend?.();
    const response = await responseWork;

    expect(response).toMatchObject({ statusCode: 200, value: "OK" });
    expect(run).toHaveBeenCalledTimes(1);

    abort.abort();
    await task;
  });

  it("gates poll card votes before recording them", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    const pollStore: MSTeamsPollStore = {
      createPoll: vi.fn(async () => {}),
      getPoll: vi.fn(async () => ({
        id: "poll-1",
        question: "Ship?",
        options: ["Yes", "No"],
        maxSelections: 1,
        createdAt: "2026-01-01T00:00:00Z",
        conversationId: "19:channel@thread.tacv2",
        votes: {},
      })),
      recordVote: vi.fn(async () => null),
    };
    isCardActionInvokeAuthorized.mockResolvedValueOnce(false);

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore,
    });

    await waitForMSTeamsTestState(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
    if (!sdkResultPromise) {
      throw new Error("expected loadMSTeamsSdkWithAuth result");
    }
    const app = (await sdkResultPromise).app;
    const cardActionHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "card.action",
    )?.[1];
    if (typeof cardActionHandler !== "function") {
      throw new Error("expected card.action handler");
    }

    const response = await cardActionHandler({
      activity: {
        type: "invoke",
        name: "adaptiveCard/action",
        from: { id: "29:user", aadObjectId: "aad-user" },
        conversation: { id: "19:channel@thread.tacv2", conversationType: "channel" },
        value: { action: { data: { openclawPollId: "poll-1", choices: "0" } } },
      },
    });

    expect(response).toMatchObject({ statusCode: 200, value: "Not authorized." });
    expect(isCardActionInvokeAuthorized).toHaveBeenCalledTimes(1);
    expect(pollStore.getPoll).not.toHaveBeenCalled();
    expect(pollStore.recordVote).not.toHaveBeenCalled();

    abort.abort();
    await task;
  });

  it("rejects poll card votes from the wrong conversation", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    const pollStore: MSTeamsPollStore = {
      createPoll: vi.fn(async () => {}),
      getPoll: vi.fn(async () => ({
        id: "poll-1",
        question: "Ship?",
        options: ["Yes", "No"],
        maxSelections: 1,
        createdAt: "2026-01-01T00:00:00Z",
        conversationId: "19:expected@thread.tacv2",
        votes: {},
      })),
      recordVote: vi.fn(async () => null),
    };

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore,
    });

    await waitForMSTeamsTestState(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
    if (!sdkResultPromise) {
      throw new Error("expected loadMSTeamsSdkWithAuth result");
    }
    const app = (await sdkResultPromise).app;
    const cardActionHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "card.action",
    )?.[1];
    if (typeof cardActionHandler !== "function") {
      throw new Error("expected card.action handler");
    }

    const response = await cardActionHandler({
      activity: {
        type: "invoke",
        name: "adaptiveCard/action",
        from: { id: "29:user", aadObjectId: "aad-user" },
        conversation: { id: "19:other@thread.tacv2", conversationType: "channel" },
        value: { action: { data: { openclawPollId: "poll-1", choices: "0" } } },
      },
    });

    expect(response).toMatchObject({ statusCode: 200, value: "Poll not found." });
    expect(isCardActionInvokeAuthorized).toHaveBeenCalledTimes(1);
    expect(pollStore.getPoll).toHaveBeenCalledWith("poll-1");
    expect(pollStore.recordVote).not.toHaveBeenCalled();

    abort.abort();
    await task;
  });

  it("does not resolve user allowlists by display name unless name matching is enabled", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, {
      allowFrom: ["Alice", "user:40a1a0ed-4ff2-4164-a219-55518990c197"],
      groupAllowFrom: ["Bob", "msteams:user:50a1a0ed-4ff2-4164-a219-55518990c198"],
      teams: {
        Product: {
          channels: {
            Roadmap: {},
          },
        },
      },
    });
    resolveAllowlistMocks.resolveMSTeamsTeamsConfig.mockResolvedValueOnce({
      teams: {
        "team-id": {
          channels: {
            "channel-id": {},
          },
        },
      },
      mapping: ["Product/Roadmap→team-id/channel-id"],
      unresolved: [],
    });

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await waitForMSTeamsTestState(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    expect(resolveAllowlistMocks.resolveMSTeamsUserAllowlist).not.toHaveBeenCalled();
    expect(resolveAllowlistMocks.resolveMSTeamsTeamsConfig).toHaveBeenCalledWith({
      cfg,
      teamIdMode: "bot-framework",
      teams: {
        Product: {
          channels: {
            Roadmap: {},
          },
        },
      },
    });

    const registeredCfg = requireRegisteredMSTeamsConfig();
    expect(registeredCfg.channels?.msteams?.allowFrom).toEqual([
      "40a1a0ed-4ff2-4164-a219-55518990c197",
    ]);
    expect(registeredCfg.channels?.msteams?.groupAllowFrom).toEqual([
      "50a1a0ed-4ff2-4164-a219-55518990c198",
    ]);
    expect(registeredCfg.channels?.msteams?.teams).toEqual({
      "team-id": {
        channels: {
          "channel-id": {},
        },
      },
    });

    abort.abort();
    await task;
  });

  it("resolves user allowlists when name matching is enabled", async () => {
    resolveAllowlistMocks.resolveMSTeamsUserAllowlist
      .mockResolvedValueOnce([{ input: "Alice", resolved: true, id: "alice-aad" }])
      .mockResolvedValueOnce([{ input: "Bob", resolved: true, id: "bob-aad" }]);

    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, {
      dangerouslyAllowNameMatching: true,
      allowFrom: ["Alice"],
      groupAllowFrom: ["Bob"],
    });

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await waitForMSTeamsTestState(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    expect(resolveAllowlistMocks.resolveMSTeamsUserAllowlist).toHaveBeenNthCalledWith(1, {
      cfg,
      entries: ["Alice"],
    });
    expect(resolveAllowlistMocks.resolveMSTeamsUserAllowlist).toHaveBeenNthCalledWith(2, {
      cfg,
      entries: ["Bob"],
    });

    const registeredCfg = requireRegisteredMSTeamsConfig();
    expect(registeredCfg.channels?.msteams?.allowFrom).toEqual(["alice-aad"]);
    expect(registeredCfg.channels?.msteams?.groupAllowFrom).toEqual(["bob-aad"]);

    abort.abort();
    await task;
  });

  it("keeps only stable allowlist entries when Graph resolution fails", async () => {
    resolveAllowlistMocks.resolveMSTeamsUserAllowlist.mockRejectedValueOnce(
      new Error("Graph unavailable"),
    );
    const runtime = createRuntime();
    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, {
      dangerouslyAllowNameMatching: true,
      allowFrom: ["Alice", "accessGroup:operators", "user:40a1a0ed-4ff2-4164-a219-55518990c197"],
      teams: {
        Mutable: {
          channels: {
            Roadmap: {},
          },
        },
        "19:stable-team@thread.tacv2": {
          channels: {
            "19:stable-channel@thread.tacv2": {},
          },
        },
      },
    });

    const task = monitorMSTeamsProvider({
      cfg,
      runtime,
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await waitForMSTeamsTestState(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    expect(requireRegisteredMSTeamsConfig().channels?.msteams?.allowFrom).toEqual([
      "accessGroup:operators",
      "40a1a0ed-4ff2-4164-a219-55518990c197",
    ]);
    expect(requireRegisteredMSTeamsConfig().channels?.msteams?.teams).toEqual({
      "19:stable-team@thread.tacv2": {
        channels: {
          "19:stable-channel@thread.tacv2": {},
        },
      },
    });
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("mutable allowlist entries are disabled"),
    );

    abort.abort();
    await task;
  });
});
