import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mcpMocks = vi.hoisted(() => ({
  authorityResolvers: [] as Array<
    (options?: { signal?: AbortSignal }) => Promise<{
      tools: readonly (string | { name: string; pluginId?: string })[];
      provenance: { version: 1; source: "final-executable-surface" };
    }>
  >,
  captureCalls: [] as Array<{
    sourceNames: string[];
    storedNames: string[];
    provenance?: unknown;
  }>,
  dispose: vi.fn(async () => undefined),
  captureFacade: vi.fn(),
  staticFacade: vi.fn(),
  threadConfigFacade: vi.fn(),
  requesterCalls: 0,
  requesterParams: [] as Array<Record<string, unknown>>,
  staticDiagnosticNotice: undefined as string | undefined,
  staticFailure: undefined as Error | undefined,
  staticFailureGate: undefined as Promise<void> | undefined,
  staticCalls: [] as Array<Record<string, unknown>>,
  staticToolExecutes: [] as ReturnType<typeof vi.fn>[],
  threadConfigCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    materializeRequesterScopedMcpToolsForHarnessRun: async (
      ...args: Parameters<typeof actual.materializeRequesterScopedMcpToolsForHarnessRun>
    ) => {
      mcpMocks.requesterCalls += 1;
      mcpMocks.requesterParams.push(args[0] as Record<string, unknown>);
      return undefined;
    },
    loadCodexBundleMcpThreadConfig: async (
      ...args: Parameters<typeof actual.loadCodexBundleMcpThreadConfig>
    ) => {
      const params = args[0] as Record<string, unknown>;
      mcpMocks.threadConfigCalls.push(params);
      mcpMocks.threadConfigFacade(params);
      const cfg = params.cfg as
        | { mcp?: { servers?: Record<string, Record<string, unknown>> } }
        | undefined;
      const configuredServers = cfg?.mcp?.servers ?? {};
      const staticServerNames = Object.keys(configuredServers).toSorted();
      return {
        configPatch: staticServerNames.length > 0 ? { mcp_servers: configuredServers } : undefined,
        diagnostics: [],
        evaluated: true,
        fingerprint: staticServerNames.length > 0 ? "configured-mcp-test-fixture" : undefined,
        staticServerNames,
        userStaticServerNames: staticServerNames,
      };
    },
  };
});

vi.mock("openclaw/plugin-sdk/codex-mcp-projection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/codex-mcp-projection")>();
  return {
    ...actual,
    runWithCronCreatorAuthorityResolver: <T>(params: {
      resolve: (options?: { signal?: AbortSignal }) => Promise<{
        tools: readonly (string | { name: string; pluginId?: string })[];
        provenance: { version: 1; source: "final-executable-surface" };
      }>;
      run: () => T;
    }) => {
      mcpMocks.authorityResolvers.push(params.resolve);
      return params.run();
    },
    materializeStaticMcpToolsForScheduledHarnessRun: async (params: Record<string, unknown>) => {
      mcpMocks.staticCalls.push(params);
      mcpMocks.staticFacade(params);
      if (mcpMocks.staticFailure) {
        await mcpMocks.staticFailureGate;
        throw mcpMocks.staticFailure;
      }
      const execute = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "initial-result" }],
        details: { status: "ok" },
      }));
      mcpMocks.staticToolExecutes.push(execute);
      return {
        tools: mcpMocks.staticDiagnosticNotice
          ? []
          : [
              {
                name: "fake__show",
                description: "Show the configured MCP fixture result.",
                parameters: { type: "object", properties: {} },
                execute,
              },
            ],
        ...(mcpMocks.staticDiagnosticNotice
          ? { diagnosticNotice: mcpMocks.staticDiagnosticNotice }
          : {}),
        dispose: async () => {
          await mcpMocks.dispose();
        },
      };
    },
    captureFinalCodexCronCreatorToolAllowlist: async (
      ...args: Parameters<typeof actual.captureFinalCodexCronCreatorToolAllowlist>
    ) => {
      const [target, captureRef, tools] = args;
      mcpMocks.captureFacade(target, captureRef, tools);
      target.length = 0;
      for (const tool of tools) {
        if (
          !target.some((entry) => (typeof entry === "string" ? entry : entry.name) === tool.name)
        ) {
          target.push({ name: tool.name });
        }
      }
      captureRef.value = { version: 1, source: "final-executable-surface" };
      mcpMocks.captureCalls.push({
        sourceNames: tools.map((tool) => tool.name).toSorted(),
        storedNames: target
          .map((entry) => (typeof entry === "string" ? entry : entry.name))
          .toSorted(),
        provenance: captureRef.value,
      });
    },
  };
});

import {
  createParams,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

beforeEach(() => {
  mcpMocks.authorityResolvers.length = 0;
  mcpMocks.captureCalls.length = 0;
  mcpMocks.staticCalls.length = 0;
  mcpMocks.staticToolExecutes.length = 0;
  mcpMocks.requesterCalls = 0;
  mcpMocks.requesterParams.length = 0;
  mcpMocks.threadConfigCalls.length = 0;
  mcpMocks.staticDiagnosticNotice = undefined;
  mcpMocks.staticFailure = undefined;
  mcpMocks.staticFailureGate = undefined;
  mcpMocks.dispose.mockClear();
  mcpMocks.captureFacade.mockClear();
  mcpMocks.staticFacade.mockClear();
  mcpMocks.threadConfigFacade.mockClear();
});

function configureFakeMcp(params: ReturnType<typeof createParams>): void {
  setCodexTestModelSupportsTools(params, true);
  params.cleanupBundleMcpOnRunEnd = true;
  params.runtimePlan = createCodexRuntimePlanFixture();
  params.preparedModelRuntime = {
    metadataSnapshot: { manifestRegistry: { plugins: [] } },
  } as never;
  params.config = {
    ...params.config,
    mcp: {
      servers: {
        fake: {
          command: process.execPath,
          args: [path.resolve("scripts/e2e/mcp-app-conformance-server.mjs")],
          codex: { defaultToolsApprovalMode: "prompt" },
        },
      },
    },
  };
}

describe("runCodexAppServerAttempt configured MCP ownership", () => {
  it("does not replace bundle discovery with partial prepared plugin metadata", async () => {
    const sessionFile = path.join(tempDir, "session-partial-manifest-registry.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-partial-registry"));
    configureFakeMcp(params);
    const manifestRegistry = { plugins: [] };
    params.preparedModelRuntime = {
      metadataSnapshot: { manifestRegistry, pluginIds: ["codex"] },
    } as never;

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(mcpMocks.threadConfigCalls[0]?.manifestRegistry).toBeUndefined();

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("projects scheduled static MCP dynamically under the exact stored cap", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-static-mcp.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-scheduled-static-mcp"));
    configureFakeMcp(params);
    params.trigger = "cron";
    params.toolsAllow = ["*"];
    params.scheduledToolPolicy = { version: 1, mode: "trusted" };

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
      },
    });
    await harness.waitForMethod("turn/start");

    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as { config?: Record<string, unknown>; dynamicTools?: unknown } | undefined;
    expect(mcpMocks.requesterCalls).toBe(0);
    expect(mcpMocks.threadConfigCalls[0]?.manifestRegistry).toBe(
      params.preparedModelRuntime?.metadataSnapshot.manifestRegistry,
    );
    expect(mcpMocks.threadConfigFacade).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: params.workspaceDir,
        cfg: params.config,
        toolsAllow: ["*"],
        manifestRegistry: params.preparedModelRuntime?.metadataSnapshot.manifestRegistry,
      }),
    );
    expect(mcpMocks.staticCalls).toHaveLength(1);
    expect(threadStart?.config).not.toHaveProperty("mcp_servers");
    expect(JSON.stringify(threadStart?.config ?? {})).not.toContain("fake-mcp");
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).toContain("fake__show");
    expect(mcpMocks.staticCalls[0]).not.toHaveProperty("requesterSenderId");
    expect(mcpMocks.staticCalls[0]).toMatchObject({
      toolsAllow: ["*"],
      manifestRegistry: params.preparedModelRuntime?.metadataSnapshot.manifestRegistry,
      autoApproveCodexAppServerApprovals: true,
    });
    expect(mcpMocks.staticFacade).toHaveBeenCalledWith(mcpMocks.staticCalls[0]);

    const toolResult = await harness.handleServerRequest({
      id: "request-fake-ping",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-fake-ping",
        namespace: null,
        tool: "fake__show",
        arguments: {},
      },
    });
    expect(toolResult).toMatchObject({ success: true });
    expect(JSON.stringify(toolResult)).toContain("initial-result");
    expect(mcpMocks.staticToolExecutes[0]).toHaveBeenCalledOnce();

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(mcpMocks.captureCalls).toHaveLength(1);
    expect(mcpMocks.captureCalls[0]).toMatchObject({
      sourceNames: expect.arrayContaining(["fake__show"]),
      storedNames: expect.arrayContaining(["fake__show"]),
      provenance: { version: 1, source: "final-executable-surface" },
    });
    expect(mcpMocks.captureCalls[0]!.storedNames).toEqual(mcpMocks.captureCalls[0]!.sourceNames);
    expect(mcpMocks.captureFacade).toHaveBeenCalledOnce();
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding).toMatchObject({ configuredMcpOwnershipVersion: 1 });
    expect(binding).not.toHaveProperty("mcpServersFingerprint");
    expect(binding).not.toHaveProperty("userMcpServersFingerprint");
  });

  it("keeps ordinary configured MCP native without probing or stamping its inventory", async () => {
    const sessionFile = path.join(tempDir, "session-native-mcp-auth-failure.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-native-mcp-auth-failure"),
    );
    configureFakeMcp(params);

    const harness = createStartedThreadHarness(async (method) => {
      if (method === "mcpServerStatus/list") {
        return {
          data: [
            {
              name: "fake",
              serverInfo: null,
              authStatus: "notLoggedIn",
              tools: {},
            },
          ],
          nextCursor: null,
        };
      }
      return undefined;
    });
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();

    expect(harness.requests.map((request) => request.method)).not.toContain("mcpServerStatus/list");
    expect(mcpMocks.staticCalls).toHaveLength(0);
    expect(mcpMocks.requesterParams[0]?.manifestRegistry).toBe(
      params.preparedModelRuntime?.metadataSnapshot.manifestRegistry,
    );
    expect(mcpMocks.captureCalls).toHaveLength(1);
    expect(mcpMocks.captureCalls[0]!.storedNames).not.toContain("fake__show");
  });

  it("captures a restricted ordinary turn without inventing intentionally disabled native MCP", async () => {
    const sessionFile = path.join(tempDir, "session-native-mcp-restricted.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-native-mcp-restricted"));
    configureFakeMcp(params);
    params.toolsAllow = ["cron", "fake__show"];

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();

    expect(harness.requests.map((request) => request.method)).not.toContain("mcpServerStatus/list");
    expect(mcpMocks.staticCalls).toHaveLength(0);
    expect(mcpMocks.captureCalls).toHaveLength(1);
    expect(mcpMocks.captureCalls[0]!.storedNames).not.toContain("fake__show");
    expect(mcpMocks.captureCalls[0]!.provenance).toEqual({
      version: 1,
      source: "final-executable-surface",
    });
  });

  it("lazily snapshots configured MCP through the local-operator resolver without replacing native MCP", async () => {
    const sessionFile = path.join(tempDir, "session-local-operator-mutation.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-local-operator-mutation"),
    );
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = true;

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as { config?: Record<string, unknown>; dynamicTools?: unknown } | undefined;
    expect(JSON.stringify(threadStart?.config ?? {})).toContain("fake");
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).not.toContain("fake__show");
    expect(mcpMocks.staticCalls).toHaveLength(0);

    expect(mcpMocks.authorityResolvers).toHaveLength(2);
    const authority = await mcpMocks.authorityResolvers[0]!();
    expect(authority.provenance).toEqual({ version: 1, source: "final-executable-surface" });
    expect(
      authority.tools.map((entry) => (typeof entry === "string" ? entry : entry.name)),
    ).toContain("fake__show");
    expect(mcpMocks.staticCalls).toHaveLength(1);
    expect(mcpMocks.staticCalls[0]).toMatchObject({
      sessionId: `cron-authority:${params.runId}`,
      manifestRegistry: params.preparedModelRuntime?.metadataSnapshot.manifestRegistry,
      retireSessionRuntimeAfterDispose: true,
    });
    expect(mcpMocks.staticCalls[0]).not.toHaveProperty("sessionKey");
    expect(mcpMocks.captureCalls.at(-1)?.storedNames).toContain("fake__show");
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("rematerializes after one cron operation aborts pending materialization", async () => {
    const sessionFile = path.join(tempDir, "session-local-operator-aborted-mutation.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-local-operator-aborted-mutation"),
    );
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = true;

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const resolver = mcpMocks.authorityResolvers[0]!;
    const firstOperation = new AbortController();
    const firstResolution = resolver({ signal: firstOperation.signal });
    firstOperation.abort(new Error("first cron call timed out"));

    await expect(firstResolution).rejects.toThrow("first cron call timed out");
    const secondResolution = await resolver({ signal: new AbortController().signal });

    expect(
      secondResolution.tools.map((entry) => (typeof entry === "string" ? entry : entry.name)),
    ).toContain("fake__show");
    expect(mcpMocks.staticCalls).toHaveLength(2);
    expect(mcpMocks.dispose).toHaveBeenCalledTimes(2);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("shares one configured-MCP materialization across concurrent active cron operations", async () => {
    const sessionFile = path.join(tempDir, "session-local-operator-concurrent-mutation.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-local-operator-concurrent-mutation"),
    );
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = true;

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const resolver = mcpMocks.authorityResolvers[0]!;
    const firstResolution = resolver({ signal: new AbortController().signal });
    const secondResolution = resolver({ signal: new AbortController().signal });

    expect(secondResolution).toBe(firstResolution);
    const [first, second] = await Promise.all([firstResolution, secondResolution]);
    expect(second).toBe(first);
    expect(mcpMocks.staticCalls).toHaveLength(1);
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("retains an unrelated cached timeout when its operation signal aborts concurrently", async () => {
    const sessionFile = path.join(tempDir, "session-local-operator-unrelated-timeout.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-local-operator-unrelated-timeout"),
    );
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = true;
    let releaseFailure!: () => void;
    mcpMocks.staticFailureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    mcpMocks.staticFailure = Object.assign(new Error("configured MCP materialization timed out"), {
      name: "TimeoutError",
    });

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const resolver = mcpMocks.authorityResolvers[0]!;
    const operation = new AbortController();
    const firstResolution = resolver({ signal: operation.signal });
    operation.abort(new Error("cron tool call was cancelled"));
    releaseFailure();

    await expect(firstResolution).rejects.toThrow("configured MCP materialization timed out");
    const secondResolution = resolver({ signal: new AbortController().signal });
    expect(secondResolution).toBe(firstResolution);
    await expect(secondResolution).rejects.toThrow("configured MCP materialization timed out");
    expect(mcpMocks.staticCalls).toHaveLength(1);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("keeps static discovery failures visible without stamping inherited authority", async () => {
    const sessionFile = path.join(tempDir, "session-static-mcp-discovery-failure.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-static-mcp-discovery-failure"),
    );
    configureFakeMcp(params);
    params.trigger = "cron";
    params.toolsAllow = ["*"];
    params.scheduledToolPolicy = { version: 1, mode: "trusted" };
    mcpMocks.staticDiagnosticNotice =
      "Configured MCP is incomplete for this scheduled run: fake: authentication required. " +
      "Do not claim MCP-backed work succeeded; report this blocker to the operator.";

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    expect(JSON.stringify(threadStart?.params)).toContain("fake: authentication required");
    expect(mcpMocks.captureCalls).toHaveLength(1);
    expect(mcpMocks.captureCalls[0]!.storedNames).not.toContain("fake__show");

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();
  });
});
