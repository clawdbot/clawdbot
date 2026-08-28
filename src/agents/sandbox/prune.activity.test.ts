import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import type { SandboxRegistryEntry } from "./registry.js";
import type { SandboxConfig } from "./types.js";

const configMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
}));

const registryMocks = vi.hoisted(() => ({
  readBrowserRegistry: vi.fn(async () => ({ entries: [] })),
  readRegistry: vi.fn(),
  removeBrowserRegistryEntry: vi.fn(),
  removeRegistryEntry: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: configMocks.getRuntimeConfig,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: vi.fn() },
}));

vi.mock("./registry.js", () => ({
  readBrowserRegistry: registryMocks.readBrowserRegistry,
  readRegistry: registryMocks.readRegistry,
  removeBrowserRegistryEntryIfUnchanged: registryMocks.removeBrowserRegistryEntry,
  removeRegistryEntryIfUnchanged: registryMocks.removeRegistryEntry,
}));

vi.mock("./browser-bridges.js", () => ({
  stopCachedBrowserBridgesForContainer: vi.fn(),
}));

function buildPruneConfig(): SandboxConfig {
  return {
    mode: "all",
    backend: "test-runtime-activity",
    scope: "session",
    workspaceAccess: "none",
    workspaceRoot: "/tmp/openclaw-sandboxes",
    dockerTmpfsSource: "configured",
    docker: {
      image: "test-image",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: [],
      network: "none",
      capDrop: ["ALL"],
      env: {},
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: false,
      image: "test-browser-image",
      containerPrefix: "openclaw-sbx-browser-",
      network: "none",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: true,
      noVncEnabled: false,
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 1_000,
    },
    tools: { allow: [], deny: [] },
    prune: { idleHours: 24, maxAgeDays: 7 },
  };
}

describe("sandbox prune activity coordination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drains an active old runtime and revalidates it before removal", async () => {
    const now = Date.now();
    const cfg = buildPruneConfig();
    let currentEntry: SandboxRegistryEntry = {
      containerName: "active-old-runtime",
      backendId: "test-runtime-activity",
      sessionKey: "agent:main:main",
      createdAtMs: now - 8 * 24 * 60 * 60 * 1000,
      lastUsedAtMs: now,
      image: "test-image",
      registryGeneration: 1,
    };
    registryMocks.readRegistry.mockImplementation(async () => ({ entries: [currentEntry] }));
    configMocks.getRuntimeConfig.mockReturnValue({
      agents: { defaults: { sandbox: { prune: cfg.prune } } },
    });

    const removeRuntime = vi.fn(async () => {});
    const rawHandle: SandboxBackendHandle = {
      id: "test-runtime-activity",
      runtimeId: currentEntry.containerName,
      runtimeLabel: currentEntry.containerName,
      workdir: "/workspace",
      async buildExecSpec() {
        return { argv: ["true"], env: {}, stdinMode: "pipe-closed", finalizeToken: "exec" };
      },
      async finalizeExec() {},
      async runShellCommand() {
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
      },
    };
    const { getSandboxBackendFactory, registerSandboxBackend } = await import("./backend.js");
    const { coordinateSandboxBackendHandle } = await import("./runtime-activity.js");
    const restore = registerSandboxBackend("test-runtime-activity", {
      factory: async () => rawHandle,
      manager: {
        describeRuntime: async () => ({ running: true, configLabelMatch: true }),
        removeRuntime,
      },
    });

    try {
      const factory = getSandboxBackendFactory("test-runtime-activity");
      if (!factory) {
        throw new Error("test backend was not registered");
      }
      const backend = coordinateSandboxBackendHandle(
        await factory({
          sessionKey: currentEntry.sessionKey,
          scopeKey: currentEntry.sessionKey,
          workspaceDir: "/workspace",
          agentWorkspaceDir: "/workspace",
          cfg,
        }),
      );
      const exec = await backend.buildExecSpec({
        command: "sleep 60",
        env: {},
        usePty: false,
      });

      const { maybePruneSandboxes } = await import("./prune.js");
      const pruning = maybePruneSandboxes(cfg);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(removeRuntime).not.toHaveBeenCalled();

      currentEntry = { ...currentEntry, lastUsedAtMs: now + 1, registryGeneration: 2 };
      await backend.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: exec.finalizeToken,
      });
      await pruning;

      expect(removeRuntime).not.toHaveBeenCalled();
      expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();

      currentEntry = { ...currentEntry, registryGeneration: 3 };
      const nextExec = await backend.buildExecSpec({ command: "true", env: {}, usePty: false });
      await backend.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: nextExec.finalizeToken,
      });
      vi.resetModules();
      const freshPrune = await import("./prune.js");
      await freshPrune.maybePruneSandboxes(cfg);

      expect(removeRuntime).toHaveBeenCalledOnce();
      expect(registryMocks.removeRegistryEntry).toHaveBeenCalledWith(currentEntry);
    } finally {
      restore();
    }
  });
});
