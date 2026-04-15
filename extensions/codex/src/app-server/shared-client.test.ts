import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient, MIN_CODEX_APP_SERVER_VERSION } from "./client.js";
import { listCodexAppServerModels } from "./models.js";
import { resetSharedCodexAppServerClientForTests } from "./shared-client.js";
import { createClientHarness } from "./test-support.js";

describe("shared Codex app-server client", () => {
  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("closes the shared app-server when the version gate fails", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    // Model discovery uses the shared-client path, which owns child teardown
    // when initialize discovers an unsupported app-server.
    const listPromise = listCodexAppServerModels({ timeoutMs: 1000 });
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
});
