import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient, MIN_CODEX_APP_SERVER_VERSION } from "./client.js";
import { createClientHarness } from "./test-support.js";

const mocks = vi.hoisted(() => ({
  bridgeCodexAppServerStartOptions: vi.fn(async ({ startOptions }) => startOptions),
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
}));

vi.mock("./auth-bridge.js", () => ({
  bridgeCodexAppServerStartOptions: mocks.bridgeCodexAppServerStartOptions,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveOpenClawAgentDir: mocks.resolveOpenClawAgentDir,
}));

let listCodexAppServerModels: typeof import("./models.js").listCodexAppServerModels;
let resetSharedCodexAppServerClientForTests: typeof import("./shared-client.js").resetSharedCodexAppServerClientForTests;

describe("shared Codex app-server client", () => {
  beforeAll(async () => {
    ({ listCodexAppServerModels } = await import("./models.js"));
    ({ resetSharedCodexAppServerClientForTests } = await import("./shared-client.js"));
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
    mocks.bridgeCodexAppServerStartOptions.mockClear();
    mocks.resolveOpenClawAgentDir.mockClear();
  });

  it("closes the shared app-server when the version gate fails", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    // Model discovery uses the shared-client path, which owns child teardown
    // when initialize discovers an unsupported app-server.
    const listPromise = listCodexAppServerModels({ timeoutMs: 1000 });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));
    const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: initialize.id,
      result: { userAgent: "openclaw/0.117.9 (macOS; test)" },
    });

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
    await vi.waitFor(() => expect(second.writes.length).toBeGreaterThanOrEqual(1));
    const initialize = JSON.parse(second.writes[0] ?? "{}") as { id?: number };
    second.send({
      id: initialize.id,
      result: { userAgent: "openclaw/0.118.0 (macOS; test)" },
    });
    await vi.waitFor(() => expect(second.writes.length).toBeGreaterThanOrEqual(3));
    const modelList = JSON.parse(second.writes[2] ?? "{}") as { id?: number };
    second.send({ id: modelList.id, result: { data: [] } });

    await expect(secondList).resolves.toEqual({ models: [] });
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it("passes the selected auth profile through the bridge helper", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const listPromise = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: "openai-codex:work",
    });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));
    const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: initialize.id,
      result: { userAgent: "openclaw/0.118.0 (macOS; test)" },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(3));
    const modelList = JSON.parse(harness.writes[2] ?? "{}") as { id?: number };
    harness.send({ id: modelList.id, result: { data: [] } });

    await expect(listPromise).resolves.toEqual({ models: [] });
    expect(mocks.bridgeCodexAppServerStartOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "openai-codex:work",
      }),
    );
  });
});
