// Codex tests cover attempt diagnostics plugin behavior.
import {
  createDiagnosticTraceContext,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodexPluginThreadConfigEligibilityLogData,
  createCodexModelCallDiagnosticEmitter,
} from "./attempt-diagnostics.js";
import { resolveCodexPluginsPolicy } from "./config.js";
import { buildCodexPluginAppCacheKey } from "./plugin-app-cache-key.js";

describe("Codex app-server attempt diagnostics", () => {
  afterEach(() => resetDiagnosticEventsForTest());

  it("projects response-level model calls between tool boundaries", async () => {
    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type.startsWith("model.call.")) {
        events.push(event);
      }
    });
    let now = 1_000;
    const trace = createDiagnosticTraceContext();
    const diagnostics = createCodexModelCallDiagnosticEmitter({
      baseFields: {
        runId: "run-1",
        callId: "run-1:codex-model:1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        api: "openai-chatgpt-responses",
        transport: "stdio",
        observationUnit: "turn",
        trace,
      },
      capture: {},
      tools: [],
      buildInputMessages: () => [],
      buildSystemPrompt: () => undefined,
      now: () => now,
    });

    diagnostics.emitStarted();
    diagnostics.recordResponseCompleted({
      responseId: "response-1",
      completedAtMs: 1_090,
      usage: { input: 80, output: 20, total: 100 },
    });
    diagnostics.recordToolStarted("tool-1", 1_100);
    diagnostics.recordToolCompleted("tool-1", 1_200);
    diagnostics.recordToolStarted("tool-2", 1_500);
    diagnostics.recordToolCompleted("tool-2", 1_550);
    // Codex can deliver this response completion after the tool triggered by
    // that response has already finished. Pairing by response/tool order keeps
    // the provider span bounded by the tool start instead of overlapping it.
    diagnostics.recordResponseCompleted({
      responseId: "response-2",
      completedAtMs: 1_570,
      usage: { input: 220, output: 30, cacheRead: 50, reasoningTokens: 10, total: 300 },
    });
    diagnostics.recordResponseCompleted({
      responseId: "response-2",
      completedAtMs: 1_575,
      usage: { input: 1, output: 1, total: 2 },
    });
    diagnostics.recordResponseCompleted({
      responseId: "response-3",
      completedAtMs: 1_600,
    });
    now = 1_650;
    diagnostics.emitCompleted({
      attemptUsage: {
        input: 300,
        output: 50,
        cacheRead: 50,
        reasoningTokens: 10,
        total: 400,
      },
    });
    await waitForDiagnosticEventsDrained();
    unsubscribe();

    const completed = events.filter(
      (event): event is Extract<DiagnosticEventPayload, { type: "model.call.completed" }> =>
        event.type === "model.call.completed",
    );
    expect(completed).toHaveLength(4);
    expect(completed[0]).toMatchObject({
      callId: "run-1:codex-model:1:response:1",
      observationUnit: "request",
      durationMs: 90,
      sourceTimestampMs: 1_090,
      usage: { input: 80, output: 20, total: 100 },
      trace: { traceId: trace.traceId, parentSpanId: trace.spanId },
    });
    expect(completed[1]).toMatchObject({
      callId: "run-1:codex-model:1:response:2",
      observationUnit: "request",
      durationMs: 300,
      sourceTimestampMs: 1_500,
      usage: {
        input: 220,
        output: 30,
        cacheRead: 50,
        reasoningTokens: 10,
        total: 300,
      },
      trace: { traceId: trace.traceId, parentSpanId: trace.spanId },
    });
    expect(completed[0]?.trace?.spanId).not.toBe(completed[1]?.trace?.spanId);
    expect(completed[2]).toMatchObject({
      callId: "run-1:codex-model:1:response:3",
      observationUnit: "request",
      durationMs: 50,
      sourceTimestampMs: 1_600,
    });
    expect(completed[2]).not.toHaveProperty("usage");
    expect(completed[3]).toMatchObject({
      callId: "run-1:codex-model:1",
      observationUnit: "turn",
      durationMs: 650,
      usage: {
        input: 300,
        output: 50,
        cacheRead: 50,
        reasoningTokens: 10,
        total: 400,
      },
    });
  });

  it("collapses sequential tools emitted by one provider response", async () => {
    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "model.call.completed" && event.observationUnit === "request") {
        events.push(event);
      }
    });
    let now = 1_000;
    const diagnostics = createCodexModelCallDiagnosticEmitter({
      baseFields: {
        runId: "run-sequential-tools",
        callId: "run-sequential-tools:codex-model:1",
        provider: "openai",
        model: "gpt-5",
      },
      capture: {},
      tools: [],
      buildInputMessages: () => [],
      buildSystemPrompt: () => undefined,
      now: () => now,
    });

    diagnostics.emitStarted();
    diagnostics.recordToolStarted("tool-1", 1_100);
    diagnostics.recordToolCompleted("tool-1", 1_200);
    diagnostics.recordToolStarted("tool-2", 1_201);
    diagnostics.recordToolCompleted("tool-2", 1_300);
    diagnostics.recordResponseCompleted({
      responseId: "response-1",
      completedAtMs: 1_350,
      usage: { total: 10 },
    });
    diagnostics.recordResponseCompleted({
      responseId: "response-2",
      completedAtMs: 1_500,
      usage: { total: 20 },
    });
    now = 1_550;
    diagnostics.emitCompleted({});
    await waitForDiagnosticEventsDrained();
    unsubscribe();

    expect(
      events.map((event) => ({
        durationMs: "durationMs" in event ? event.durationMs : undefined,
        sourceTimestampMs: "sourceTimestampMs" in event ? event.sourceTimestampMs : undefined,
        total: "usage" in event ? event.usage?.total : undefined,
      })),
    ).toEqual([
      { durationMs: 100, sourceTimestampMs: 1_100, total: 10 },
      { durationMs: 200, sourceTimestampMs: 1_500, total: 20 },
    ]);
  });

  it("redacts plugin thread config eligibility log data", () => {
    const appServer = {
      start: {
        transport: "websocket" as const,
        command: "codex",
        commandSource: "config" as const,
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "token-secret",
        headers: {
          Authorization: "Bearer secret",
          "X-Test-Token": "header-secret",
        },
        env: {
          CODEX_HOME: "/tmp/codex-home",
          OPENAI_API_KEY: "env-secret",
        },
      },
      codeModeOnly: false,
      loopDetectionPreToolUseRelay: true,
      requestTimeoutMs: 60_000,
      turnCompletionIdleTimeoutMs: 60_000,
      approvalPolicy: "never" as const,
      approvalsReviewer: "user" as const,
      sandbox: "danger-full-access" as const,
      connectionClass: "local-loopback" as const,
      remoteAppsSubstrate: "preconfigured" as const,
      serviceTier: "priority" as const,
    };
    const resolvedPluginPolicy = resolveCodexPluginsPolicy({
      codexPlugins: {
        enabled: true,
        allow_all_plugins: true,
        plugins: {
          "google-calendar": {
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
          },
        },
      },
    });

    const logData = buildCodexPluginThreadConfigEligibilityLogData({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      pluginThreadConfigRequired: true,
      resolvedPluginPolicy,
      enabledPluginConfigKeys: ["google-calendar"],
      pluginAppCacheKey: buildCodexPluginAppCacheKey({
        appServer,
        agentDir: "/tmp/agent",
        authProfileId: "openai:work",
        accountId: "account-work",
        envApiKeyFingerprint: "env-key",
      }),
      startupAuthProfileId: "openai:work",
      appServer,
    });

    expect(logData).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        enabled: true,
        policyConfigured: true,
        policyEnabled: true,
        allowAllPlugins: true,
        pluginConfigKeys: ["google-calendar"],
        enabledPluginConfigKeys: ["google-calendar"],
        appCacheKeyFingerprint: expect.stringMatching(/^sha256:/),
        authProfileId: "openai:work",
        appServerTransport: "websocket",
        appServerCommandSource: "config",
      }),
    );
    expect(logData).not.toHaveProperty("appCacheKeyInput");
    const serialized = JSON.stringify(logData);
    expect(serialized).not.toContain("token-secret");
    expect(serialized).not.toContain("Bearer secret");
    expect(serialized).not.toContain("header-secret");
    expect(serialized).not.toContain("env-secret");
    expect(serialized).not.toContain("/tmp/codex-home");
  });
});
