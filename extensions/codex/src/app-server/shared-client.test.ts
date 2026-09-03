// Codex tests cover shared client plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { SemVer } from "semver";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type RawData } from "ws";
import type { CodexAppServerPreparedAuth } from "./auth-bridge.js";
import { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import { acquireCodexNativeConfigFence } from "./native-config-fence.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { withCodexAppServerJsonClient } from "./request.js";
import { createClientHarness } from "./test-support.js";
import { CodexAdoptedThreadActiveError } from "./thread-lifecycle-errors.js";
import { CODEX_APP_SERVER_VERSION, MIN_SUPPORTED_CODEX_APP_SERVER_VERSION } from "./version.js";

const mocks = vi.hoisted(() => ({
  CodexComputerUseCandidateArtifactsUnavailableError: class extends Error {
    readonly code = "CODEX_COMPUTER_USE_CANDIDATE_ARTIFACTS_UNAVAILABLE";
  },
  bridgeCodexAppServerStartOptions: vi.fn(async ({ startOptions }) => startOptions),
  reconcileCodexComputerUseStartArtifacts: vi.fn(
    async (_params?: {
      startOptions: { command: string };
      desktopGeneration?: { epoch: number; fingerprint: string };
    }) => undefined,
  ),
  applyCodexAppServerAuthProfile: vi.fn(
    async (_params?: {
      agentDir?: string;
      authProfileId?: string;
      config?: unknown;
    }): Promise<void> => undefined,
  ),
  resolveCodexAppServerAuthProfileIdForAgent: vi.fn(
    (params?: { authProfileId?: string }) => params?.authProfileId,
  ),
  resolveCodexAppServerAuthProfileStore: vi.fn(
    (params?: { authProfileStore?: unknown }) => params?.authProfileStore,
  ),
  resolveCodexAppServerPreparedAuthProfileSnapshot: vi.fn(async () => ({
    loginParams: {
      type: "chatgptAuthTokens" as const,
      accessToken: "prepared-token",
      chatgptAccountId: "prepared-account",
      chatgptPlanType: null,
    },
    secretFreeCacheKey: "prepared-account:token:sha256:prepared",
  })),
  refreshCodexAppServerAuthTokens: vi.fn(async () => ({
    accessToken: "refreshed-access",
    chatgptAccountId: "refreshed-account",
    chatgptPlanType: null,
  })),
  resolveCodexAppServerFallbackApiKeyCacheKey: vi.fn(() => undefined as string | undefined),
  resolveCodexAppServerPreparedApiKeyCacheKey: vi.fn(
    (_apiKey: string) => "api_key:sha256:prepared",
  ),
  resolveManagedCodexAppServerStartOptions: vi.fn(async (startOptions) => startOptions),
  resolveManagedCodexNativeCommand: vi.fn((command: string) => `${command}.native`),
  isManagedCodexDesktopCommand: vi.fn((command: string) => command.startsWith("/Applications/")),
  embeddedAgentLog: { debug: vi.fn(), warn: vi.fn() },
  resolveDefaultAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
  desktopGeneration: undefined as { epoch: number; fingerprint: string } | undefined,
  desktopGenerationCurrent: true,
  waitForCodexDesktopGeneration: vi.fn(),
}));
mocks.waitForCodexDesktopGeneration.mockImplementation(async () => mocks.desktopGeneration);

vi.mock("./auth-bridge.js", () => ({
  applyCodexAppServerAuthProfile: mocks.applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions: mocks.bridgeCodexAppServerStartOptions,
  reconcileCodexComputerUseStartArtifacts: mocks.reconcileCodexComputerUseStartArtifacts,
  resolveCodexAppServerAuthProfileIdForAgent: mocks.resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerAuthProfileStore: mocks.resolveCodexAppServerAuthProfileStore,
  resolveCodexAppServerPreparedAuthProfileSnapshot:
    mocks.resolveCodexAppServerPreparedAuthProfileSnapshot,
  refreshCodexAppServerAuthTokens: mocks.refreshCodexAppServerAuthTokens,
  resolveCodexAppServerFallbackApiKeyCacheKey: mocks.resolveCodexAppServerFallbackApiKeyCacheKey,
  resolveCodexAppServerHomeDir: (agentDir: string) =>
    path.join(path.resolve(agentDir), "codex-home"),
  resolveCodexAppServerPreparedApiKeyCacheKey: mocks.resolveCodexAppServerPreparedApiKeyCacheKey,
}));

vi.mock("./managed-binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./managed-binary.js")>()),
  isManagedCodexDesktopCommand: mocks.isManagedCodexDesktopCommand,
  resolveManagedCodexAppServerStartOptions: mocks.resolveManagedCodexAppServerStartOptions,
  resolveManagedCodexNativeCommand: mocks.resolveManagedCodexNativeCommand,
}));

vi.mock("./desktop-generation.js", () => ({
  isCodexDesktopGenerationCurrent: (generation: { epoch: number; fingerprint: string }) =>
    mocks.desktopGenerationCurrent &&
    generation.epoch === mocks.desktopGeneration?.epoch &&
    generation.fingerprint === mocks.desktopGeneration?.fingerprint,
  waitForCodexDesktopGeneration: mocks.waitForCodexDesktopGeneration,
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  AgentHarnessPreflightError: (
    await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()
  ).AgentHarnessPreflightError,
  embeddedAgentLog: mocks.embeddedAgentLog,
  formatErrorMessage: (error: unknown) => String(error),
  OPENCLAW_VERSION: "test",
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveDefaultAgentDir: mocks.resolveDefaultAgentDir,
}));

import {
  assertCodexAppServerClientStartSelectionCurrent,
  captureCodexAppServerClientLifetime,
  captureSharedCodexAppServerCatalogLifetime,
  getSharedCodexAppServerClient,
  readCodexAppServerClientDesktopGeneration,
  readCodexAppServerClientProcessIdentity,
} from "./shared-client.js";

let listCodexAppServerModels: typeof import("./models.js").listCodexAppServerModels;
let clearSharedCodexAppServerClient: typeof import("./shared-client.js").clearSharedCodexAppServerClient;
let clearSharedCodexAppServerClientAndWait: typeof import("./shared-client.js").clearSharedCodexAppServerClientAndWait;
let clearSharedCodexAppServerClientIfCurrent: typeof import("./shared-client.js").clearSharedCodexAppServerClientIfCurrent;
let clearSharedCodexAppServerClientIfCurrentAndUnclaimed: typeof import("./shared-client.js").clearSharedCodexAppServerClientIfCurrentAndUnclaimed;
let clearSharedCodexAppServerClientIfCurrentAndWait: typeof import("./shared-client.js").clearSharedCodexAppServerClientIfCurrentAndWait;
let createIsolatedCodexAppServerClient: typeof import("./shared-client.js").createIsolatedCodexAppServerClient;
let getLeasedSharedCodexAppServerClient: typeof import("./shared-client.js").getLeasedSharedCodexAppServerClient;
let isCodexAppServerStartSelectionChangedError: typeof import("./shared-client.js").isCodexAppServerStartSelectionChangedError;
let retainSharedCodexAppServerClientIfCurrent: typeof import("./shared-client.js").retainSharedCodexAppServerClientIfCurrent;
let retainSharedCodexAppServerClientByInstanceId: typeof import("./shared-client.js").retainSharedCodexAppServerClientByInstanceId;
let releaseLeasedSharedCodexAppServerClient: typeof import("./shared-client.js").releaseLeasedSharedCodexAppServerClient;
let releaseCodexAppServerClientLease: typeof import("./shared-client.js").releaseCodexAppServerClientLease;
let resolveCodexNativeConfigFenceKey: typeof import("./shared-client.js").resolveCodexNativeConfigFenceKey;
let resolveCodexAppServerSpawnIdentity: typeof import("./shared-client.js").resolveCodexAppServerSpawnIdentity;
let retireSharedCodexAppServerClientIfCurrent: typeof import("./shared-client.js").retireSharedCodexAppServerClientIfCurrent;
let retireSharedCodexAppServerClientsBeforeDesktopGeneration: typeof import("./shared-client.js").retireSharedCodexAppServerClientsBeforeDesktopGeneration;
let waitForCodexAppServerClientDesktopGenerationDrain: typeof import("./shared-client.js").waitForCodexAppServerClientDesktopGenerationDrain;
let resetSharedCodexAppServerClientForTests: typeof import("./shared-client.js").resetSharedCodexAppServerClientForTests;
let withLeasedCodexAppServerClientStartSelectionRetry: typeof import("./shared-client.js").withLeasedCodexAppServerClientStartSelectionRetry;

async function sendInitializeResult(
  harness: ReturnType<typeof createClientHarness>,
  userAgent: string,
): Promise<void> {
  const initialize = JSON.parse(await harness.waitForWrite(0)) as { id: number; method: string };
  expect(initialize.method).toBe("initialize");
  harness.send({ id: initialize.id, result: { userAgent } });
}

async function sendEmptyModelList(harness: ReturnType<typeof createClientHarness>): Promise<void> {
  const modelList = JSON.parse(await harness.waitForWrite(2)) as { id: number; method: string };
  expect(modelList.method).toBe("model/list");
  harness.send({ id: modelList.id, result: { data: [] } });
}

function firstMockArg(mock: unknown, label: string): unknown {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.at(0);
  if (!call) {
    throw new Error(`Expected ${label} first call`);
  }
  return call[0];
}

function bridgeStartOptionsCall() {
  return firstMockArg(mocks.bridgeCodexAppServerStartOptions, "bridge start options") as {
    agentDir?: string;
    agentId?: string;
    authProfileId?: string;
    authProfileStore?: unknown;
    preparedAuth?:
      | { kind: "api-key"; apiKey: string }
      | { kind: "profile"; profileId: string; snapshot?: unknown };
    config?: unknown;
    startOptions: { command?: string; commandSource?: string };
  };
}

function applyAuthProfileCall() {
  return firstMockArg(mocks.applyCodexAppServerAuthProfile, "apply auth profile") as {
    agentDir?: string;
    authProfileId?: string;
    authProfileStore?: unknown;
    preparedAuth?:
      | { kind: "api-key"; apiKey: string }
      | { kind: "profile"; snapshot: { loginParams: unknown } };
    config?: unknown;
  };
}

function resolveAuthProfileCall() {
  return firstMockArg(mocks.resolveCodexAppServerAuthProfileIdForAgent, "resolve auth profile") as {
    agentDir?: string;
    authProfileId?: string;
    authProfileStore?: unknown;
    config?: unknown;
  };
}

function managedStartOptionsCall() {
  return firstMockArg(mocks.resolveManagedCodexAppServerStartOptions, "managed start options") as {
    command?: string;
    commandSource?: string;
    managedCommandOrder?: string;
  };
}

function clientStartCall(startSpy: unknown) {
  return firstMockArg(startSpy, "CodexAppServerClient.start") as {
    command?: string;
    commandSource?: string;
  };
}

function deferNextAuthProfileApplication(): () => void {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  mocks.applyCodexAppServerAuthProfile.mockReturnValueOnce(gate);
  return release;
}

function configureManagedDesktopFallback(): CodexAppServerStartOptions {
  mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
    ...startOptions,
    command: "/Applications/Codex.app/Contents/Resources/codex",
    commandSource: "resolved-managed",
    managedFallbackCommandPaths: ["/cache/openclaw/codex"],
  }));
  return {
    transport: "stdio",
    homeScope: "user",
    command: "codex",
    commandSource: "managed",
    args: ["app-server", "--listen", "stdio://"],
    headers: {},
  };
}

describe("shared Codex app-server client", () => {
  beforeAll(async () => {
    ({ listCodexAppServerModels } = await import("./models.js"));
    ({
      clearSharedCodexAppServerClient,
      clearSharedCodexAppServerClientAndWait,
      clearSharedCodexAppServerClientIfCurrent,
      clearSharedCodexAppServerClientIfCurrentAndUnclaimed,
      clearSharedCodexAppServerClientIfCurrentAndWait,
      createIsolatedCodexAppServerClient,
      getLeasedSharedCodexAppServerClient,
      isCodexAppServerStartSelectionChangedError,
      retainSharedCodexAppServerClientIfCurrent,
      retainSharedCodexAppServerClientByInstanceId,
      releaseLeasedSharedCodexAppServerClient,
      releaseCodexAppServerClientLease,
      resolveCodexNativeConfigFenceKey,
      resolveCodexAppServerSpawnIdentity,
      retireSharedCodexAppServerClientIfCurrent,
      retireSharedCodexAppServerClientsBeforeDesktopGeneration,
      waitForCodexAppServerClientDesktopGenerationDrain,
      resetSharedCodexAppServerClientForTests,
      withLeasedCodexAppServerClientStartSelectionRetry,
    } = await import("./shared-client.js"));
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
    mocks.bridgeCodexAppServerStartOptions.mockClear();
    mocks.reconcileCodexComputerUseStartArtifacts.mockClear();
    mocks.applyCodexAppServerAuthProfile.mockClear();
    mocks.applyCodexAppServerAuthProfile.mockResolvedValue(undefined);
    mocks.resolveCodexAppServerAuthProfileIdForAgent.mockClear();
    mocks.resolveCodexAppServerAuthProfileIdForAgent.mockImplementation(
      (params?: { authProfileId?: string }) => params?.authProfileId,
    );
    mocks.resolveCodexAppServerAuthProfileStore.mockClear();
    mocks.resolveCodexAppServerAuthProfileStore.mockImplementation(
      (params?: { authProfileStore?: unknown }) => params?.authProfileStore,
    );
    mocks.resolveCodexAppServerPreparedAuthProfileSnapshot.mockReset();
    mocks.resolveCodexAppServerPreparedAuthProfileSnapshot.mockResolvedValue({
      loginParams: {
        type: "chatgptAuthTokens",
        accessToken: "prepared-token",
        chatgptAccountId: "prepared-account",
        chatgptPlanType: null,
      },
      secretFreeCacheKey: "prepared-account:token:sha256:prepared",
    });
    mocks.refreshCodexAppServerAuthTokens.mockClear();
    mocks.resolveCodexAppServerFallbackApiKeyCacheKey.mockClear();
    mocks.resolveCodexAppServerFallbackApiKeyCacheKey.mockReturnValue(undefined);
    mocks.resolveCodexAppServerPreparedApiKeyCacheKey.mockClear();
    mocks.resolveManagedCodexAppServerStartOptions.mockClear();
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(
      async (startOptions) => startOptions,
    );
    mocks.desktopGeneration = undefined;
    mocks.desktopGenerationCurrent = true;
    mocks.waitForCodexDesktopGeneration.mockReset();
    mocks.waitForCodexDesktopGeneration.mockImplementation(async () => mocks.desktopGeneration);
    mocks.resolveManagedCodexNativeCommand.mockClear();
    mocks.resolveManagedCodexNativeCommand.mockImplementation(
      (command: string) => `${command}.native`,
    );
    mocks.embeddedAgentLog.debug.mockClear();
    mocks.embeddedAgentLog.warn.mockClear();
    mocks.resolveDefaultAgentDir.mockClear();
  });

  it("closes the shared app-server when the version gate fails", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);

    // Model discovery uses the shared-client path, which owns child teardown
    // when initialize discovers an unsupported app-server.
    const listPromise = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.117.9 (macOS; test)");

    await expect(listPromise).rejects.toThrow(
      `Codex app-server ${MIN_SUPPORTED_CODEX_APP_SERVER_VERSION} or newer is required`,
    );
    expect(harness.process.stdin.destroyed).toBe(true);
    startSpy.mockRestore();
  });

  it("recognizes selection changes thrown by another bundle copy", () => {
    const error = Object.assign(new Error("selection changed"), {
      code: "CODEX_APP_SERVER_START_SELECTION_CHANGED",
    });

    expect(isCodexAppServerStartSelectionChangedError(error)).toBe(true);
  });

  it("fingerprints argv without exposing secret-shaped config overrides", () => {
    const identity = resolveCodexAppServerSpawnIdentity({
      transport: "stdio",
      homeScope: "agent",
      command: "/usr/local/bin/codex",
      commandSource: "config",
      args: ["-c", "provider.api_key=super-secret-value", "app-server"],
      headers: {},
    });

    expect(identity.argsFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(identity)).not.toContain("super-secret-value");
  });

  it("does not resolve startup context for a pre-aborted acquire", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const startSpy = vi.spyOn(CodexAppServerClient, "start");

    await expect(
      getLeasedSharedCodexAppServerClient({
        abandonSignal: abortController.signal,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("codex app-server initialize aborted");

    expect(mocks.resolveManagedCodexAppServerStartOptions).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("bounds isolated transport startup and closes a client returned after its deadline", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    let finishStart!: (client: CodexAppServerClient) => void;
    const starting = new Promise<CodexAppServerClient>((resolve) => {
      finishStart = resolve;
    });
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(starting);
    const acquire = createIsolatedCodexAppServerClient({ timeoutMs: 50 });
    const rejected = expect(acquire).rejects.toThrow("codex app-server initialize timed out");
    await vi.advanceTimersByTimeAsync(0);
    expect(startSpy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    finishStart(harness.client);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.stdinDestroyed).toBe(true);
  });

  it.each(["implicit", "explicit"] as const)(
    "revalidates %s auth before reusing a warm client after account replacement",
    async (selector) => {
      const first = createClientHarness();
      const replacement = createClientHarness();
      const startSpy = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(first.client)
        .mockResolvedValueOnce(replacement.client);
      mocks.resolveCodexAppServerAuthProfileIdForAgent.mockReturnValue("openai:work");
      mocks.resolveCodexAppServerAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
      const options = {
        config: { auth: { order: { openai: ["openai:work"] } } },
        startOptions: {
          transport: "stdio",
          homeScope: "agent",
          command: "codex",
          args: ["app-server"],
          headers: {},
        } satisfies CodexAppServerStartOptions,
        authProfileId: selector === "explicit" ? "openai:work" : undefined,
        timeoutMs: 1_000,
      };
      const firstAcquire = getLeasedSharedCodexAppServerClient(options);
      await sendInitializeResult(first, "openclaw/0.149.0 (Linux; test)");
      await expect(firstAcquire).resolves.toBe(first.client);
      releaseLeasedSharedCodexAppServerClient(first.client);
      await expect(getLeasedSharedCodexAppServerClient(options)).resolves.toBe(first.client);
      releaseLeasedSharedCodexAppServerClient(first.client);

      mocks.resolveCodexAppServerPreparedAuthProfileSnapshot.mockResolvedValue({
        loginParams: {
          type: "chatgptAuthTokens",
          accessToken: "replacement-token",
          chatgptAccountId: "replacement-account",
          chatgptPlanType: null,
        },
        secretFreeCacheKey: "replacement-account",
      });
      const nextAcquire = getLeasedSharedCodexAppServerClient(options);
      await sendInitializeResult(replacement, "openclaw/0.149.0 (Linux; test)");
      expect(startSpy).toHaveBeenCalledTimes(2);
      await expect(nextAcquire).resolves.toBe(replacement.client);
      releaseLeasedSharedCodexAppServerClient(replacement.client);
      expect(mocks.applyCodexAppServerAuthProfile).toHaveBeenLastCalledWith(
        expect.objectContaining({
          preparedAuth: expect.objectContaining({
            snapshot: expect.objectContaining({
              loginParams: expect.objectContaining({
                accessToken: "replacement-token",
                chatgptAccountId: "replacement-account",
              }),
            }),
          }),
        }),
      );
    },
  );

  it("does not spawn after startup context exceeds its total deadline", async () => {
    vi.useFakeTimers();
    let resolveManaged: ((value: CodexAppServerStartOptions) => void) | undefined;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveManaged = resolve;
        }),
    );
    const startSpy = vi.spyOn(CodexAppServerClient, "start");
    const acquire = getLeasedSharedCodexAppServerClient({ timeoutMs: 50 });
    const rejection = expect(acquire).rejects.toThrow("codex app-server initialize timed out");

    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(startSpy).not.toHaveBeenCalled();

    resolveManaged?.({
      transport: "stdio",
      homeScope: "agent",
      command: "codex",
      commandSource: "managed",
      args: ["app-server"],
      headers: {},
    });
    await Promise.resolve();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("rejects an aborted startup acquire while another caller keeps initialization alive", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const abortController = new AbortController();
    const first = getLeasedSharedCodexAppServerClient({
      abandonSignal: abortController.signal,
      timeoutMs: 1_000,
    });
    const second = getLeasedSharedCodexAppServerClient({ timeoutMs: 1_000 });
    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));

    abortController.abort();
    await expect(first).rejects.toThrow("codex app-server initialize aborted");
    expect(harness.stdinDestroyed).toBe(false);

    await sendInitializeResult(harness, "openclaw/0.149.0 (Linux; test)");
    await expect(second).resolves.toBe(harness.client);
    expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);
  });

  it("retains an initialized shared client by its persisted instance id", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const acquire = getLeasedSharedCodexAppServerClient({ timeoutMs: 1_000 });
    await sendInitializeResult(harness, "openclaw/0.149.0 (Linux; test)");
    const client = await acquire;

    const retained = retainSharedCodexAppServerClientByInstanceId(client.getInstanceId());
    expect(retained?.client).toBe(client);
    retained?.release();
    expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
  });

  it.each([
    { name: "isolated stdio", transport: "stdio", allowed: true },
    { name: "isolated websocket", transport: "websocket", allowed: false },
    { name: "isolated unix", transport: "unix", allowed: false },
    { name: "shared websocket", transport: "websocket", allowed: false, shared: true },
    { name: "shared unix", transport: "unix", allowed: false, shared: true },
    { name: "redirected stdio", transport: "stdio", allowed: false, redirect: true },
    { name: "stdio proxy", transport: "stdio", allowed: false, args: ["app-server", "proxy"] },
    {
      name: "stdio option value",
      transport: "stdio",
      allowed: true,
      args: ["app-server", "--cd", "proxy"],
    },
  ] as const)(
    "captures configuration ownership only for a caller-spawned runtime: $name",
    async (scenario) => {
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      if ("redirect" in scenario) {
        mocks.bridgeCodexAppServerStartOptions.mockImplementationOnce(async ({ startOptions }) => ({
          ...startOptions,
          transport: "websocket",
          url: "ws://127.0.0.1:8123",
        }));
      }
      const acquire = (
        "shared" in scenario
          ? getLeasedSharedCodexAppServerClient
          : createIsolatedCodexAppServerClient
      )({
        timeoutMs: 1_000,
        startOptions: {
          transport: scenario.transport,
          command: "codex",
          args: scenario.args ? [...scenario.args] : ["app-server"],
          headers: {},
          ...(scenario.transport === "websocket" ? { url: "ws://127.0.0.1:8123" } : {}),
          ...(scenario.transport === "unix" ? { url: "unix:///tmp/synthetic-codex.sock" } : {}),
        },
      });
      await sendInitializeResult(harness, "openclaw/0.151.0 (Linux; test)");
      const client = await acquire;
      if (!scenario.allowed) {
        const writes = harness.writes.length;
        expect(() => captureCodexAppServerClientLifetime(client, "native-process")).toThrow(
          "reconnect through managed local stdio",
        );
        expect(harness.writes).toHaveLength(writes);
        expect(client.getCloseError()).toBeUndefined();
      } else {
        const assertCurrent = captureCodexAppServerClientLifetime(client, "native-process");
        expect(assertCurrent).not.toThrow();
        client.close();
        expect(assertCurrent).toThrow(CodexAdoptedThreadActiveError);
      }
      if ("shared" in scenario) {
        releaseLeasedSharedCodexAppServerClient(client);
      }
      client.close();
    },
  );

  it("captures registered client lifetime independently of lease counts", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    expect(() => captureCodexAppServerClientLifetime(harness.client, "connection")).toThrow(
      CodexAdoptedThreadActiveError,
    );
    const acquire = getLeasedSharedCodexAppServerClient({ timeoutMs: 1_000 });
    await sendInitializeResult(harness, "openclaw/0.151.0 (Linux; test)");
    const client = await acquire;
    const assertCurrent = captureCodexAppServerClientLifetime(client, "native-process");
    const retained = retainSharedCodexAppServerClientByInstanceId(client.getInstanceId());
    expect(assertCurrent).not.toThrow();
    retained?.release();
    expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
    expect(assertCurrent).not.toThrow();
    const catalogCurrent = captureSharedCodexAppServerCatalogLifetime(client);
    const configWrite = client.request("config/batchWrite", { edits: [], reloadUserConfig: false });
    const written = JSON.parse(harness.writes.at(-1)!);
    harness.send({ id: written.id, result: {} });
    await configWrite;
    expect(catalogCurrent()).toBe(false);
    expect(assertCurrent).not.toThrow();
    client.close();
    expect(assertCurrent).toThrow(CodexAdoptedThreadActiveError);
  });

  it.each(["websocket", "unix", "proxy"] as const)(
    "preserves supervised connection lifetime over %s without claiming its native process",
    async (transport) => {
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const acquire = getLeasedSharedCodexAppServerClient({
        timeoutMs: 1_000,
        startOptions: {
          transport: transport === "proxy" ? "stdio" : transport,
          command: "codex",
          args: transport === "proxy" ? ["app-server", "proxy"] : ["app-server"],
          headers: {},
          ...(transport === "websocket" ? { url: "ws://127.0.0.1:8123" } : {}),
          ...(transport === "unix" ? { url: "unix:///tmp/synthetic-codex.sock" } : {}),
        },
      });
      await sendInitializeResult(harness, "openclaw/0.151.0 (Linux; test)");
      const client = await acquire;
      try {
        const assertCurrent = captureCodexAppServerClientLifetime(client, "connection");
        expect(assertCurrent).not.toThrow();
        const release = retainSharedCodexAppServerClientIfCurrent(client);
        expect(assertCurrent).not.toThrow();
        release?.();
        expect(assertCurrent).not.toThrow();
        expect(captureCodexAppServerClientLifetime(client, "connection")).not.toThrow();
      } finally {
        releaseLeasedSharedCodexAppServerClient(client);
        client.close();
      }
    },
  );

  it.each(["acquire", "retain"] as const)(
    "preserves captured client lifetime after a completed sibling %s",
    async (operation) => {
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const options = {
        timeoutMs: 1_000,
        config: {},
        startOptions: {
          transport: "stdio",
          homeScope: "agent",
          command: "codex",
          args: ["app-server"],
          headers: {},
        } satisfies CodexAppServerStartOptions,
      };
      const acquire = getLeasedSharedCodexAppServerClient(options);
      await sendInitializeResult(harness, "openclaw/0.149.0 (Linux; test)");
      const client = await acquire;
      const assertCurrent = captureCodexAppServerClientLifetime(client, "native-process");
      if (operation === "acquire") {
        expect(await getLeasedSharedCodexAppServerClient(options)).toBe(client);
        expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
      } else {
        retainSharedCodexAppServerClientIfCurrent(client)?.();
      }

      expect(assertCurrent).not.toThrow();
      expect(captureCodexAppServerClientLifetime(client, "native-process")).not.toThrow();
      expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
    },
  );

  it("preserves client lifetime while an unleased acquire is pending", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const acquire = getLeasedSharedCodexAppServerClient({ timeoutMs: 1_000 });
    await sendInitializeResult(harness, "openclaw/0.149.0 (Linux; test)");
    const client = await acquire;
    const assertCurrent = captureCodexAppServerClientLifetime(client, "native-process");
    let observedPendingAcquire = false;
    await getSharedCodexAppServerClient({
      timeoutMs: 1_000,
      onStartedClient: () => {
        observedPendingAcquire = true;
        expect(captureCodexAppServerClientLifetime(client, "native-process")).not.toThrow();
        expect(assertCurrent).not.toThrow();
      },
    });

    expect(observedPendingAcquire).toBe(true);
    expect(assertCurrent).not.toThrow();
    expect(captureCodexAppServerClientLifetime(client, "native-process")).not.toThrow();
    expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
  });

  it("revokes configuration ownership when its physical client is retired", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const acquire = getLeasedSharedCodexAppServerClient({ timeoutMs: 1_000 });
    await sendInitializeResult(harness, "openclaw/0.149.0 (Linux; test)");
    const client = await acquire;
    const assertExclusive = captureCodexAppServerClientLifetime(client, "native-process");
    retireSharedCodexAppServerClientIfCurrent(client);

    expect(assertExclusive).toThrow(CodexAdoptedThreadActiveError);
    expect(() => captureCodexAppServerClientLifetime(client, "native-process")).toThrow(
      CodexAdoptedThreadActiveError,
    );
    expect(harness.stdinDestroyed).toBe(false);
    expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
    expect(harness.stdinDestroyed).toBe(true);
  });

  it.each(["fails", "succeeds"])(
    "preserves a co-lease when selection replacement acquisition %s",
    async (replacementOutcome) => {
      const harness = createClientHarness();
      const replacement = createClientHarness();
      const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const options = { timeoutMs: 1_000 };
      const firstLease = getLeasedSharedCodexAppServerClient(options);
      await sendInitializeResult(harness, "openclaw/0.149.0 (Linux; test)");
      const client = await firstLease;
      await expect(getLeasedSharedCodexAppServerClient(options)).resolves.toBe(client);
      const ownedLease = { client };
      if (replacementOutcome === "fails") {
        mocks.resolveManagedCodexAppServerStartOptions.mockRejectedValueOnce(
          new Error("replacement acquisition failed"),
        );
      } else {
        start.mockResolvedValue(replacement.client);
      }

      const retry = withLeasedCodexAppServerClientStartSelectionRetry({
        lease: ownedLease,
        options,
        run: async (attemptClient) => {
          if (attemptClient !== client) {
            return attemptClient;
          }
          throw Object.assign(new Error("selection changed"), {
            code: "CODEX_APP_SERVER_START_SELECTION_CHANGED",
          });
        },
      });
      if (replacementOutcome === "fails") {
        await expect(retry).rejects.toThrow("replacement acquisition failed");
        expect(ownedLease.client).toBeUndefined();
      } else {
        await sendInitializeResult(replacement, "openclaw/0.149.0 (Linux; test)");
        await expect(retry).resolves.toBe(replacement.client);
        expect(ownedLease.client).toBe(replacement.client);
      }
      expect(releaseCodexAppServerClientLease(ownedLease)).toBe(replacementOutcome === "succeeds");
      expect(harness.stdinDestroyed).toBe(false);
      expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
      await vi.waitFor(() => expect(harness.stdinDestroyed).toBe(true));
    },
  );

  it("falls back before starting a desktop candidate with incomplete Computer Use artifacts", async () => {
    const pluginLocal = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(pluginLocal.client);
    mocks.reconcileCodexComputerUseStartArtifacts
      .mockRejectedValueOnce(
        new mocks.CodexComputerUseCandidateArtifactsUnavailableError(
          "desktop artifacts unavailable",
        ),
      )
      .mockResolvedValueOnce(undefined);
    const startOptions = configureManagedDesktopFallback();

    const acquire = getSharedCodexAppServerClient({ startOptions, timeoutMs: 1_000 });
    await sendInitializeResult(pluginLocal, "openclaw/0.149.0 (macOS; test)");
    const client = await acquire;

    expect(client).toBe(pluginLocal.client);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ command: "/cache/openclaw/codex" }),
      expect.any(Function),
    );
    expect(mocks.reconcileCodexComputerUseStartArtifacts).toHaveBeenCalledTimes(2);
    expect(mocks.reconcileCodexComputerUseStartArtifacts.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        startOptions: expect.objectContaining({
          command: "/Applications/Codex.app/Contents/Resources/codex",
        }),
      }),
    );
    expect(mocks.reconcileCodexComputerUseStartArtifacts.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        startOptions: expect.objectContaining({ command: "/cache/openclaw/codex" }),
      }),
    );
  });

  it("classifies terminal incomplete Computer Use artifacts as harness preflight", async () => {
    mocks.reconcileCodexComputerUseStartArtifacts.mockRejectedValueOnce(
      new mocks.CodexComputerUseCandidateArtifactsUnavailableError("desktop artifacts unavailable"),
    );

    await expect(
      getSharedCodexAppServerClient({
        startOptions: {
          transport: "stdio",
          command: "/Applications/Codex.app/Contents/Resources/codex",
          commandSource: "config",
          args: ["app-server"],
          headers: {},
        },
      }),
    ).rejects.toMatchObject({ name: "AgentHarnessPreflightError", scope: "harness" });
  });

  it("reuses the successful managed fallback after desktop initialize is unsupported", async () => {
    const desktop = createClientHarness();
    const pluginLocal = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(desktop.client)
      .mockResolvedValueOnce(pluginLocal.client)
      .mockImplementation(async () => {
        throw new Error("unexpected duplicate start");
      });
    const startOptions = configureManagedDesktopFallback();

    const firstAcquire = getSharedCodexAppServerClient({ startOptions, timeoutMs: 1_000 });
    await sendInitializeResult(desktop, "openclaw/0.148.0 (macOS; test)");
    await sendInitializeResult(pluginLocal, "openclaw/0.149.0 (macOS; test)");
    const firstClient = await firstAcquire;

    const secondClient = await getSharedCodexAppServerClient({ startOptions, timeoutMs: 1_000 });

    expect(secondClient).toBe(firstClient);
    expect(desktop.process.stdin.destroyed).toBe(true);
    expect(pluginLocal.process.stdin.destroyed).toBe(false);
    expect(startSpy).toHaveBeenCalledTimes(2);
    const retained = retainSharedCodexAppServerClientByInstanceId(firstClient.getInstanceId());
    expect(retained?.client).toBe(firstClient);
    retained?.release();
    expect(startSpy.mock.calls[0]?.[0]).toMatchObject({
      command: "/Applications/Codex.app/Contents/Resources/codex",
      commandSource: "resolved-managed",
      managedFallbackCommandPaths: ["/cache/openclaw/codex"],
    });
    expect(startSpy.mock.calls[1]?.[0]).toMatchObject({
      command: "/cache/openclaw/codex",
      commandSource: "resolved-managed",
    });
    expect(startSpy.mock.calls[1]?.[0]).not.toHaveProperty("managedFallbackCommandPaths");

    await clearSharedCodexAppServerClientAndWait({ exitTimeoutMs: 25, forceKillDelayMs: 5 });
    expect(pluginLocal.process.stdin.destroyed).toBe(true);
  });

  it("keeps a supported desktop prerelease instead of falling back by version", async () => {
    const desktop = createClientHarness();
    const desktopVersion = `${new SemVer(CODEX_APP_SERVER_VERSION).inc("minor").version}-alpha.4`;
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(desktop.client);
    const startOptions = configureManagedDesktopFallback();

    const acquire = getSharedCodexAppServerClient({ startOptions, timeoutMs: 1_000 });
    await sendInitializeResult(desktop, `openclaw/${desktopVersion} (macOS; test)`);
    const client = await acquire;

    expect(client).toBe(desktop.client);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0]?.[0]).toMatchObject({
      command: "/Applications/Codex.app/Contents/Resources/codex",
      commandSource: "resolved-managed",
      managedFallbackCommandPaths: ["/cache/openclaw/codex"],
    });
    expect(desktop.process.stdin.destroyed).toBe(false);
    expect(mocks.embeddedAgentLog.warn).toHaveBeenCalledExactlyOnceWith(
      "codex app-server is newer than OpenClaw's managed runtime; continuing with normal startup validation",
      {
        detectedVersion: desktopVersion,
        validatedVersion: CODEX_APP_SERVER_VERSION,
      },
    );

    await clearSharedCodexAppServerClientAndWait({ exitTimeoutMs: 25, forceKillDelayMs: 5 });
    expect(desktop.process.stdin.destroyed).toBe(true);
  });

  it("shares a managed fallback with a waiter that arrives during fallback initialize", async () => {
    const desktop = createClientHarness();
    const fallback = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(desktop.client)
      .mockResolvedValueOnce(fallback.client)
      .mockImplementation(async () => {
        throw new Error("unexpected duplicate start");
      });
    const options = {
      timeoutMs: 1_000,
      startOptions: configureManagedDesktopFallback(),
    };

    const firstAcquire = getSharedCodexAppServerClient(options);
    await sendInitializeResult(desktop, "openclaw/0.148.0 (macOS; test)");
    await vi.waitFor(() => expect(fallback.writes.length).toBeGreaterThanOrEqual(1));
    const secondAcquire = getSharedCodexAppServerClient(options);
    await sendInitializeResult(fallback, "openclaw/0.149.0 (macOS; test)");

    const [firstClient, secondClient] = await Promise.all([firstAcquire, secondAcquire]);
    expect(secondClient).toBe(firstClient);
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(desktop.process.stdin.destroyed).toBe(true);
    expect(fallback.process.stdin.destroyed).toBe(false);
  });

  it("keeps capture clients separate from ordinary shared clients", async () => {
    await withTempDir("openclaw-codex-capture-client-", async (root) => {
      const command = path.join(root, "codex");
      await fs.writeFile(command, "native-v1");
      const normal = createClientHarness();
      const captured = createClientHarness();
      const startSpy = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(normal.client)
        .mockResolvedValueOnce(captured.client);
      const startOptions: CodexAppServerStartOptions = {
        transport: "stdio",
        command,
        commandSource: "config",
        args: ["app-server"],
        headers: {},
      };

      const normalPromise = getLeasedSharedCodexAppServerClient({ startOptions });
      await sendInitializeResult(normal, "openclaw/0.149.0 (Linux; test)");
      const normalClient = await normalPromise;
      const capturedPromise = getLeasedSharedCodexAppServerClient({
        startOptions,
        runtimeArtifactMode: "capture",
      });
      await sendInitializeResult(captured, "openclaw/0.149.0 (Linux; test)");
      const capturedClient = await capturedPromise;

      expect(capturedClient).not.toBe(normalClient);
      expect(startSpy).toHaveBeenCalledTimes(2);
      const { readCodexAppServerClientRuntimeArtifact } = await import("./runtime-artifact.js");
      expect(readCodexAppServerClientRuntimeArtifact(normalClient)).toBeUndefined();
      expect(readCodexAppServerClientRuntimeArtifact(capturedClient)).toEqual({
        id: expect.stringMatching(/^codex-app-server:v1:/u),
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(releaseLeasedSharedCodexAppServerClient(normalClient)).toBe(true);
      expect(releaseLeasedSharedCodexAppServerClient(capturedClient)).toBe(true);
    });
  });

  it("binds the managed fallback candidate that actually initialized", async () => {
    await withTempDir("openclaw-codex-capture-fallback-", async (root) => {
      const desktopCommand = path.join(root, "desktop-codex");
      const fallbackCommand = path.join(root, "package-codex");
      await Promise.all([
        fs.writeFile(desktopCommand, "desktop-launcher"),
        fs.writeFile(`${desktopCommand}.native`, "desktop-native"),
        fs.writeFile(fallbackCommand, "package-launcher"),
        fs.writeFile(`${fallbackCommand}.native`, "package-native"),
      ]);
      const desktop = createClientHarness();
      const fallback = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(desktop.client)
        .mockResolvedValueOnce(fallback.client);
      mocks.resolveManagedCodexAppServerStartOptions.mockImplementationOnce(
        async (startOptions) => ({
          ...startOptions,
          command: desktopCommand,
          commandSource: "resolved-managed" as const,
          managedFallbackCommandPaths: [fallbackCommand],
        }),
      );
      const requested: CodexAppServerStartOptions = {
        transport: "stdio",
        command: "codex",
        commandSource: "managed",
        args: ["app-server"],
        headers: {},
      };

      const acquire = getLeasedSharedCodexAppServerClient({
        startOptions: requested,
        runtimeArtifactMode: "capture",
      });
      await sendInitializeResult(desktop, "openclaw/0.124.9 (macOS; test)");
      await sendInitializeResult(fallback, "openclaw/0.149.0 (macOS; test)");
      const client = await acquire;
      const { readCodexAppServerClientRuntimeArtifact, validateCodexAppServerRuntimeArtifact } =
        await import("./runtime-artifact.js");
      const binding = readCodexAppServerClientRuntimeArtifact(client);
      if (!binding) {
        throw new Error("expected captured Codex runtime artifact");
      }

      await fs.writeFile(`${desktopCommand}.native`, "desktop-native-updated");
      await expect(validateCodexAppServerRuntimeArtifact(binding)).resolves.toBe(true);
      await fs.writeFile(`${fallbackCommand}.native`, "package-native-updated");
      await expect(validateCodexAppServerRuntimeArtifact(binding)).resolves.toBe(false);
      expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
    });
  });

  it("fails capture-mode WebSocket startup before opening a client", async () => {
    const startSpy = vi.spyOn(CodexAppServerClient, "start");
    const startOptions: CodexAppServerStartOptions = {
      transport: "websocket",
      command: "codex",
      commandSource: "config",
      args: ["app-server"],
      url: "ws://127.0.0.1:1234",
      headers: {},
    };

    await expect(
      getLeasedSharedCodexAppServerClient({
        startOptions,
        runtimeArtifactMode: "capture",
      }),
    ).rejects.toThrow("WebSocket attestation is unsupported");
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("detects persisted Computer Use enabled after managed client startup", async () => {
    await withTempDir("openclaw-codex-managed-selection-", async (root) => {
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      mocks.resolveManagedCodexAppServerStartOptions.mockImplementationOnce(
        async (startOptions) => ({
          ...startOptions,
          command: "/cache/openclaw/codex",
          commandSource: "resolved-managed",
        }),
      );
      const agentDir = path.join(root, "agent");
      const startOptions = {
        transport: "stdio" as const,
        homeScope: "agent" as const,
        command: "codex",
        commandSource: "managed" as const,
        managedComputerUsePluginNames: ["computer-use"],
        args: ["app-server"],
        headers: {},
      };

      const clientPromise = createIsolatedCodexAppServerClient({
        startOptions,
        agentDir,
      });
      await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
      const client = await clientPromise;

      expect(readCodexAppServerClientProcessIdentity(client)).toEqual({
        clientId: expect.any(String),
        command: "/cache/openclaw/codex",
        argsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        commandSource: "resolved-managed",
        nativeCommand: "/cache/openclaw/codex.native",
        serverVersion: "0.149.0",
        userAgent: "openclaw/0.149.0 (macOS; test)",
      });

      expect(() =>
        assertCodexAppServerClientStartSelectionCurrent({ client, startOptions, agentDir }),
      ).not.toThrow();
      const fenceKey = resolveCodexNativeConfigFenceKey({ client });
      expect(fenceKey).toBeTypeOf("string");
      const writeCountBeforeThreadRequests = harness.writes.length;
      const releaseTimeoutFence = await acquireCodexNativeConfigFence(fenceKey as string);
      await expect(client.request("thread/start", {}, { timeoutMs: 5 })).rejects.toThrow(
        "thread/start timed out",
      );
      releaseTimeoutFence();
      await Promise.resolve();
      expect(harness.writes).toHaveLength(writeCountBeforeThreadRequests);

      const releaseAbortFence = await acquireCodexNativeConfigFence(fenceKey as string);
      const abortController = new AbortController();
      const abortedRequest = client.request(
        "thread/resume",
        { threadId: "thread-1" },
        {
          signal: abortController.signal,
        },
      );
      abortController.abort();
      await expect(abortedRequest).rejects.toThrow("thread/resume aborted");
      releaseAbortFence();
      await Promise.resolve();
      expect(harness.writes).toHaveLength(writeCountBeforeThreadRequests);

      const releaseFence = await acquireCodexNativeConfigFence(fenceKey as string);
      const guardedRequestOptions = { timeoutMs: 5_000 };
      const guardedRequests = [
        client.request("thread/start", {}, guardedRequestOptions),
        client.request("thread/resume", { threadId: "thread-1" }, guardedRequestOptions),
        client.request("thread/fork", { threadId: "thread-1" }, guardedRequestOptions),
      ];
      const guardedRequestAssertions = guardedRequests.map((request) =>
        expect(request).rejects.toThrow("managed executable selection changed during startup"),
      );
      await Promise.resolve();
      expect(harness.writes).toHaveLength(writeCountBeforeThreadRequests);
      await fs.mkdir(path.join(agentDir, "codex-home"), { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "codex-home", "config.toml"),
        '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
      );
      releaseFence();
      await Promise.all(guardedRequestAssertions);
      expect(harness.writes).toHaveLength(writeCountBeforeThreadRequests);
      expect(() =>
        assertCodexAppServerClientStartSelectionCurrent({ client, startOptions, agentDir }),
      ).toThrow("managed executable selection changed during startup");
      client.close();
    });
  });

  it.each(["config", "env"] as const)(
    "rejects a stale %s-selected standard desktop client",
    async (commandSource) => {
      const generationX = { epoch: 1, fingerprint: "desktop-x" };
      mocks.desktopGeneration = generationX;
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
      const startOptions: CodexAppServerStartOptions = {
        transport: "stdio",
        homeScope: "agent",
        command: "/Applications/ChatGPT.app/Contents/Resources/codex",
        commandSource,
        args: ["app-server"],
        headers: {},
      };

      const clientPromise = createIsolatedCodexAppServerClient({ startOptions });
      await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
      const client = await clientPromise;

      mocks.desktopGeneration = { epoch: 2, fingerprint: "desktop-y" };
      expect(() =>
        assertCodexAppServerClientStartSelectionCurrent({ client, startOptions }),
      ).toThrow("managed executable selection changed during startup");
      client.close();
    },
  );

  it.each(["abort", "timeout"] as const)(
    "holds the native config fence through process exit after a post-write %s",
    async (mode) => {
      await withTempDir("openclaw-codex-guarded-request-cancel-", async (root) => {
        const harness = createClientHarness();
        vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
        mocks.resolveManagedCodexAppServerStartOptions.mockImplementationOnce(
          async (startOptions) => ({
            ...startOptions,
            command: "/cache/openclaw/codex",
            commandSource: "resolved-managed",
          }),
        );
        const agentDir = path.join(root, "agent");
        const startOptions = {
          transport: "stdio" as const,
          homeScope: "agent" as const,
          command: "codex",
          commandSource: "managed" as const,
          managedComputerUsePluginNames: ["computer-use"],
          args: ["app-server"],
          headers: {},
        };

        const clientPromise = createIsolatedCodexAppServerClient({ startOptions, agentDir });
        await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
        const client = await clientPromise;
        const fenceKey = resolveCodexNativeConfigFenceKey({ client });
        expect(fenceKey).toBeTypeOf("string");

        const abortController = new AbortController();
        const requestOptions =
          mode === "abort" ? { signal: abortController.signal } : { timeoutMs: 250 };
        const request = client.request("thread/start", {}, requestOptions);
        await vi.waitFor(() => {
          const messages = harness.writes.map((line) => JSON.parse(line) as { method?: string });
          expect(messages.some((message) => message.method === "thread/start")).toBe(true);
        });

        const events: string[] = [];
        harness.process.once("exit", () => events.push("exit"));
        let contenderAcquired = false;
        const contender = acquireCodexNativeConfigFence(fenceKey as string).then((release) => {
          contenderAcquired = true;
          events.push("fence");
          return release;
        });
        await Promise.resolve();
        expect(contenderAcquired).toBe(false);

        if (mode === "abort") {
          abortController.abort();
        }
        await expect(request).rejects.toThrow(
          `thread/start ${mode === "abort" ? "aborted" : "timed out"}`,
        );
        const releaseContender = await contender;
        try {
          expect(harness.stdinDestroyed).toBe(true);
          expect(events).toEqual(["exit", "fence"]);
        } finally {
          releaseContender();
        }
      });
    },
  );

  it("closes and clears a shared app-server when initialize times out", async () => {
    vi.useFakeTimers();
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const firstAcquire = getSharedCodexAppServerClient({
      timeoutMs: 5,
      onStartedClient: markFirstStarted,
    });
    const firstRejection = expect(firstAcquire).rejects.toThrow(
      "codex app-server initialize timed out",
    );
    await firstStarted;
    await vi.advanceTimersByTimeAsync(5);
    await firstRejection;
    expect(first.process.stdin.destroyed).toBe(true);

    vi.useRealTimers();
    const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(second);

    await expect(secondList).resolves.toEqual({ models: [] });
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it("includes redacted app-server stderr when shared initialize times out", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);

    const models = listCodexAppServerModels({ timeoutMs: 100 });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));
    harness.process.stderr.write(
      'Error: failed to initialize sqlite state runtime token="secret-value"\n',
    );

    await expect(models).rejects.toThrow(
      'codex app-server initialize timed out; stderr="Error: failed to initialize sqlite state runtime token=\\"<redacted>\\""',
    );
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("keeps shared startup alive for a caller with a longer initialize timeout", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);

    const shortAcquire = getSharedCodexAppServerClient({ timeoutMs: 5 });
    const longAcquire = getSharedCodexAppServerClient({ timeoutMs: 1000 });

    await expect(shortAcquire).rejects.toThrow("codex app-server initialize timed out");
    expect(harness.process.stdin.destroyed).toBe(false);

    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");

    await expect(longAcquire).resolves.toBe(harness.client);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(harness.process.stdin.destroyed).toBe(false);
  });

  it("reports a stalled shared auth phase separately from initialize", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const releaseAuth = deferNextAuthProfileApplication();

    const acquire = getSharedCodexAppServerClient({ timeoutMs: 100 });
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");

    await expect(acquire).rejects.toThrow("codex app-server authentication timed out");
    expect(harness.process.stdin.destroyed).toBe(true);
    releaseAuth();
  });

  it("keeps shared auth alive for a caller with a longer timeout", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const releaseAuth = deferNextAuthProfileApplication();

    const shortAcquire = getSharedCodexAppServerClient({ timeoutMs: 100 });
    const longAcquire = getSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");

    await expect(shortAcquire).rejects.toThrow("codex app-server authentication timed out");
    expect(harness.process.stdin.destroyed).toBe(false);

    releaseAuth();
    await expect(longAcquire).resolves.toBe(harness.client);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(harness.process.stdin.destroyed).toBe(false);
  });

  it("keeps a pending shared app-server alive when another acquire still owns startup", async () => {
    const harness = createClientHarness();
    const abandonController = new AbortController();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);

    const abandonedAcquire = getSharedCodexAppServerClient({
      timeoutMs: 1000,
      abandonSignal: abandonController.signal,
    });
    const activeAcquire = getSharedCodexAppServerClient({ timeoutMs: 1000 });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));

    const abandonedRejection = expect(abandonedAcquire).rejects.toThrow(
      "codex app-server initialize aborted",
    );
    abandonController.abort();
    expect(harness.process.stdin.destroyed).toBe(false);

    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");

    await abandonedRejection;
    await expect(activeAcquire).resolves.toBe(harness.client);
    expect(harness.process.stdin.destroyed).toBe(false);
  });

  it("does not wait for isolated initialize after a timeout closes the client", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const client = createIsolatedCodexAppServerClient({
      timeoutMs: 5,
      onStartedClient: markStarted,
    });
    const rejection = expect(client).rejects.toThrow("codex app-server initialize timed out");
    await started;
    await vi.advanceTimersByTimeAsync(5);
    await rejection;
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("includes redacted app-server stderr when isolated initialize times out", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);

    const client = createIsolatedCodexAppServerClient({ timeoutMs: 100 });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));
    harness.process.stderr.write("state database is locked access_token=secret-value\n");

    await expect(client).rejects.toThrow(
      'codex app-server initialize timed out; stderr="state database is locked access_token=<redacted>"',
    );
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("includes isolated auth application in the total startup deadline", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    let finishAuth: () => void = () => undefined;
    mocks.applyCodexAppServerAuthProfile.mockImplementationOnce(
      async () =>
        await new Promise<undefined>((resolve) => {
          finishAuth = () => resolve(undefined);
        }),
    );

    const clientPromise = createIsolatedCodexAppServerClient({ timeoutMs: 100 });
    const rejection = expect(clientPromise).rejects.toThrow(
      "codex app-server initialize timed out",
    );
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");

    await rejection;
    expect(harness.process.stdin.destroyed).toBe(true);
    finishAuth();
  });

  it("does not start isolated auth after the total startup deadline elapsed", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const clientPromise = createIsolatedCodexAppServerClient({ timeoutMs: 100 });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));
    now = 101;
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");

    await expect(clientPromise).rejects.toThrow("codex app-server initialize timed out");
    expect(mocks.applyCodexAppServerAuthProfile).not.toHaveBeenCalled();
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("passes the selected auth profile through the bridge helper", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);

    const listPromise = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: "openai:work",
    });
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(harness);

    await expect(listPromise).resolves.toEqual({ models: [] });
    const bridgeCall = bridgeStartOptionsCall();
    expect(bridgeCall?.authProfileId).toBe("openai:work");
    const applyCall = applyAuthProfileCall();
    expect(applyCall?.authProfileId).toBe("openai:work");
  });

  it("carries a scoped auth store through isolated app-server startup", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const authProfileStore = { version: 1, profiles: {} };
    const preparedAuthProfileStore = {
      version: 1,
      profiles: {
        "openai:scoped": { type: "token", provider: "openai", token: "prepared-token" },
      },
    };
    mocks.resolveCodexAppServerAuthProfileIdForAgent.mockReturnValue("openai:scoped");
    mocks.resolveCodexAppServerAuthProfileStore.mockReturnValue(preparedAuthProfileStore);

    const clientPromise = createIsolatedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileStore,
    });
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");

    await expect(clientPromise).resolves.toBe(harness.client);
    expect(mocks.resolveCodexAppServerAuthProfileStore).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw-agent",
      authProfileId: undefined,
      authProfileStore,
      config: undefined,
    });
    expect(resolveAuthProfileCall().authProfileStore).toBe(preparedAuthProfileStore);
    expect(bridgeStartOptionsCall().authProfileStore).toBe(preparedAuthProfileStore);
    expect(applyAuthProfileCall().authProfileStore).toBe(preparedAuthProfileStore);
    mocks.refreshCodexAppServerAuthTokens.mockResolvedValueOnce({
      accessToken: "refreshed-access",
      chatgptAccountId: "scoped-account",
      chatgptPlanType: null,
    });

    const priorWriteCount = harness.writes.length;
    harness.send({
      id: "refresh-1",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "unauthorized", previousAccountId: "scoped-account" },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThan(priorWriteCount));

    expect(mocks.refreshCodexAppServerAuthTokens).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw-agent",
      authProfileId: "openai:scoped",
      authProfileStore: preparedAuthProfileStore,
      previousAccountId: "scoped-account",
      config: undefined,
    });
    expect(JSON.parse(harness.writes.at(-1) ?? "{}")).toEqual({
      id: "refresh-1",
      result: {
        accessToken: "refreshed-access",
        chatgptAccountId: "scoped-account",
        chatgptPlanType: null,
      },
    });
  });

  it.each(["failure", "workspace-change"] as const)(
    "retires a shared client after token refresh %s while existing leases drain",
    async (failure) => {
      const first = createClientHarness();
      const replacement = createClientHarness();
      const startSpy = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(first.client)
        .mockResolvedValueOnce(replacement.client);
      const options = { timeoutMs: 1_000, authProfileId: "openai:work" };
      const acquired = getLeasedSharedCodexAppServerClient(options);
      await sendInitializeResult(first, "openclaw/0.149.0 (Linux; test)");
      await acquired;
      if (failure === "failure") {
        mocks.refreshCodexAppServerAuthTokens.mockRejectedValueOnce(new Error("refresh failed"));
      } else {
        mocks.refreshCodexAppServerAuthTokens.mockResolvedValueOnce({
          accessToken: "other-token",
          chatgptAccountId: "other-account",
          chatgptPlanType: null,
        });
      }
      const responseIndex = first.writes.length;
      first.send({
        id: "failed-refresh",
        method: "account/chatgptAuthTokens/refresh",
        params: { reason: "unauthorized", previousAccountId: "original-account" },
      });
      expect(JSON.parse(await first.waitForWrite(responseIndex))).toEqual({
        id: "failed-refresh",
        error: {
          code: -32603,
          message:
            failure === "failure"
              ? "refresh failed"
              : "ChatGPT workspace changed during Codex token refresh. Retry to start a client for the selected workspace.",
        },
      });
      expect(first.stdinDestroyed).toBe(false);
      const nextAcquire = getLeasedSharedCodexAppServerClient(options);
      await sendInitializeResult(replacement, "openclaw/0.149.0 (Linux; test)");
      expect(startSpy).toHaveBeenCalledTimes(2);
      await expect(nextAcquire).resolves.toBe(replacement.client);
      expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
      expect(first.stdinDestroyed).toBe(true);
      expect(replacement.stdinDestroyed).toBe(false);
      expect(releaseLeasedSharedCodexAppServerClient(replacement.client)).toBe(true);
      expect(clearSharedCodexAppServerClientIfCurrent(replacement.client)).toBe(true);
      expect(replacement.stdinDestroyed).toBe(true);
    },
  );

  it("keeps a shared prepared auth store authoritative through startup and refresh", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const authProfileStore = {
      version: 1 as const,
      profiles: {
        "openai:scoped": {
          type: "token" as const,
          provider: "openai",
          token: "prepared-token",
        },
      },
      order: { openai: ["openai:scoped"] },
    };
    const clientPromise = getSharedCodexAppServerClient({
      timeoutMs: 1000,
      preparedAuth: {
        kind: "profile",
        profileId: "openai:scoped",
        store: authProfileStore,
      },
    });
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");

    await expect(clientPromise).resolves.toBe(harness.client);
    expect(mocks.resolveCodexAppServerAuthProfileStore).not.toHaveBeenCalled();
    expect(mocks.resolveCodexAppServerAuthProfileIdForAgent).not.toHaveBeenCalled();
    expect(mocks.resolveCodexAppServerPreparedAuthProfileSnapshot).toHaveBeenCalledOnce();
    expect(bridgeStartOptionsCall()).toMatchObject({
      authProfileId: "openai:scoped",
      authProfileStore,
      preparedAuth: { kind: "profile", profileId: "openai:scoped" },
    });
    expect(applyAuthProfileCall()).toMatchObject({
      authProfileId: "openai:scoped",
      authProfileStore,
      preparedAuth: {
        kind: "profile",
        snapshot: {
          loginParams: {
            type: "chatgptAuthTokens",
            accessToken: "prepared-token",
          },
        },
      },
    });
    mocks.refreshCodexAppServerAuthTokens.mockResolvedValueOnce({
      accessToken: "refreshed-access",
      chatgptAccountId: "scoped-account",
      chatgptPlanType: null,
    });

    const priorWriteCount = harness.writes.length;
    harness.send({
      id: "refresh-authoritative",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "unauthorized", previousAccountId: "scoped-account" },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThan(priorWriteCount));
    expect(mocks.refreshCodexAppServerAuthTokens).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw-agent",
      authProfileId: "openai:scoped",
      authProfileStore,
      previousAccountId: "scoped-account",
      config: undefined,
    });
  });

  it.each(["prepared", "selected"] as const)(
    "separates %s profile clients by secret-free account identity",
    async (selection) => {
      const firstHarness = createClientHarness();
      const secondHarness = createClientHarness();
      const startSpy = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(firstHarness.client)
        .mockResolvedValueOnce(secondHarness.client);
      const resolvedCacheKeys: string[] = [];
      mocks.resolveCodexAppServerPreparedAuthProfileSnapshot.mockImplementation(
        async (params?: {
          authProfileStore?: {
            profiles?: Record<string, { token?: string }>;
          };
        }) => {
          const token = params?.authProfileStore?.profiles?.["openai:scoped"]?.token;
          const key =
            token === "first-secret-token" ? "account:sha256:first" : "account:sha256:second";
          resolvedCacheKeys.push(key);
          return {
            loginParams: {
              type: "chatgptAuthTokens" as const,
              accessToken: token ?? "",
              chatgptAccountId: "prepared-account",
              chatgptPlanType: null,
            },
            secretFreeCacheKey: key,
          };
        },
      );
      const firstStore = {
        version: 1 as const,
        profiles: {
          "openai:scoped": {
            type: "token" as const,
            provider: "openai",
            token: "first-secret-token",
          },
        },
      };
      const secondStore = {
        version: 1 as const,
        profiles: {
          "openai:scoped": {
            type: "token" as const,
            provider: "openai",
            token: "second-secret-token",
          },
        },
      };

      const firstPromise = getSharedCodexAppServerClient({
        timeoutMs: 1000,
        ...(selection === "prepared"
          ? {
              preparedAuth: {
                kind: "profile" as const,
                profileId: "openai:scoped",
                store: firstStore,
              },
            }
          : { authProfileId: "openai:scoped", authProfileStore: firstStore }),
      });
      await sendInitializeResult(firstHarness, "openclaw/0.149.0 (macOS; test)");
      await expect(firstPromise).resolves.toBe(firstHarness.client);

      const secondPromise = getSharedCodexAppServerClient({
        timeoutMs: 1000,
        ...(selection === "prepared"
          ? {
              preparedAuth: {
                kind: "profile" as const,
                profileId: "openai:scoped",
                store: secondStore,
              },
            }
          : { authProfileId: "openai:scoped", authProfileStore: secondStore }),
      });
      await sendInitializeResult(secondHarness, "openclaw/0.149.0 (macOS; test)");
      expect(startSpy).toHaveBeenCalledTimes(2);
      await expect(secondPromise).resolves.toBe(secondHarness.client);

      expect(resolvedCacheKeys).toEqual(["account:sha256:first", "account:sha256:second"]);
      expect(mocks.applyCodexAppServerAuthProfile).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          preparedAuth: expect.objectContaining({
            snapshot: expect.objectContaining({
              loginParams: expect.objectContaining({ accessToken: "first-secret-token" }),
            }),
          }),
        }),
      );
      expect(mocks.applyCodexAppServerAuthProfile).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          preparedAuth: expect.objectContaining({
            snapshot: expect.objectContaining({
              loginParams: expect.objectContaining({ accessToken: "second-secret-token" }),
            }),
          }),
        }),
      );
      expect(resolvedCacheKeys.join("\n")).not.toContain("first-secret-token");
      expect(resolvedCacheKeys.join("\n")).not.toContain("second-secret-token");
    },
  );

  it("starts a prepared API-key client without profile or ambient-store resolution", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);

    const clientPromise = getSharedCodexAppServerClient({
      timeoutMs: 1000,
      preparedAuth: { kind: "api-key", apiKey: "platform-key" },
    });
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");

    await expect(clientPromise).resolves.toBe(harness.client);
    expect(mocks.resolveCodexAppServerAuthProfileStore).not.toHaveBeenCalled();
    expect(mocks.resolveCodexAppServerAuthProfileIdForAgent).not.toHaveBeenCalled();
    expect(bridgeStartOptionsCall().authProfileId).toBeNull();
    expect(bridgeStartOptionsCall().preparedAuth).toEqual({
      kind: "api-key",
      apiKey: "platform-key",
    });
    expect(applyAuthProfileCall()).toMatchObject({
      authProfileId: null,
      preparedAuth: { kind: "api-key", apiKey: "platform-key" },
    });
    expect(mocks.resolveCodexAppServerPreparedApiKeyCacheKey).toHaveBeenCalledWith("platform-key");
  });

  it.each(["api-key", "subscription"] as const)(
    "reuses a turn's %s physical client for a control resume",
    async (authRequirement) => {
      const harness = createClientHarness();
      const start = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(harness.client)
        .mockImplementation(async () => {
          throw new Error("control resume opened a second physical client");
        });
      const preparedAuth: CodexAppServerPreparedAuth =
        authRequirement === "api-key"
          ? { kind: "api-key", apiKey: "platform-key" }
          : {
              kind: "profile",
              profileId: "openai:scoped",
              store: {
                version: 1,
                profiles: {
                  "openai:scoped": { type: "token", provider: "openai", token: "prepared-token" },
                },
              },
            };
      const options = {
        timeoutMs: 1000,
        agentDir: "/tmp/openclaw-agent",
        preparedAuth,
        authRequirement,
        authBindingFingerprint:
          authRequirement === "subscription" ? "profile-credential-fingerprint" : undefined,
      };
      const producer = getSharedCodexAppServerClient(options);
      await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
      await expect(producer).resolves.toBe(harness.client);
      const response = { thread: { id: "thread-resume" } };
      const request = vi.spyOn(harness.client, "request").mockResolvedValue(response as never);

      await expect(
        withCodexAppServerJsonClient(options, async (send, client) => {
          expect(client).toBe(harness.client);
          return await send({
            method: "thread/resume",
            requestParams: { threadId: "thread-resume" },
          });
        }),
      ).resolves.toEqual(response);

      expect(start).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "thread/resume",
        { threadId: "thread-resume" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    },
  );

  it("rejects ambiguous prepared and legacy auth before starting a client", async () => {
    const startSpy = vi.spyOn(CodexAppServerClient, "start");

    await expect(
      getSharedCodexAppServerClient({
        authProfileId: "openai:legacy",
        preparedAuth: { kind: "api-key", apiKey: "platform-key" },
      }),
    ).rejects.toThrow("Prepared Codex auth cannot also select a legacy auth profile");

    expect(startSpy).not.toHaveBeenCalled();
  });

  it("rotates prepared API keys onto distinct shared clients", async () => {
    const firstHarness = createClientHarness();
    const secondHarness = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(firstHarness.client)
      .mockResolvedValueOnce(secondHarness.client);
    const cacheKeys: string[] = [];
    mocks.resolveCodexAppServerPreparedApiKeyCacheKey.mockImplementation((apiKey: string) => {
      const cacheKey =
        apiKey === "first-platform-key" ? "api_key:sha256:first" : "api_key:sha256:second";
      cacheKeys.push(cacheKey);
      return cacheKey;
    });

    const firstPromise = getSharedCodexAppServerClient({
      timeoutMs: 1000,
      preparedAuth: { kind: "api-key", apiKey: "first-platform-key" },
    });
    await sendInitializeResult(firstHarness, "openclaw/0.149.0 (macOS; test)");
    await expect(firstPromise).resolves.toBe(firstHarness.client);

    const secondPromise = getSharedCodexAppServerClient({
      timeoutMs: 1000,
      preparedAuth: { kind: "api-key", apiKey: "second-platform-key" },
    });
    await sendInitializeResult(secondHarness, "openclaw/0.149.0 (macOS; test)");
    expect(startSpy).toHaveBeenCalledTimes(2);
    await expect(secondPromise).resolves.toBe(secondHarness.client);

    expect(cacheKeys).toEqual(["api_key:sha256:first", "api_key:sha256:second"]);
    expect(cacheKeys.join("\n")).not.toContain("platform-key");
    expect(mocks.applyCodexAppServerAuthProfile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        preparedAuth: { kind: "api-key", apiKey: "first-platform-key" },
      }),
    );
    expect(mocks.applyCodexAppServerAuthProfile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        preparedAuth: { kind: "api-key", apiKey: "second-platform-key" },
      }),
    );
  });

  it("registers persisted profile refresh for isolated app-server startup", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);

    const clientPromise = createIsolatedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileId: "openai:persisted",
      agentDir: "/tmp/openclaw-persisted-agent",
    });
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");

    await expect(clientPromise).resolves.toBe(harness.client);
    mocks.refreshCodexAppServerAuthTokens.mockResolvedValueOnce({
      accessToken: "refreshed-access",
      chatgptAccountId: "persisted-account",
      chatgptPlanType: null,
    });
    const priorWriteCount = harness.writes.length;
    harness.send({
      id: "refresh-persisted",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "unauthorized", previousAccountId: "persisted-account" },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThan(priorWriteCount));

    expect(mocks.refreshCodexAppServerAuthTokens).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw-persisted-agent",
      authProfileId: "openai:persisted",
      previousAccountId: "persisted-account",
      config: undefined,
    });
    expect(JSON.parse(harness.writes.at(-1) ?? "{}")).toEqual({
      id: "refresh-persisted",
      result: {
        accessToken: "refreshed-access",
        chatgptAccountId: "persisted-account",
        chatgptPlanType: null,
      },
    });
  });

  it("skips target auth resolution when native source auth is requested", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const config = { auth: { order: { openai: ["openai:target"] } } };

    const clientPromise = getSharedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileId: null,
      agentDir: "/tmp/openclaw-target-agent",
      agentId: "research",
      config,
    });
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");

    await expect(clientPromise).resolves.toBe(harness.client);
    expect(mocks.resolveCodexAppServerAuthProfileIdForAgent).not.toHaveBeenCalled();
    const bridgeCall = bridgeStartOptionsCall();
    expect(bridgeCall.agentDir).toBe("/tmp/openclaw-target-agent");
    expect(bridgeCall.agentId).toBe("research");
    expect(bridgeCall.authProfileId).toBeNull();
    expect(bridgeCall.config).toBe(config);
    const applyCall = applyAuthProfileCall();
    expect(applyCall.agentDir).toBe("/tmp/openclaw-target-agent");
    expect(applyCall.authProfileId).toBeNull();
    expect(applyCall.config).toBe(config);
  });

  it("uses native auth automatically for shared user-home clients", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);

    const clientPromise = createIsolatedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileId: "openai:target",
      startOptions: {
        transport: "stdio",
        homeScope: "user",
        command: "codex",
        args: ["app-server"],
        headers: {},
      },
    });
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");

    await expect(clientPromise).resolves.toBe(harness.client);
    expect(mocks.resolveCodexAppServerAuthProfileIdForAgent).not.toHaveBeenCalled();
    expect(bridgeStartOptionsCall().authProfileId).toBeNull();
    expect(applyAuthProfileCall().authProfileId).toBeNull();
  });

  it("resolves the configured implicit auth profile before sharing a client", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const config = { auth: { order: { openai: ["openai:work"] } } };
    mocks.resolveCodexAppServerAuthProfileIdForAgent.mockReturnValue("openai:work");

    const listPromise = listCodexAppServerModels({
      timeoutMs: 1000,
      config,
    });
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(harness);

    await expect(listPromise).resolves.toEqual({ models: [] });
    const resolveCall = resolveAuthProfileCall();
    expect(resolveCall).toStrictEqual({
      authProfileId: undefined,
      agentDir: "/tmp/openclaw-agent",
      config,
    });
    const bridgeCall = bridgeStartOptionsCall();
    expect(bridgeCall?.authProfileId).toBe("openai:work");
    expect(bridgeCall?.config).toBe(config);
    const applyCall = applyAuthProfileCall();
    expect(applyCall?.authProfileId).toBe("openai:work");
    expect(applyCall?.config).toBe(config);
  });

  it("uses the selected agent dir for shared app-server auth bridging", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);

    const listPromise = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: "openai:work",
      agentDir: "/tmp/openclaw-agent-nova",
    });
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(harness);

    await expect(listPromise).resolves.toEqual({ models: [] });
    const bridgeCall = bridgeStartOptionsCall();
    expect(bridgeCall?.agentDir).toBe("/tmp/openclaw-agent-nova");
    expect(bridgeCall?.authProfileId).toBe("openai:work");
    const applyCall = applyAuthProfileCall();
    expect(applyCall?.agentDir).toBe("/tmp/openclaw-agent-nova");
    expect(applyCall?.authProfileId).toBe("openai:work");
  });

  it("keeps an active shared client alive when another agent dir uses a different key", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      agentDir: "/tmp/openclaw-agent-one",
    });
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      agentDir: "/tmp/openclaw-agent-two",
    });
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(first.process.stdin.destroyed).toBe(false);
    expect(second.process.stdin.destroyed).toBe(false);
  });

  it("resolves the managed binary before bridging and spawning the shared client", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementationOnce(async (startOptions) => ({
      ...startOptions,
      command: "/cache/openclaw/codex",
      commandSource: "resolved-managed",
    }));

    const listPromise = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(harness);

    await expect(listPromise).resolves.toEqual({ models: [] });
    const managedCall = managedStartOptionsCall();
    expect(managedCall?.command).toBe("codex");
    expect(managedCall?.commandSource).toBe("managed");
    const bridgeCall = bridgeStartOptionsCall();
    expect(bridgeCall?.startOptions.command).toBe("/cache/openclaw/codex");
    expect(bridgeCall?.startOptions.commandSource).toBe("resolved-managed");
    const startCall = clientStartCall(startSpy);
    expect(startCall?.command).toBe("/cache/openclaw/codex");
    expect(startCall?.commandSource).toBe("resolved-managed");
  });

  it("rechecks persisted native Computer Use before managed binary resolution", async () => {
    await withTempDir("openclaw-codex-shared-native-", async (agentDir) => {
      const codexHome = path.join(agentDir, "codex-home");
      await fs.mkdir(codexHome);
      await fs.writeFile(
        path.join(codexHome, "config.toml"),
        '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
      );
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);

      const clientPromise = createIsolatedCodexAppServerClient({
        agentDir,
        timeoutMs: 1000,
        startOptions: {
          transport: "stdio",
          homeScope: "agent",
          command: "codex",
          commandSource: "managed",
          managedComputerUsePluginNames: ["computer-use"],
          args: ["app-server", "--listen", "stdio://"],
          headers: {},
        },
      });
      await sendInitializeResult(harness, `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)`);

      await expect(clientPromise).resolves.toBe(harness.client);
      expect(managedStartOptionsCall().managedCommandOrder).toBe("desktop-first");
    });
  });

  it("starts an independent shared client when the bridged auth token changes", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      startOptions: {
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "tok-first",
        headers: {},
      },
    });
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      startOptions: {
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "tok-second",
        headers: {},
      },
    });
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(first.process.stdin.destroyed).toBe(false);
  });

  it("starts an independent shared client when fallback api-key auth changes", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    mocks.resolveCodexAppServerFallbackApiKeyCacheKey
      .mockReturnValueOnce("api-key:first")
      .mockReturnValueOnce("api-key:second");

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      authRequirement: "api-key",
    });
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      authRequirement: "api-key",
    });
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(first.process.stdin.destroyed).toBe(false);
    expect(second.process.stdin.destroyed).toBe(false);
  });

  it("does not share a client across auth requirements", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: "openai:work",
      authRequirement: "api-key",
    });
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: "openai:work",
      authRequirement: "subscription",
    });
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(first.process.stdin.destroyed).toBe(false);
    expect(second.process.stdin.destroyed).toBe(false);
  });

  it("rejects prepared auth that conflicts with the auth requirement", async () => {
    const startSpy = vi.spyOn(CodexAppServerClient, "start");

    await expect(
      getSharedCodexAppServerClient({
        authRequirement: "subscription",
        preparedAuth: { kind: "api-key", apiKey: "placeholder" },
      }),
    ).rejects.toThrow("Prepared Codex auth does not satisfy the requested auth requirement.");
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("does not let one shared-client failure tear down another keyed client", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      startOptions: {
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "tok-first",
        headers: {},
      },
    });
    const firstFailure = firstList.catch((error: unknown) => error);
    await vi.waitFor(() => expect(first.writes.length).toBeGreaterThanOrEqual(1));

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      startOptions: {
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "tok-second",
        headers: {},
      },
    });
    await vi.waitFor(() => expect(second.writes.length).toBeGreaterThanOrEqual(1));

    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    first.client.close();
    await expect(firstFailure).resolves.toBeInstanceOf(Error);

    expect(second.process.kill).not.toHaveBeenCalled();
  });

  it("only clears the shared client that is still current", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);

    const firstList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    expect(clearSharedCodexAppServerClientIfCurrent(first.client)).toBe(true);
    expect(first.process.stdin.destroyed).toBe(true);

    const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(clearSharedCodexAppServerClientIfCurrent(first.client)).toBe(false);
    expect(second.process.kill).not.toHaveBeenCalled();
    expect(clearSharedCodexAppServerClientIfCurrent(second.client)).toBe(true);
    expect(second.process.stdin.destroyed).toBe(true);
  });

  it("closes a retired shared app-server and forces active leases onto the retryable close path", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);

    const firstList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const releaseFirst = retainSharedCodexAppServerClientIfCurrent(first.client);
    const releaseSecond = retainSharedCodexAppServerClientIfCurrent(first.client);
    expect(releaseFirst).toBeTypeOf("function");
    expect(releaseSecond).toBeTypeOf("function");
    const activeRequest = first.client.request("test/pending", {});
    expect(
      retireSharedCodexAppServerClientIfCurrent(first.client, { failActiveLeases: true }),
    ).toEqual({
      activeLeases: 2,
      closed: true,
    });
    expect(first.process.stdin.destroyed).toBe(true);
    await expect(activeRequest).rejects.toThrow("codex app-server client is closed");

    const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    releaseFirst?.();
    releaseSecond?.();
    expect(first.process.stdin.destroyed).toBe(true);
    expect(second.process.kill).not.toHaveBeenCalled();
    expect(retireSharedCodexAppServerClientIfCurrent(second.client)).toEqual({
      activeLeases: 0,
      closed: true,
    });
    expect(second.process.stdin.destroyed).toBe(true);
  });

  it("keeps a retired one-shot client alive until native subagent completion", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);

    const clientPromise = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.149.0 (Linux; test)");
    const client = await clientPromise;
    const deliverCompletion = vi.fn(async () => ({ delivered: true, path: "direct" as const }));
    const taskRuntime = {
      tryCreateRunningTaskRun: vi.fn(() => ({ taskId: "child-thread" })),
      recordTaskRunProgressByRunId: vi.fn(() => []),
      finalizeTaskRunByRunId: vi.fn(() => []),
      listTaskRecords: vi.fn(() => []),
      setDetachedTaskDeliveryStatusByRunId: vi.fn(() => []),
    };
    const retainClient = vi.fn(() => retainSharedCodexAppServerClientIfCurrent(client));
    const monitor = new codexNativeSubagentMonitorRuntime.Monitor(
      client,
      {
        createAgentHarnessTaskRuntime: vi.fn(() => taskRuntime),
        deliverAgentHarnessTaskCompletion: deliverCompletion,
      } as never,
      { retainClient },
    );
    monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:main",
      taskRuntimeScope: {} as never,
      agentId: "main",
    });

    harness.send({
      method: "thread/started",
      params: {
        thread: {
          id: "child-thread",
          parentThreadId: "parent-thread",
          preview: "inspect the repo",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "parent-thread",
                depth: 1,
                agent_path: "child-thread",
              },
            },
          },
        },
      },
    });
    await vi.waitFor(() => expect(retainClient).toHaveBeenCalledTimes(1));

    expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
    expect(retireSharedCodexAppServerClientIfCurrent(client)).toEqual({
      activeLeases: 1,
      closed: false,
    });
    expect(harness.process.stdin.destroyed).toBe(false);

    // The ordinary lease is gone, but native completion still explicitly owns
    // the detached process and repeated cleanup must not close that owner.
    expect(retireSharedCodexAppServerClientIfCurrent(client)).toEqual({
      activeLeases: 1,
      closed: false,
    });
    expect(harness.process.stdin.destroyed).toBe(false);

    harness.send({
      method: "turn/completed",
      params: {
        threadId: "child-thread",
        turn: {
          id: "child-turn",
          status: "completed",
          items: [
            {
              id: "child-final",
              type: "agentMessage",
              phase: "final_answer",
              text: "child final result",
            },
          ],
          error: null,
        },
      },
    });

    await vi.waitFor(() => expect(deliverCompletion).toHaveBeenCalledTimes(1));
    expect(deliverCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionId: "child-thread", result: "child final result" }),
    );
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("leases shared app-server clients before returning concurrent acquirers", async () => {
    const first = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(first.client);

    const firstLease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    const secondLease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await expect(firstLease).resolves.toBe(first.client);
    await expect(secondLease).resolves.toBe(first.client);

    expect(
      retireSharedCodexAppServerClientIfCurrent(first.client, { failActiveLeases: true }),
    ).toEqual({
      activeLeases: 2,
      closed: true,
    });
    expect(
      retireSharedCodexAppServerClientIfCurrent(first.client, { failActiveLeases: true }),
    ).toEqual({
      activeLeases: 2,
      closed: false,
    });
    expect(first.process.stdin.destroyed).toBe(true);

    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    expect(first.process.stdin.destroyed).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(false);
  });

  it("keeps the current client registered while a staggered sibling lease is active", async () => {
    const first = createClientHarness();
    const replacement = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(replacement.client);

    const completedRunLease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    const siblingRunLease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await expect(completedRunLease).resolves.toBe(first.client);
    await expect(siblingRunLease).resolves.toBe(first.client);

    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    expect(clearSharedCodexAppServerClientIfCurrentAndUnclaimed(first.client)).toEqual({
      found: true,
      closed: false,
      activeLeases: 1,
      pendingAcquires: 0,
    });
    expect(first.process.stdin.destroyed).toBe(false);

    const staggeredLease = await getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    expect(staggeredLease).toBe(first.client);
    expect(startSpy).toHaveBeenCalledTimes(1);

    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    expect(clearSharedCodexAppServerClientIfCurrentAndUnclaimed(first.client)).toEqual({
      found: true,
      closed: true,
      activeLeases: 0,
      pendingAcquires: 0,
    });
    expect(first.process.stdin.destroyed).toBe(true);
  });

  it("rejects pending acquires during shared-client retirement", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);

    const firstLease = getLeasedSharedCodexAppServerClient();
    const pendingLease = getLeasedSharedCodexAppServerClient();
    await vi.waitFor(() => expect(first.writes.length).toBeGreaterThanOrEqual(1));

    expect(
      retireSharedCodexAppServerClientIfCurrent(first.client, { failActiveLeases: true }),
    ).toEqual({
      activeLeases: 0,
      closed: true,
    });
    await expect(firstLease).rejects.toThrow("codex app-server client is closed");
    await expect(pendingLease).rejects.toThrow("codex app-server client is closed");

    const freshLease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    await expect(freshLease).resolves.toBe(second.client);
    expect(second.process.stdin.destroyed).toBe(false);
  });

  it("suspect retirement closes a client that was already gracefully detached", async () => {
    const first = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(first.client);

    const lease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await expect(lease).resolves.toBe(first.client);

    // Routine cleanup detaches gracefully; a later terminal-idle kill must
    // still be able to fail the leaseholders off the poisoned process.
    expect(retireSharedCodexAppServerClientIfCurrent(first.client)).toEqual({
      activeLeases: 1,
      closed: false,
    });
    expect(first.process.stdin.destroyed).toBe(false);

    expect(
      retireSharedCodexAppServerClientIfCurrent(first.client, { failActiveLeases: true }),
    ).toEqual({
      activeLeases: 1,
      closed: true,
    });
    expect(first.process.stdin.destroyed).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
  });

  it("retires gracefully by default: leased clients close on release, not immediately", async () => {
    const first = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(first.client);

    const lease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await expect(lease).resolves.toBe(first.client);
    const current = captureSharedCodexAppServerCatalogLifetime(first.client);
    expect(current()).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    expect(current()).toBe(true);
    await expect(getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 })).resolves.toBe(
      first.client,
    );
    expect(current()).toBe(true);

    // Routine cleanup (e.g. one-shot bundle-MCP) must not yank a healthy
    // client from co-leased sessions; only suspect retirement does.
    expect(retireSharedCodexAppServerClientIfCurrent(first.client)).toEqual({
      activeLeases: 1,
      closed: false,
    });
    expect(first.process.stdin.destroyed).toBe(false);
    expect(current()).toBe(false);

    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    expect(first.process.stdin.destroyed).toBe(true);
  });

  it.each(["account/login/start", "account/logout", "config/value/write", "config/batchWrite"])(
    "invalidates catalog observations before %s settles",
    async (method) => {
      const transport = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(transport.client);
      const lease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
      await sendInitializeResult(transport, "openclaw/0.149.0 (test)");
      const client = await lease;
      const current = captureSharedCodexAppServerCatalogLifetime(client);
      expect(current()).toBe(true);
      const requestIndex = transport.writes.length;
      const pending = client.request(method, {});
      const request = JSON.parse(await transport.waitForWrite(requestIndex));
      expect(current()).toBe(false);
      transport.send({ id: request.id, result: {} });
      await pending;
      expect(current()).toBe(false);
      releaseLeasedSharedCodexAppServerClient(client);
    },
  );

  it("waits for a dirty desktop generation before reusing a warm managed client", async () => {
    const generation = { epoch: 1, fingerprint: "desktop-x" };
    mocks.desktopGeneration = generation;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
      ...startOptions,
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "resolved-managed" as const,
    }));
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
    const config = {};
    const startOptions: CodexAppServerStartOptions = {
      transport: "stdio",
      homeScope: "agent",
      command: "codex",
      commandSource: "managed",
      managedCommandOrder: "desktop-first",
      args: ["app-server"],
      headers: {},
    };
    const options = { config, startOptions, agentDir: "/tmp/openclaw-agent" };

    const firstAcquire = getLeasedSharedCodexAppServerClient(options);
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
    const first = await firstAcquire;
    const dirty = createDeferred<typeof generation>();
    mocks.desktopGenerationCurrent = false;
    mocks.waitForCodexDesktopGeneration.mockReturnValue(dirty.promise);
    let settled = false;
    const secondAcquire = getLeasedSharedCodexAppServerClient(options).then((client) => {
      settled = true;
      return client;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(startSpy).toHaveBeenCalledOnce();
    mocks.desktopGenerationCurrent = true;
    dirty.resolve(generation);
    await expect(secondAcquire).resolves.toBe(first);
    expect(startSpy).toHaveBeenCalledOnce();
    expect(releaseLeasedSharedCodexAppServerClient(first)).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(first)).toBe(true);
  });

  it("bounds a dirty desktop generation wait by the acquisition abort signal", async () => {
    mocks.desktopGeneration = { epoch: 1, fingerprint: "desktop-x" };
    mocks.waitForCodexDesktopGeneration.mockReturnValue(new Promise(() => {}));
    const abort = new AbortController();
    const acquire = getLeasedSharedCodexAppServerClient({
      timeoutMs: 1_000,
      abandonSignal: abort.signal,
      startOptions: {
        transport: "stdio",
        homeScope: "agent",
        command: "codex",
        commandSource: "managed",
        managedCommandOrder: "desktop-first",
        args: ["app-server"],
        headers: {},
      },
    });

    abort.abort();

    await expect(acquire).rejects.toThrow("codex app-server initialize aborted");
  });

  it("does not start a client after its sole waiter abandons artifact reconciliation", async () => {
    const reconcileStarted = createDeferred<void>();
    const releaseReconcile = createDeferred<void>();
    const reconcileFinished = createDeferred<void>();
    mocks.reconcileCodexComputerUseStartArtifacts.mockImplementationOnce(
      async (value?: unknown) => {
        const params = value as { assertCurrent?: () => void };
        reconcileStarted.resolve();
        await releaseReconcile.promise;
        try {
          params.assertCurrent?.();
        } finally {
          reconcileFinished.resolve();
        }
      },
    );
    const startSpy = vi.spyOn(CodexAppServerClient, "start");
    const abort = new AbortController();
    const acquire = getLeasedSharedCodexAppServerClient({
      config: {},
      agentDir: "/tmp/openclaw-agent",
      startOptions: {
        transport: "stdio",
        homeScope: "agent",
        command: "codex",
        commandSource: "managed",
        args: ["app-server"],
        headers: {},
      },
      timeoutMs: 1_000,
      abandonSignal: abort.signal,
    });
    await reconcileStarted.promise;

    abort.abort();
    await expect(acquire).rejects.toThrow("codex app-server initialize aborted");
    releaseReconcile.resolve();
    await reconcileFinished.promise;
    await Promise.resolve();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("does not start a client abandoned after reconciliation's final currentness check", async () => {
    const abort = new AbortController();
    mocks.reconcileCodexComputerUseStartArtifacts.mockImplementationOnce(
      async (value?: unknown) => {
        const params = value as { assertCurrent?: () => void };
        params.assertCurrent?.();
        abort.abort();
      },
    );
    const startSpy = vi.spyOn(CodexAppServerClient, "start");

    await expect(
      getLeasedSharedCodexAppServerClient({
        config: {},
        agentDir: "/tmp/openclaw-agent",
        startOptions: {
          transport: "stdio",
          homeScope: "agent",
          command: "codex",
          commandSource: "managed",
          args: ["app-server"],
          headers: {},
        },
        timeoutMs: 1_000,
        abandonSignal: abort.signal,
      }),
    ).rejects.toThrow("codex app-server initialize aborted");
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("waits for active generation X leases before publishing generation Y artifacts", async () => {
    const generationX = { epoch: 1, fingerprint: "desktop-x" };
    const generationY = { epoch: 2, fingerprint: "desktop-y" };
    mocks.desktopGeneration = generationX;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
      ...startOptions,
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "resolved-managed" as const,
    }));
    const first = createClientHarness({ autoEmitExit: false });
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const config = {};
    const startOptions: CodexAppServerStartOptions = {
      transport: "stdio",
      homeScope: "agent",
      command: "codex",
      commandSource: "managed",
      managedCommandOrder: "desktop-first",
      args: ["app-server"],
      headers: {},
    };
    const options = {
      config,
      startOptions,
      agentDir: "/tmp/openclaw-agent",
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
    };

    const firstAcquire = getLeasedSharedCodexAppServerClient(options);
    const siblingAcquire = getLeasedSharedCodexAppServerClient(options);
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    const clientX = await firstAcquire;
    await expect(siblingAcquire).resolves.toBe(clientX);
    const pending = clientX.request("test/pending", {});
    await vi.waitFor(() => expect(first.writes.length).toBeGreaterThanOrEqual(2));

    mocks.desktopGeneration = generationY;
    retireSharedCodexAppServerClientsBeforeDesktopGeneration(generationY);
    const replacementAcquire = getLeasedSharedCodexAppServerClient(options);
    await vi.waitFor(() =>
      expect(mocks.resolveManagedCodexAppServerStartOptions).toHaveBeenCalledTimes(2),
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(mocks.reconcileCodexComputerUseStartArtifacts).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(first.process.stdin.destroyed).toBe(false);

    const pendingRequest = JSON.parse(first.writes.at(-1) ?? "{}") as { id?: number };
    first.send({ id: pendingRequest.id, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
    expect(releaseLeasedSharedCodexAppServerClient(clientX)).toBe(true);
    expect(first.process.stdin.destroyed).toBe(false);
    expect(releaseLeasedSharedCodexAppServerClient(clientX)).toBe(true);
    expect(first.process.stdin.destroyed).toBe(true);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(mocks.reconcileCodexComputerUseStartArtifacts).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
    first.emitExit();

    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    const clientY = await replacementAcquire;
    expect(clientY).toBe(second.client);
    expect(clientY).not.toBe(clientX);
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(mocks.reconcileCodexComputerUseStartArtifacts).toHaveBeenCalledTimes(2);
    expect(second.process.stdin.destroyed).toBe(false);
    expect(releaseLeasedSharedCodexAppServerClient(clientY)).toBe(true);
  });

  it("waits for an initializing generation X client before publishing generation Y artifacts", async () => {
    const generationX = { epoch: 1, fingerprint: "desktop-x" };
    const generationY = { epoch: 2, fingerprint: "desktop-y" };
    mocks.desktopGeneration = generationX;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
      ...startOptions,
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "resolved-managed" as const,
    }));
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const options = {
      config: {},
      agentDir: "/tmp/openclaw-agent",
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      startOptions: {
        transport: "stdio" as const,
        homeScope: "agent" as const,
        command: "codex",
        commandSource: "managed" as const,
        managedCommandOrder: "desktop-first" as const,
        args: ["app-server"],
        headers: {},
      },
    };

    const firstAcquire = getLeasedSharedCodexAppServerClient(options);
    await vi.waitFor(() => expect(first.writes).toHaveLength(1));
    mocks.desktopGeneration = generationY;
    retireSharedCodexAppServerClientsBeforeDesktopGeneration(generationY);
    const replacementAcquire = getLeasedSharedCodexAppServerClient(options);
    await vi.waitFor(() =>
      expect(mocks.resolveManagedCodexAppServerStartOptions).toHaveBeenCalledTimes(2),
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(mocks.reconcileCodexComputerUseStartArtifacts).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);

    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await expect(firstAcquire).rejects.toMatchObject({
      code: "CODEX_APP_SERVER_START_SELECTION_CHANGED",
    });
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    const clientY = await replacementAcquire;

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(first.process.stdin.destroyed).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(clientY)).toBe(true);
  });

  it("waits for an isolated generation X client before publishing generation Y artifacts", async () => {
    const generationX = { epoch: 1, fingerprint: "desktop-x" };
    const generationY = { epoch: 2, fingerprint: "desktop-y" };
    mocks.desktopGeneration = generationX;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
      ...startOptions,
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "resolved-managed" as const,
    }));
    const first = createClientHarness({ autoEmitExit: false });
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const options = {
      config: {},
      agentDir: "/tmp/openclaw-agent",
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      startOptions: {
        transport: "stdio" as const,
        homeScope: "agent" as const,
        command: "codex",
        commandSource: "managed" as const,
        managedCommandOrder: "desktop-first" as const,
        args: ["app-server"],
        headers: {},
      },
    };

    const clientXPromise = createIsolatedCodexAppServerClient(options);
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    const clientX = await clientXPromise;

    mocks.desktopGeneration = generationY;
    const clientYPromise = createIsolatedCodexAppServerClient(options);
    await vi.waitFor(() =>
      expect(mocks.resolveManagedCodexAppServerStartOptions).toHaveBeenCalledTimes(2),
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(mocks.reconcileCodexComputerUseStartArtifacts).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);

    clientX.close();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(mocks.reconcileCodexComputerUseStartArtifacts).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
    first.emitExit();
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    const clientY = await clientYPromise;

    expect(mocks.reconcileCodexComputerUseStartArtifacts).toHaveBeenCalledTimes(2);
    expect(startSpy).toHaveBeenCalledTimes(2);
    clientY.close();
  });

  it("bounds an explicit install drain while an isolated generation X client remains live", async () => {
    const generationX = { epoch: 1, fingerprint: "desktop-x" };
    const generationY = { epoch: 2, fingerprint: "desktop-y" };
    mocks.desktopGeneration = generationX;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
      ...startOptions,
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "resolved-managed" as const,
    }));
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const options = {
      config: {},
      agentDir: "/tmp/openclaw-agent",
      pluginConfig: { computerUse: { enabled: true, autoInstall: false } },
      startOptions: {
        transport: "stdio" as const,
        homeScope: "agent" as const,
        command: "codex",
        commandSource: "managed" as const,
        managedCommandOrder: "desktop-first" as const,
        args: ["app-server"],
        headers: {},
      },
    };

    const clientXPromise = createIsolatedCodexAppServerClient(options);
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    const clientX = await clientXPromise;
    mocks.desktopGeneration = generationY;
    const clientYPromise = createIsolatedCodexAppServerClient(options);
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    const clientY = await clientYPromise;

    await expect(
      waitForCodexAppServerClientDesktopGenerationDrain({ client: clientY, timeoutMs: 25 }),
    ).rejects.toThrow("timed out waiting for older desktop clients");

    clientX.close();
    clientY.close();
  });

  it("waits for an initializing isolated generation X client before publishing generation Y artifacts", async () => {
    const generationX = { epoch: 1, fingerprint: "desktop-x" };
    const generationY = { epoch: 2, fingerprint: "desktop-y" };
    mocks.desktopGeneration = generationX;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
      ...startOptions,
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "resolved-managed" as const,
    }));
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const options = {
      config: {},
      agentDir: "/tmp/openclaw-agent",
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      startOptions: {
        transport: "stdio" as const,
        homeScope: "agent" as const,
        command: "codex",
        commandSource: "managed" as const,
        managedCommandOrder: "desktop-first" as const,
        args: ["app-server"],
        headers: {},
      },
    };

    const clientXPromise = createIsolatedCodexAppServerClient(options);
    await vi.waitFor(() => expect(first.writes).toHaveLength(1));
    mocks.desktopGeneration = generationY;
    const clientYPromise = createIsolatedCodexAppServerClient(options);
    await vi.waitFor(() =>
      expect(mocks.resolveManagedCodexAppServerStartOptions).toHaveBeenCalledTimes(2),
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(mocks.reconcileCodexComputerUseStartArtifacts).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);

    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await expect(clientXPromise).rejects.toMatchObject({
      code: "CODEX_APP_SERVER_START_SELECTION_CHANGED",
    });
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    const clientY = await clientYPromise;

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(first.process.stdin.destroyed).toBe(true);
    clientY.close();
  });

  it("does not block generation Y artifacts on an older client for another home", async () => {
    const generationX = { epoch: 1, fingerprint: "desktop-x" };
    const generationY = { epoch: 2, fingerprint: "desktop-y" };
    mocks.desktopGeneration = generationX;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
      ...startOptions,
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "resolved-managed" as const,
    }));
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const startOptions: CodexAppServerStartOptions = {
      transport: "stdio",
      homeScope: "agent",
      command: "codex",
      commandSource: "managed",
      managedCommandOrder: "desktop-first",
      args: ["app-server"],
      headers: {},
    };
    const common = {
      config: {},
      startOptions,
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
    };

    const firstAcquire = getLeasedSharedCodexAppServerClient({
      ...common,
      agentDir: "/tmp/openclaw-agent-a",
    });
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    const clientX = await firstAcquire;

    mocks.desktopGeneration = generationY;
    retireSharedCodexAppServerClientsBeforeDesktopGeneration(generationY);
    const secondAcquire = getLeasedSharedCodexAppServerClient({
      ...common,
      agentDir: "/tmp/openclaw-agent-b",
    });
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    const clientY = await secondAcquire;

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(first.process.stdin.destroyed).toBe(false);
    expect(releaseLeasedSharedCodexAppServerClient(clientX)).toBe(true);
    expect(first.process.stdin.destroyed).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(clientY)).toBe(true);
  });

  it("tracks a package-first client whose Computer Use artifacts come from the desktop", async () => {
    const generationX = { epoch: 1, fingerprint: "desktop-x" };
    const generationY = { epoch: 2, fingerprint: "desktop-y" };
    mocks.desktopGeneration = generationX;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
      ...startOptions,
      command: "/cache/openclaw/codex",
      commandSource: "resolved-managed" as const,
      managedFallbackCommandPaths: ["/Applications/Codex.app/Contents/Resources/codex"],
    }));
    const packageX = createClientHarness();
    const packageY = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(packageX.client)
      .mockResolvedValueOnce(packageY.client);
    const options = {
      config: {},
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      agentDir: "/tmp/openclaw-agent",
      startOptions: {
        transport: "stdio" as const,
        homeScope: "agent" as const,
        command: "codex",
        commandSource: "managed" as const,
        managedCommandOrder: "package-first" as const,
        args: ["app-server"],
        headers: {},
      },
    };

    const firstAcquire = getLeasedSharedCodexAppServerClient(options);
    await sendInitializeResult(packageX, "openclaw/0.149.0 (macOS; test)");
    const clientX = await firstAcquire;

    mocks.desktopGeneration = generationY;
    retireSharedCodexAppServerClientsBeforeDesktopGeneration(generationY);
    const replacementAcquire = getLeasedSharedCodexAppServerClient(options);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(packageX.process.stdin.destroyed).toBe(false);
    expect(releaseLeasedSharedCodexAppServerClient(clientX)).toBe(true);
    expect(packageX.process.stdin.destroyed).toBe(true);
    await sendInitializeResult(packageY, "openclaw/0.149.0 (macOS; test)");
    const clientY = await replacementAcquire;

    expect(clientY).not.toBe(clientX);
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(
      mocks.reconcileCodexComputerUseStartArtifacts.mock.calls.map(
        ([params]) => params?.desktopGeneration,
      ),
    ).toEqual([generationX, generationY]);
    expect(releaseLeasedSharedCodexAppServerClient(clientY)).toBe(true);
  });

  it.each(["config", "env"] as const)(
    "does not generation-bind a custom Computer Use app-server selected by %s",
    async (commandSource) => {
      const generationX = { epoch: 1, fingerprint: "desktop-x" };
      const generationY = { epoch: 2, fingerprint: "desktop-y" };
      mocks.desktopGeneration = generationX;
      const packageX = createClientHarness();
      const startSpy = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(packageX.client);
      const options = {
        config: {},
        pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
        agentDir: "/tmp/openclaw-agent",
        startOptions: {
          transport: "stdio" as const,
          homeScope: "agent" as const,
          command: "/opt/codex/bin/codex",
          commandSource,
          args: ["app-server"],
          headers: {},
        },
      };

      const firstAcquire = getLeasedSharedCodexAppServerClient(options);
      await sendInitializeResult(packageX, "openclaw/0.149.0 (macOS; test)");
      const clientX = await firstAcquire;
      expect(readCodexAppServerClientDesktopGeneration(clientX)).toBeUndefined();

      mocks.desktopGeneration = generationY;
      retireSharedCodexAppServerClientsBeforeDesktopGeneration(generationY);
      const clientAfterDesktopUpdate = await getLeasedSharedCodexAppServerClient(options);

      expect(clientAfterDesktopUpdate).toBe(clientX);
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(
        mocks.reconcileCodexComputerUseStartArtifacts.mock.calls.map(
          ([params]) => params?.desktopGeneration,
        ),
      ).toEqual([undefined]);
      expect(releaseLeasedSharedCodexAppServerClient(clientAfterDesktopUpdate)).toBe(true);
      expect(releaseLeasedSharedCodexAppServerClient(clientX)).toBe(true);
    },
  );

  it("generation-binds an explicit desktop client while Computer Use is disabled", async () => {
    const generation = { epoch: 1, fingerprint: "desktop-x" };
    mocks.desktopGeneration = generation;
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);

    const clientPromise = getLeasedSharedCodexAppServerClient({
      config: {},
      pluginConfig: { computerUse: { enabled: false } },
      agentDir: "/tmp/openclaw-agent",
      startOptions: {
        transport: "stdio",
        homeScope: "agent",
        command: "/Applications/ChatGPT.app/Contents/Resources/codex",
        commandSource: "config",
        args: ["app-server"],
        headers: {},
      },
    });
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
    const client = await clientPromise;

    expect(readCodexAppServerClientDesktopGeneration(client)).toEqual(generation);
    expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
  });

  it("binds a package-first acquisition when its actual fallback is a desktop app", async () => {
    const generationX = { epoch: 1, fingerprint: "desktop-x" };
    const generationY = { epoch: 2, fingerprint: "desktop-y" };
    mocks.desktopGeneration = generationX;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
      ...startOptions,
      command: "/cache/openclaw/codex",
      commandSource: "resolved-managed" as const,
      managedFallbackCommandPaths: ["/Applications/Codex.app/Contents/Resources/codex"],
    }));
    const packageX = createClientHarness();
    const desktopX = createClientHarness();
    const packageY = createClientHarness();
    const desktopY = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(packageX.client)
      .mockResolvedValueOnce(desktopX.client)
      .mockResolvedValueOnce(packageY.client)
      .mockResolvedValueOnce(desktopY.client);
    const options = {
      config: {},
      agentDir: "/tmp/openclaw-agent",
      startOptions: {
        transport: "stdio" as const,
        homeScope: "agent" as const,
        command: "codex",
        commandSource: "managed" as const,
        managedCommandOrder: "package-first" as const,
        args: ["app-server"],
        headers: {},
      },
    };

    const firstAcquire = getLeasedSharedCodexAppServerClient(options);
    await sendInitializeResult(packageX, "openclaw/0.124.9 (macOS; test)");
    await sendInitializeResult(desktopX, "openclaw/0.149.0 (macOS; test)");
    const clientX = await firstAcquire;

    mocks.desktopGeneration = generationY;
    retireSharedCodexAppServerClientsBeforeDesktopGeneration(generationY);
    const replacementAcquire = getLeasedSharedCodexAppServerClient(options);
    await sendInitializeResult(packageY, "openclaw/0.124.9 (macOS; test)");
    await sendInitializeResult(desktopY, "openclaw/0.149.0 (macOS; test)");
    const clientY = await replacementAcquire;

    expect(clientX).toBe(desktopX.client);
    expect(clientY).toBe(desktopY.client);
    expect(
      mocks.reconcileCodexComputerUseStartArtifacts.mock.calls.map(
        ([params]) => params?.startOptions.command,
      ),
    ).toEqual([
      "/cache/openclaw/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      "/cache/openclaw/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
    ]);
    expect(desktopX.process.stdin.destroyed).toBe(false);
    expect(releaseLeasedSharedCodexAppServerClient(clientX)).toBe(true);
    expect(desktopX.process.stdin.destroyed).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(clientY)).toBe(true);
  });

  it("does not publish a desktop client superseded during initialization", async () => {
    const generationX = { epoch: 1, fingerprint: "desktop-x" };
    mocks.desktopGeneration = generationX;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
      ...startOptions,
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "resolved-managed" as const,
    }));
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
    const acquire = getLeasedSharedCodexAppServerClient({
      config: {},
      agentDir: "/tmp/openclaw-agent",
      startOptions: {
        transport: "stdio",
        homeScope: "agent",
        command: "codex",
        commandSource: "managed",
        managedCommandOrder: "desktop-first",
        args: ["app-server"],
        headers: {},
      },
    });
    await vi.waitFor(() => expect(harness.writes).toHaveLength(1));

    mocks.desktopGeneration = { epoch: 2, fingerprint: "desktop-y" };
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");

    const error = await acquire.catch((caught: unknown) => caught);
    expect(isCodexAppServerStartSelectionChangedError(error)).toBe(true);
    expect(mocks.applyCodexAppServerAuthProfile).not.toHaveBeenCalled();
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("globally disposes a gracefully detached client with an explicit retain", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);

    const lease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.149.0 (Linux; test)");
    const client = await lease;
    const releaseRetain = retainSharedCodexAppServerClientIfCurrent(client);
    expect(releaseRetain).toBeTypeOf("function");

    expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
    expect(retireSharedCodexAppServerClientIfCurrent(client)).toEqual({
      activeLeases: 1,
      closed: false,
    });
    expect(harness.process.stdin.destroyed).toBe(false);

    await clearSharedCodexAppServerClientAndWait({
      exitTimeoutMs: 25,
      forceKillDelayMs: 5,
    });
    expect(harness.process.stdin.destroyed).toBe(true);
    releaseRetain?.();
  });

  it("waits only for the shared client that is still current", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const firstCloseAndWait = vi.spyOn(first.client, "closeAndWait");
    const secondCloseAndWait = vi.spyOn(second.client, "closeAndWait");

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      agentDir: "/tmp/openclaw-agent-one",
    });
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      agentDir: "/tmp/openclaw-agent-two",
    });
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    await expect(
      clearSharedCodexAppServerClientIfCurrentAndWait(first.client, {
        exitTimeoutMs: 25,
        forceKillDelayMs: 5,
      }),
    ).resolves.toBe(true);

    expect(firstCloseAndWait).toHaveBeenCalledTimes(1);
    expect(secondCloseAndWait).not.toHaveBeenCalled();
    expect(first.process.stdin.destroyed).toBe(true);
    expect(second.process.stdin.destroyed).toBe(false);
  });

  it("uses a fresh websocket Authorization header after shared-client token rotation", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const authHeaders: Array<string | undefined> = [];
    server.on("connection", (socket, request) => {
      authHeaders.push(request.headers.authorization);
      socket.on("message", (data) => {
        const message = JSON.parse(rawDataToText(data)) as { id?: number; method?: string };
        if (message.method === "initialize") {
          socket.send(
            JSON.stringify({ id: message.id, result: { userAgent: "openclaw/0.149.0" } }),
          );
          return;
        }
        if (message.method === "model/list") {
          socket.send(JSON.stringify({ id: message.id, result: { data: [] } }));
        }
      });
    });

    try {
      await new Promise<void>((resolve) => {
        server.once("listening", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected websocket test server port");
      }
      const url = `ws://127.0.0.1:${address.port}`;

      await expect(
        listCodexAppServerModels({
          timeoutMs: 1000,
          startOptions: {
            transport: "websocket",
            command: "codex",
            args: [],
            url,
            authToken: "tok-first",
            headers: {},
          },
        }),
      ).resolves.toEqual({ models: [] });
      await expect(
        listCodexAppServerModels({
          timeoutMs: 1000,
          startOptions: {
            transport: "websocket",
            command: "codex",
            args: [],
            url,
            authToken: "tok-second",
            headers: {},
          },
        }),
      ).resolves.toEqual({ models: [] });

      expect(authHeaders).toEqual(["Bearer tok-first", "Bearer tok-second"]);
    } finally {
      clearSharedCodexAppServerClient();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
