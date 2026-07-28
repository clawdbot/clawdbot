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
    diagnostics.emitResponseCompleted({
      responseId: "response-1",
      completedAtMs: 1_100,
      usage: { input: 80, output: 20, total: 100 },
    });
    diagnostics.recordToolCompleted(1_200);
    diagnostics.emitResponseCompleted({
      responseId: "response-2",
      completedAtMs: 1_500,
      usage: { input: 220, output: 30, cacheRead: 50, reasoningTokens: 10, total: 300 },
    });
    diagnostics.emitResponseCompleted({
      responseId: "response-2",
      completedAtMs: 1_550,
      usage: { input: 1, output: 1, total: 2 },
    });
    diagnostics.recordToolCompleted(1_550);
    diagnostics.emitResponseCompleted({
      responseId: "response-3",
      completedAtMs: 1_575,
    });
    now = 1_600;
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
      durationMs: 100,
      usage: { input: 80, output: 20, total: 100 },
      trace: { traceId: trace.traceId, parentSpanId: trace.spanId },
    });
    expect(completed[1]).toMatchObject({
      callId: "run-1:codex-model:1:response:2",
      observationUnit: "request",
      durationMs: 300,
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
      durationMs: 25,
    });
    expect(completed[2]).not.toHaveProperty("usage");
    expect(completed[3]).toMatchObject({
      callId: "run-1:codex-model:1",
      observationUnit: "turn",
      durationMs: 600,
      usage: {
        input: 300,
        output: 50,
        cacheRead: 50,
        reasoningTokens: 10,
        total: 400,
      },
    });
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
