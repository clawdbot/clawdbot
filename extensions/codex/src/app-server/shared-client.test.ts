import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type RawData } from "ws";
import { CodexAppServerClient, MIN_CODEX_APP_SERVER_VERSION } from "./client.js";
import { createClientHarness } from "./test-support.js";

const mocks = vi.hoisted(() => ({
  bridgeCodexAppServerStartOptions: vi.fn(async ({ startOptions }) => startOptions),
  applyCodexAppServerAuthProfile: vi.fn(async () => undefined),
  resolveManagedCodexAppServerStartOptions: vi.fn(async (startOptions) => startOptions),
  embeddedAgentLog: { debug: vi.fn(), warn: vi.fn() },
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
}));

vi.mock("./auth-bridge.js", () => ({
  applyCodexAppServerAuthProfile: mocks.applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions: mocks.bridgeCodexAppServerStartOptions,
}));

vi.mock("./managed-binary.js", () => ({
  resolveManagedCodexAppServerStartOptions: mocks.resolveManagedCodexAppServerStartOptions,
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  embeddedAgentLog: mocks.embeddedAgentLog,
  OPENCLAW_VERSION: "test",
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveOpenClawAgentDir: mocks.resolveOpenClawAgentDir,
}));

let listCodexAppServerModels: typeof import("./models.js").listCodexAppServerModels;
let clearSharedCodexAppServerClient: typeof import("./shared-client.js").clearSharedCodexAppServerClient;
let clearSharedCodexAppServerClientIfCurrent: typeof import("./shared-client.js").clearSharedCodexAppServerClientIfCurrent;
let createIsolatedCodexAppServerClient: typeof import("./shared-client.js").createIsolatedCodexAppServerClient;
let resetSharedCodexAppServerClientForTests: typeof import("./shared-client.js").resetSharedCodexAppServerClientForTests;

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

describe("shared Codex app-server client", () => {
  beforeAll(async () => {
    ({ listCodexAppServerModels } = await import("./models.js"));
    ({
      clearSharedCodexAppServerClient,
      clearSharedCodexAppServerClientIfCurrent,
      createIsolatedCodexAppServerClient,
      resetSharedCodexAppServerClientForTests,
    } = await import("./shared-client.js"));
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
    mocks.bridgeCodexAppServerStartOptions.mockClear();
    mocks.applyCodexAppServerAuthProfile.mockClear();
    mocks.resolveManagedCodexAppServerStartOptions.mockClear();
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(
      async (startOptions) => startOptions,
    );
    mocks.embeddedAgentLog.debug.mockClear();
    mocks.embeddedAgentLog.warn.mockClear();
    mocks.resolveOpenClawAgentDir.mockClear();
  });

  it("closes the shared app-server when the version gate fails", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    // Model discovery uses the shared-client path, which owns child teardown
    // when initialize discovers an unsupported app-server.
    const listPromise = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.117.9 (macOS; test)");

    await expect(listPromise).rejects.toThrow(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required`,
    );
    expect(harness.process.kill).toHaveBeenCalledTimes(1);
    startSpy.mockRestore();
  });

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
    expect(first.process.kill).toHaveBeenCalledTimes(1);

    const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);

    await expect(secondList).resolves.toEqual({ models: [] });
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it("does not wait for isolated initialize after a timeout closes the client", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    await expect(createIsolatedCodexAppServerClient({ timeoutMs: 5 })).rejects.toThrow(
      "codex app-server initialize timed out",
    );
    expect(harness.process.kill).toHaveBeenCalledTimes(1);
  });

  it("passes the selected auth profile through the bridge helper", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const listPromise = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: "openai-codex:work",
    });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(harness);

    await expect(listPromise).resolves.toEqual({ models: [] });
    expect(mocks.bridgeCodexAppServerStartOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "openai-codex:work",
      }),
    );
    expect(mocks.applyCodexAppServerAuthProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "openai-codex:work",
      }),
    );
  });

  it("uses the selected agent dir for shared app-server auth bridging", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const listPromise = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: "openai-codex:work",
      agentDir: "/tmp/openclaw-agent-nova",
    });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(harness);

    await expect(listPromise).resolves.toEqual({ models: [] });
    expect(mocks.bridgeCodexAppServerStartOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/openclaw-agent-nova",
        authProfileId: "openai-codex:work",
      }),
    );
    expect(mocks.applyCodexAppServerAuthProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/openclaw-agent-nova",
        authProfileId: "openai-codex:work",
      }),
    );
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
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(harness);

    await expect(listPromise).resolves.toEqual({ models: [] });
    expect(mocks.resolveManagedCodexAppServerStartOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "codex",
        commandSource: "managed",
      }),
    );
    expect(mocks.bridgeCodexAppServerStartOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        startOptions: expect.objectContaining({
          command: "/cache/openclaw/codex",
          commandSource: "resolved-managed",
        }),
      }),
    );
    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/cache/openclaw/codex",
        commandSource: "resolved-managed",
      }),
    );
  });

  it("restarts the shared client when the bridged auth token changes", async () => {
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
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
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
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(first.process.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not let a superseded shared-client failure tear down the newer client", async () => {
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

    await expect(firstFailure).resolves.toBeInstanceOf(Error);

    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(second.process.kill).not.toHaveBeenCalled();
  });

  it("only clears the shared client that is still current", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    const firstList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    expect(clearSharedCodexAppServerClientIfCurrent(first.client)).toBe(true);
    expect(first.process.kill).toHaveBeenCalledWith("SIGTERM");

    const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(clearSharedCodexAppServerClientIfCurrent(first.client)).toBe(false);
    expect(second.process.kill).not.toHaveBeenCalled();
    expect(clearSharedCodexAppServerClientIfCurrent(second.client)).toBe(true);
    expect(second.process.kill).toHaveBeenCalledWith("SIGTERM");
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
            JSON.stringify({ id: message.id, result: { userAgent: "openclaw/0.125.0" } }),
          );
          return;
        }
        if (message.method === "model/list") {
          socket.send(JSON.stringify({ id: message.id, result: { data: [] } }));
        }
      });
    });

    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
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
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
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
