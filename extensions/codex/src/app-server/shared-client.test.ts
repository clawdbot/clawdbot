// Codex tests cover shared client plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type RawData } from "ws";
import { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import { acquireCodexNativeConfigFence } from "./native-config-fence.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { createClientHarness } from "./test-support.js";

const mocks = vi.hoisted(() => ({
  bridgeCodexAppServerStartOptions: vi.fn(async ({ startOptions }) => startOptions),
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
  embeddedAgentLog: { debug: vi.fn(), warn: vi.fn() },
  resolveDefaultAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
}));

vi.mock("./auth-bridge.js", () => ({
  applyCodexAppServerAuthProfile: mocks.applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions: mocks.bridgeCodexAppServerStartOptions,
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

vi.mock("./managed-binary.js", () => ({
  resolveManagedCodexAppServerStartOptions: mocks.resolveManagedCodexAppServerStartOptions,
  resolveManagedCodexNativeCommand: mocks.resolveManagedCodexNativeCommand,
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  embeddedAgentLog: mocks.embeddedAgentLog,
  formatErrorMessage: (error: unknown) => String(error),
  OPENCLAW_VERSION: "test",
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveDefaultAgentDir: mocks.resolveDefaultAgentDir,
}));

import {
  assertCodexAppServerClientStartSelectionCurrent,
  detachSharedCodexAppServerClientIfCurrent,
  getSharedCodexAppServerClient,
  readCodexAppServerClientProcessIdentity,
} from "./shared-client.js";

let listCodexAppServerModels: typeof import("./models.js").listCodexAppServerModels;
let clearSharedCodexAppServerClient: typeof import("./shared-client.js").clearSharedCodexAppServerClient;
let clearSharedCodexAppServerClientIfCurrent: typeof import("./shared-client.js").clearSharedCodexAppServerClientIfCurrent;
let clearSharedCodexAppServerClientIfCurrentAndUnclaimed: typeof import("./shared-client.js").clearSharedCodexAppServerClientIfCurrentAndUnclaimed;
let clearSharedCodexAppServerClientIfCurrentAndWait: typeof import("./shared-client.js").clearSharedCodexAppServerClientIfCurrentAndWait;
let createIsolatedCodexAppServerClient: typeof import("./shared-client.js").createIsolatedCodexAppServerClient;
let getLeasedSharedCodexAppServerClient: typeof import("./shared-client.js").getLeasedSharedCodexAppServerClient;
let isCodexAppServerStartSelectionChangedError: typeof import("./shared-client.js").isCodexAppServerStartSelectionChangedError;
let retainSharedCodexAppServerClientIfCurrent: typeof import("./shared-client.js").retainSharedCodexAppServerClientIfCurrent;
let releaseLeasedSharedCodexAppServerClient: typeof import("./shared-client.js").releaseLeasedSharedCodexAppServerClient;
let releaseCodexAppServerClientLease: typeof import("./shared-client.js").releaseCodexAppServerClientLease;
let resolveCodexNativeConfigFenceKey: typeof import("./shared-client.js").resolveCodexNativeConfigFenceKey;
let resolveCodexAppServerSpawnIdentity: typeof import("./shared-client.js").resolveCodexAppServerSpawnIdentity;
let retireSharedCodexAppServerClientIfCurrent: typeof import("./shared-client.js").retireSharedCodexAppServerClientIfCurrent;
let resetSharedCodexAppServerClientForTests: typeof import("./shared-client.js").resetSharedCodexAppServerClientForTests;
let withLeasedCodexAppServerClientStartSelectionRetry: typeof import("./shared-client.js").withLeasedCodexAppServerClientStartSelectionRetry;

async function sendInitializeResult(
  harness: ReturnType<typeof createClientHarness>,
  userAgent: string,
): Promise<void> {
  await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));
  const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
  harness.send({ id: initialize.id, result: { userAgent } });
}

async function sendEmptyModelList(harness: ReturnType<typeof createClientHarness>): Promise<void> {
  await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(3));
  const modelList = JSON.parse(harness.writes[2] ?? "{}") as { id?: number };
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

describe("shared Codex app-server client", () => {
  beforeAll(async () => {
    ({ listCodexAppServerModels } = await import("./models.js"));
    ({
      clearSharedCodexAppServerClient,
      clearSharedCodexAppServerClientIfCurrent,
      clearSharedCodexAppServerClientIfCurrentAndUnclaimed,
      clearSharedCodexAppServerClientIfCurrentAndWait,
      createIsolatedCodexAppServerClient,
      getLeasedSharedCodexAppServerClient,
      isCodexAppServerStartSelectionChangedError,
      retainSharedCodexAppServerClientIfCurrent,
      releaseLeasedSharedCodexAppServerClient,
      releaseCodexAppServerClientLease,
      resolveCodexNativeConfigFenceKey,
      resolveCodexAppServerSpawnIdentity,
      retireSharedCodexAppServerClientIfCurrent,
      resetSharedCodexAppServerClientForTests,
      withLeasedCodexAppServerClientStartSelectionRetry,
    } = await import("./shared-client.js"));
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
    mocks.bridgeCodexAppServerStartOptions.mockClear();
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
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    // Model discovery uses the shared-client path, which owns child teardown
    // when initialize discovers an unsupported app-server.
    const listPromise = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.117.9 (macOS; test)");

    await expect(listPromise).rejects.toThrow(
      "A stable Codex app-server from 0.143.0 through 0.144.5 is required",
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
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
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

    await sendInitializeResult(harness, "openclaw/0.143.0 (Linux; test)");
    await expect(second).resolves.toBe(harness.client);
    expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);
  });

  it("does not consume a co-lease when selection replacement acquisition fails", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
    const options = { timeoutMs: 1_000 };
    const firstLease = getLeasedSharedCodexAppServerClient(options);
    await sendInitializeResult(harness, "openclaw/0.143.0 (Linux; test)");
    const client = await firstLease;
    await expect(getLeasedSharedCodexAppServerClient(options)).resolves.toBe(client);
    const ownedLease = { client };
    mocks.resolveManagedCodexAppServerStartOptions.mockRejectedValueOnce(
      new Error("replacement acquisition failed"),
    );

    await expect(
      withLeasedCodexAppServerClientStartSelectionRetry({
        lease: ownedLease,
        options,
        run: async () => {
          throw Object.assign(new Error("selection changed"), {
            code: "CODEX_APP_SERVER_START_SELECTION_CHANGED",
          });
        },
        onClientChange: () => undefined,
      }),
    ).rejects.toThrow("replacement acquisition failed");

    expect(ownedLease.client).toBeUndefined();
    expect(releaseCodexAppServerClientLease(ownedLease)).toBe(false);
    expect(harness.stdinDestroyed).toBe(false);
    expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
    await vi.waitFor(() => expect(harness.stdinDestroyed).toBe(true));
  });

  it("falls back to the next managed app-server when desktop initialize is unsupported", async () => {
    const desktop = createClientHarness();
    const pluginLocal = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(desktop.client)
      .mockReturnValueOnce(pluginLocal.client);
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementationOnce(async (startOptions) => ({
      ...startOptions,
      command: "/Applications/Codex.app/Contents/Resources/codex",
      commandSource: "resolved-managed",
      managedFallbackCommandPaths: ["/cache/openclaw/codex"],
    }));

    const listPromise = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(desktop, "openclaw/0.124.9 (macOS; test)");
    await sendInitializeResult(pluginLocal, "openclaw/0.143.0 (macOS; test)");
    await sendEmptyModelList(pluginLocal);

    await expect(listPromise).resolves.toEqual({ models: [] });
    expect(desktop.process.stdin.destroyed).toBe(true);
    expect(pluginLocal.process.stdin.destroyed).toBe(false);
    expect(startSpy).toHaveBeenCalledTimes(2);
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
  });

  it("keeps capture clients separate from ordinary shared clients", async () => {
    await withTempDir("openclaw-codex-capture-client-", async (root) => {
      const command = path.join(root, "codex");
      await fs.writeFile(command, "native-v1");
      const normal = createClientHarness();
      const captured = createClientHarness();
      const startSpy = vi
        .spyOn(CodexAppServerClient, "start")
        .mockReturnValueOnce(normal.client)
        .mockReturnValueOnce(captured.client);
      const startOptions: CodexAppServerStartOptions = {
        transport: "stdio",
        command,
        commandSource: "config",
        args: ["app-server"],
        headers: {},
      };

      const normalPromise = getLeasedSharedCodexAppServerClient({ startOptions });
      await sendInitializeResult(normal, "openclaw/0.143.0 (Linux; test)");
      const normalClient = await normalPromise;
      const capturedPromise = getLeasedSharedCodexAppServerClient({
        startOptions,
        runtimeArtifactMode: "capture",
      });
      await sendInitializeResult(captured, "openclaw/0.143.0 (Linux; test)");
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
        .mockReturnValueOnce(desktop.client)
        .mockReturnValueOnce(fallback.client);
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
      await sendInitializeResult(fallback, "openclaw/0.143.0 (macOS; test)");
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
      vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
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
      await sendInitializeResult(harness, "openclaw/0.143.0 (macOS; test)");
      const client = await clientPromise;

      expect(readCodexAppServerClientProcessIdentity(client)).toEqual({
        clientId: expect.any(String),
        command: "/cache/openclaw/codex",
        argsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        commandSource: "resolved-managed",
        nativeCommand: "/cache/openclaw/codex.native",
        serverVersion: "0.143.0",
        userAgent: "openclaw/0.143.0 (macOS; test)",
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

  it.each(["abort", "timeout"] as const)(
    "holds the native config fence through process exit after a post-write %s",
    async (mode) => {
      await withTempDir("openclaw-codex-guarded-request-cancel-", async (root) => {
        const harness = createClientHarness();
        vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
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
        await sendInitializeResult(harness, "openclaw/0.143.0 (macOS; test)");
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
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    await expect(listCodexAppServerModels({ timeoutMs: 5 })).rejects.toThrow(
      "codex app-server initialize timed out",
    );
    expect(first.process.stdin.destroyed).toBe(true);

    const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.143.0 (macOS; test)");
    await sendEmptyModelList(second);

    await expect(secondList).resolves.toEqual({ models: [] });
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps shared startup alive for a caller with a longer initialize timeout", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const shortAcquire = getSharedCodexAppServerClient({ timeoutMs: 5 });
    const longAcquire = getSharedCodexAppServerClient({ timeoutMs: 1000 });

    await expect(shortAcquire).rejects.toThrow("codex app-server initialize timed out");
    expect(harness.process.stdin.destroyed).toBe(false);

    await sendInitializeResult(harness, "openclaw/0.143.0 (macOS; test)");

    await expect(longAcquire).resolves.toBe(harness.client);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(harness.process.stdin.destroyed).toBe(false);
  });

  it("reports a stalled shared auth phase separately from initialize", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
    const releaseAuth = deferNextAuthProfileApplication();

    const acquire = getSharedCodexAppServerClient({ timeoutMs: 100 });
    await sendInitializeResult(harness, "openclaw/0.143.0 (macOS; test)");

    await expect(acquire).rejects.toThrow("codex app-server authentication timed out");
    expect(harness.process.stdin.destroyed).toBe(true);
    releaseAuth();
  });

  it("keeps shared auth alive for a caller with a longer timeout", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
    const releaseAuth = deferNextAuthProfileApplication();

    const shortAcquire = getSharedCodexAppServerClient({ timeoutMs: 100 });
    const longAcquire = getSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.143.0 (macOS; test)");

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
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

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

    await sendInitializeResult(harness, "openclaw/0.143.0 (macOS; test)");

    await abandonedRejection;
    await expect(activeAcquire).resolves.toBe(harness.client);
    expect(harness.process.stdin.destroyed).toBe(false);
  });

  it("does not wait for isolated initialize after a timeout closes the client", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    await expect(createIsolatedCodexAppServerClient({ timeoutMs: 5 })).rejects.toThrow(
      "codex app-server initialize timed out",
    );
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("includes isolated auth application in the total startup deadline", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
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
    await sendInitializeResult(harness, "openclaw/0.143.0 (macOS; test)");

    await rejection;
    expect(harness.process.stdin.destroyed).toBe(true);
    finishAuth();
  });

  it("does not start isolated auth after the total startup deadline elapsed", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const clientPromise = createIsolatedCodexAppServerClient({ timeoutMs: 100 });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));
    now = 101;
    await sendInitializeResult(harness, "openclaw/0.143.0 (macOS; test)");

    await expect(clientPromise).rejects.toThrow("codex app-server initialize timed out");
    expect(mocks.applyCodexAppServerAuthProfile).not.toHaveBeenCalled();
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("passes the selected auth profile through the bridge helper", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const listPromise = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: "openai:work",
    });
    await sendInitializeResult(harness, "openclaw/0.143.0 (macOS; test)");
    await sendEmptyModelList(harness);

    await expect(listPromise).resolves.toEqual({ models: [] });
    const bridgeCall = bridgeStartOptionsCall();
    expect(bridgeCall?.authProfileId).toBe("openai:work");
    const applyCall = applyAuthProfileCall();
    expect(applyCall?.authProfileId).toBe("openai:work");
  });

  it("carries a scoped auth store through isolated app-server startup", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
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
    await sendInitializeResult(harness, "openclaw/0.143.0 (macOS; test)");

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
      config: undefined,
    });
    expect(JSON.parse(harness.writes.at(-1) ?? "{}")).toEqual({
      id: "refresh-1",
      result: {
        accessToken: "refreshed-access",
        chatgptAccountId: "refreshed-account",
        chatgptPlanType: null,
      },
    });
  });

  it("keeps a shared prepared auth store authoritative through startup and refresh", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
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
    await sendInitializeResult(harness, "openclaw/0.143.0 (macOS; test)");

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
      config: undefined,
    });
  });

  it("separates prepared profile clients by secret-free account identity", async () => {
    const firstHarness = createClientHarness();
    const secondHarness = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(firstHarness.client)
      .mockReturnValueOnce(secondHarness.client);
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
      preparedAuth: { kind: "profile", profileId: "openai:scoped", store: firstStore },
    });
    await sendInitializeResult(firstHarness, "openclaw/0.143.0 (macOS; test)");
    await expect(firstPromise).resolves.toBe(firstHarness.client);

    const secondPromise = getSharedCodexAppServerClient({
      timeoutMs: 1000,
      preparedAuth: { kind: "profile", profileId: "openai:scoped", store: secondStore },
    });
    await vi.waitFor(() => expect(startSpy).toHaveBeenCalledTimes(2));
    await sendInitializeResult(secondHarness, "openclaw/0.143.0 (macOS; test)");
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
  });

  it("starts a prepared API-key client without profile or ambient-store resolution", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const clientPromise = getSharedCodexAppServerClient({
      timeoutMs: 1000,
      preparedAuth: { kind: "api-key", apiKey: "platform-key" },
    });
    await sendInitializeResult(harness, "openclaw/0.143.0 (macOS; test)");

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
      .mockReturnValueOnce(firstHarness.client)
      .mockReturnValueOnce(secondHarness.client);
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
    await sendInitializeResult(firstHarness, "openclaw/0.143.0 (macOS; test)");
    await expect(firstPromise).resolves.toBe(firstHarness.client);

    const secondPromise = getSharedCodexAppServerClient({
      timeoutMs: 1000,
      preparedAuth: { kind: "api-key", apiKey: "second-platform-key" },
    });
    await vi.waitFor(() => expect(startSpy).toHaveBeenCalledTimes(2));
    await sendInitializeResult(secondHarness, "openclaw/0.143.0 (macOS; test)");
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
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const clientPromise = createIsolatedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileId: "openai:persisted",
      agentDir: "/tmp/openclaw-persisted-agent",
    });
    await sendInitializeResult(harness, "openclaw/0.143.0 (macOS; test)");

    await expect(clientPromise).resolves.toBe(harness.client);
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
      config: undefined,
    });
    expect(JSON.parse(harness.writes.at(-1) ?? "{}")).toEqual({
      id: "refresh-persisted",
      result: {
        accessToken: "refreshed-access",
        chatgptAccountId: "refreshed-account",
        chatgptPlanType: null,
      },
    });
  });

  it("skips target auth resolution when native source auth is requested", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
    const config = { auth: { order: { openai: ["openai:target"] } } };

    const clientPromise = getSharedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileId: null,
      agentDir: "/tmp/openclaw-target-agent",
      config,
    });
    await sendInitializeResult(harness, "openclaw/0.143.0 (macOS; test)");

    await expect(clientPromise).resolves.toBe(harness.client);
    expect(mocks.resolveCodexAppServerAuthProfileIdForAgent).not.toHaveBeenCalled();
    const bridgeCall = bridgeStartOptionsCall();
    expect(bridgeCall.agentDir).toBe("/tmp/openclaw-target-agent");
    expect(bridgeCall.authProfileId).toBeNull();
    expect(bridgeCall.config).toBe(config);
    const applyCall = applyAuthProfileCall();
    expect(applyCall.agentDir).toBe("/tmp/openclaw-target-agent");
    expect(applyCall.authProfileId).toBeNull();
    expect(applyCall.config).toBe(config);
  });

  it("uses native auth automatically for shared user-home clients", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

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
    await sendInitializeResult(harness, "openclaw/0.143.0 (macOS; test)");

    await expect(clientPromise).resolves.toBe(harness.client);
    expect(mocks.resolveCodexAppServerAuthProfileIdForAgent).not.toHaveBeenCalled();
    expect(bridgeStartOptionsCall().authProfileId).toBeNull();
    expect(applyAuthProfileCall().authProfileId).toBeNull();
  });

  it("resolves the configured implicit auth profile before sharing a client", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
    const config = { auth: { order: { openai: ["openai:work"] } } };
    mocks.resolveCodexAppServerAuthProfileIdForAgent.mockReturnValue("openai:work");

    const listPromise = listCodexAppServerModels({
      timeoutMs: 1000,
      config,
    });
    await sendInitializeResult(harness, "openclaw/0.143.0 (macOS; test)");
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
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const listPromise = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: "openai:work",
      agentDir: "/tmp/openclaw-agent-nova",
    });
    await sendInitializeResult(harness, "openclaw/0.143.0 (macOS; test)");
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
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      agentDir: "/tmp/openclaw-agent-one",
    });
    await sendInitializeResult(first, "openclaw/0.143.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      agentDir: "/tmp/openclaw-agent-two",
    });
    await sendInitializeResult(second, "openclaw/0.143.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(first.process.stdin.destroyed).toBe(false);
    expect(second.process.stdin.destroyed).toBe(false);
  });

  it("resolves the managed binary before bridging and spawning the shared client", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementationOnce(async (startOptions) => ({
      ...startOptions,
      command: "/cache/openclaw/codex",
      commandSource: "resolved-managed",
    }));

    const listPromise = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.143.0 (macOS; test)");
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
      vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

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
      await sendInitializeResult(harness, "openclaw/0.144.1 (macOS; test)");

      await expect(clientPromise).resolves.toBe(harness.client);
      expect(managedStartOptionsCall().managedCommandOrder).toBe("desktop-first");
    });
  });

  it("starts an independent shared client when the bridged auth token changes", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

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
    await sendInitializeResult(first, "openclaw/0.143.0 (macOS; test)");
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
    await sendInitializeResult(second, "openclaw/0.143.0 (macOS; test)");
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
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);
    mocks.resolveCodexAppServerFallbackApiKeyCacheKey
      .mockReturnValueOnce("api-key:first")
      .mockReturnValueOnce("api-key:second");

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      authRequirement: "api-key",
    });
    await sendInitializeResult(first, "openclaw/0.143.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      authRequirement: "api-key",
    });
    await sendInitializeResult(second, "openclaw/0.143.0 (macOS; test)");
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
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: "openai:work",
      authRequirement: "api-key",
    });
    await sendInitializeResult(first, "openclaw/0.143.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: "openai:work",
      authRequirement: "subscription",
    });
    await sendInitializeResult(second, "openclaw/0.143.0 (macOS; test)");
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
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

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

    await sendInitializeResult(second, "openclaw/0.143.0 (macOS; test)");
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
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    const firstList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.143.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    expect(clearSharedCodexAppServerClientIfCurrent(first.client)).toBe(true);
    expect(first.process.stdin.destroyed).toBe(true);

    const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.143.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(clearSharedCodexAppServerClientIfCurrent(first.client)).toBe(false);
    expect(second.process.kill).not.toHaveBeenCalled();
    expect(clearSharedCodexAppServerClientIfCurrent(second.client)).toBe(true);
    expect(second.process.stdin.destroyed).toBe(true);
  });

  it("can detach the current shared client without closing it", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    const firstList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.143.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    expect(detachSharedCodexAppServerClientIfCurrent(first.client)).toBe(true);
    expect(first.process.stdin.destroyed).toBe(false);

    const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.143.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(detachSharedCodexAppServerClientIfCurrent(first.client)).toBe(false);
    first.client.close();
    expect(first.process.stdin.destroyed).toBe(true);
    expect(second.process.kill).not.toHaveBeenCalled();
    expect(detachSharedCodexAppServerClientIfCurrent(second.client)).toBe(true);
    second.client.close();
    expect(second.process.stdin.destroyed).toBe(true);
  });

  it("closes a retired shared app-server and forces active leases onto the retryable close path", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    const firstList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.143.0 (macOS; test)");
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
    await sendInitializeResult(second, "openclaw/0.143.0 (macOS; test)");
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
    vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(harness.client);

    const clientPromise = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.143.0 (Linux; test)");
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
    vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(first.client);

    const firstLease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    const secondLease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.143.0 (macOS; test)");
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
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(replacement.client);

    const completedRunLease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    const siblingRunLease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.143.0 (macOS; test)");
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
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

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
    await sendInitializeResult(second, "openclaw/0.143.0 (macOS; test)");
    await expect(freshLease).resolves.toBe(second.client);
    expect(second.process.stdin.destroyed).toBe(false);
  });

  it("suspect retirement closes a client that was already gracefully detached", async () => {
    const first = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(first.client);

    const lease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.143.0 (macOS; test)");
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
    vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(first.client);

    const lease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.143.0 (macOS; test)");
    await expect(lease).resolves.toBe(first.client);

    // Routine cleanup (e.g. one-shot bundle-MCP) must not yank a healthy
    // client from co-leased sessions; only suspect retirement does.
    expect(retireSharedCodexAppServerClientIfCurrent(first.client)).toEqual({
      activeLeases: 1,
      closed: false,
    });
    expect(first.process.stdin.destroyed).toBe(false);

    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    expect(first.process.stdin.destroyed).toBe(true);
  });

  it("waits only for the shared client that is still current", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);
    const firstCloseAndWait = vi.spyOn(first.client, "closeAndWait");
    const secondCloseAndWait = vi.spyOn(second.client, "closeAndWait");

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      agentDir: "/tmp/openclaw-agent-one",
    });
    await sendInitializeResult(first, "openclaw/0.143.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      agentDir: "/tmp/openclaw-agent-two",
    });
    await sendInitializeResult(second, "openclaw/0.143.0 (macOS; test)");
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
            JSON.stringify({ id: message.id, result: { userAgent: "openclaw/0.143.0" } }),
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
