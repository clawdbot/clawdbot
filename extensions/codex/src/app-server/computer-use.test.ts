import fs from "node:fs";
import path from "node:path";
// Codex tests cover computer use plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerRuntimeOptions, resolveCodexComputerUseConfig } from "./config.js";
import { acquireCodexNativeConfigFence } from "./native-config-fence.js";
import { resolveCodexNativeConfigFenceKey } from "./shared-client.js";
import { createClientHarness, useAutoCleanupTempDirTracker } from "./test-support.js";

const requestCodexAppServerJsonMock = vi.hoisted(() => vi.fn());
const sharedClientMocks = vi.hoisted(() => ({
  assertCodexAppServerClientStartSelectionCurrent: vi.fn(),
  getLeasedSharedCodexAppServerClient: vi.fn(),
  readCodexAppServerClientDesktopGeneration: vi.fn(),
  readCodexAppServerClientProcessIdentity: vi.fn(),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  waitForCodexAppServerClientDesktopGenerationDrain: vi.fn(),
}));
const managedProvisioningMocks = vi.hoisted(() => ({
  ensureCodexComputerUseSharedPluginCache: vi.fn(async () => ({
    status: "independent" as const,
    changed: false,
    message: "independent",
    removedStaleVersions: [],
    warnings: [],
  })),
  ensureCodexManagedBundledMarketplace: vi.fn(),
  ensureCodexComputerUseServiceApp: vi.fn(),
  resolveCodexManagedBundledMarketplaceSource: vi.fn(
    async (params: { candidates?: readonly unknown[] }) => params.candidates?.[0],
  ),
  resolveCodexComputerUseServiceAppSourcePath: vi.fn(
    async (params: { sourceAppCandidates?: readonly string[] }) => params.sourceAppCandidates?.[0],
  ),
}));

vi.mock("./request.js", () => ({
  requestCodexAppServerJson: requestCodexAppServerJsonMock,
}));

vi.mock("./shared-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared-client.js")>()),
  ...sharedClientMocks,
}));

vi.mock("./computer-use-marketplace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./computer-use-marketplace.js")>()),
  ensureCodexManagedBundledMarketplace:
    managedProvisioningMocks.ensureCodexManagedBundledMarketplace,
  resolveCodexManagedBundledMarketplaceSource:
    managedProvisioningMocks.resolveCodexManagedBundledMarketplaceSource,
}));

vi.mock("./computer-use-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./computer-use-service.js")>()),
  ensureCodexComputerUseServiceApp: managedProvisioningMocks.ensureCodexComputerUseServiceApp,
  resolveCodexComputerUseServiceAppSourcePath:
    managedProvisioningMocks.resolveCodexComputerUseServiceAppSourcePath,
}));

vi.mock("./computer-use-cache.js", () => ({
  ensureCodexComputerUseSharedPluginCache:
    managedProvisioningMocks.ensureCodexComputerUseSharedPluginCache,
}));

vi.mock("./desktop-app-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./desktop-app-paths.js")>();
  return {
    ...actual,
    resolveMacOSDesktopCodexAppPathCandidates: (platform?: NodeJS.Platform) =>
      actual.resolveMacOSDesktopCodexAppPathCandidates(platform ?? "darwin"),
    resolveMacOSDesktopCodexBundledMarketplaceCandidates: (platform?: NodeJS.Platform) =>
      actual.resolveMacOSDesktopCodexBundledMarketplaceCandidates(platform ?? "darwin"),
  };
});

import {
  ensureCodexComputerUse,
  installCodexComputerUse,
  readCodexComputerUseStatus,
  runCodexComputerUseLiveTest,
  type CodexComputerUseStatus,
} from "./computer-use.js";

type CodexComputerUseRequest = NonNullable<
  NonNullable<Parameters<typeof ensureCodexComputerUse>[0]>["request"]
>;

const REMOTE_COMPUTER_USE_MARKETPLACE_NAME = "openai-curated-remote";
const REMOTE_COMPUTER_USE_PLUGIN_ID = "plugins~Plugin_00000000000000000000000000000000";

function expectStatusFields(
  status: CodexComputerUseStatus,
  fields: Partial<CodexComputerUseStatus>,
): void {
  for (const key of Object.keys(fields) as Array<keyof CodexComputerUseStatus>) {
    expect(status[key]).toEqual(fields[key]);
  }
}

async function expectSetupErrorStatus(
  promise: Promise<CodexComputerUseStatus>,
  fields: Partial<CodexComputerUseStatus>,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  const error = requireRecord(caught, "setup error");
  const status = requireRecord(error.status, "setup error status") as CodexComputerUseStatus;
  expectStatusFields(status, fields);
}

const requireRecord = createRequireRecord("object", "label-not-object");

function requestCalls(
  request: CodexComputerUseRequest,
): ReadonlyArray<readonly [method: string, params?: unknown, options?: { timeoutMs?: number }]> {
  return vi.mocked(request).mock.calls;
}

function expectRequestMethodNotCalled(request: CodexComputerUseRequest, method: string): void {
  expect(requestCalls(request).map(([calledMethod]) => calledMethod)).not.toContain(method);
}

describe("Codex Computer Use setup", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    vi.useRealTimers();
    requestCodexAppServerJsonMock.mockReset();
    sharedClientMocks.assertCodexAppServerClientStartSelectionCurrent.mockReset();
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockReset();
    sharedClientMocks.readCodexAppServerClientDesktopGeneration.mockReset();
    sharedClientMocks.readCodexAppServerClientProcessIdentity.mockReset();
    sharedClientMocks.releaseLeasedSharedCodexAppServerClient.mockReset();
    sharedClientMocks.waitForCodexAppServerClientDesktopGenerationDrain.mockReset();
    sharedClientMocks.waitForCodexAppServerClientDesktopGenerationDrain.mockResolvedValue(
      undefined,
    );
    managedProvisioningMocks.ensureCodexManagedBundledMarketplace.mockReset();
    managedProvisioningMocks.ensureCodexComputerUseServiceApp.mockReset();
    managedProvisioningMocks.ensureCodexComputerUseSharedPluginCache.mockReset();
    managedProvisioningMocks.ensureCodexComputerUseSharedPluginCache.mockResolvedValue({
      status: "independent",
      changed: false,
      message: "independent",
      removedStaleVersions: [],
      warnings: [],
    });
    managedProvisioningMocks.resolveCodexManagedBundledMarketplaceSource.mockReset();
    managedProvisioningMocks.resolveCodexManagedBundledMarketplaceSource.mockImplementation(
      async (params: { candidates?: readonly unknown[] }) => params.candidates?.[0],
    );
    managedProvisioningMocks.resolveCodexComputerUseServiceAppSourcePath.mockReset();
    managedProvisioningMocks.resolveCodexComputerUseServiceAppSourcePath.mockImplementation(
      async (params: { sourceAppCandidates?: readonly string[] }) =>
        params.sourceAppCandidates?.[0],
    );
  });

  it("stays disabled until configured", async () => {
    const status = await readCodexComputerUseStatus({ pluginConfig: {}, request: vi.fn() });
    expectStatusFields(status, {
      enabled: false,
      ready: false,
      reason: "disabled",
      message: "Computer Use is disabled.",
    });
  });

  it("starts one-off Computer Use setup with the desktop app owner", async () => {
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockRejectedValueOnce(
      new Error("captured start options"),
    );
    const config = { agents: { list: [{ id: "worker" }] } };
    const agentDir = "/tmp/openclaw-worker-agent";

    await expect(installCodexComputerUse({ pluginConfig: {}, config, agentDir })).rejects.toThrow(
      "captured start options",
    );
    expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).toHaveBeenCalledWith(
      expect.objectContaining({
        startOptions: expect.objectContaining({
          commandSource: "managed",
          managedCommandOrder: "desktop-first",
        }),
        config,
        agentDir,
      }),
    );
  });

  it("holds the Codex-home fence until an install request settles", async () => {
    const agentDir = "/tmp/openclaw-computer-use-fence-agent";
    let rejectInstallRequest: (error: Error) => void = () => undefined;
    const request = vi.fn(
      async () =>
        await new Promise((_resolve, reject) => {
          rejectInstallRequest = reject;
        }),
    );
    const client = {
      request,
      closeAndRunAfterExit: vi.fn(),
      getRuntimeIdentity: vi.fn(() => undefined),
    };
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValueOnce(client);
    const install = installCodexComputerUse({ pluginConfig: {}, agentDir });
    const rejectedInstall = expect(install).rejects.toThrow("stop install");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    const startOptions = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {},
      managedCommandOrder: "desktop-first",
    }).start;
    const fenceKey = resolveCodexNativeConfigFenceKey({ startOptions, agentDir });
    expect(fenceKey).toBeTypeOf("string");
    let contenderAcquired = false;
    const contender = (async () => {
      const release = await acquireCodexNativeConfigFence(fenceKey as string);
      contenderAcquired = true;
      release();
    })();
    await Promise.resolve();
    expect(contenderAcquired).toBe(false);

    rejectInstallRequest(new Error("stop install"));
    await rejectedInstall;
    await contender;
    expect(contenderAcquired).toBe(true);
    expect(client.closeAndRunAfterExit).not.toHaveBeenCalled();
    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledWith(client);
  });

  it("releases the install mutation fence before the guarded readiness thread", async () => {
    const agentDir = "/tmp/openclaw-computer-use-guarded-install-agent";
    const pluginConfig = {
      computerUse: { marketplaceName: "desktop-tools", liveTestTimeoutMs: 150 },
    };
    const startOptions = resolveCodexAppServerRuntimeOptions({
      pluginConfig,
      managedCommandOrder: "desktop-first",
    }).start;
    const fenceKey = resolveCodexNativeConfigFenceKey({ startOptions, agentDir });
    expect(fenceKey).toBeTypeOf("string");

    const harness = createClientHarness();
    harness.client.setThreadSessionRequestGuard((options) =>
      acquireCodexNativeConfigFence(fenceKey as string, options),
    );
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValueOnce(harness.client);
    const fixture = createComputerUseRequest({ installed: false });
    let cursor = 0;
    const readFrame = async (method: string) => {
      await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThan(cursor), {
        timeout: 1_000,
      });
      const frame = JSON.parse(harness.writes[cursor++] ?? "{}") as {
        id: number;
        method: string;
        params?: unknown;
      };
      expect(frame.method).toBe(method);
      return frame;
    };
    const answerFrame = async (frame: { id: number; method: string; params?: unknown }) => {
      const result = await fixture(frame.method, frame.params);
      harness.send({ id: frame.id, result: result ?? null });
    };
    const answer = async (method: string) => answerFrame(await readFrame(method));

    const install = installCodexComputerUse({ pluginConfig, agentDir, timeoutMs: 2_000 });
    void install.catch(() => undefined);
    await answer("experimentalFeature/enablement/set");
    await answer("plugin/list");
    await answer("plugin/read");
    const mutation = await readFrame("plugin/install");
    await expect(
      acquireCodexNativeConfigFence(fenceKey as string, {
        timeoutMs: 10,
        timeoutMessage: "mutation fence held",
      }),
    ).rejects.toThrow("mutation fence held");
    await answerFrame(mutation);
    await answer("config/mcpServer/reload");
    await answer("plugin/read");
    await answer("mcpServerStatus/list");
    await answer("thread/start");
    await answer("mcpServer/tool/call");
    await answer("thread/unsubscribe");
    await answer("thread/archive");

    await expect(install).resolves.toMatchObject({
      ready: true,
      liveTest: { status: "passed", attempts: 1 },
    });
    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledWith(
      harness.client,
    );
    harness.client.close();
  });

  it.each(["abort", "timeout"] as const)(
    "holds the install fence through process exit after a post-write %s",
    async (mode) => {
      const harness = createClientHarness();
      sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValueOnce(harness.client);
      const agentDir = `/tmp/openclaw-computer-use-${mode}-agent`;
      const abortController = new AbortController();
      const install = installCodexComputerUse({
        pluginConfig: {},
        agentDir,
        timeoutMs: mode === "timeout" ? 150 : 1_000,
        signal: abortController.signal,
      });
      await vi.waitFor(() => {
        const methods = harness.writes.map(
          (line) => (JSON.parse(line) as { method?: string }).method,
        );
        expect(methods).toContain("experimentalFeature/enablement/set");
      });

      const startOptions = resolveCodexAppServerRuntimeOptions({
        pluginConfig: {},
        managedCommandOrder: "desktop-first",
      }).start;
      const fenceKey = resolveCodexNativeConfigFenceKey({ startOptions, agentDir });
      expect(fenceKey).toBeTypeOf("string");
      const events: string[] = [];
      harness.process.once("exit", () => events.push("exit"));
      const contender = acquireCodexNativeConfigFence(fenceKey as string).then((release) => {
        events.push("fence");
        return release;
      });
      await Promise.resolve();
      expect(events).toEqual([]);

      if (mode === "abort") {
        abortController.abort();
      }
      await expect(install).rejects.toThrow(
        `experimentalFeature/enablement/set ${mode === "abort" ? "aborted" : "timed out"}`,
      );
      const releaseContender = await contender;
      try {
        expect(harness.stdinDestroyed).toBe(true);
        expect(events).toEqual(["exit", "fence"]);
        expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledWith(
          harness.client,
        );
      } finally {
        releaseContender();
      }
    },
  );

  it.each(["stdin", "stdout"] as const)(
    "holds the install fence through process exit after a post-write %s failure",
    async (stream) => {
      const harness = createClientHarness();
      sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValueOnce(harness.client);
      const agentDir = `/tmp/openclaw-computer-use-${stream}-failure-agent`;
      const install = installCodexComputerUse({ pluginConfig: {}, agentDir, timeoutMs: 1_000 });
      await vi.waitFor(() => {
        const methods = harness.writes.map(
          (line) => (JSON.parse(line) as { method?: string }).method,
        );
        expect(methods).toContain("experimentalFeature/enablement/set");
      });

      const startOptions = resolveCodexAppServerRuntimeOptions({
        pluginConfig: {},
        managedCommandOrder: "desktop-first",
      }).start;
      const fenceKey = resolveCodexNativeConfigFenceKey({ startOptions, agentDir });
      expect(fenceKey).toBeTypeOf("string");
      const events: string[] = [];
      harness.process.once("exit", () => events.push("exit"));
      const contender = acquireCodexNativeConfigFence(fenceKey as string).then((release) => {
        events.push("fence");
        return release;
      });
      await Promise.resolve();
      expect(events).toEqual([]);

      const failure = new Error(stream === "stdin" ? "write EPIPE" : "stdout pipe broke");
      harness.process[stream].emit("error", failure);

      await expect(install).rejects.toThrow(failure.message);
      const releaseContender = await contender;
      try {
        expect(harness.stdinDestroyed).toBe(true);
        expect(events).toEqual(["exit", "fence"]);
        expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledWith(
          harness.client,
        );
      } finally {
        releaseContender();
      }
    },
  );

  it("reports an installed Computer Use MCP server from a registered marketplace", async () => {
    const request = createComputerUseRequest({ installed: true });

    const status = await readCodexComputerUseStatus({
      pluginConfig: { computerUse: { enabled: true, marketplaceName: "desktop-tools" } },
      request,
    });

    expectStatusFields(status, {
      enabled: true,
      ready: true,
      reason: "ready",
      installed: true,
      pluginEnabled: true,
      mcpServerAvailable: true,
      marketplaceName: "desktop-tools",
      tools: ["list_apps"],
      message: "Computer Use is ready.",
    });
    expect(status.installation).toMatchObject({
      status: "installed",
      ok: true,
    });
    expect(status.exposure).toMatchObject({
      status: "available",
      ok: true,
    });
    expect(status.liveTest).toMatchObject({
      status: "passed",
      ok: true,
      attempted: true,
      attempts: 1,
      timeoutMs: 60_000,
      retried: false,
      repaired: false,
    });
    expect(request).toHaveBeenCalledWith(
      "thread/start",
      {
        input: [],
        developerInstructions: "OpenClaw Computer Use readiness probe",
        ephemeral: true,
      },
      { timeoutMs: 60_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "mcpServer/tool/call",
      {
        threadId: "computer-use-probe-thread-1",
        server: "computer-use",
        tool: "list_apps",
        arguments: {},
      },
      {
        timeoutMs: 60_000,
      },
    );
    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "computer-use-probe-thread-1" },
      { timeoutMs: 60_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "thread/archive",
      { threadId: "computer-use-probe-thread-1" },
      { timeoutMs: 60_000 },
    );
    expectRequestMethodNotCalled(request, "marketplace/add");
    expectRequestMethodNotCalled(request, "experimentalFeature/enablement/set");
    expectRequestMethodNotCalled(request, "plugin/install");
  });

  it("inherits managed security policy when starting a Computer Use readiness probe", async () => {
    const request = createComputerUseRequest({ installed: true });
    const managedRequest = vi.fn(async (method: string, params?: unknown) => {
      if (method === "thread/start") {
        const threadParams = requireRecord(params, "managed readiness thread");
        if ("sandbox" in threadParams || "approvalPolicy" in threadParams) {
          throw new Error("enterprise policy does not permit thread security overrides");
        }
      }
      return await request(method, params);
    }) as CodexComputerUseRequest;

    const status = await readCodexComputerUseStatus({
      pluginConfig: {
        computerUse: {
          enabled: true,
          marketplaceName: "desktop-tools",
          strictReadiness: true,
        },
      },
      request: managedRequest,
    });

    expect(status).toMatchObject({ ready: true, reason: "ready" });
  });

  it("repairs a failed probe through the owning MCP runtime without signaling sibling processes", async () => {
    const request = createComputerUseRequest({ installed: true, liveTestFailures: 1 });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const status = await readCodexComputerUseStatus({
        pluginConfig: {
          computerUse: { enabled: true, marketplaceName: "desktop-tools", autoRepair: true },
        },
        request,
      });

      expect(status).toMatchObject({ ready: true, reason: "ready" });
      expect(status.liveTest).toMatchObject({
        status: "passed",
        attempts: 2,
        retried: true,
        repaired: true,
      });
      expect(status.repair).toMatchObject({ attempted: true, killedPids: [], warnings: [] });
      expect(request).toHaveBeenCalledWith("config/mcpServer/reload", undefined, {
        timeoutMs: 60_000,
      });
      const methods = requestCalls(request).map(([method]) => method);
      expect(methods.indexOf("thread/archive")).toBeLessThan(
        methods.indexOf("config/mcpServer/reload"),
      );
      expect(
        requestCalls(request).filter(([method]) => method === "mcpServer/tool/call"),
      ).toHaveLength(2);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("reports an owner-managed MCP reload failure without preventing the bounded retry", async () => {
    const request = createComputerUseRequest({
      installed: true,
      liveTestFailures: 1,
      reloadFailures: 1,
    });

    const status = await readCodexComputerUseStatus({
      pluginConfig: {
        computerUse: { enabled: true, marketplaceName: "desktop-tools", autoRepair: true },
      },
      request,
    });

    expect(status.liveTest).toMatchObject({ status: "passed", attempts: 2, repaired: false });
    expect(status.repair).toMatchObject({
      attempted: true,
      killedPids: [],
      warnings: ["Could not reload Computer Use MCP servers: MCP runtime reload failed"],
    });
    expect(status.warnings).toContain(
      "Could not reload Computer Use MCP servers: MCP runtime reload failed",
    );
  });

  it("propagates a desktop selection change without retrying the stale client", async () => {
    const selectionChanged = Object.assign(new Error("desktop selection changed"), {
      code: "CODEX_APP_SERVER_START_SELECTION_CHANGED",
    });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return { thread: { id: "probe-thread" } };
      }
      if (method === "mcpServer/tool/call") {
        throw selectionChanged;
      }
      if (method === "thread/unsubscribe" || method === "thread/archive") {
        return undefined;
      }
      throw new Error(`unexpected request: ${method}`);
    }) as CodexComputerUseRequest;

    await expect(
      runCodexComputerUseLiveTest({
        request,
        config: resolveCodexComputerUseConfig({
          pluginConfig: { computerUse: { enabled: true, autoRepair: true } },
        }),
      }),
    ).rejects.toBe(selectionChanged);
    expect(requestCalls(request).map(([method]) => method)).toEqual([
      "thread/start",
      "mcpServer/tool/call",
      "thread/unsubscribe",
      "thread/archive",
    ]);
  });

  it("fails fast when the named MCP server exposes no tools", async () => {
    const request = createComputerUseRequest({ installed: true, mcpToolsAvailable: false });

    await expectSetupErrorStatus(
      ensureCodexComputerUse({
        pluginConfig: {
          computerUse: {
            enabled: true,
            strictReadiness: true,
            marketplaceName: "desktop-tools",
          },
        },
        request,
      }),
      {
        ready: false,
        reason: "mcp_missing",
        mcpServerAvailable: false,
        tools: [],
        message: "Computer Use is installed, but the computer-use MCP server exposes no tools.",
      },
    );
    expectRequestMethodNotCalled(request, "thread/start");
    expectRequestMethodNotCalled(request, "mcpServer/tool/call");
  });

  it("reloads empty MCP exposure once during install before failing closed", async () => {
    const request = createComputerUseRequest({ installed: true, mcpToolsAvailable: false });

    await expectSetupErrorStatus(
      installCodexComputerUse({
        pluginConfig: { computerUse: { marketplaceName: "desktop-tools" } },
        request,
      }),
      { ready: false, reason: "mcp_missing", mcpServerAvailable: false },
    );
    expect(
      requestCalls(request).filter(([method]) => method === "config/mcpServer/reload"),
    ).toHaveLength(1);
    expectRequestMethodNotCalled(request, "thread/start");
  });

  it("does not reload the Computer Use MCP runtime unless autoRepair is enabled", async () => {
    const request = createComputerUseRequest({ installed: true, liveTestFailures: 2 });

    const status = await readCodexComputerUseStatus({
      pluginConfig: { computerUse: { enabled: true, marketplaceName: "desktop-tools" } },
      request,
    });

    expect(status.liveTest).toMatchObject({
      status: "failed",
      ok: false,
      attempts: 2,
      retried: true,
      repaired: false,
    });
    expectStatusFields(status, {
      ready: false,
      reason: "live_test_failed",
      installed: true,
      pluginEnabled: true,
      mcpServerAvailable: true,
    });
    expect(status.warnings).toContain(
      "Computer Use live test failed, but compatibility startup remains enabled; set computerUse.strictReadiness to true to fail closed.",
    );
    expect(status.message).toContain(
      "Startup is allowed because computerUse.strictReadiness is false.",
    );
    expect(status.repair).toBeUndefined();
    expectRequestMethodNotCalled(request, "config/mcpServer/reload");
  });

  it("surfaces install, exposure, and live-test layers separately when the live test fails", async () => {
    const request = createComputerUseRequest({ installed: true, liveTestFailures: 2 });

    const status = await readCodexComputerUseStatus({
      pluginConfig: {
        computerUse: {
          enabled: true,
          marketplaceName: "desktop-tools",
          autoRepair: true,
          strictReadiness: true,
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: false,
      reason: "live_test_failed",
      installed: true,
      pluginEnabled: true,
      mcpServerAvailable: true,
    });
    expect(status.installation).toMatchObject({ status: "installed", ok: true });
    expect(status.exposure).toMatchObject({ status: "available", ok: true });
    expect(status.liveTest).toMatchObject({
      status: "failed",
      ok: false,
      attempted: true,
      attempts: 2,
      timeoutMs: 60_000,
      retried: true,
      repaired: true,
      error: "list_apps timed out",
    });
    expect(status.message).toContain("Computer Use live test failed after 2 attempts");
    expect(
      requestCalls(request).filter(([method]) => method === "config/mcpServer/reload"),
    ).toHaveLength(1);
  });

  it("keeps startup compatible by default when the live test fails", async () => {
    const request = createComputerUseRequest({ installed: true, liveTestFailures: 2 });

    const status = await ensureCodexComputerUse({
      pluginConfig: {
        computerUse: {
          enabled: true,
          marketplaceName: "desktop-tools",
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: false,
      reason: "live_test_failed",
      installed: true,
      pluginEnabled: true,
      mcpServerAvailable: true,
    });
    expect(status.liveTest).toMatchObject({ status: "failed", ok: false });
    expect(status.warnings).toContain(
      "Computer Use live test failed, but compatibility startup remains enabled; set computerUse.strictReadiness to true to fail closed.",
    );
    expect(status.message).toContain(
      "Startup is allowed because computerUse.strictReadiness is false.",
    );
  });

  it("keeps auto-install startup compatible when installation succeeds but the live test fails", async () => {
    const request = createComputerUseRequest({ installed: false, liveTestFailures: 2 });

    const status = await ensureCodexComputerUse({
      pluginConfig: {
        computerUse: {
          enabled: true,
          autoInstall: true,
          marketplaceName: "desktop-tools",
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: false,
      reason: "live_test_failed",
      installed: true,
      pluginEnabled: true,
      mcpServerAvailable: true,
    });
    expect(status.warnings).toContain(
      "Computer Use live test failed, but compatibility startup remains enabled; set computerUse.strictReadiness to true to fail closed.",
    );
    expect(status.message).toContain(
      "Startup is allowed because computerUse.strictReadiness is false.",
    );
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
      pluginName: "computer-use",
    });
  });

  it("fails startup closed when strictReadiness is enabled", async () => {
    const request = createComputerUseRequest({ installed: true, liveTestFailures: 2 });

    await expectSetupErrorStatus(
      ensureCodexComputerUse({
        pluginConfig: {
          computerUse: {
            enabled: true,
            marketplaceName: "desktop-tools",
            strictReadiness: true,
          },
        },
        request,
      }),
      {
        ready: false,
        reason: "live_test_failed",
        installed: true,
        pluginEnabled: true,
        mcpServerAvailable: true,
      },
    );
  });

  it("reports an installed but disabled Computer Use plugin separately", async () => {
    const request = createComputerUseRequest({ installed: true, enabled: false });

    const status = await readCodexComputerUseStatus({
      pluginConfig: { computerUse: { enabled: true, marketplaceName: "desktop-tools" } },
      request,
    });

    expectStatusFields(status, {
      ready: false,
      reason: "plugin_disabled",
      installed: true,
      pluginEnabled: false,
      mcpServerAvailable: false,
      message:
        "Computer Use is installed, but the computer-use plugin is disabled. Run /codex computer-use install or enable computerUse.autoInstall to re-enable it.",
    });
    expectRequestMethodNotCalled(request, "plugin/install");
  });

  it("does not register marketplace sources during status checks", async () => {
    const request = createComputerUseRequest({ installed: true });

    const status = await readCodexComputerUseStatus({
      pluginConfig: {
        computerUse: {
          enabled: true,
          marketplaceSource: "github:example/desktop-tools",
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      message: "Computer Use is ready.",
    });
    expectRequestMethodNotCalled(request, "marketplace/add");
    expectRequestMethodNotCalled(request, "experimentalFeature/enablement/set");
  });

  it("fails closed when multiple marketplaces contain Computer Use", async () => {
    const request = createAmbiguousComputerUseRequest();

    const status = await readCodexComputerUseStatus({
      pluginConfig: { computerUse: { enabled: true } },
      request,
    });

    expectStatusFields(status, {
      ready: false,
      reason: "marketplace_missing",
      message:
        "Multiple Codex marketplaces contain computer-use. Configure computerUse.marketplaceName or computerUse.marketplacePath to choose one.",
    });
    expectRequestMethodNotCalled(request, "plugin/read");
  });

  it("installs Computer Use from a configured marketplace source", async () => {
    const request = createComputerUseRequest({ installed: false });

    const status = await installCodexComputerUse({
      pluginConfig: {
        computerUse: {
          marketplaceSource: "github:example/desktop-tools",
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      installed: true,
      pluginEnabled: true,
      tools: ["list_apps"],
    });
    expect(request).toHaveBeenCalledWith("experimentalFeature/enablement/set", {
      enablement: { plugins: true },
    });
    expect(request).toHaveBeenCalledWith("marketplace/add", {
      source: "github:example/desktop-tools",
    });
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
      pluginName: "computer-use",
    });
    expect(request).toHaveBeenCalledWith("config/mcpServer/reload", undefined);
  });

  it("requires explicit install commands to finish with a passing live test", async () => {
    const request = createComputerUseRequest({ installed: true, liveTestFailures: 2 });

    await expectSetupErrorStatus(
      installCodexComputerUse({
        pluginConfig: { computerUse: { marketplaceName: "desktop-tools" } },
        request,
      }),
      {
        ready: false,
        reason: "live_test_failed",
        installed: true,
        pluginEnabled: true,
        mcpServerAvailable: true,
      },
    );
  });

  it("re-enables an installed but disabled Computer Use plugin during install", async () => {
    const request = createComputerUseRequest({ installed: true, enabled: false });

    const status = await installCodexComputerUse({
      pluginConfig: { computerUse: { marketplaceName: "desktop-tools" } },
      request,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      installed: true,
      pluginEnabled: true,
      message: "Computer Use is ready.",
    });
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
      pluginName: "computer-use",
    });
  });

  it("fails closed when Computer Use is required but not installed", async () => {
    const request = createComputerUseRequest({ installed: false });

    await expectSetupErrorStatus(
      ensureCodexComputerUse({
        pluginConfig: { computerUse: { enabled: true, marketplaceName: "desktop-tools" } },
        request,
      }),
      {
        reason: "plugin_not_installed",
      },
    );
    expectRequestMethodNotCalled(request, "plugin/install");
  });

  it("skips setup writes when auto-install is already ready", async () => {
    const request = createComputerUseRequest({ installed: true });

    const status = await ensureCodexComputerUse({
      pluginConfig: {
        computerUse: {
          enabled: true,
          autoInstall: true,
          marketplaceName: "desktop-tools",
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      message: "Computer Use is ready.",
    });
    expectRequestMethodNotCalled(request, "marketplace/add");
    expectRequestMethodNotCalled(request, "experimentalFeature/enablement/set");
    expectRequestMethodNotCalled(request, "plugin/install");
  });

  it("uses setup writes when auto-install needs to install", async () => {
    const request = createComputerUseRequest({ installed: false });

    const status = await ensureCodexComputerUse({
      pluginConfig: {
        computerUse: {
          enabled: true,
          autoInstall: true,
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      message: "Computer Use is ready.",
    });
    expect(request).toHaveBeenCalledWith("experimentalFeature/enablement/set", {
      enablement: { plugins: true },
    });
    expectRequestMethodNotCalled(request, "marketplace/add");
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
      pluginName: "computer-use",
    });
  });

  it("auto-registers the current ChatGPT.app bundled marketplace before legacy Codex.app", async () => {
    const root = tempDirs.make("openclaw-codex-bundled-marketplace-");
    const chatGptMarketplacePath = path.join(
      root,
      "Applications",
      "ChatGPT.app",
      "Contents",
      "Resources",
      "plugins",
      "openai-bundled",
    );
    const legacyCodexMarketplacePath = path.join(
      root,
      "Applications",
      "Codex.app",
      "Contents",
      "Resources",
      "plugins",
      "openai-bundled",
    );
    fs.mkdirSync(chatGptMarketplacePath, { recursive: true });
    fs.mkdirSync(legacyCodexMarketplacePath, { recursive: true });
    const request = createBundledMarketplaceComputerUseRequest(chatGptMarketplacePath);

    const status = await ensureCodexComputerUse({
      pluginConfig: {
        computerUse: {
          enabled: true,
          autoInstall: true,
        },
      },
      request,
      defaultBundledMarketplacePathCandidates: [chatGptMarketplacePath, legacyCodexMarketplacePath],
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      marketplaceName: "openai-bundled",
      message: "Computer Use is ready.",
    });
    expect(request).toHaveBeenCalledWith("marketplace/add", {
      source: chatGptMarketplacePath,
    });
  });

  it("auto-registers the legacy Codex.app bundled marketplace when ChatGPT.app is absent", async () => {
    const root = tempDirs.make("openclaw-codex-bundled-marketplace-");
    const chatGptMarketplacePath = path.join(
      root,
      "Applications",
      "ChatGPT.app",
      "Contents",
      "Resources",
      "plugins",
      "openai-bundled",
    );
    const legacyCodexMarketplacePath = path.join(
      root,
      "Applications",
      "Codex.app",
      "Contents",
      "Resources",
      "plugins",
      "openai-bundled",
    );
    fs.mkdirSync(legacyCodexMarketplacePath, { recursive: true });
    const request = createBundledMarketplaceComputerUseRequest(legacyCodexMarketplacePath);

    const status = await ensureCodexComputerUse({
      pluginConfig: {
        computerUse: {
          enabled: true,
          autoInstall: true,
        },
      },
      request,
      defaultBundledMarketplacePathCandidates: [chatGptMarketplacePath, legacyCodexMarketplacePath],
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      marketplaceName: "openai-bundled",
      message: "Computer Use is ready.",
    });
    expect(request).toHaveBeenCalledWith("marketplace/add", {
      source: legacyCodexMarketplacePath,
    });
  });

  it("keeps explicit bundled marketplace test overrides authoritative during auto-install", async () => {
    const bundledMarketplacePath = tempDirs.make("openclaw-codex-bundled-marketplace-");
    const request = createBundledMarketplaceComputerUseRequest(bundledMarketplacePath);

    const status = await ensureCodexComputerUse({
      pluginConfig: {
        computerUse: {
          enabled: true,
          autoInstall: true,
        },
      },
      request,
      defaultBundledMarketplacePath: bundledMarketplacePath,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      marketplaceName: "openai-bundled",
      message: "Computer Use is ready.",
    });
    expect(request).toHaveBeenCalledWith("marketplace/add", {
      source: bundledMarketplacePath,
    });
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: `${bundledMarketplacePath}/.agents/plugins/marketplace.json`,
      pluginName: "computer-use",
    });
  });

  it.each([
    "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled",
    "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled",
  ])("migrates the legacy bundled marketplace source through Codex", async (legacySource) => {
    const { agentDir, client, managedMarketplacePath } = createManagedMarketplaceHarness(
      tempDirs.make("openclaw-codex-managed-marketplace-"),
    );
    const request = createBundledMarketplaceComputerUseRequest(managedMarketplacePath, {
      configuredSource: legacySource,
    });

    const status = await ensureCodexComputerUse({
      agentDir,
      client,
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      request,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      marketplaceName: "openai-bundled",
    });
    expect(
      requestCalls(request)
        .filter(([method]) => method.startsWith("marketplace/"))
        .map(([method, params]) => [method, params]),
    ).toStrictEqual([
      ["marketplace/remove", { marketplaceName: "openai-bundled" }],
      ["marketplace/add", { source: managedMarketplacePath }],
    ]);

    await expect(
      ensureCodexComputerUse({
        agentDir,
        client,
        pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
        request,
      }),
    ).resolves.toMatchObject({ ready: true, reason: "ready" });
    expect(
      requestCalls(request).filter(([method]) => method === "marketplace/remove"),
    ).toHaveLength(1);
  });

  it("preserves a custom source that uses the reserved bundled marketplace name", async () => {
    const { agentDir, client, managedMarketplacePath } = createManagedMarketplaceHarness(
      tempDirs.make("openclaw-codex-managed-marketplace-"),
    );
    const request = createBundledMarketplaceComputerUseRequest(managedMarketplacePath, {
      configuredSource: "/opt/company/openai-bundled",
    });

    await expect(
      ensureCodexComputerUse({
        agentDir,
        client,
        pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
        request,
      }),
    ).rejects.toThrow("already added from a different source");
    expectRequestMethodNotCalled(request, "marketplace/remove");
  });

  it("preserves a legacy source owned by a non-user config layer", async () => {
    const { agentDir, client, managedMarketplacePath } = createManagedMarketplaceHarness(
      tempDirs.make("openclaw-codex-managed-marketplace-"),
    );
    const request = createBundledMarketplaceComputerUseRequest(managedMarketplacePath, {
      configuredSource: "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled",
      configuredSourceOrigin: "system",
    });

    await expect(
      ensureCodexComputerUse({
        agentDir,
        client,
        pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
        request,
      }),
    ).rejects.toThrow("already added from a different source");
    expectRequestMethodNotCalled(request, "marketplace/remove");
  });

  it("preserves a legacy source owned by a selected user profile", async () => {
    const { agentDir, client, managedMarketplacePath } = createManagedMarketplaceHarness(
      tempDirs.make("openclaw-codex-managed-marketplace-"),
    );
    const request = createBundledMarketplaceComputerUseRequest(managedMarketplacePath, {
      configuredSource: "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled",
      configuredSourceProfile: "work",
    });

    await expect(
      ensureCodexComputerUse({
        agentDir,
        client,
        pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
        request,
      }),
    ).rejects.toThrow("already added from a different source");
    expectRequestMethodNotCalled(request, "marketplace/remove");
  });

  it.each([
    {
      label: "config-selected default marketplace",
      commandSource: "config" as const,
      selector: {},
      provisionsWrapper: true,
    },
    {
      label: "env-selected default marketplace",
      commandSource: "env" as const,
      selector: {},
      provisionsWrapper: true,
    },
    {
      label: "configured marketplace source",
      commandSource: "config" as const,
      selector: { marketplaceSource: "github:example/desktop-tools" },
      provisionsWrapper: false,
    },
    {
      label: "configured marketplace path",
      commandSource: "config" as const,
      selector: {
        marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
      },
      provisionsWrapper: false,
    },
    {
      label: "configured marketplace name",
      commandSource: "config" as const,
      selector: { marketplaceName: "desktop-tools" },
      provisionsWrapper: false,
    },
  ])(
    "provisions the managed service for a $label explicit desktop install",
    async ({ commandSource, selector, provisionsWrapper }) => {
      const root = tempDirs.make("openclaw-codex-explicit-install-");
      const agentDir = path.join(root, "agent");
      const codexHome = path.join(agentDir, "codex-home");
      const managedMarketplacePath = path.join(
        codexHome,
        ".tmp",
        "bundled-marketplaces",
        "openai-bundled",
      );
      fs.mkdirSync(managedMarketplacePath, { recursive: true });
      const harness = createClientHarness();
      vi.spyOn(harness.client, "getRuntimeIdentity").mockReturnValue({
        serverVersion: "0.148.0",
        codexHome,
      });
      sharedClientMocks.readCodexAppServerClientProcessIdentity.mockReturnValue({
        clientId: "client-explicit-install",
        command: "/Applications/ChatGPT.app/Contents/Resources/codex",
        commandSource,
        argsFingerprint: "args",
      });
      const desktopGeneration = { epoch: 1, fingerprint: "desktop-current" };
      sharedClientMocks.readCodexAppServerClientDesktopGeneration.mockReturnValue(
        desktopGeneration,
      );
      managedProvisioningMocks.ensureCodexManagedBundledMarketplace.mockResolvedValue(
        managedMarketplacePath,
      );
      managedProvisioningMocks.ensureCodexComputerUseServiceApp.mockResolvedValue({
        status: "already_current",
        changed: false,
      });
      let drainedBeforeFence = false;
      sharedClientMocks.waitForCodexAppServerClientDesktopGenerationDrain.mockImplementationOnce(
        async () => {
          const release = await acquireCodexNativeConfigFence(
            `codex-home:${path.resolve(codexHome)}`,
            { timeoutMs: 50 },
          );
          drainedBeforeFence = true;
          release();
        },
      );
      const request = provisionsWrapper
        ? createBundledMarketplaceComputerUseRequest(managedMarketplacePath)
        : createComputerUseRequest({ installed: false });

      const status = await installCodexComputerUse({
        agentDir,
        client: harness.client,
        request,
        pluginConfig: { computerUse: { enabled: true, autoInstall: false, ...selector } },
      });

      expect(status.ready).toBe(true);
      expect(drainedBeforeFence).toBe(true);
      if (provisionsWrapper) {
        expect(managedProvisioningMocks.ensureCodexManagedBundledMarketplace).toHaveBeenCalledWith(
          expect.objectContaining({
            codexHome,
            ownershipRoot: agentDir,
            appServerCommand: "/Applications/ChatGPT.app/Contents/Resources/codex",
          }),
        );
      } else {
        expect(
          managedProvisioningMocks.ensureCodexManagedBundledMarketplace,
        ).not.toHaveBeenCalled();
      }
      expect(managedProvisioningMocks.ensureCodexComputerUseServiceApp).toHaveBeenCalledWith(
        expect.objectContaining({
          codexHome,
          ownershipRoot: agentDir,
          appServerCommand: "/Applications/ChatGPT.app/Contents/Resources/codex",
        }),
      );
      expect(sharedClientMocks.assertCodexAppServerClientStartSelectionCurrent).toHaveBeenCalled();
      expect(
        sharedClientMocks.waitForCodexAppServerClientDesktopGenerationDrain,
      ).toHaveBeenCalledWith({ client: harness.client, timeoutMs: expect.any(Number) });
      expect(
        sharedClientMocks.waitForCodexAppServerClientDesktopGenerationDrain.mock
          .invocationCallOrder[0],
      ).toBeLessThan(
        (provisionsWrapper
          ? managedProvisioningMocks.ensureCodexManagedBundledMarketplace.mock
              .invocationCallOrder[0]
          : managedProvisioningMocks.ensureCodexComputerUseServiceApp.mock
              .invocationCallOrder[0]) ?? Number.POSITIVE_INFINITY,
      );
      expect(sharedClientMocks.readCodexAppServerClientDesktopGeneration).toHaveReturnedWith(
        desktopGeneration,
      );
      expect(managedProvisioningMocks.ensureCodexComputerUseSharedPluginCache).toHaveBeenCalledWith(
        expect.objectContaining({ forceRefresh: true }),
      );
    },
  );

  it("rejects explicit managed provisioning from a desktop client without a generation", async () => {
    const root = tempDirs.make("openclaw-codex-explicit-install-unbound-");
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(agentDir, "codex-home");
    fs.mkdirSync(codexHome, { recursive: true });
    const harness = createClientHarness();
    vi.spyOn(harness.client, "getRuntimeIdentity").mockReturnValue({
      serverVersion: "0.148.0",
      codexHome,
    });
    sharedClientMocks.readCodexAppServerClientProcessIdentity.mockReturnValue({
      clientId: "client-explicit-install-unbound",
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "config",
      argsFingerprint: "args",
    });

    await expect(
      installCodexComputerUse({
        agentDir,
        client: harness.client,
        request: vi.fn(),
        pluginConfig: { computerUse: { enabled: true, autoInstall: false } },
      }),
    ).rejects.toThrow("requires a desktop-generation-bound client");
    expect(
      sharedClientMocks.waitForCodexAppServerClientDesktopGenerationDrain,
    ).not.toHaveBeenCalled();
    expect(managedProvisioningMocks.ensureCodexManagedBundledMarketplace).not.toHaveBeenCalled();
  });

  it("rejects explicit provisioning from a stale desktop client", async () => {
    const root = tempDirs.make("openclaw-codex-explicit-install-stale-");
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(agentDir, "codex-home");
    fs.mkdirSync(codexHome, { recursive: true });
    const harness = createClientHarness();
    vi.spyOn(harness.client, "getRuntimeIdentity").mockReturnValue({
      serverVersion: "0.148.0",
      codexHome,
    });
    sharedClientMocks.readCodexAppServerClientProcessIdentity.mockReturnValue({
      clientId: "client-explicit-install-stale",
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "resolved-managed",
      argsFingerprint: "args",
    });
    sharedClientMocks.readCodexAppServerClientDesktopGeneration.mockReturnValue({
      epoch: 1,
      fingerprint: "desktop-x",
    });
    sharedClientMocks.assertCodexAppServerClientStartSelectionCurrent.mockImplementation(() => {
      throw Object.assign(new Error("desktop selection changed"), {
        code: "CODEX_APP_SERVER_START_SELECTION_CHANGED",
      });
    });

    await expect(
      installCodexComputerUse({
        agentDir,
        client: harness.client,
        request: vi.fn(),
        pluginConfig: { computerUse: { enabled: true, autoInstall: false } },
      }),
    ).rejects.toThrow("desktop selection changed");
    expect(managedProvisioningMocks.ensureCodexManagedBundledMarketplace).not.toHaveBeenCalled();
    expect(managedProvisioningMocks.ensureCodexComputerUseServiceApp).not.toHaveBeenCalled();
  });

  it("allows auto-install from a configured local marketplace path", async () => {
    const request = createComputerUseRequest({ installed: false });

    const status = await ensureCodexComputerUse({
      pluginConfig: {
        computerUse: {
          enabled: true,
          autoInstall: true,
          marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      message: "Computer Use is ready.",
    });
    expectRequestMethodNotCalled(request, "marketplace/add");
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
      pluginName: "computer-use",
    });
  });

  it("requires an explicit install command for configured marketplace sources", async () => {
    const request = createComputerUseRequest({ installed: false });

    await expectSetupErrorStatus(
      ensureCodexComputerUse({
        pluginConfig: {
          computerUse: {
            enabled: true,
            autoInstall: true,
            marketplaceSource: "github:example/desktop-tools",
          },
        },
        request,
      }),
      {
        reason: "auto_install_blocked",
      },
    );
    expectRequestMethodNotCalled(request, "marketplace/add");
    expectRequestMethodNotCalled(request, "plugin/install");
  });

  it("fails closed when a configured marketplace name is not discovered", async () => {
    const request = createEmptyMarketplaceComputerUseRequest();

    const status = await readCodexComputerUseStatus({
      pluginConfig: {
        computerUse: {
          enabled: true,
          marketplaceName: "missing-marketplace",
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: false,
      reason: "marketplace_missing",
      message:
        "Configured Codex marketplace missing-marketplace was not found or does not contain computer-use. Run /codex computer-use install with a source or path to install from a new marketplace.",
    });
    expectRequestMethodNotCalled(request, "plugin/read");
  });

  it("reads installed remote Computer Use plugins by their opaque Codex id", async () => {
    const request = createComputerUseRequest({
      installed: true,
      remoteMarketplace: {
        name: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        pluginId: REMOTE_COMPUTER_USE_PLUGIN_ID,
      },
    });

    const status = await readCodexComputerUseStatus({
      pluginConfig: {
        computerUse: {
          enabled: true,
          marketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      installed: true,
      pluginEnabled: true,
      marketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
      tools: ["list_apps"],
    });
    expect(request).toHaveBeenCalledWith("plugin/read", {
      remoteMarketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
      pluginName: REMOTE_COMPUTER_USE_PLUGIN_ID,
    });
    expectRequestMethodNotCalled(request, "marketplace/add");
    expectRequestMethodNotCalled(request, "experimentalFeature/enablement/set");
    expectRequestMethodNotCalled(request, "plugin/install");
    expectRequestMethodNotCalled(request, "config/mcpServer/reload");
  });

  it("reports an uninstalled remote Computer Use plugin without installing it", async () => {
    const request = createComputerUseRequest({
      installed: false,
      remoteMarketplace: {
        name: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        pluginId: REMOTE_COMPUTER_USE_PLUGIN_ID,
      },
    });

    const status = await readCodexComputerUseStatus({
      pluginConfig: {
        computerUse: {
          enabled: true,
          marketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: false,
      reason: "plugin_not_installed",
      installed: false,
      pluginEnabled: false,
      marketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
    });
    expect(request).toHaveBeenCalledWith("plugin/read", {
      remoteMarketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
      pluginName: REMOTE_COMPUTER_USE_PLUGIN_ID,
    });
    expectRequestMethodNotCalled(request, "marketplace/add");
    expectRequestMethodNotCalled(request, "experimentalFeature/enablement/set");
    expectRequestMethodNotCalled(request, "plugin/install");
    expectRequestMethodNotCalled(request, "config/mcpServer/reload");
  });

  it("installs a discovered remote Computer Use plugin by its opaque Codex id", async () => {
    const request = createComputerUseRequest({
      installed: false,
      remoteMarketplace: {
        name: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        pluginId: REMOTE_COMPUTER_USE_PLUGIN_ID,
      },
    });

    const status = await installCodexComputerUse({
      pluginConfig: {
        computerUse: { marketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME },
      },
      request,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      installed: true,
      pluginEnabled: true,
      marketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
      tools: ["list_apps"],
    });
    expect(
      requestCalls(request)
        .filter(([method]) => method === "plugin/read")
        .map(([, params]) => params),
    ).toStrictEqual([
      {
        remoteMarketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        pluginName: REMOTE_COMPUTER_USE_PLUGIN_ID,
      },
      {
        remoteMarketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        pluginName: REMOTE_COMPUTER_USE_PLUGIN_ID,
      },
    ]);
    expect(request).toHaveBeenCalledWith("experimentalFeature/enablement/set", {
      enablement: { plugins: true },
    });
    expect(request).toHaveBeenCalledWith("plugin/install", {
      remoteMarketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
      pluginName: REMOTE_COMPUTER_USE_PLUGIN_ID,
    });
    expect(request).toHaveBeenCalledWith("config/mcpServer/reload", undefined);
    expectRequestMethodNotCalled(request, "marketplace/add");
  });

  it("auto-installs discovered remote Computer Use only when explicitly configured", async () => {
    const request = createComputerUseRequest({
      installed: false,
      remoteMarketplace: {
        name: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        pluginId: REMOTE_COMPUTER_USE_PLUGIN_ID,
      },
    });

    const status = await ensureCodexComputerUse({
      pluginConfig: {
        computerUse: {
          enabled: true,
          autoInstall: true,
          marketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      marketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
    });
    expect(request).toHaveBeenCalledWith("plugin/install", {
      remoteMarketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
      pluginName: REMOTE_COMPUTER_USE_PLUGIN_ID,
    });
    expectRequestMethodNotCalled(request, "marketplace/add");
  });

  it("fails closed before reading a remote Computer Use plugin without its opaque id", async () => {
    const request = createComputerUseRequest({
      installed: false,
      remoteMarketplace: {
        name: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        pluginId: null,
      },
    });

    const status = await readCodexComputerUseStatus({
      pluginConfig: {
        computerUse: {
          enabled: true,
          marketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: false,
      reason: "marketplace_missing",
      installed: false,
      pluginEnabled: false,
    });
    expectRequestMethodNotCalled(request, "plugin/read");
    expectRequestMethodNotCalled(request, "plugin/install");
    expectRequestMethodNotCalled(request, "experimentalFeature/enablement/set");

    await expectSetupErrorStatus(
      installCodexComputerUse({
        pluginConfig: {
          computerUse: { marketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME },
        },
        request,
      }),
      { ready: false, reason: "marketplace_missing" },
    );
    expectRequestMethodNotCalled(request, "plugin/read");
    expectRequestMethodNotCalled(request, "plugin/install");
    expectRequestMethodNotCalled(request, "marketplace/add");
  });

  it("prefers the official remote Computer Use marketplace over unrelated matches", async () => {
    const request = createComputerUseRequest({
      installed: false,
      remoteMarketplace: {
        name: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        pluginId: REMOTE_COMPUTER_USE_PLUGIN_ID,
      },
      additionalMarketplaceNames: ["workspace-tools"],
    });

    const status = await installCodexComputerUse({
      pluginConfig: { computerUse: {} },
      request,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      marketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
    });
    expect(request).toHaveBeenCalledWith("plugin/install", {
      remoteMarketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
      pluginName: REMOTE_COMPUTER_USE_PLUGIN_ID,
    });
    expectRequestMethodNotCalled(request, "marketplace/add");
  });

  it("waits for the default Codex marketplace during install", async () => {
    vi.useFakeTimers();
    const request = createComputerUseRequest({
      installed: false,
      marketplaceAvailableAfterListCalls: 3,
    });
    const installed = installCodexComputerUse({
      pluginConfig: { computerUse: {} },
      request,
    });

    await vi.advanceTimersByTimeAsync(4_000);

    const status = await installed;
    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      message: "Computer Use is ready.",
    });
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
      pluginName: "computer-use",
    });
    expect(
      vi.mocked(request).mock.calls.filter(([method]) => method === "plugin/list"),
    ).toHaveLength(3);
  });

  it("fails fast when Codex native plugins are disabled", async () => {
    vi.useFakeTimers();
    const request = createComputerUseRequest({
      installed: false,
      nativePluginsEnabled: false,
      marketplaceAvailableAfterListCalls: Number.POSITIVE_INFINITY,
    });
    const install = installCodexComputerUse({
      pluginConfig: { computerUse: {} },
      request,
    });
    const pending = expectSetupErrorStatus(install, {
      ready: false,
      reason: "marketplace_missing",
      message: expect.stringContaining("features.plugins = false"),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await pending;

    expect(requestCalls(request).filter(([method]) => method === "plugin/list")).toHaveLength(1);
    expect(
      requestCalls(request).filter(([method]) => method === "experimentalFeature/list"),
    ).toHaveLength(1);
    expectRequestMethodNotCalled(request, "plugin/install");
    await expect(install).rejects.toThrow("/codex computer-use install");
  });

  it("keeps waiting for marketplace discovery when the feature list does not report plugins", async () => {
    vi.useFakeTimers();
    const request = createComputerUseRequest({
      installed: false,
      nativePluginsEnabled: "absent",
      marketplaceAvailableAfterListCalls: 3,
    });
    const installed = installCodexComputerUse({
      pluginConfig: { computerUse: {} },
      request,
    });

    await vi.advanceTimersByTimeAsync(4_000);

    expectStatusFields(await installed, { ready: true, reason: "ready" });
    expect(requestCalls(request).filter(([method]) => method === "plugin/list")).toHaveLength(3);
    expect(
      requestCalls(request).filter(([method]) => method === "experimentalFeature/list"),
    ).toHaveLength(1);
  });

  it("does not read native plugin state when the marketplace is immediately available", async () => {
    const request = createComputerUseRequest({ installed: false });

    await installCodexComputerUse({ pluginConfig: { computerUse: {} }, request });

    expectRequestMethodNotCalled(request, "experimentalFeature/list");
  });

  it("prefers the official Computer Use marketplace when multiple matches are present", async () => {
    const request = createMultiMarketplaceComputerUseRequest();

    const status = await installCodexComputerUse({
      pluginConfig: { computerUse: {} },
      request,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      marketplaceName: "openai-curated",
    });
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: "/marketplaces/openai-curated/.agents/plugins/marketplace.json",
      pluginName: "computer-use",
    });
  });
});

function createComputerUseRequest(params: {
  installed: boolean;
  enabled?: boolean;
  nativePluginsEnabled?: boolean | "absent";
  marketplaceAvailableAfterListCalls?: number;
  liveTestFailures?: number;
  reloadFailures?: number;
  mcpToolsAvailable?: boolean;
  remoteMarketplace?: {
    name: string;
    pluginId?: string | null;
  };
  additionalMarketplaceNames?: readonly string[];
}): CodexComputerUseRequest {
  let installed = params.installed;
  let enabled = params.enabled ?? installed;
  let pluginListCalls = 0;
  let liveTestFailures = params.liveTestFailures ?? 0;
  let reloadFailures = params.reloadFailures ?? 0;
  let threadStartCalls = 0;
  const marketplaceName = params.remoteMarketplace?.name ?? "desktop-tools";
  const marketplacePath = params.remoteMarketplace
    ? null
    : `/marketplaces/${marketplaceName}/.agents/plugins/marketplace.json`;
  const source = params.remoteMarketplace ? "remote" : "local";
  const currentPluginSummary = () =>
    pluginSummary(installed, marketplaceName, enabled, source, params.remoteMarketplace?.pluginId);
  return vi.fn(async (method: string, requestParams?: unknown) => {
    if (method === "experimentalFeature/enablement/set") {
      return {
        enablement: params.nativePluginsEnabled === false ? {} : { plugins: true },
      };
    }
    if (method === "experimentalFeature/list") {
      return {
        data:
          params.nativePluginsEnabled === "absent"
            ? []
            : [{ name: "plugins", enabled: params.nativePluginsEnabled ?? true }],
        nextCursor: null,
      };
    }
    if (method === "marketplace/add") {
      return {
        marketplaceName: "desktop-tools",
        installedRoot: "/marketplaces/desktop-tools",
        alreadyAdded: false,
      };
    }
    if (method === "plugin/list") {
      pluginListCalls += 1;
      const marketplaceAvailable =
        pluginListCalls >= (params.marketplaceAvailableAfterListCalls ?? 1);
      return {
        marketplaces: marketplaceAvailable
          ? [
              ...(params.additionalMarketplaceNames ?? []).map((name) =>
                marketplaceEntry(name, false),
              ),
              {
                name: marketplaceName,
                path: marketplacePath,
                interface: null,
                plugins: [currentPluginSummary()],
              },
            ]
          : [],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      };
    }
    if (method === "plugin/read") {
      expect(requestParams).toEqual(
        params.remoteMarketplace
          ? {
              remoteMarketplaceName: marketplaceName,
              pluginName: params.remoteMarketplace.pluginId,
            }
          : { marketplacePath, pluginName: "computer-use" },
      );
      return {
        plugin: {
          marketplaceName,
          marketplacePath,
          summary: currentPluginSummary(),
          description: "Control desktop apps.",
          skills: [],
          apps: [],
          mcpServers: ["computer-use"],
        },
      };
    }
    if (method === "plugin/install") {
      if (params.remoteMarketplace) {
        expect(requestParams).toEqual({
          remoteMarketplaceName: marketplaceName,
          pluginName: params.remoteMarketplace.pluginId,
        });
      }
      installed = true;
      enabled = true;
      return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] };
    }
    if (method === "config/mcpServer/reload") {
      if (reloadFailures > 0) {
        reloadFailures -= 1;
        throw new Error("MCP runtime reload failed");
      }
      return undefined;
    }
    if (method === "mcpServerStatus/list") {
      return {
        data:
          installed && enabled
            ? [
                {
                  name: "computer-use",
                  tools:
                    params.mcpToolsAvailable === false
                      ? {}
                      : {
                          list_apps: {
                            name: "list_apps",
                            inputSchema: { type: "object" },
                          },
                        },
                  resources: [],
                  resourceTemplates: [],
                  authStatus: "unsupported",
                },
              ]
            : [],
        nextCursor: null,
      };
    }
    if (method === "thread/start") {
      threadStartCalls += 1;
      return {
        thread: {
          id: `computer-use-probe-thread-${threadStartCalls}`,
        },
        model: "gpt-5.1",
        modelProvider: "openai",
      };
    }
    if (method === "mcpServer/tool/call") {
      expect(requestParams).toEqual({
        threadId: `computer-use-probe-thread-${threadStartCalls}`,
        server: "computer-use",
        tool: "list_apps",
        arguments: {},
      });
      if (liveTestFailures > 0) {
        liveTestFailures -= 1;
        throw new Error("list_apps timed out");
      }
      return { content: [{ type: "text", text: "[]" }] };
    }
    if (method === "thread/unsubscribe" || method === "thread/archive") {
      expect(requestParams).toEqual({ threadId: `computer-use-probe-thread-${threadStartCalls}` });
      return undefined;
    }
    throw new Error(`unexpected request ${method}`);
  }) as CodexComputerUseRequest;
}

function createAmbiguousComputerUseRequest(): CodexComputerUseRequest {
  return vi.fn(async (method: string) => {
    if (method === "plugin/list") {
      return {
        marketplaces: [
          {
            name: "desktop-tools",
            path: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
            interface: null,
            plugins: [pluginSummary(true, "desktop-tools")],
          },
          {
            name: "other-tools",
            path: "/marketplaces/other-tools/.agents/plugins/marketplace.json",
            interface: null,
            plugins: [pluginSummary(true, "other-tools")],
          },
        ],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      };
    }
    throw new Error(`unexpected request ${method}`);
  }) as CodexComputerUseRequest;
}

function createEmptyMarketplaceComputerUseRequest(): CodexComputerUseRequest {
  return vi.fn(async (method: string) => {
    if (method === "plugin/list") {
      return {
        marketplaces: [],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      };
    }
    throw new Error(`unexpected request ${method}`);
  }) as CodexComputerUseRequest;
}

function createMultiMarketplaceComputerUseRequest(): CodexComputerUseRequest {
  let installed = false;
  let threadStartCalls = 0;
  return vi.fn(async (method: string, requestParams?: unknown) => {
    if (method === "experimentalFeature/enablement/set") {
      return { enablement: { plugins: true } };
    }
    if (method === "plugin/list") {
      return {
        marketplaces: [
          marketplaceEntry("workspace-tools", false),
          marketplaceEntry("openai-curated", installed),
        ],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      };
    }
    if (method === "plugin/read") {
      return {
        plugin: {
          marketplaceName: "openai-curated",
          marketplacePath: "/marketplaces/openai-curated/.agents/plugins/marketplace.json",
          summary: pluginSummary(installed, "openai-curated"),
          description: "Control desktop apps.",
          skills: [],
          apps: [],
          mcpServers: ["computer-use"],
        },
      };
    }
    if (method === "plugin/install") {
      expect(requestParams).toEqual({
        marketplacePath: "/marketplaces/openai-curated/.agents/plugins/marketplace.json",
        pluginName: "computer-use",
      });
      installed = true;
      return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] };
    }
    if (method === "config/mcpServer/reload") {
      return undefined;
    }
    if (method === "mcpServerStatus/list") {
      return {
        data: installed
          ? [
              {
                name: "computer-use",
                tools: {
                  list_apps: {
                    name: "list_apps",
                    inputSchema: { type: "object" },
                  },
                },
                resources: [],
                resourceTemplates: [],
                authStatus: "unsupported",
              },
            ]
          : [],
        nextCursor: null,
      };
    }
    if (method === "thread/start") {
      threadStartCalls += 1;
      return {
        thread: { id: `multi-marketplace-probe-thread-${threadStartCalls}` },
        model: "gpt-5.1",
        modelProvider: "openai",
      };
    }
    if (method === "mcpServer/tool/call") {
      return { content: [{ type: "text", text: "[]" }] };
    }
    if (method === "thread/unsubscribe" || method === "thread/archive") {
      return undefined;
    }
    throw new Error(`unexpected request ${method}`);
  }) as CodexComputerUseRequest;
}

function createBundledMarketplaceComputerUseRequest(
  bundledMarketplacePath: string,
  options: {
    configuredSource?: string;
    configuredSourceOrigin?: "system" | "user";
    configuredSourceProfile?: string;
  } = {},
): CodexComputerUseRequest {
  const codexHome = path.resolve(bundledMarketplacePath, "../../..");
  let configuredSource = options.configuredSource;
  let registered = configuredSource === bundledMarketplacePath;
  let installed = false;
  let threadStartCalls = 0;
  return vi.fn(async (method: string, requestParams?: unknown) => {
    if (method === "experimentalFeature/enablement/set") {
      return { enablement: { plugins: true } };
    }
    if (method === "config/read") {
      return {
        config: configuredSource
          ? {
              marketplaces: {
                "openai-bundled": { source_type: "local", source: configuredSource },
              },
            }
          : {},
        origins: configuredSource
          ? {
              "marketplaces.openai-bundled.source": {
                name:
                  options.configuredSourceOrigin === "system"
                    ? { type: "system", file: "/etc/codex/config.toml" }
                    : {
                        type: "user",
                        file: options.configuredSourceProfile
                          ? path.join(codexHome, `${options.configuredSourceProfile}.config.toml`)
                          : path.join(codexHome, "config.toml"),
                        profile: options.configuredSourceProfile ?? null,
                      },
                version: "legacy-config",
              },
            }
          : {},
        layers: null,
      };
    }
    if (method === "marketplace/remove") {
      expect(requestParams).toEqual({ marketplaceName: "openai-bundled" });
      configuredSource = undefined;
      registered = false;
      return { marketplaceName: "openai-bundled", installedRoot: null };
    }
    if (method === "marketplace/add") {
      expect(requestParams).toEqual({
        source: bundledMarketplacePath,
      });
      if (configuredSource && configuredSource !== bundledMarketplacePath) {
        throw new Error(
          "marketplace 'openai-bundled' is already added from a different source; remove it before adding this source | -32600",
        );
      }
      configuredSource = bundledMarketplacePath;
      registered = true;
      return {
        marketplaceName: "openai-bundled",
        installedRoot: bundledMarketplacePath,
        alreadyAdded: false,
      };
    }
    if (method === "plugin/list") {
      return {
        marketplaces: registered
          ? [
              {
                name: "openai-bundled",
                path: `${bundledMarketplacePath}/.agents/plugins/marketplace.json`,
                interface: null,
                plugins: [pluginSummary(installed, "openai-bundled")],
              },
            ]
          : [],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      };
    }
    if (method === "plugin/read") {
      return {
        plugin: {
          marketplaceName: "openai-bundled",
          marketplacePath: `${bundledMarketplacePath}/.agents/plugins/marketplace.json`,
          summary: pluginSummary(installed, "openai-bundled"),
          description: "Control desktop apps.",
          skills: [],
          apps: [],
          mcpServers: ["computer-use"],
        },
      };
    }
    if (method === "plugin/install") {
      installed = true;
      return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] };
    }
    if (method === "config/mcpServer/reload") {
      return undefined;
    }
    if (method === "mcpServerStatus/list") {
      return {
        data: installed
          ? [
              {
                name: "computer-use",
                tools: {
                  list_apps: {
                    name: "list_apps",
                    inputSchema: { type: "object" },
                  },
                },
                resources: [],
                resourceTemplates: [],
                authStatus: "unsupported",
              },
            ]
          : [],
        nextCursor: null,
      };
    }
    if (method === "thread/start") {
      threadStartCalls += 1;
      return {
        thread: { id: `bundled-marketplace-probe-thread-${threadStartCalls}` },
        model: "gpt-5.1",
        modelProvider: "openai",
      };
    }
    if (method === "mcpServer/tool/call") {
      return { content: [{ type: "text", text: "[]" }] };
    }
    if (method === "thread/unsubscribe" || method === "thread/archive") {
      return undefined;
    }
    throw new Error(`unexpected request ${method}`);
  }) as CodexComputerUseRequest;
}

function createManagedMarketplaceHarness(root: string): {
  agentDir: string;
  client: ReturnType<typeof createClientHarness>["client"];
  managedMarketplacePath: string;
} {
  const agentDir = path.join(root, "agent");
  const codexHome = path.join(agentDir, "codex-home");
  const managedMarketplacePath = path.join(
    codexHome,
    ".tmp",
    "bundled-marketplaces",
    "openai-bundled",
  );
  fs.mkdirSync(managedMarketplacePath, { recursive: true });
  const client = createClientHarness().client;
  vi.spyOn(client, "getRuntimeIdentity").mockReturnValue({
    serverVersion: "0.149.1",
    codexHome,
  });
  return { agentDir, client, managedMarketplacePath };
}

function marketplaceEntry(marketplaceName: string, installed: boolean) {
  return {
    name: marketplaceName,
    path: `/marketplaces/${marketplaceName}/.agents/plugins/marketplace.json`,
    interface: null,
    plugins: [pluginSummary(installed, marketplaceName)],
  };
}

function pluginSummary(
  installed: boolean,
  marketplaceName = "desktop-tools",
  enabled = installed,
  source: "local" | "remote" = "local",
  remotePluginId?: string | null,
) {
  return {
    id: `computer-use@${marketplaceName}`,
    ...(source === "remote" ? { remotePluginId: remotePluginId ?? null } : {}),
    name: "computer-use",
    source:
      source === "local"
        ? { type: "local", path: `/marketplaces/${marketplaceName}/plugins/computer-use` }
        : { type: "remote" },
    installed,
    enabled,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_INSTALL",
    interface: null,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
