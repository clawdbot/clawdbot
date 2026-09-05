import { describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import type { CodexAttemptRuntime } from "./run-attempt-runtime.js";
import { prepareCodexAttemptTools } from "./run-attempt-tool-setup.js";

function createRuntime(sandboxEnabled: boolean, nativeToolSurfaceEnabled: boolean) {
  const acquisitionError = new Error("native catalog client acquired");
  const clientFactory = vi.fn().mockRejectedValue(acquisitionError);
  const assertActive = vi.fn();
  const appServer = resolveCodexAppServerRuntimeOptions({ env: {}, requirementsToml: null });
  appServer.start.cwd = "/tmp/model-workspace";
  const runtime = {
    nativeToolSurfaceEnabled,
    runtimeParams: {},
    bundleMcpThreadConfig: { diagnostics: [], staticServerNames: [] },
    connection: {
      appServer,
      attemptClientFactory: clientFactory,
      assertCurrent: assertActive,
      params: { hostCapabilities: { assertActive } },
      preDynamicStartupStages: { snapshot: () => ({ totalMs: 0, stages: [] }) },
      mutable: {
        startupBinding: { threadId: "native-thread", connectionScope: "supervision" },
      },
      sandbox: { enabled: sandboxEnabled },
      pluginConfig: { supervision: { enabled: true } },
      runAbortController: new AbortController(),
      usesSupervisionConnection: true,
    },
  } as unknown as CodexAttemptRuntime;
  return { runtime, clientFactory, acquisitionError };
}

describe("sandboxed Codex native catalog startup", () => {
  it("rejects supervised native catalog acquisition before protected startup", async () => {
    const { runtime, clientFactory } = createRuntime(true, false);

    await expect(prepareCodexAttemptTools(runtime)).rejects.toThrow(
      "Sandboxed Codex sessions with native tools disabled cannot use a supervised native tool catalog",
    );
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it.each([
    [false, false],
    [false, true],
    [true, true],
  ])(
    "retains existing catalog acquisition with sandbox=%s and native tools=%s",
    async (sandboxEnabled, nativeToolSurfaceEnabled) => {
      const { runtime, clientFactory, acquisitionError } = createRuntime(
        sandboxEnabled,
        nativeToolSurfaceEnabled,
      );

      await expect(prepareCodexAttemptTools(runtime)).rejects.toBe(acquisitionError);
      expect(clientFactory).toHaveBeenCalledOnce();
      expect(clientFactory.mock.calls[0]?.[0].startOptions).toBe(
        runtime.connection.appServer.start,
      );
    },
  );
});
