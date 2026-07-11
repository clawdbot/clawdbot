// Codex tests cover computer use plugin behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { acquireCodexNativeConfigFence } from "./native-config-fence.js";
import { resolveCodexNativeConfigFenceKey } from "./shared-client.js";
import { createClientHarness } from "./test-support.js";

const requestCodexAppServerJsonMock = vi.hoisted(() => vi.fn());
const sharedClientMocks = vi.hoisted(() => ({
  getLeasedSharedCodexAppServerClient: vi.fn(),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
}));

vi.mock("./request.js", () => ({
  requestCodexAppServerJson: requestCodexAppServerJsonMock,
}));

vi.mock("./shared-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared-client.js")>()),
  ...sharedClientMocks,
}));

import {
  ensureCodexComputerUse,
  installCodexComputerUse,
  readCodexComputerUseStatus,
  testing,
  type CodexComputerUseStatus,
  type CodexComputerUseRequest,
} from "./computer-use.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

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
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockReset();
    sharedClientMocks.releaseLeasedSharedCodexAppServerClient.mockReset();
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
        sandbox: "danger-full-access",
        approvalPolicy: "never",
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

  it("repairs stale Computer Use MCP children and retries the live test once", async () => {
    const request = createComputerUseRequest({ installed: true, liveTestFailures: 1 });
    const repairComputerUseMcpChildren = vi.fn(async () => ({
      attempted: true,
      killedPids: [1234],
      warnings: [],
      message: "Terminated 1 stale Computer Use MCP child process.",
    }));

    const status = await readCodexComputerUseStatus({
      pluginConfig: {
        computerUse: { enabled: true, marketplaceName: "desktop-tools", autoRepair: true },
      },
      request,
      repairComputerUseMcpChildren,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      message: "Computer Use is ready.",
    });
    expect(status.liveTest).toMatchObject({
      status: "passed",
      attempts: 2,
      retried: true,
      repaired: true,
    });
    expect(status.repair).toMatchObject({
      attempted: true,
      killedPids: [1234],
    });
    expect(repairComputerUseMcpChildren).toHaveBeenCalledTimes(1);
    expect(
      requestCalls(request).filter(([method]) => method === "mcpServer/tool/call"),
    ).toHaveLength(2);
  });

  it("does not repair stale Computer Use MCP children unless autoRepair is enabled", async () => {
    const request = createComputerUseRequest({ installed: true, liveTestFailures: 2 });
    const repairComputerUseMcpChildren = vi.fn(async () => ({
      attempted: true,
      killedPids: [],
      warnings: [],
      message: "No stale Computer Use MCP children were found.",
    }));

    const status = await readCodexComputerUseStatus({
      pluginConfig: { computerUse: { enabled: true, marketplaceName: "desktop-tools" } },
      request,
      repairComputerUseMcpChildren,
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
    expect(repairComputerUseMcpChildren).not.toHaveBeenCalled();
  });

  it("surfaces install, exposure, and live-test layers separately when the live test fails", async () => {
    const request = createComputerUseRequest({ installed: true, liveTestFailures: 2 });
    const repairComputerUseMcpChildren = vi.fn(async () => ({
      attempted: true,
      killedPids: [],
      warnings: [],
      message: "No stale Computer Use MCP children were found.",
    }));

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
      repairComputerUseMcpChildren,
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
    expect(repairComputerUseMcpChildren).toHaveBeenCalledTimes(1);
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
      repairComputerUseMcpChildren: vi.fn(async () => ({
        attempted: true,
        killedPids: [],
        warnings: [],
        message: "No stale Computer Use MCP children were found.",
      })),
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

  it("parses process trees so repair can stay scoped to the app-server child tree", () => {
    const processes = testing.parsePsOutput(`
      100 1 /Applications/Codex.app/Contents/MacOS/Codex app-server
      101 100 /Applications/Codex.app/Contents/Frameworks/SkyComputerUseClient mcp
      102 1 /Applications/Codex.app/Contents/Frameworks/SkyComputerUseClient mcp
      103 101 helper
    `);

    expect(processes).toContainEqual({
      pid: 101,
      ppid: 100,
      command: "/Applications/Codex.app/Contents/Frameworks/SkyComputerUseClient mcp",
    });
    expect(testing.isDescendantOfPid(101, 100, processes)).toBe(true);
    expect(testing.isDescendantOfPid(103, 100, processes)).toBe(true);
    expect(testing.isDescendantOfPid(102, 100, processes)).toBe(false);
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

  it("fails closed instead of installing from a remote-only Codex marketplace", async () => {
    const request = createRemoteOnlyComputerUseRequest();

    await expectSetupErrorStatus(
      installCodexComputerUse({
        pluginConfig: { computerUse: { marketplaceName: "openai-curated" } },
        request,
      }),
      {
        ready: false,
        reason: "remote_install_unsupported",
        installed: false,
        pluginEnabled: false,
        marketplaceName: "openai-curated",
        message:
          "Computer Use is available in remote Codex marketplace openai-curated, but Codex app-server does not support remote plugin install yet. Configure computerUse.marketplaceSource or computerUse.marketplacePath for a local marketplace, then run /codex computer-use install.",
      },
    );
    expectRequestMethodNotCalled(request, "plugin/install");
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
  marketplaceAvailableAfterListCalls?: number;
  liveTestFailures?: number;
}): CodexComputerUseRequest {
  let installed = params.installed;
  let enabled = params.enabled ?? installed;
  let pluginListCalls = 0;
  let liveTestFailures = params.liveTestFailures ?? 0;
  let threadStartCalls = 0;
  return vi.fn(async (method: string, requestParams?: unknown) => {
    if (method === "experimentalFeature/enablement/set") {
      return { enablement: { plugins: true } };
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
              {
                name: "desktop-tools",
                path: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
                interface: null,
                plugins: [pluginSummary(installed, "desktop-tools", enabled)],
              },
            ]
          : [],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      };
    }
    if (method === "plugin/read") {
      expect(requireRecord(requestParams, "plugin read params").pluginName).toBe("computer-use");
      return {
        plugin: {
          marketplaceName: "desktop-tools",
          marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
          summary: pluginSummary(installed, "desktop-tools", enabled),
          description: "Control desktop apps.",
          skills: [],
          apps: [],
          mcpServers: ["computer-use"],
        },
      };
    }
    if (method === "plugin/install") {
      installed = true;
      enabled = true;
      return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] };
    }
    if (method === "config/mcpServer/reload") {
      return undefined;
    }
    if (method === "mcpServerStatus/list") {
      return {
        data:
          installed && enabled
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

function createRemoteOnlyComputerUseRequest(): CodexComputerUseRequest {
  return vi.fn(async (method: string, requestParams?: unknown) => {
    if (method === "experimentalFeature/enablement/set") {
      return { enablement: { plugins: true } };
    }
    if (method === "plugin/list") {
      return {
        marketplaces: [
          {
            name: "openai-curated",
            path: null,
            interface: null,
            plugins: [pluginSummary(false, "openai-curated", false, "remote")],
          },
        ],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      };
    }
    if (method === "plugin/read") {
      expect(requestParams).toEqual({
        remoteMarketplaceName: "openai-curated",
        pluginName: "computer-use",
      });
      return {
        plugin: {
          marketplaceName: "openai-curated",
          marketplacePath: null,
          summary: pluginSummary(false, "openai-curated", false, "remote"),
          description: "Control desktop apps.",
          skills: [],
          apps: [],
          mcpServers: ["computer-use"],
        },
      };
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
): CodexComputerUseRequest {
  let registered = false;
  let installed = false;
  let threadStartCalls = 0;
  return vi.fn(async (method: string, requestParams?: unknown) => {
    if (method === "experimentalFeature/enablement/set") {
      return { enablement: { plugins: true } };
    }
    if (method === "marketplace/add") {
      expect(requestParams).toEqual({
        source: bundledMarketplacePath,
      });
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
) {
  return {
    id: `computer-use@${marketplaceName}`,
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
