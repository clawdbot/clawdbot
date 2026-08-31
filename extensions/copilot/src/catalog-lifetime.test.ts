import path from "node:path";
import type {
  AgentHarnessAttemptParamsV2,
  AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createContractToolTerminalObserver } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { createCopilotAgentHarness } from "../harness.js";
import { createCopilotFaultPeer } from "./catalog-lifetime.test-support.js";
import { createCopilotClientPool } from "./runtime.js";
import { createCopilotToolBridge } from "./tool-bridge.js";
import * as toolBridgeModule from "./tool-bridge.js";

it("cancels a resumed Code Mode cell during real SDK session.error cleanup before host closure", async () => {
  const state = await createOpenClawTestState({ label: "copilot-catalog-lifetime" });
  const peer = await createCopilotFaultPeer();
  const pool = createCopilotClientPool({ sdkFactory: () => peer.client });
  const harness = createCopilotAgentHarness({ pool });
  const entered = createDeferred<void>();
  const gate = createDeferred<void>();
  const callController = new AbortController();
  const observed: Array<{ toolName: string; result: unknown }> = [];
  let aborts = 0;
  let nestedSignal: AbortSignal | undefined;
  type ToolOptions = NonNullable<
    Parameters<
      NonNullable<Parameters<typeof createCopilotToolBridge>[0]["createOpenClawCodingTools"]>
    >[0]
  >;
  let catalog: ToolOptions["toolSearchCatalogRef"];
  let contextSignal: AbortSignal | undefined;
  let retained: AnyAgentTool[] = [];
  const fixtureTool: AnyAgentTool = {
    name: "fixture_gate",
    label: "Fixture gate",
    description: "Wait for the local proof gate.",
    parameters: { type: "object", properties: {} },
    async execute(_id, _args, signal) {
      nestedSignal = signal;
      signal?.addEventListener(
        "abort",
        () => {
          aborts += 1;
        },
        { once: true },
      );
      entered.resolve();
      await gate.promise;
      return { content: [{ type: "text", text: "gate released" }], details: { released: true } };
    },
  };
  const sessionId = "catalog-lifetime-session";
  const sessionKey = "agent:main:catalog-lifetime";
  const runId = "catalog-lifetime-run";
  const providerFailure = "deterministic non-timeout provider failure";
  const target = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  const userMessage = {
    role: "user" as const,
    content: "Exercise the deterministic catalog lifetime fixture.",
    timestamp: Date.now(),
  };
  let persisted = false;
  let blocked = false;
  const recorder: NonNullable<AgentHarnessAttemptParamsV2["userTurnTranscriptRecorder"]> = {
    message: userMessage,
    resolveMessage: async () => userMessage,
    markRuntimePersistencePending: () => {},
    markRuntimePersisted: () => {
      persisted = true;
    },
    markBlocked: () => {
      blocked = true;
    },
    hasPersisted: () => persisted,
    isBlocked: () => blocked,
    hasRuntimePersistencePending: () => false,
    getAdmissionReceipt: () => undefined,
    waitForRuntimePersistence: async () => {},
    persistApproved: async () => {},
    persistBlocked: async () => {},
    persistFallback: async () => {},
  };
  const config = { tools: { codeMode: { enabled: true } } };
  const host = await createAdmittedHostCapabilityTestFixture({
    config,
    runId,
    agentId: "main",
    sessionId,
    sessionKey,
    workspaceDir: state.workspaceDir,
    abortSignal: callController.signal,
  });
  let attempt: ReturnType<typeof harness.runAttempt> | undefined;
  const realCreateToolBridge = createCopilotToolBridge;
  const constructBridge = vi
    .spyOn(toolBridgeModule, "createCopilotToolBridge")
    .mockImplementation(async (input) => {
      const bridge = await realCreateToolBridge({
        ...input,
        createOpenClawCodingTools: (options) => {
          catalog = options?.toolSearchCatalogRef;
          contextSignal = options?.abortSignal;
          return [fixtureTool];
        },
      });
      retained = bridge.sourceTools;
      return bridge;
    });
  try {
    await state.writeConfig(config);
    await upsertSessionEntry({ ...target, entry: { sessionId, updatedAt: Date.now() } });
    const authStorage = AuthStorage.inMemory();
    const params = {
      agentId: "main",
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      sessionId,
      sessionKey,
      sessionTarget: target,
      sessionFile: path.join(state.sessionsDir(), "catalog-lifetime.jsonl"),
      runId,
      config,
      hostCapabilities: host.hostCapabilities,
      auth: { useLoggedInUser: true },
      provider: "github-copilot",
      modelId: "auto",
      model: {
        api: "openai-responses",
        provider: "github-copilot",
        id: "auto",
        name: "Local protocol fixture",
        baseUrl: "http://127.0.0.1",
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      authStorage,
      authProfileStore: { version: 1, profiles: {} },
      modelRegistry: ModelRegistry.inMemory(authStorage),
      thinkLevel: "off",
      prompt: userMessage.content,
      timeoutMs: 60_000,
      abortSignal: callController.signal,
      observeToolTerminal: createContractToolTerminalObserver(runId),
      userTurnTranscriptRecorder: recorder,
      onAgentToolResult: (event: { toolName: string; result: unknown }) => {
        observed.push(event);
      },
    } satisfies AgentHarnessAttemptParamsV2 & { auth: { useLoggedInUser: true } };
    attempt = harness.runAttempt(params).finally(() => {
      host.closeHost();
      host.closeAdmission();
    });
    await peer.sent;
    const execReply = peer.requestTool("exec", {
      code: 'await yield_control(); await fixture_gate({}); text("STALE AFTER CLOSE"); return "stale";',
    });
    await execReply;
    const execResult = observed.find((event) => event.toolName === "exec")?.result as {
      details: { status: string; runId: string };
    };
    expect(execResult.details.status).toBe("waiting");
    const catalogIdentity = catalog?.current;
    expect(catalogIdentity).toBeDefined();
    const waitReply = peer.requestTool("wait", { runId: execResult.details.runId });
    await entered.promise;
    host.hostCapabilities.assertActive();
    expect(nestedSignal?.aborted).toBe(false);
    peer.emit("session.error", {
      message: providerFailure,
      errorType: "model_error",
    });
    await peer.destroying;
    expect(catalog?.current).toBeUndefined();
    host.hostCapabilities.assertActive();
    expect(callController.signal.aborted).toBe(false);
    expect(contextSignal?.aborted).toBe(false);
    const abortsBeforeGateRelease = aborts;
    const nestedAbortedBeforeGateRelease = nestedSignal?.aborted;
    gate.resolve();
    await waitReply;
    const waitResult = observed.find((event) => event.toolName === "wait")?.result;
    const cleanupWindow = {
      cellId: execResult.details.runId,
      catalogId: catalogIdentity?.counterScope,
      catalogClosed: catalog?.current === undefined,
      contextAborted: contextSignal?.aborted,
      callAborted: callController.signal.aborted,
      admissionRunId: host.admittedRunContext.operationalRunInstance.runId,
      hostActiveAtCleanup: true,
      abortsBeforeGateRelease,
      nestedAbortedBeforeGateRelease,
      nestedAborted: nestedSignal?.aborted,
      aborts,
      waitResult,
    };
    peer.releaseDestroy();
    const attemptResult = await attempt;
    if (!("terminal" in attemptResult)) {
      throw new Error("Expected a canonical Copilot attempt terminal");
    }
    const terminal = attemptResult.terminal;
    const failure =
      terminal.kind === "failed" ? terminal : "failure" in terminal ? terminal.failure : undefined;
    const attemptFacts = {
      terminal: {
        kind: terminal.kind,
        source: "source" in terminal ? terminal.source : null,
        failureSource: failure?.source ?? null,
        errorMessage: failure?.error instanceof Error ? failure.error.message.slice(0, 512) : null,
      },
      lastToolError: attemptResult.lastToolError
        ? {
            toolName: attemptResult.lastToolError.toolName,
            error: attemptResult.lastToolError.error?.slice(0, 512),
            executionStarted: attemptResult.lastToolError.executionStarted,
            mutatingAction: attemptResult.lastToolError.mutatingAction,
          }
        : null,
      toolMetas: attemptResult.toolMetas.slice(0, 8).map(({ toolName, isError, meta }) => ({
        toolName,
        isError,
        meta: meta?.slice(0, 512),
      })),
      replayMetadata: attemptResult.replayMetadata,
      outerAborted: callController.signal.aborted,
    };
    expect(() => host.hostCapabilities.assertActive()).toThrow(/no longer active/);
    const retainedTool = retained.at(0);
    if (!retainedTool) {
      throw new Error("Expected a retained host-bound tool");
    }
    await expect(retainedTool.execute("retained", {})).rejects.toThrow(/no longer active/);
    console.log(
      "CATALOG_LIFETIME_VERDICT",
      JSON.stringify({
        ...cleanupWindow,
        attempt: attemptFacts,
        caller: "createCopilotAgentHarness.runAttempt",
        finalHostClosed: true,
        retainedToolRejected: true,
        rpcMethods: peer.methods,
      }),
    );
    expect(abortsBeforeGateRelease).toBe(1);
    expect(nestedAbortedBeforeGateRelease).toBe(true);
    expect(aborts).toBe(1);
    expect(waitResult).toMatchObject({ details: { status: "failed", code: "aborted" } });
    expect(JSON.stringify(waitResult)).not.toContain("STALE AFTER CLOSE");
    expect(attemptFacts.terminal).toEqual({
      kind: "failed",
      source: "prompt",
      failureSource: "prompt",
      errorMessage: providerFailure,
    });
    expect(callController.signal.aborted).toBe(false);
    expect(attemptResult.lastToolError).toMatchObject({
      toolName: "wait",
      error: "code mode execution aborted",
      executionStarted: true,
    });
  } finally {
    gate.resolve();
    peer.releaseDestroy();
    await attempt;
    host.closeHost();
    host.closeAdmission();
    constructBridge.mockRestore();
    await harness.dispose?.();
    await pool.dispose();
    await peer.close();
    await state.cleanup();
  }
});
