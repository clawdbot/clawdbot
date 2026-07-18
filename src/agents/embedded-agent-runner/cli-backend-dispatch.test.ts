import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { resolveEmbeddedCliBackendDispatchEligibility } from "./cli-backend-dispatch-eligibility.js";
import { runEmbeddedAgentViaCliBackendIfEligible } from "./cli-backend-dispatch.js";
import type { RunEmbeddedAgentParams } from "./run/params.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const ensureAuthProfileStore = vi.hoisted(() => vi.fn());
const resolveAuthProfileOrder = vi.hoisted(() => vi.fn());
const resolveModelAuthMode = vi.hoisted(() => vi.fn());
const resolveRuntimeCliBackends = vi.hoisted(() => vi.fn());
const resolveCliRuntimeExecutionProvider = vi.hoisted(() => vi.fn());
const runCliAgent = vi.hoisted(() => vi.fn());
const retireSessionMcpRuntime = vi.hoisted(() => vi.fn());
const retireSessionMcpRuntimeForSessionKey = vi.hoisted(() => vi.fn());

vi.mock("../model-auth.js", () => ({
  ensureAuthProfileStore,
  resolveAuthProfileOrder,
  resolveModelAuthMode,
}));
vi.mock("../model-runtime-aliases.js", () => ({
  resolveCliRuntimeExecutionProvider,
}));
vi.mock("../../plugins/cli-backends.runtime.js", () => ({
  resolveRuntimeCliBackends,
}));
vi.mock("../cli-runner.runtime.js", () => ({
  runCliAgent,
}));
vi.mock("../agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
}));
const transcriptRecorder = vi.hoisted(() => ({
  noteToolEvent: vi.fn(),
  noteAssistantText: vi.fn(),
  flushAssistantSnapshot: vi.fn(),
  finalize: vi.fn(async () => undefined),
}));
const createCliDispatchTranscriptRecorder = vi.hoisted(() => vi.fn(() => transcriptRecorder));
vi.mock("./cli-backend-dispatch-transcript.js", () => ({
  createCliDispatchTranscriptRecorder,
}));

function baseRunParams(overrides: Partial<RunEmbeddedAgentParams> = {}): RunEmbeddedAgentParams {
  return {
    sessionId: "recall-session",
    sessionKey: "agent:main:recall",
    sessionFile: "/tmp/recall/session.jsonl",
    workspaceDir: "/tmp/recall/workspace",
    prompt: "recall prompt",
    provider: "claude-cli",
    model: "claude-opus-4-8",
    timeoutMs: 30_000,
    runId: "run-cli-dispatch-test",
    cliBackendDispatch: "subscription-auth" as const,
    toolsAllow: ["memory_search"],
    ...overrides,
  };
}

function cliRunResult(meta: Partial<EmbeddedAgentRunResult["meta"]> = {}): EmbeddedAgentRunResult {
  return {
    payloads: [{ text: "recall summary" }],
    meta: meta as EmbeddedAgentRunResult["meta"],
  } as EmbeddedAgentRunResult;
}

beforeEach(() => {
  ensureAuthProfileStore.mockReset();
  resolveAuthProfileOrder.mockReset();
  resolveModelAuthMode.mockReset();
  resolveRuntimeCliBackends.mockReset();
  runCliAgent.mockReset();
  retireSessionMcpRuntime.mockReset();
  retireSessionMcpRuntimeForSessionKey.mockReset();
  resolveCliRuntimeExecutionProvider.mockReset();
  ensureAuthProfileStore.mockReturnValue({ profiles: {} });
  resolveAuthProfileOrder.mockReturnValue([]);
  resolveModelAuthMode.mockReturnValue("oauth");
  // Default registry: the claude-cli backend declares the capability, a
  // gemini backend does not.
  resolveRuntimeCliBackends.mockReturnValue([
    { id: "claude-cli", subscriptionAuthDispatch: true },
    { id: "google-gemini-cli" },
  ]);
  resolveCliRuntimeExecutionProvider.mockReturnValue(undefined);
  retireSessionMcpRuntimeForSessionKey.mockResolvedValue(true);
  retireSessionMcpRuntime.mockResolvedValue(true);
  runCliAgent.mockResolvedValue(cliRunResult());
  transcriptRecorder.noteToolEvent.mockReset();
  transcriptRecorder.noteAssistantText.mockReset();
  transcriptRecorder.flushAssistantSnapshot.mockReset();
  transcriptRecorder.finalize.mockClear();
  createCliDispatchTranscriptRecorder.mockClear();
});

describe("resolveEmbeddedCliBackendDispatchEligibility", () => {
  // The recall timeout default consumes this decision directly; these cases
  // pin that API-key and missing-backend setups stay ineligible so callers
  // budgeting on it keep the passthrough default.
  it("resolves the provider for subscription (oauth) credentials", () => {
    expect(resolveEmbeddedCliBackendDispatchEligibility({ provider: "claude-cli" })).toEqual({
      provider: "claude-cli",
    });
  });

  it("returns undefined for API-key credentials", () => {
    resolveModelAuthMode.mockReturnValue("api-key");
    expect(
      resolveEmbeddedCliBackendDispatchEligibility({ provider: "claude-cli" }),
    ).toBeUndefined();
  });

  it("returns undefined without a registered claude-cli backend", () => {
    resolveRuntimeCliBackends.mockReturnValue([]);
    expect(
      resolveEmbeddedCliBackendDispatchEligibility({ provider: "claude-cli" }),
    ).toBeUndefined();
  });

  it("honors an explicitly pinned API-key profile over subscription-first order", () => {
    // A pinned profile is the credential the run executes on; order must not
    // override it in either direction.
    ensureAuthProfileStore.mockReturnValue({
      profiles: {
        "anthropic:claude-cli": { type: "oauth", provider: "claude-cli" },
        "anthropic:api": { type: "api_key", provider: "anthropic" },
      },
    });
    resolveAuthProfileOrder.mockReturnValue(["anthropic:claude-cli", "anthropic:api"]);
    expect(
      resolveEmbeddedCliBackendDispatchEligibility({
        provider: "claude-cli",
        authProfileId: "anthropic:api",
      }),
    ).toBeUndefined();
    expect(resolveModelAuthMode).not.toHaveBeenCalled();
  });

  it("honors an explicitly pinned OAuth profile over API-key-first order", () => {
    ensureAuthProfileStore.mockReturnValue({
      profiles: {
        "anthropic:api": { type: "api_key", provider: "anthropic" },
        "anthropic:claude-cli": { type: "oauth", provider: "claude-cli" },
      },
    });
    resolveAuthProfileOrder.mockReturnValue(["anthropic:api", "anthropic:claude-cli"]);
    expect(
      resolveEmbeddedCliBackendDispatchEligibility({
        provider: "claude-cli",
        authProfileId: "anthropic:claude-cli",
      }),
    ).toEqual({ provider: "claude-cli" });
  });

  it("falls back to ordered selection when the pinned profile is unknown", () => {
    ensureAuthProfileStore.mockReturnValue({
      profiles: { "anthropic:api": { type: "api_key", provider: "anthropic" } },
    });
    resolveAuthProfileOrder.mockReturnValue(["anthropic:api"]);
    expect(
      resolveEmbeddedCliBackendDispatchEligibility({
        provider: "claude-cli",
        authProfileId: "anthropic:missing",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the backend does not declare the capability", () => {
    // The provider plugin owns the subscription-billing claim; a registered
    // backend without it (e.g. gemini) keeps the passthrough.
    expect(
      resolveEmbeddedCliBackendDispatchEligibility({ provider: "google-gemini-cli" }),
    ).toBeUndefined();
    expect(resolveModelAuthMode).not.toHaveBeenCalled();
  });

  it("resolves canonical refs through the configured runtime", () => {
    resolveCliRuntimeExecutionProvider.mockReturnValue("claude-cli");
    expect(
      resolveEmbeddedCliBackendDispatchEligibility({
        provider: "anthropic",
        model: "claude-opus-4-8",
        agentId: "main",
      }),
    ).toEqual({ provider: "claude-cli" });
  });

  it("forwards the pinned auth profile into runtime resolution", () => {
    // The pin can be what maps a canonical ref onto its CLI runtime; the
    // resolver must see it or dispatch strands the run on the passthrough.
    resolveCliRuntimeExecutionProvider.mockReturnValue("claude-cli");
    ensureAuthProfileStore.mockReturnValue({
      profiles: { "anthropic:claude-cli": { type: "oauth", provider: "claude-cli" } },
    });
    expect(
      resolveEmbeddedCliBackendDispatchEligibility({
        provider: "anthropic",
        model: "claude-opus-4-8",
        agentId: "main",
        authProfileId: "anthropic:claude-cli",
      }),
    ).toEqual({ provider: "claude-cli" });
    expect(resolveCliRuntimeExecutionProvider).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "anthropic:claude-cli" }),
    );
  });
});

describe("runEmbeddedAgentViaCliBackendIfEligible gate", () => {
  const runGate = (overrides: Partial<RunEmbeddedAgentParams> = {}) =>
    runEmbeddedAgentViaCliBackendIfEligible(baseRunParams(overrides));

  it("returns undefined without the opt-in", async () => {
    expect(await runGate({ cliBackendDispatch: undefined })).toBeUndefined();
    expect(resolveModelAuthMode).not.toHaveBeenCalled();
    expect(runCliAgent).not.toHaveBeenCalled();
  });

  it("dispatches claude-cli runs with subscription (oauth) credentials", async () => {
    expect(await runGate({ agentDir: "/agents/main", workspaceDir: "/workspace" })).toBeDefined();
    expect(ensureAuthProfileStore).toHaveBeenCalledWith("/agents/main", expect.anything());
    expect(resolveModelAuthMode).toHaveBeenCalledWith(
      "claude-cli",
      undefined,
      expect.anything(),
      expect.objectContaining({ workspaceDir: "/workspace" }),
    );
    expect(runCliAgent.mock.calls[0]?.[0]).toMatchObject({ provider: "claude-cli" });
  });

  it("dispatches when no credential mode resolves for the passthrough", async () => {
    resolveModelAuthMode.mockReturnValue(undefined);
    expect(await runGate()).toBeDefined();
    expect(runCliAgent).toHaveBeenCalledTimes(1);
  });

  it("dispatches when the credential store is unreadable", async () => {
    ensureAuthProfileStore.mockImplementation(() => {
      throw new Error("store unreadable");
    });
    expect(await runGate()).toBeDefined();
    expect(runCliAgent).toHaveBeenCalledTimes(1);
  });

  it.each(["api-key", "mixed", "aws-sdk"] as const)(
    "keeps the passthrough when the auth mode is %s",
    async (mode) => {
      resolveModelAuthMode.mockReturnValue(mode);
      expect(await runGate()).toBeUndefined();
      expect(runCliAgent).not.toHaveBeenCalled();
    },
  );

  it("dispatches when the ordered profile selection picks a subscription credential in a mixed store", async () => {
    // The passthrough follows auth.order; a store-wide "mixed" aggregate must
    // not suppress dispatch when the selected profile is oauth.
    ensureAuthProfileStore.mockReturnValue({
      profiles: {
        "anthropic:claude-cli": { type: "oauth", provider: "claude-cli" },
        "anthropic:api": { type: "api_key", provider: "anthropic" },
      },
    });
    resolveAuthProfileOrder.mockReturnValue(["anthropic:claude-cli", "anthropic:api"]);
    resolveModelAuthMode.mockReturnValue("mixed");
    expect(await runGate()).toBeDefined();
    expect(resolveModelAuthMode).not.toHaveBeenCalled();
  });

  it("keeps the passthrough when the ordered profile selection picks an API key", async () => {
    ensureAuthProfileStore.mockReturnValue({
      profiles: {
        "anthropic:api": { type: "api_key", provider: "anthropic" },
        "anthropic:claude-cli": { type: "oauth", provider: "claude-cli" },
      },
    });
    resolveAuthProfileOrder.mockReturnValue(["anthropic:api", "anthropic:claude-cli"]);
    expect(await runGate()).toBeUndefined();
    expect(runCliAgent).not.toHaveBeenCalled();
  });

  it("dispatches canonical anthropic refs whose configured runtime is claude-cli", async () => {
    resolveCliRuntimeExecutionProvider.mockReturnValue("claude-cli");
    expect(
      await runGate({ provider: "anthropic", model: "claude-opus-4-8", agentId: "main" }),
    ).toBeDefined();
    expect(resolveCliRuntimeExecutionProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        agentId: "main",
        modelId: "claude-opus-4-8",
      }),
    );
    // The dispatch runs on the resolved execution provider, not the canonical ref.
    expect(runCliAgent.mock.calls[0]?.[0]).toMatchObject({ provider: "claude-cli" });
  });

  it("keeps the passthrough for canonical refs without a claude-cli runtime", async () => {
    resolveCliRuntimeExecutionProvider.mockReturnValue(undefined);
    expect(await runGate({ provider: "anthropic", model: "claude-opus-4-8" })).toBeUndefined();
    resolveCliRuntimeExecutionProvider.mockReturnValue("google-gemini-cli");
    expect(await runGate({ provider: "google", model: "gemini-3.1-pro-preview" })).toBeUndefined();
    expect(runCliAgent).not.toHaveBeenCalled();
  });

  it("keeps the passthrough for other CLI runtimes until verified", async () => {
    expect(await runGate({ provider: "google-gemini-cli" })).toBeUndefined();
    expect(resolveModelAuthMode).not.toHaveBeenCalled();
  });

  it("keeps the passthrough without a caller-owned session file", async () => {
    expect(await runGate({ sessionFile: undefined })).toBeUndefined();
  });

  it("keeps the passthrough when no claude-cli backend is registered", async () => {
    resolveRuntimeCliBackends.mockReturnValue([]);
    expect(await runGate()).toBeUndefined();
  });
});

describe("runEmbeddedAgentViaCliBackendIfEligible execution", () => {
  it("maps the embedded run onto a one-shot restricted CLI run", async () => {
    runCliAgent.mockResolvedValue(cliRunResult());
    const params = baseRunParams({
      toolsAllow: ["memory_search", "memory_get", "notes_retrieve_context"],
    });

    const result = await runEmbeddedAgentViaCliBackendIfEligible(params);

    expect(result?.payloads?.[0]?.text).toBe("recall summary");
    expect(runCliAgent).toHaveBeenCalledTimes(1);
    const cliParams = runCliAgent.mock.calls[0]?.[0];
    expect(cliParams).toMatchObject({
      provider: "claude-cli",
      model: "claude-opus-4-8",
      sessionFile: "/tmp/recall/session.jsonl",
      timeoutMs: 30_000,
      runTimeoutOverrideMs: 30_000,
      disableCliLiveSession: true,
      cleanupCliLiveSessionOnRunEnd: true,
      requireExplicitMessageTarget: true,
      cliToolAvailability: {
        native: [],
        mcp: [
          "mcp__openclaw__memory_search",
          "mcp__openclaw__memory_get",
          "mcp__openclaw__notes_retrieve_context",
        ],
      },
    });
    // Embedded toolsAllow must never reach the CLI runner: it fails closed.
    expect(cliParams).not.toHaveProperty("toolsAllow");
  });

  // Fail-closed tool policy: only a non-empty named allowlist is expressible
  // on the CLI surface. Every other embedded tool state keeps the passthrough
  // so no closed state silently widens.
  it.each([
    ["a wildcard allowlist", { toolsAllow: ["*"] }],
    ["a mixed wildcard allowlist", { toolsAllow: ["memory_search", "*"] }],
    ["a deny-all allowlist", { toolsAllow: [] }],
    ["no allowlist", { toolsAllow: undefined }],
    ["disableTools", { disableTools: true }],
    ["a raw model run", { modelRun: true }],
  ] as const)("refuses dispatch for %s", async (_label, overrides) => {
    expect(
      await runEmbeddedAgentViaCliBackendIfEligible(
        baseRunParams(overrides as Partial<RunEmbeddedAgentParams>),
      ),
    ).toBeUndefined();
    expect(runCliAgent).not.toHaveBeenCalled();
  });

  it("invokes onExecutionStarted once at the dispatch boundary", async () => {
    runCliAgent.mockResolvedValue(cliRunResult());
    const onExecutionStarted = vi.fn();
    await runEmbeddedAgentViaCliBackendIfEligible(
      baseRunParams({ onExecutionStarted, lifecycleGeneration: "gen-1" }),
    );
    expect(onExecutionStarted).toHaveBeenCalledTimes(1);
    expect(onExecutionStarted).toHaveBeenCalledWith({ lifecycleGeneration: "gen-1" });
  });

  it("forwards execution phases from the CLI backend", async () => {
    const onExecutionPhase = vi.fn();
    runCliAgent.mockImplementation(
      async (cliParams: { onExecutionPhase?: RunEmbeddedAgentParams["onExecutionPhase"] }) => {
        cliParams.onExecutionPhase?.({
          phase: "model_call_started",
          provider: "anthropic",
          model: "claude-opus-4-8",
          backend: "claude-cli",
          firstModelCallStarted: true,
        });
        return cliRunResult();
      },
    );

    await runEmbeddedAgentViaCliBackendIfEligible(baseRunParams({ onExecutionPhase }));

    expect(onExecutionPhase).toHaveBeenCalledWith({
      phase: "model_call_started",
      provider: "anthropic",
      model: "claude-opus-4-8",
      backend: "claude-cli",
      firstModelCallStarted: true,
    });
  });

  it("bridges CLI tool result events to onAgentToolResult without the MCP prefix", async () => {
    const observed: Array<{ toolName: string; isError: boolean }> = [];
    const params = baseRunParams({
      toolsAllow: ["memory_search"],
      onAgentToolResult: (event) => {
        observed.push({ toolName: event.toolName, isError: event.isError });
      },
    });
    runCliAgent.mockImplementation(async (cliParams: { runId: string }) => {
      emitAgentEvent({
        runId: cliParams.runId,
        stream: "tool",
        data: {
          phase: "result",
          name: "mcp__openclaw__memory_search",
          result: { content: [] },
          isError: false,
        },
      });
      // Soft tool failures must surface as isError like the native path.
      emitAgentEvent({
        runId: cliParams.runId,
        stream: "tool",
        data: {
          phase: "result",
          name: "mcp__openclaw__memory_get",
          result: { details: { status: "error" } },
          isError: false,
        },
      });
      emitAgentEvent({
        runId: "other-run",
        stream: "tool",
        data: { phase: "result", name: "mcp__openclaw__memory_get", isError: true },
      });
      return cliRunResult();
    });

    await runEmbeddedAgentViaCliBackendIfEligible(params);

    expect(observed).toEqual([
      { toolName: "memory_search", isError: false },
      { toolName: "memory_get", isError: true },
    ]);

    // The bridge must not outlive the run.
    emitAgentEvent({
      runId: params.runId,
      stream: "tool",
      data: { phase: "result", name: "mcp__openclaw__memory_search", isError: false },
    });
    expect(observed).toHaveLength(2);
  });

  it("retires only the run's session MCP runtime instead of the process-wide server", async () => {
    runCliAgent.mockResolvedValue(cliRunResult());
    const params = baseRunParams({ cleanupBundleMcpOnRunEnd: true });
    await runEmbeddedAgentViaCliBackendIfEligible(params);
    // The CLI runner's flag would close the shared loopback MCP server, which
    // concurrent turns may still be using; it must never be forwarded.
    expect(runCliAgent.mock.calls[0]?.[0]).not.toHaveProperty("cleanupBundleMcpOnRunEnd");
    expect(retireSessionMcpRuntimeForSessionKey).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: params.sessionKey }),
    );
    expect(retireSessionMcpRuntime).not.toHaveBeenCalled();
  });

  it("skips MCP runtime cleanup when the caller did not request it", async () => {
    runCliAgent.mockResolvedValue(cliRunResult());
    await runEmbeddedAgentViaCliBackendIfEligible(baseRunParams());
    expect(retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
  });

  it("mirrors the run into the transcript recorder", async () => {
    runCliAgent.mockImplementation(async (cliParams: { runId: string }) => {
      emitAgentEvent({
        runId: cliParams.runId,
        stream: "assistant",
        data: { text: "partial answer" },
      });
      emitAgentEvent({
        runId: cliParams.runId,
        stream: "tool",
        data: {
          phase: "start",
          name: "mcp__openclaw__memory_search",
          toolCallId: "call-1",
          args: { query: "wings" },
        },
      });
      emitAgentEvent({
        runId: cliParams.runId,
        stream: "tool",
        data: {
          phase: "result",
          name: "mcp__openclaw__memory_search",
          toolCallId: "call-1",
          result: { content: [] },
          isError: false,
        },
      });
      return cliRunResult();
    });

    await runEmbeddedAgentViaCliBackendIfEligible(baseRunParams({ toolsAllow: ["memory_search"] }));

    expect(createCliDispatchTranscriptRecorder).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: "/tmp/recall/session.jsonl",
        sessionId: "recall-session",
        prompt: "recall prompt",
        provider: "claude-cli",
      }),
    );
    expect(transcriptRecorder.noteAssistantText).toHaveBeenCalledWith("partial answer");
    expect(transcriptRecorder.noteToolEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "start",
        toolName: "memory_search",
        toolCallId: "call-1",
        args: { query: "wings" },
      }),
    );
    expect(transcriptRecorder.noteToolEvent).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "result", toolName: "memory_search" }),
    );
    expect(transcriptRecorder.finalize).toHaveBeenCalledWith("recall summary");
  });

  it("flushes the assistant snapshot the moment the run aborts", async () => {
    const abortController = new AbortController();
    runCliAgent.mockImplementation(async () => {
      abortController.abort(new Error("recall timeout"));
      expect(transcriptRecorder.flushAssistantSnapshot).toHaveBeenCalledTimes(1);
      throw new Error("aborted");
    });
    await expect(
      runEmbeddedAgentViaCliBackendIfEligible(
        baseRunParams({ abortSignal: abortController.signal }),
      ),
    ).rejects.toThrow("aborted");
    expect(transcriptRecorder.finalize).toHaveBeenCalledWith(undefined);
  });

  it("finalizes the transcript when the CLI run fails", async () => {
    runCliAgent.mockRejectedValue(new Error("boom"));
    await expect(runEmbeddedAgentViaCliBackendIfEligible(baseRunParams())).rejects.toThrow("boom");
    expect(transcriptRecorder.finalize).toHaveBeenCalledWith(undefined);
  });

  it("drops CLI session bindings from the run result", async () => {
    runCliAgent.mockResolvedValue(
      cliRunResult({
        agentMeta: {
          sessionId: "native-session",
          cliSessionBinding: { sessionId: "native-session" },
        },
      } as Partial<EmbeddedAgentRunResult["meta"]>),
    );
    const result = await runEmbeddedAgentViaCliBackendIfEligible(baseRunParams());
    expect(result?.meta.agentMeta?.cliSessionBinding).toBeUndefined();
  });
});
