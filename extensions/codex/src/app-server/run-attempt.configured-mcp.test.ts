import path from "node:path";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
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
  captureRefs: [] as Array<{
    value?: { version: 1; source: "final-executable-surface" };
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
  suppressThreadConfig: false,
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
      if (mcpMocks.suppressThreadConfig) {
        return {
          configPatch: undefined,
          diagnostics: [],
          evaluated: true,
          fingerprint: undefined,
          staticServerNames: [],
          userStaticServerNames: [],
        };
      }
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
    runWithCronCreatorAuthorityCapabilityResolver: (
      params: Parameters<typeof actual.runWithCronCreatorAuthorityCapabilityResolver>[0],
    ) => {
      if (
        params.capability?.active !== true ||
        !params.runId ||
        params.capability.runId !== params.runId
      ) {
        return actual.runWithCronCreatorAuthorityCapabilityResolver(params as never);
      }
      mcpMocks.authorityResolvers.push(params.resolve);
      return actual.runWithCronCreatorAuthorityCapabilityResolver(params as never);
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
        appTools: [
          {
            name: "fake__app_only",
            description: "App-view-only configured MCP fixture.",
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
      mcpMocks.captureRefs.push(captureRef);
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
  assistantMessage,
  createParams,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  userMessage,
} from "./run-attempt-test-harness.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

beforeEach(() => {
  mcpMocks.authorityResolvers.length = 0;
  mcpMocks.captureCalls.length = 0;
  mcpMocks.captureRefs.length = 0;
  mcpMocks.staticCalls.length = 0;
  mcpMocks.staticToolExecutes.length = 0;
  mcpMocks.requesterCalls = 0;
  mcpMocks.requesterParams.length = 0;
  mcpMocks.threadConfigCalls.length = 0;
  mcpMocks.staticDiagnosticNotice = undefined;
  mcpMocks.staticFailure = undefined;
  mcpMocks.staticFailureGate = undefined;
  mcpMocks.suppressThreadConfig = false;
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
    metadataSnapshot: { manifestRegistry: { plugins: [] }, plugins: [] },
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

function createCronAuthorityCapabilityFixture(
  runId: string,
): NonNullable<ReturnType<typeof createParams>["cronCreatorAuthorityCapability"]> {
  // Mirror the gateway-minted capability instead of casting a partial fixture;
  // transcript tools consume callerOrigin and future contract drift must type-fail.
  const abortController = new AbortController();
  return {
    active: true,
    abort: () => abortController.abort(),
    callerOrigin: { kind: "local" },
    grantTokens: new Set<string>(),
    runId,
    signal: abortController.signal,
  };
}

function admitLocalOperatorCronAuthority(params: ReturnType<typeof createParams>): void {
  params.cronCreatorAuthorityCapability = createCronAuthorityCapabilityFixture(params.runId);
}

describe("runCodexAppServerAttempt configured MCP ownership", () => {
  it("does not replace bundle discovery with partial prepared plugin metadata", async () => {
    const sessionFile = path.join(tempDir, "session-partial-manifest-registry.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-partial-registry"));
    configureFakeMcp(params);
    const manifestRegistry = { plugins: [] };
    params.preparedModelRuntime = {
      metadataSnapshot: { manifestRegistry, pluginIds: ["codex"], plugins: [] },
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

  it("preserves bounded canonical continuity when scheduled MCP replaces ordinary ownership", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-mcp-ownership-continuity.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-scheduled-mcp-ownership-continuity");
    const cutoff = Date.now();
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-ordinary",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      mcpServersFingerprint: "configured-mcp-test-fixture",
      historyCoveredThrough: new Date(cutoff).toISOString(),
    });
    const sessionManager = openFileBackedSessionManagerForTest(sessionFile, {
      sessionId: "session-1",
    });
    sessionManager.appendMessage(userMessage("ordinary-thread covered context", cutoff - 1_000));
    for (let index = 0; index < 10; index += 1) {
      sessionManager.appendMessage(
        assistantMessage(
          `scheduled ownership continuity block ${index}: ${"x".repeat(128_000)}`,
          cutoff + 2_000 + index,
        ),
      );
    }
    sessionManager.appendMessage(userMessage("new scheduled ownership question", cutoff + 20_000));
    sessionManager.appendMessage(
      assistantMessage("recent scheduled ownership answer", cutoff + 21_000),
    );

    const params = createParams(sessionFile, workspaceDir);
    configureFakeMcp(params);
    params.prompt = "continue after the scheduled ownership transition";
    params.trigger = "cron";
    params.toolsAllow = ["*"];
    params.scheduledToolPolicy = { version: 1, mode: "trusted" };
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
          threadId: "thread-ordinary",
        });
      }
      return undefined;
    });

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
      },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(harness.requests.map((request) => request.method)).toContain("thread/start");
    expect(harness.requests.map((request) => request.method)).not.toContain("thread/resume");
    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const inputText =
      (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]?.text ??
      "";
    expect(inputText.length).toBeLessThanOrEqual(1 << 20);
    expect(inputText).toContain("OpenClaw assembled context for this turn:");
    expect(inputText).toContain("new scheduled ownership question");
    expect(inputText).toContain("recent scheduled ownership answer");
    expect(inputText).toContain("Current user request:");
    expect(inputText).toContain("continue after the scheduled ownership transition");
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-1",
      configuredMcpOwnershipVersion: 1,
    });
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

  it("keeps ordinary configured MCP when dynamic native tools are restricted", async () => {
    const sessionFile = path.join(tempDir, "session-native-mcp-restricted.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-native-mcp-restricted"));
    configureFakeMcp(params);
    params.toolsAllow = ["cron", "fake__show"];
    mcpMocks.suppressThreadConfig = true;

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as { config?: { mcp_servers?: Record<string, unknown> } } | undefined;
    expect(threadStart?.config?.mcp_servers).toHaveProperty("fake");
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

  it("does not project host MCP into a sandbox without the native tool surface", async () => {
    const sessionFile = path.join(tempDir, "session-native-mcp-sandboxed.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-native-mcp-sandboxed"));
    configureFakeMcp(params);
    params.sandbox = createSandboxContext({});
    mcpMocks.suppressThreadConfig = true;

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as { config?: { mcp_servers?: Record<string, unknown> } } | undefined;
    expect(threadStart?.config?.mcp_servers).toBeUndefined();
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("withholds final provenance when a sender-attributed turn cannot snapshot native MCP", async () => {
    const sessionFile = path.join(tempDir, "session-sender-attributed-mcp.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-sender-attributed-mcp"));
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = true;
    params.senderId = "external-sender";

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();

    expect(mcpMocks.authorityResolvers).toHaveLength(0);
    expect(mcpMocks.captureRefs).toHaveLength(1);
    expect(mcpMocks.captureRefs[0]!.value).toBeUndefined();
    expect(mcpMocks.captureCalls[0]!.storedNames).not.toContain("fake__show");
  });

  it.each([
    { name: "missing", capabilityRunId: undefined },
    { name: "wrong-run", capabilityRunId: "other-run" },
  ])(
    "does not bind $name local-operator authority at Codex tool construction",
    async (testCase) => {
      const sessionFile = path.join(tempDir, `session-local-operator-${testCase.name}.jsonl`);
      const params = createParams(
        sessionFile,
        path.join(tempDir, `workspace-local-operator-${testCase.name}`),
      );
      configureFakeMcp(params);
      params.trigger = "user";
      params.senderIsOwner = false;
      if (testCase.capabilityRunId) {
        params.cronCreatorAuthorityCapability = createCronAuthorityCapabilityFixture(
          testCase.capabilityRunId,
        );
      }

      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await expect(run).resolves.toBeDefined();

      expect(mcpMocks.authorityResolvers).toHaveLength(0);
    },
  );

  it("lazily snapshots configured MCP through the local-operator resolver without replacing native MCP", async () => {
    const sessionFile = path.join(tempDir, "session-local-operator-mutation.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-local-operator-mutation"),
    );
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = false;
    admitLocalOperatorCronAuthority(params);

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as { config?: Record<string, unknown>; dynamicTools?: unknown } | undefined;
    expect(JSON.stringify(threadStart?.config ?? {})).toContain("fake");
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).toContain("automations");
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).not.toContain("fake__show");
    expect(mcpMocks.staticCalls).toHaveLength(0);

    expect(mcpMocks.authorityResolvers).toHaveLength(2);
    const authority = await mcpMocks.authorityResolvers[0]!();
    expect(authority.provenance).toEqual({ version: 1, source: "final-executable-surface" });
    expect(
      authority.tools.map((entry) => (typeof entry === "string" ? entry : entry.name)),
    ).toContain("fake__show");
    expect(
      authority.tools.map((entry) => (typeof entry === "string" ? entry : entry.name)),
    ).not.toContain("fake__app_only");
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

  it("offers explicit finite tools when inherited configured MCP discovery is incomplete", async () => {
    const sessionFile = path.join(tempDir, "session-local-operator-incomplete-mcp.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-local-operator-incomplete-mcp"),
    );
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = true;
    admitLocalOperatorCronAuthority(params);
    mcpMocks.staticDiagnosticNotice =
      "Configured MCP is incomplete for this scheduled run: fake: authentication required.";

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    await expect(mcpMocks.authorityResolvers[0]!()).rejects.toThrow(
      "provide an explicit finite toolsAllow list containing only currently visible tools",
    );
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
    admitLocalOperatorCronAuthority(params);

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
    admitLocalOperatorCronAuthority(params);

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
    admitLocalOperatorCronAuthority(params);
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

    await expect(firstResolution).rejects.toThrow(
      "provide an explicit finite toolsAllow list containing only currently visible tools",
    );
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
