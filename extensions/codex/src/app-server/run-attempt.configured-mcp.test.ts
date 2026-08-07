import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mcpMocks = vi.hoisted(() => ({
  captureCalls: [] as Array<{
    sourceNames: string[];
    storedNames: string[];
    provenance?: unknown;
  }>,
  dispose: vi.fn(async () => undefined),
  requesterCalls: 0,
  staticDiagnosticNotice: undefined as string | undefined,
  staticCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    materializeRequesterScopedMcpToolsForHarnessRun: async (
      ...args: Parameters<typeof actual.materializeRequesterScopedMcpToolsForHarnessRun>
    ) => {
      mcpMocks.requesterCalls += 1;
      return await actual.materializeRequesterScopedMcpToolsForHarnessRun(...args);
    },
  };
});

vi.mock("openclaw/plugin-sdk/codex-mcp-projection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/codex-mcp-projection")>();
  return {
    ...actual,
    materializeStaticMcpToolsForScheduledHarnessRun: async (params: Record<string, unknown>) => {
      mcpMocks.staticCalls.push(params);
      const materialized = await actual.materializeStaticMcpToolsForScheduledHarnessRun(
        params as Parameters<typeof actual.materializeStaticMcpToolsForScheduledHarnessRun>[0],
      );
      return {
        ...materialized,
        ...(mcpMocks.staticDiagnosticNotice
          ? { diagnosticNotice: mcpMocks.staticDiagnosticNotice }
          : {}),
        dispose: async () => {
          await materialized.dispose();
          await mcpMocks.dispose();
        },
      };
    },
    captureFinalCodexCronCreatorToolAllowlist: async (
      ...args: Parameters<typeof actual.captureFinalCodexCronCreatorToolAllowlist>
    ) => {
      await actual.captureFinalCodexCronCreatorToolAllowlist(...args);
      const [target, captureRef, tools] = args;
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
  mcpMocks.captureCalls.length = 0;
  mcpMocks.staticCalls.length = 0;
  mcpMocks.requesterCalls = 0;
  mcpMocks.staticDiagnosticNotice = undefined;
  mcpMocks.dispose.mockClear();
});

function configureFakeMcp(params: ReturnType<typeof createParams>): void {
  setCodexTestModelSupportsTools(params, true);
  params.runtimePlan = createCodexRuntimePlanFixture();
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
    expect(mcpMocks.staticCalls).toHaveLength(1);
    expect(threadStart?.config).not.toHaveProperty("mcp_servers");
    expect(JSON.stringify(threadStart?.config ?? {})).not.toContain("fake-mcp");
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).toContain("fake__show");
    expect(mcpMocks.staticCalls[0]).not.toHaveProperty("requesterSenderId");
    expect(mcpMocks.staticCalls[0]).toMatchObject({
      toolsAllow: ["*"],
      autoApproveCodexAppServerApprovals: true,
    });

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

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(mcpMocks.captureCalls).toHaveLength(1);
    expect(mcpMocks.captureCalls[0]).toMatchObject({
      sourceNames: expect.arrayContaining(["fake__show"]),
      storedNames: expect.arrayContaining(["fake__show"]),
      provenance: { version: 1, source: "final-executable-surface" },
    });
    expect(mcpMocks.captureCalls[0]!.storedNames).toEqual(mcpMocks.captureCalls[0]!.sourceNames);
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding).toMatchObject({ configuredMcpOwnershipVersion: 1 });
    expect(binding).not.toHaveProperty("mcpServersFingerprint");
    expect(binding).not.toHaveProperty("userMcpServersFingerprint");
  });

  it("keeps an ordinary turn running without stamping failed native inventory", async () => {
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

    expect(harness.requests.map((request) => request.method)).toContain("mcpServerStatus/list");
    expect(mcpMocks.staticCalls).toHaveLength(0);
    expect(mcpMocks.captureCalls).toHaveLength(0);
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
    expect(mcpMocks.captureCalls).toHaveLength(0);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();
  });
});
