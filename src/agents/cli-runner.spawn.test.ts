/** Tests CLI runner process spawning, logging, diagnostics, and live-session paths. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplyOperation, replyRunRegistry } from "../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../auto-reply/reply/reply-run-registry.test-support.js";
import {
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  recordMcpLoopbackToolCallResult,
} from "../gateway/mcp-http.loopback-runtime.js";
import { invokeNodeClaudeCliRun } from "../gateway/node-agent-cli-runtime.js";
import { onAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import {
  onInternalDiagnosticEvent,
  onTrustedToolExecutionEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { PLUGIN_APPROVAL_DETAIL_MAX_LENGTH } from "../infra/plugin-approvals.js";
import {
  getDiagnosticSessionActivitySnapshot,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../logging/diagnostic-run-activity.js";
import type { getProcessSupervisor } from "../process/supervisor/index.js";
import type { RunExit } from "../process/supervisor/types.js";
import {
  registerExecApprovalRequestForHostOrThrow,
  resolveRegisteredExecApprovalDecision,
} from "./bash-tools.exec-approval-request.js";
import {
  makeBootstrapWarn as realMakeBootstrapWarn,
  resolveBootstrapContextForRun as realResolveBootstrapContextForRun,
} from "./bootstrap-files.js";
import {
  buildClaudeControlRequestEvents,
  buildClaudeLiveBackend,
  buildClaudeLiveRunContext,
  buildPreparedCliRunContext,
  captureModelCallDiagnostics,
  createCancelableLiveRunLifecycle,
  expectPathMissing,
  expectRejectsWithFields,
  expectClaudeControlDecision,
  expectModelCallTypes,
  mockCallArg,
  mockClaudeLiveRun,
  requireArgAfter,
  requireRecord,
  requireRegexMatch,
  withTempExecApprovalsFile,
  withTempOpenClawHome,
  type PreparedCliRunContextOverrides,
} from "./cli-runner.test-helpers.js";
import {
  createManagedRun,
  mockSuccessfulCliRun,
  restoreCliRunnerPrepareTestDeps,
  supervisorSpawnMock,
} from "./cli-runner.test-support.js";
import {
  getClaudeLiveSessionGenerationForOwner,
  runClaudeLiveSessionTurn,
} from "./cli-runner/claude-live-session.js";
import {
  buildClaudeLiveArgs,
  resetClaudeLiveSessionsForTest,
} from "./cli-runner/claude-live-session.test-support.js";
import {
  attachCliMessagingDeliveryEvidence,
  getCliMessagingDeliveryEvidence,
} from "./cli-runner/delivery-evidence.js";
import { executePreparedCliRun } from "./cli-runner/execute.js";
import {
  buildCliEnvAuthLog,
  buildCliExecLogLine,
  setCliRunnerExecuteTestDeps,
} from "./cli-runner/execute.test-support.js";
import { buildCliAgentSystemPrompt, writeCliSystemPromptFile } from "./cli-runner/helpers.js";
import { cliBackendLog, formatCliBackendOutputDigest } from "./cli-runner/log.js";
import { setCliRunnerPrepareTestDeps } from "./cli-runner/prepare.test-support.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";
import { createClaudeApiErrorFixture } from "./test-helpers/claude-api-error-fixture.js";
import { callGatewayTool } from "./tools/gateway.js";

// Gateway unit coverage owns quiet-admission timing. These spawn cases only
// need to drain calls already in flight, so skip the repeated 250 ms quiet window.
vi.mock("../gateway/mcp-http.loopback-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/mcp-http.loopback-runtime.js")>();
  return {
    ...actual,
    waitForMcpLoopbackToolCallCaptureIdle: (
      captureKey: string,
      options: Parameters<typeof actual.waitForMcpLoopbackToolCallCaptureIdle>[1],
    ) =>
      actual.waitForMcpLoopbackToolCallCaptureIdle(captureKey, {
        ...options,
        admissionGraceMs: 0,
      }),
  };
});

vi.mock("../plugin-sdk/anthropic-cli.js", () => ({
  CLAUDE_CLI_BACKEND_ID: "claude-cli",
  isClaudeCliProvider: (providerId: string) => providerId === "claude-cli",
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnFn = ProcessSupervisor["spawn"];
type ClaudeControlPolicyTestCase = {
  name: string;
  requestId: string;
  toolUseId: string;
  input: Record<string, unknown>;
  expected: {
    behavior: "allow" | "deny";
    messageIncludes?: string;
    updatedInput?: Record<string, unknown>;
  };
  context?: PreparedCliRunContextOverrides;
  approvals?: Record<string, unknown>;
  expectedPermissionMode?: string;
};

beforeEach(() => {
  setDiagnosticsEnabledForProcess(true);
  resetAgentEventsForTest();
  resetDiagnosticRunActivityForTest();
  startDiagnosticRunActivityTracking();
  resetClaudeLiveSessionsForTest();
  replyRunTesting.resetReplyRunRegistry();
  restoreCliRunnerPrepareTestDeps();
  setCliRunnerExecuteTestDeps({
    writeCliSystemPromptFile,
    invokeNodeClaudeCliRun,
    registerExecApprovalRequestForHostOrThrow,
    resolveRegisteredExecApprovalDecision,
  });
  supervisorSpawnMock.mockClear();
  mockCallGatewayTool.mockReset();
  mockCallGatewayTool.mockResolvedValue({ id: "claude-native-approval", decision: "deny" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetDiagnosticRunActivityForTest();
  resetClaudeLiveSessionsForTest();
  replyRunTesting.resetReplyRunRegistry();
});

const CLAUDE_OK_JSONL = `${JSON.stringify({ type: "result", result: "ok" })}\n`;
const GEMINI_OK_JSONL = `${[
  JSON.stringify({ type: "message", role: "assistant", content: "ok", delta: true }),
  JSON.stringify({ type: "result", status: "success" }),
].join("\n")}\n`;

describe("runCliAgent spawn path", () => {
  it("formats output digests without logging response content", () => {
    expect(formatCliBackendOutputDigest("one")).toBe("outBytes=3 outHash=7692c3ad3540");
    expect(formatCliBackendOutputDigest("∑")).toBe("outBytes=3 outHash=be27c7179a61");
  });

  it("formats redacted CLI resume diagnostics without exposing raw session ids", () => {
    const logLine = buildCliExecLogLine({
      provider: "claude-cli",
      model: "claude-opus-4-7",
      promptChars: 42,
      trigger: "heartbeat",
      useResume: true,
      cliSessionId: "claude-session-secret",
      resolvedSessionId: "claude-session-secret",
      reusableSession: { mode: "reuse", sessionId: "claude-session-secret" },
      hasHistoryPrompt: false,
    });

    expect(logLine).toContain("trigger=heartbeat");
    expect(logLine).toContain("useResume=true");
    expect(logLine).toContain("session=present");
    expect(logLine).toContain("reuse=reusable");
    expect(logLine).toContain("historyPrompt=none");
    expect(logLine).not.toContain("claude-session-secret");
  });

  it("formats soft-resume drift in CLI resume diagnostics", () => {
    const logLine = buildCliExecLogLine({
      provider: "claude-cli",
      model: "claude-opus-4-7",
      promptChars: 42,
      trigger: "user",
      useResume: true,
      cliSessionId: "claude-session-secret",
      resolvedSessionId: "claude-session-secret",
      reusableSession: {
        mode: "reuse-with-drift",
        sessionId: "claude-session-secret",
        drift: { reasons: ["system-prompt"] },
      },
      hasHistoryPrompt: false,
    });

    expect(logLine).toContain("reuse=reusable-drift:system-prompt");
    expect(logLine).not.toContain("claude-session-secret");
  });

  it("streams a node-placed Claude resume through the normal JSONL parser", async () => {
    const writeSystemPrompt = vi.fn(writeCliSystemPromptFile);
    let toolAvailability: unknown = "unset";
    const invokeNode = vi.fn(async (params: Parameters<typeof invokeNodeClaudeCliRun>[0]) => {
      const jsonl = [
        JSON.stringify({ type: "system", subtype: "init", session_id: "forked-node-session" }),
        JSON.stringify({
          type: "result",
          session_id: "forked-node-session",
          result: "node answer",
        }),
        "",
      ].join("\n");
      params.onProgress(jsonl.slice(0, 40));
      params.onProgress(jsonl.slice(40));
      return {
        ok: true,
        payloadJSON: JSON.stringify({ exitCode: 0, stderrTail: "", truncated: false }),
      };
    });
    setCliRunnerExecuteTestDeps({
      writeCliSystemPromptFile: writeSystemPrompt,
      invokeNodeClaudeCliRun: invokeNode,
    });
    const context = buildClaudeLiveRunContext({
      model: "claude-opus-4-8",
      runId: "run-node-claude",
      prompt: "current turn",
      sessionEntry: {
        sessionId: "openclaw-session",
        updatedAt: 1,
        execHost: "node",
        execNode: "node-a",
        execCwd: "/work/on-node",
      },
      backend: {
        args: [
          "-p",
          "--output-format",
          "stream-json",
          "--permission-mode",
          "bypassPermissions",
          "--strict-mcp-config",
          "--mcp-config",
          "/tmp/gateway-mcp.json",
          "--allowedTools",
          "mcp__openclaw__*",
        ],
        resumeArgs: [
          "-p",
          "--output-format",
          "stream-json",
          "--permission-mode",
          "bypassPermissions",
          "--strict-mcp-config",
          "--mcp-config",
          "/tmp/gateway-mcp.json",
          "--allowedTools",
          "mcp__openclaw__*",
          "--resume",
          "{sessionId}",
        ],
        forkArg: "--fork-session",
        env: { ANTHROPIC_API_KEY: "configured-backend-key" },
        clearEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
        systemPromptWhen: "always",
      },
      preparedEnv: { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" },
      resolveExecutionArgs: (execution) => {
        toolAvailability = execution.toolAvailability;
        return [...execution.baseArgs];
      },
      cliToolAvailability: { native: [], openClaw: ["message"] },
    });
    context.preparedBackend.secretInput = {
      fd: 3,
      fingerprint: "selected-node-token-fingerprint",
      createData: () => Buffer.from("selected-node-token"),
    };
    context.openClawHistoryPrompt = "gateway transcript reseed";
    context.claudeSkillsPluginArgs = ["--plugin-dir", "/tmp/gateway-skills"];
    context.params.forkCliSessionOnResume = true;
    context.params.claimCliSessionFork = vi.fn(async () => true);
    context.params.persistCliSessionForkSuccessor = vi.fn(async () => {});

    const output = await executePreparedCliRun(context, "source-node-session");

    expect(output).toMatchObject({ text: "node answer", sessionId: "forked-node-session" });
    // Node runs keep the gateway's native tool policy; loopback MCP tools do
    // not exist on the node so the OpenClaw list is projected empty.
    expect(toolAvailability).toEqual({ native: [], openClaw: [], mcp: [] });
    expect(writeSystemPrompt).not.toHaveBeenCalled();
    expect(supervisorSpawnMock).not.toHaveBeenCalled();
    expect(invokeNode).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-a",
        cwd: "/work/on-node",
        stdin: "current turn",
        argv: expect.arrayContaining(["--resume", "source-node-session", "--fork-session"]),
        systemPrompt: "You are a helpful assistant.",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "selected-node-token" },
        clearEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
      }),
    );
    expect(invokeNode.mock.calls[0]?.[0].env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(invokeNode.mock.calls[0]?.[0].env).not.toHaveProperty(
      "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
    );
    const argv = invokeNode.mock.calls[0]?.[0].argv ?? [];
    expect(argv).not.toContain("--mcp-config");
    expect(argv).not.toContain("--permission-mode");
    expect(argv).not.toContain("bypassPermissions");
    expect(argv).not.toContain("--strict-mcp-config");
    expect(argv).not.toContain("--allowedTools");
    expect(argv).not.toContain("--plugin-dir");
    expect(argv).not.toContain("--append-system-prompt");
    expect(argv).not.toContain("--append-system-prompt-file");
    expect(invokeNode.mock.calls[0]?.[0].stdin).not.toContain("gateway transcript reseed");
    expect(context.params.persistCliSessionForkSuccessor).toHaveBeenCalledWith(
      "forked-node-session",
    );
  });

  it("rejects a truncated node stream that lost the terminal result", async () => {
    const invokeNode = vi.fn(async (params: Parameters<typeof invokeNodeClaudeCliRun>[0]) => {
      params.onProgress(
        `${JSON.stringify({ type: "system", subtype: "init", session_id: "trunc-node-session" })}\n`,
      );
      params.onProgress('{"type":"assistant","message":{"content":[{"type":"te');
      return {
        ok: true,
        payloadJSON: JSON.stringify({ exitCode: 0, stderrTail: "", truncated: true }),
      };
    });
    setCliRunnerExecuteTestDeps({ invokeNodeClaudeCliRun: invokeNode });
    const context = buildClaudeLiveRunContext({
      model: "claude-opus-4-8",
      prompt: "current turn",
      sessionEntry: {
        sessionId: "openclaw-session",
        updatedAt: 1,
        execHost: "node",
        execNode: "node-a",
      },
      backend: {
        args: ["-p", "--output-format", "stream-json"],
        resumeArgs: ["-p", "--output-format", "stream-json", "--resume", "{sessionId}"],
        forkArg: "--fork-session",
        env: { ANTHROPIC_API_KEY: "gateway-backend-key" },
        systemPromptWhen: "always",
      },
    });

    await expect(executePreparedCliRun(context, undefined)).rejects.toThrow(
      /truncated the Claude CLI stream before the terminal result/,
    );
    expect(invokeNode.mock.calls[0]?.[0].env).toBeUndefined();
    expect(invokeNode.mock.calls[0]?.[0].clearEnv).toBeUndefined();
  });

  it("cancels a node-placed Claude process when the run aborts", async () => {
    const controller = new AbortController();
    const invokeNode = vi.fn(
      async (params: Parameters<typeof invokeNodeClaudeCliRun>[0]) =>
        await new Promise<Awaited<ReturnType<typeof invokeNodeClaudeCliRun>>>((resolve) => {
          params.signal?.addEventListener(
            "abort",
            () =>
              resolve({
                ok: false,
                error: { code: "ABORTED", message: "node invoke cancelled" },
              }),
            { once: true },
          );
        }),
    );
    setCliRunnerExecuteTestDeps({ invokeNodeClaudeCliRun: invokeNode });
    const context = buildPreparedCliRunContext({
      model: "claude-opus-4-8",
      runId: "run-node-abort",
      sessionEntry: {
        sessionId: "openclaw-session",
        updatedAt: 1,
        execHost: "node",
        execNode: "node-a",
      },
    });
    context.params.abortSignal = controller.signal;
    const diagnostics = captureModelCallDiagnostics("run-node-abort");

    try {
      const run = executePreparedCliRun(context);
      await vi.waitFor(() => expect(invokeNode).toHaveBeenCalledOnce());
      controller.abort();

      await expect(run).rejects.toMatchObject({ name: "AbortError" });
      await waitForDiagnosticEventsDrained();
      expect(invokeNode.mock.calls[0]?.[0].signal?.aborted).toBe(true);
      expectModelCallTypes(diagnostics, ["model.call.started", "model.call.error"]);
      expect(diagnostics.events[1]?.event).toMatchObject({
        transport: "paired-node-cli",
        observationUnit: "turn",
        failureKind: "aborted",
      });
    } finally {
      diagnostics.stop();
    }
  });

  it("uses the canonical exec approval flow before retrying a node Claude run", async () => {
    const plan = {
      argv: ["/trusted/claude", "-p"],
      cwd: "/work/on-node",
      commandText: "/trusted/claude -p",
      agentId: "main",
      sessionKey: "agent:main:catalog-adopt:claude:node",
    };
    const invokeNode = vi.fn(async (input: Parameters<typeof invokeNodeClaudeCliRun>[0]) => {
      if (invokeNode.mock.calls.length === 1) {
        return {
          ok: true,
          payloadJSON: JSON.stringify({
            approvalRequired: true,
            systemRunPlan: plan,
            security: "allowlist",
            ask: "on-miss",
          }),
        };
      }
      input.onProgress(
        `${JSON.stringify({ type: "result", session_id: "approved-node-session", result: "ok" })}\n`,
      );
      return {
        ok: true,
        payloadJSON: JSON.stringify({ exitCode: 0, stderrTail: "", truncated: false }),
      };
    });
    const registerApproval = vi.fn(async () => ({
      id: "approval-1",
      expiresAtMs: Date.now() + 1_000,
    }));
    const resolveApproval = vi.fn(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      return "allow-once";
    });
    setCliRunnerExecuteTestDeps({
      invokeNodeClaudeCliRun: invokeNode,
      registerExecApprovalRequestForHostOrThrow: registerApproval,
      resolveRegisteredExecApprovalDecision: resolveApproval,
    });
    const context = buildPreparedCliRunContext({
      model: "claude-opus-4-8",
      runId: "run-node-approval",
      sessionKey: plan.sessionKey,
      agentId: "main",
      sessionEntry: {
        sessionId: "openclaw-session",
        updatedAt: 1,
        execHost: "node",
        execNode: "node-a",
        execCwd: plan.cwd,
      },
      timeoutMs: 500,
    });

    await expect(executePreparedCliRun(context)).resolves.toMatchObject({
      text: "ok",
      sessionId: "approved-node-session",
    });
    expect(registerApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        systemRunPlan: plan,
        host: "node",
        nodeId: "node-a",
        security: "allowlist",
        ask: "on-miss",
      }),
    );
    expect(resolveApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "approval-1" }),
    );
    expect(invokeNode).toHaveBeenCalledTimes(2);
    expect(invokeNode.mock.calls[1]?.[0]).toMatchObject({
      approvalDecision: "allow-once",
      systemRunPlan: plan,
    });
    expect(invokeNode.mock.calls[1]?.[0].timeoutMs).toBeLessThan(
      invokeNode.mock.calls[0]?.[0].timeoutMs ?? 0,
    );
  });

  it("keeps the node Claude hard deadline while waiting for approval", async () => {
    const plan = {
      argv: ["/trusted/claude", "-p"],
      commandText: "/trusted/claude -p",
    };
    const invokeNode = vi.fn(async () => ({
      ok: true,
      payloadJSON: JSON.stringify({
        approvalRequired: true,
        systemRunPlan: plan,
        security: "allowlist",
        ask: "on-miss",
      }),
    }));
    setCliRunnerExecuteTestDeps({
      invokeNodeClaudeCliRun: invokeNode,
      registerExecApprovalRequestForHostOrThrow: vi.fn(async () => ({
        id: "approval-timeout",
        expiresAtMs: Date.now() + 60_000,
      })),
      resolveRegisteredExecApprovalDecision: vi.fn(
        async () => await new Promise<string | null>(() => {}),
      ),
    });
    const context = buildPreparedCliRunContext({
      model: "claude-opus-4-8",
      timeoutMs: 25,
      sessionEntry: {
        sessionId: "openclaw-session",
        updatedAt: 1,
        execHost: "node",
        execNode: "node-a",
      },
    });

    await expect(executePreparedCliRun(context)).rejects.toMatchObject({
      code: "cli_overall_timeout",
    });
    expect(invokeNode).toHaveBeenCalledOnce();
  });

  it("keeps the node Claude hard deadline while registering approval", async () => {
    const invokeNode = vi.fn(async () => ({
      ok: true,
      payloadJSON: JSON.stringify({
        approvalRequired: true,
        systemRunPlan: {
          argv: ["/trusted/claude", "-p"],
          commandText: "/trusted/claude -p",
        },
        security: "allowlist",
        ask: "on-miss",
      }),
    }));
    const resolveApproval = vi.fn();
    setCliRunnerExecuteTestDeps({
      invokeNodeClaudeCliRun: invokeNode,
      registerExecApprovalRequestForHostOrThrow: vi.fn(
        async () => await new Promise<never>(() => {}),
      ),
      resolveRegisteredExecApprovalDecision: resolveApproval,
    });
    const context = buildPreparedCliRunContext({
      model: "claude-opus-4-8",
      timeoutMs: 25,
      sessionEntry: {
        sessionId: "openclaw-session",
        updatedAt: 1,
        execHost: "node",
        execNode: "node-a",
      },
    });

    await expect(executePreparedCliRun(context)).rejects.toMatchObject({
      code: "cli_overall_timeout",
    });
    expect(invokeNode).toHaveBeenCalledOnce();
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("rejects images before invoking a node-placed Claude session", async () => {
    const invokeNode = vi.fn();
    setCliRunnerExecuteTestDeps({ invokeNodeClaudeCliRun: invokeNode });
    const context = buildPreparedCliRunContext({
      model: "claude-opus-4-8",
      sessionEntry: {
        sessionId: "openclaw-session",
        updatedAt: 1,
        execHost: "node",
        execNode: "node-a",
      },
    });
    context.params.images = [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }];

    await expect(executePreparedCliRun(context)).rejects.toThrow(
      "paired-node Claude CLI sessions do not support attachments or images",
    );
    context.params.images = undefined;
    context.params.imagePrompt = "[image: /tmp/gateway-only.png]";
    await expect(executePreparedCliRun(context)).rejects.toThrow(
      "paired-node Claude CLI sessions do not support attachments or images",
    );
    context.params.imagePrompt = undefined;
    context.params.media = [{ path: "/tmp/hydratable.png", kind: "image" }];
    await expect(executePreparedCliRun(context)).rejects.toThrow(
      "paired-node Claude CLI sessions do not support attachments or images",
    );
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("allows non-hydratable image facts on a text-only node turn", async () => {
    const invokeNode = vi.fn(async (params: Parameters<typeof invokeNodeClaudeCliRun>[0]) => {
      params.onProgress(
        [
          JSON.stringify({ type: "system", subtype: "init", session_id: "node-text-only" }),
          JSON.stringify({ type: "result", session_id: "node-text-only", result: "ok" }),
          "",
        ].join("\n"),
      );
      return {
        ok: true,
        payloadJSON: JSON.stringify({ exitCode: 0, stderrTail: "", truncated: false }),
      };
    });
    setCliRunnerExecuteTestDeps({ invokeNodeClaudeCliRun: invokeNode });
    const context = buildPreparedCliRunContext({
      provider: "claude-cli",
      model: "claude-opus-4-8",
      runId: "run-node-text-only-media-facts",
      prompt: "already described",
      sessionEntry: {
        sessionId: "openclaw-session",
        updatedAt: 1,
        execHost: "node",
        execNode: "node-a",
      },
    });
    context.params.media = [
      { kind: "image" },
      { kind: "image", url: "https://example.test/described.png" },
    ];

    await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "ok" });
    expect(invokeNode).toHaveBeenCalledOnce();
  });

  it("does not inject hardcoded 'Tools are disabled' text into CLI arguments", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: CLAUDE_OK_JSONL,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const backendConfig = {
      command: "claude",
      args: ["-p", "--output-format", "stream-json"],
      output: "jsonl" as const,
      input: "stdin" as const,
      modelArg: "--model",
      sessionArgs: ["--session-id", "{sessionId}"],
      systemPromptArg: "--append-system-prompt",
      systemPromptWhen: "first" as const,
      serialize: true,
    };
    const context: PreparedCliRunContext = {
      params: {
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "Run: node script.mjs",
        provider: "claude-cli",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-no-tools-disabled",
        extraSystemPrompt: "You are a helpful assistant.",
      },
      started: Date.now(),
      workspaceDir: "/tmp",
      backendResolved: {
        id: "claude-cli",
        config: backendConfig,
        bundleMcp: true,
        pluginId: "anthropic",
      },
      preparedBackend: {
        backend: backendConfig,
        env: {},
      },
      reusableCliSession: { mode: "none" },
      hadSessionFile: false,
      contextEngineConfig: {},
      modelId: "sonnet",
      normalizedModel: "sonnet",
      systemPrompt: "You are a helpful assistant.",
      systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
      bootstrapPromptWarningLines: [],
      authEpochVersion: 2,
    };
    await executePreparedCliRun(context);

    const input = mockCallArg(supervisorSpawnMock) as { argv?: string[] };
    const allArgs = (input.argv ?? []).join("\n");
    expect(allArgs).not.toContain("Tools are disabled in this session");
    expect(allArgs).toContain("You are a helpful assistant.");
  });

  it("includes the OpenClaw skills prompt in CLI system prompts", () => {
    const systemPrompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp",
      modelDisplay: "claude-cli/sonnet",
      tools: [],
      skillsPrompt: [
        "<available_skills>",
        "  <skill>",
        "    <name>weather</name>",
        "    <description>Use weather tools.</description>",
        "    <location>/tmp/skills/weather/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
    });

    expect(systemPrompt).toContain("## Skills");
    expect(systemPrompt).toContain("<name>weather</name>");
    expect(systemPrompt).toContain("/tmp/skills/weather/SKILL.md");
  });

  it("pipes Claude prompts over stdin instead of argv", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: CLAUDE_OK_JSONL,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        prompt: "Explain this diff",
      }),
    );

    const input = mockCallArg(supervisorSpawnMock) as {
      argv?: string[];
      input?: string;
    };
    expect(input.input).toContain("Explain this diff");
    expect(input.argv).not.toContain("Explain this diff");
  });

  it("emits metadata-only one-shot Claude model-call diagnostics with aggregate usage", async () => {
    const prompt = "Trace this turn";
    const stdout =
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "cli-trace-1" }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "traced reply" }],
            usage: {
              input_tokens: 11,
              output_tokens: 6,
              cache_read_input_tokens: 125,
              cache_creation_input_tokens: 7,
            },
          },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: "cli-trace-1",
          result: "traced reply",
          usage: {
            input_tokens: 30,
            output_tokens: 15,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 12,
            total_tokens: 357,
          },
        }),
      ].join("\n") + "\n";
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    const diagnostics = captureModelCallDiagnostics("run-claude-model-call-metadata");

    try {
      const output = await executePreparedCliRun(
        buildPreparedCliRunContext({
          model: "claude-sonnet-4-6",
          runId: "run-claude-model-call-metadata",
          prompt,
        }),
      );
      await waitForDiagnosticEventsDrained();

      expect(output.usage).toEqual({
        input: 11,
        output: 6,
        cacheRead: 125,
        cacheWrite: 7,
        total: undefined,
      });
      expect(output.diagnosticUsage).toEqual({
        input: 30,
        output: 15,
        cacheRead: 300,
        cacheWrite: 12,
        total: 357,
      });
      expectModelCallTypes(diagnostics, ["model.call.started", "model.call.completed"]);
      const started = diagnostics.events[0];
      const completed = diagnostics.events[1];
      expect(started?.event).toMatchObject({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        api: "claude-code",
        transport: "stdio",
        observationUnit: "turn",
        promptStats: {
          inputMessagesCount: 1,
          inputMessagesChars: prompt.length,
          systemPromptChars: "You are a helpful assistant.".length,
          totalChars: prompt.length + "You are a helpful assistant.".length,
        },
      });
      expect(completed?.event).toMatchObject({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        api: "claude-code",
        transport: "stdio",
        requestPayloadBytes: Buffer.byteLength(prompt),
        responseStreamBytes: Buffer.byteLength(stdout),
        timeToFirstByteMs: expect.any(Number),
        usage: {
          input: 30,
          output: 15,
          cacheRead: 300,
          cacheWrite: 12,
          total: 357,
        },
      });
      expect(completed?.event.callId).toBe(started?.event.callId);
      expect(completed?.event).not.toHaveProperty("upstreamRequestIdHash");
      expect(started?.privateData.modelContent).toBeUndefined();
      expect(completed?.privateData.modelContent).toBeUndefined();
    } finally {
      diagnostics.stop();
    }
  });

  it("captures only representable Claude prompt and assistant content when opted in", async () => {
    const prompt = "Explain the trace";
    const stdout =
      [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [
              { type: "text", text: "visible answer" },
              { type: "thinking", thinking: "visible reasoning", signature: "opaque-signature" },
              {
                type: "tool_use",
                id: "tool-1",
                name: "Read",
                input: { path: "/private/path" },
              },
            ],
          },
        }),
        JSON.stringify({ type: "result", result: "visible answer" }),
      ].join("\n") + "\n";
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    const diagnostics = captureModelCallDiagnostics("run-claude-model-call-content");

    try {
      await executePreparedCliRun(
        buildPreparedCliRunContext({
          model: "claude-sonnet-4-6",
          runId: "run-claude-model-call-content",
          prompt,
          config: {
            diagnostics: {
              enabled: true,
              otel: {
                enabled: true,
                traces: true,
                captureContent: true,
              },
            },
          },
        }),
      );
      await waitForDiagnosticEventsDrained();

      const completed = diagnostics.events.find(
        ({ event }) => event.type === "model.call.completed",
      );
      expect(completed?.privateData.modelContent).toEqual({
        inputMessages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        outputMessages: [
          {
            role: "assistant",
            stopReason: "end_turn",
            content: [
              { type: "text", text: "visible answer" },
              { type: "thinking", thinking: "visible reasoning" },
              { type: "tool_call", id: "tool-1", name: "Read" },
            ],
          },
        ],
      });
      expect(completed?.privateData.modelContent?.toolDefinitions).toBeUndefined();
      expect(JSON.stringify(completed?.privateData.modelContent)).not.toContain("/private/path");
      expect(JSON.stringify(completed?.privateData.modelContent)).not.toContain("opaque-signature");
    } finally {
      diagnostics.stop();
    }
  });

  it("emits one Claude model-call error when one-shot process startup fails", async () => {
    supervisorSpawnMock.mockRejectedValueOnce(new Error("claude process spawn failed"));
    const diagnostics = captureModelCallDiagnostics("run-claude-model-call-spawn-error");

    try {
      await expect(
        executePreparedCliRun(
          buildPreparedCliRunContext({
            model: "claude-sonnet-4-6",
            runId: "run-claude-model-call-spawn-error",
            prompt: "fail now",
          }),
        ),
      ).rejects.toThrow("claude process spawn failed");
      await waitForDiagnosticEventsDrained();

      expectModelCallTypes(diagnostics, ["model.call.started", "model.call.error"]);
      expect(diagnostics.events[1]?.event).toMatchObject({
        errorCategory: "Error",
        requestPayloadBytes: Buffer.byteLength("fail now"),
      });
      expect(diagnostics.events[1]?.privateData.errorMessage).toBe("claude process spawn failed");
    } finally {
      diagnostics.stop();
    }
  });

  it.each([
    {
      label: "timeout",
      runId: "run-claude-model-call-timeout",
      exit: {
        reason: "overall-timeout" as const,
        exitCode: null,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: false,
      },
      errorCategory: "timeout",
      failureKind: "timeout",
    },
    {
      label: "parse failure",
      runId: "run-claude-model-call-parse-error",
      exit: {
        reason: "exit" as const,
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: `${JSON.stringify({ type: "system", subtype: "unexpected" })}\n`,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      },
      errorCategory: "unknown",
      failureKind: undefined,
    },
  ])("emits one Claude model-call error for $label", async (testCase) => {
    supervisorSpawnMock.mockResolvedValueOnce(createManagedRun(testCase.exit));
    const diagnostics = captureModelCallDiagnostics(testCase.runId);

    try {
      await expect(
        executePreparedCliRun(
          buildPreparedCliRunContext({
            model: "claude-sonnet-4-6",
            runId: testCase.runId,
          }),
        ),
      ).rejects.toThrow();
      await waitForDiagnosticEventsDrained();

      expectModelCallTypes(diagnostics, ["model.call.started", "model.call.error"]);
      expect(diagnostics.events[1]?.event).toMatchObject({
        errorCategory: testCase.errorCategory,
      });
      if (testCase.failureKind) {
        expect(diagnostics.events[1]?.event).toMatchObject({
          failureKind: testCase.failureKind,
        });
      } else {
        expect(diagnostics.events[1]?.event).not.toHaveProperty("failureKind");
      }
    } finally {
      diagnostics.stop();
    }
  });

  it("passes Claude system prompts through a file instead of argv", async () => {
    let systemPromptPath = "";
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { argv?: string[] };
      systemPromptPath = requireArgAfter(input.argv, "--append-system-prompt-file");
      expect(systemPromptPath).toContain("openclaw-cli-system-prompt-");
      await expect(fs.readFile(systemPromptPath, "utf-8")).resolves.toBe(
        "You are a helpful assistant.",
      );
      expect(input.argv).not.toContain("You are a helpful assistant.");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: CLAUDE_OK_JSONL,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    await executePreparedCliRun(buildPreparedCliRunContext({}));

    await expectPathMissing(systemPromptPath);
  });

  it("resends system prompts through a file for soft-resumed prompt-tool drift", async () => {
    const writeSoftResumeSystemPromptFile = vi.fn(async () => ({
      filePath: "/tmp/openclaw-soft-resume-system-prompt.md",
      cleanup: async () => {},
    }));
    setCliRunnerExecuteTestDeps({
      writeCliSystemPromptFile: writeSoftResumeSystemPromptFile,
    });
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { argv?: string[] };
      expect(input.argv).toContain("resume");
      expect(input.argv).toContain("soft-cli-session");
      expect(input.argv?.join(" ")).toContain("/tmp/openclaw-soft-resume-system-prompt.md");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });
    const context = buildPreparedCliRunContext({
      provider: "codex-cli",
      model: "gpt-5.4",
    });
    context.reusableCliSession = {
      mode: "reuse-with-drift",
      sessionId: "soft-cli-session",
      drift: { reasons: ["prompt-tools"] },
    };

    await executePreparedCliRun(context, "soft-cli-session");

    expect(writeSoftResumeSystemPromptFile).toHaveBeenCalledWith({
      backend: context.preparedBackend.backend,
      systemPrompt: "You are a helpful assistant.",
    });
  });

  it("passes --session-id for new Claude sessions", async () => {
    mockSuccessfulCliRun(CLAUDE_OK_JSONL);

    await executePreparedCliRun(buildPreparedCliRunContext({}));

    const input = mockCallArg(supervisorSpawnMock) as {
      argv?: string[];
      input?: string;
      mode?: string;
    };
    expect(input.mode).toBe("child");
    expect(input.argv).toContain("claude");
    expect(requireArgAfter(input.argv, "--session-id")).not.toBe("");
    expect(input.input).toContain("hi");
    expect(input.argv).not.toContain("hi");
  });

  it("does not pass a Claude session id for side-question runs", async () => {
    mockSuccessfulCliRun(CLAUDE_OK_JSONL);
    const resolveExecutionArgs = vi.fn(({ baseArgs }) => [...baseArgs, "--max-turns", "1"]);

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        runId: "run-claude-side-question",
        executionMode: "side-question",
        backend: { sessionMode: "none" },
        resolveExecutionArgs,
      }),
    );

    const resolveArgsInput = requireRecord(mockCallArg(resolveExecutionArgs), "resolved args");
    expect(resolveArgsInput.executionMode).toBe("side-question");
    expect(resolveArgsInput.useResume).toBe(false);
    const input = mockCallArg(supervisorSpawnMock) as { argv?: string[]; input?: string };
    expect(input.argv).not.toContain("--session-id");
    expect(input.argv).toContain("--max-turns");
    expect(input.input).toContain("hi");
  });

  it("applies backend-owned per-run args before spawning", async () => {
    mockSuccessfulCliRun(CLAUDE_OK_JSONL);
    const resolveExecutionArgs = vi.fn(({ baseArgs }) => [...baseArgs, "--effort", "high"]);

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        thinkLevel: "high",
        resolveExecutionArgs,
      }),
    );

    const resolveArgsInput = requireRecord(mockCallArg(resolveExecutionArgs), "resolved args");
    expect(resolveArgsInput.provider).toBe("claude-cli");
    expect(resolveArgsInput.modelId).toBe("sonnet");
    expect(resolveArgsInput.thinkingLevel).toBe("high");
    expect(resolveArgsInput.useResume).toBe(false);
    expect(resolveArgsInput.baseArgs).toEqual(["-p", "--output-format", "stream-json"]);
    const input = mockCallArg(supervisorSpawnMock) as { argv?: string[] };
    expect(requireArgAfter(input.argv, "--effort")).toBe("high");
  });

  it("preserves exact tool availability through execution-time argument resolution", async () => {
    mockSuccessfulCliRun(CLAUDE_OK_JSONL);
    const toolAvailability: NonNullable<PreparedCliRunContext["params"]["cliToolAvailability"]> = {
      native: [],
      openClaw: ["openclaw"],
    };
    const resolveExecutionArgs = vi.fn(({ baseArgs }) => baseArgs);

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        runId: "run-claude-tool-policy",
        cliToolAvailability: toolAvailability,
        resolveExecutionArgs,
      }),
    );

    expect(resolveExecutionArgs).toHaveBeenCalledWith(
      expect.objectContaining({
        toolAvailability: {
          ...toolAvailability,
          mcp: ["mcp__openclaw__openclaw"],
        },
      }),
    );
  });

  it("fails closed when a selectable backend does not enforce exact tool availability", async () => {
    const resolveExecutionArgs = vi.fn(() => undefined);

    await expect(
      executePreparedCliRun(
        buildPreparedCliRunContext({
          cliToolAvailability: {
            native: [],
            openClaw: ["openclaw"],
          },
          resolveExecutionArgs,
        }),
      ),
    ).rejects.toThrow("did not enforce exact per-run tool availability");
    expect(supervisorSpawnMock).not.toHaveBeenCalled();
  });

  it("does not require an argv rewrite after prepared-execution enforcement", async () => {
    mockSuccessfulCliRun(GEMINI_OK_JSONL);

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "google-gemini-cli",
        model: "gemini-3.1-pro-preview",
        cliToolAvailability: { native: [], openClaw: ["openclaw"] },
        toolAvailabilityEnforcement: "prepare-execution",
      }),
    );

    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
  });

  it("maps Ultra to the strongest generic CLI backend level", async () => {
    mockSuccessfulCliRun(CLAUDE_OK_JSONL);
    const resolveExecutionArgs = vi.fn(({ baseArgs }) => baseArgs);

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        thinkLevel: "ultra",
        resolveExecutionArgs,
      }),
    );

    const resolveArgsInput = requireRecord(mockCallArg(resolveExecutionArgs), "resolved args");
    expect(resolveArgsInput.thinkingLevel).toBe("max");
  });

  it("passes prepared backend env to the spawned CLI process", async () => {
    mockSuccessfulCliRun();

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "codex-cli",
        model: "gpt-5.5",
        backend: {
          env: {
            GEMINI_CLI_HOME: "/ignored/static-home",
            STATIC_BACKEND_FLAG: "set",
          },
        },
        preparedEnv: {
          GEMINI_CLI_HOME: "/tmp/openclaw-gemini-profile-home",
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: "/tmp/openclaw-gemini-system-settings.json",
        },
      }),
    );

    const input = mockCallArg(supervisorSpawnMock) as { env?: Record<string, string> };
    expect(input.env?.STATIC_BACKEND_FLAG).toBe("set");
    expect(input.env?.GEMINI_CLI_HOME).toBe("/tmp/openclaw-gemini-profile-home");
    expect(input.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(
      "/tmp/openclaw-gemini-system-settings.json",
    );
  });

  it("captures a runtime artifact for a strict CLI credential", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-strict-artifact-"));
    const executable = path.join(dir, "claude-fixture");
    try {
      await fs.copyFile(process.execPath, executable);
      await fs.chmod(executable, 0o755);
      mockSuccessfulCliRun(CLAUDE_OK_JSONL);
      const context = buildPreparedCliRunContext({
        backend: { command: executable },
        onSuccessfulAuthBinding: () => {},
        runtimeArtifact: {
          kind: "bundled-package-tree",
          packageName: "@fixture/native-cli",
          entrypoint: "command",
          nativeExecutableNames: ["claude-fixture"],
        },
      });
      context.authBindingFingerprint = "strict-credential-owner";

      await executePreparedCliRun(context);

      expect(context.runtimeArtifactFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(context.runtimeOwnerFingerprint).toBeUndefined();
      const input = mockCallArg(supervisorSpawnMock) as { argv?: string[] };
      expect(input.argv?.[0]).toBe(await fs.realpath(executable));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("passes OpenClaw skills to Claude as a session plugin", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-skills-"));
    const skillDir = path.join(workspaceDir, "skills", "weather");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: weather",
        "description: Use weather tools for forecasts.",
        "---",
        "",
        "Read forecast data before replying.",
      ].join("\n"),
      "utf-8",
    );

    let pluginDir = "";
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { argv?: string[] };
      pluginDir = requireArgAfter(input.argv, "--plugin-dir");
      const manifest = JSON.parse(
        await fs.readFile(path.join(pluginDir, ".claude-plugin", "plugin.json"), "utf-8"),
      ) as { name?: string; skills?: string };
      expect(manifest.name).toBe("openclaw-skills");
      expect(manifest.skills).toBe("./skills");
      await expect(
        fs.readFile(path.join(pluginDir, "skills", "weather", "SKILL.md"), "utf-8"),
      ).resolves.toContain("Read forecast data before replying.");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: CLAUDE_OK_JSONL,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    try {
      await executePreparedCliRun(
        buildPreparedCliRunContext({
          workspaceDir,
          skillsSnapshot: {
            prompt: "",
            skills: [{ name: "weather" }],
            resolvedSkills: [
              {
                name: "weather",
                description: "Use weather tools for forecasts.",
                filePath: path.join(skillDir, "SKILL.md"),
                baseDir: skillDir,
                source: "test",
                sourceInfo: {
                  path: skillDir,
                  source: "test",
                  scope: "project",
                  origin: "top-level",
                  baseDir: skillDir,
                },
                disableModelInvocation: false,
              },
            ],
          },
        }),
      );
      let accessError: unknown;
      try {
        await fs.access(pluginDir);
      } catch (error) {
        accessError = error;
      }
      expect((accessError as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("injects skill env overrides into CLI child env and restores host env", async () => {
    const previousEnvValue = process.env.CLI_SKILL_API_KEY;
    delete process.env.CLI_SKILL_API_KEY;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { env?: Record<string, string> };
      expect(input.env?.CLI_SKILL_API_KEY).toBe("skill-secret");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: CLAUDE_OK_JSONL,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    try {
      await executePreparedCliRun(
        buildPreparedCliRunContext({
          config: {
            skills: {
              entries: {
                envskill: { apiKey: "skill-secret" }, // pragma: allowlist secret
              },
            },
          },
          skillsSnapshot: {
            prompt: "",
            skills: [{ name: "envskill", primaryEnv: "CLI_SKILL_API_KEY" }],
          },
        }),
      );
      expect(process.env.CLI_SKILL_API_KEY).toBeUndefined();
    } finally {
      if (previousEnvValue === undefined) {
        delete process.env.CLI_SKILL_API_KEY;
      } else {
        process.env.CLI_SKILL_API_KEY = previousEnvValue;
      }
    }
  });

  it("runs CLI through supervisor and returns payload", async () => {
    const logInfoSpy = vi.spyOn(cliBackendLog, "info").mockImplementation(() => undefined);
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const context = buildPreparedCliRunContext({
      provider: "codex-cli",
      model: "gpt-5.4",
    });
    context.reusableCliSession = { mode: "reuse", sessionId: "thread-123" };

    try {
      const result = await executePreparedCliRun(context, "thread-123");

      expect(result.text).toBe("ok");
      const input = mockCallArg(supervisorSpawnMock) as {
        argv?: string[];
        mode?: string;
        timeoutMs?: number;
        noOutputTimeoutMs?: number;
        replaceExistingScope?: boolean;
        scopeKey?: string;
      };
      expect(input.mode).toBe("child");
      expect(input.argv).toEqual([
        "codex",
        "exec",
        "resume",
        "thread-123",
        "--skip-git-repo-check",
        "--model",
        "gpt-5.4",
        "hi",
      ]);
      expect(input.timeoutMs).toBe(1_000);
      expect(input.noOutputTimeoutMs).toBeGreaterThanOrEqual(1_000);
      expect(input.replaceExistingScope).toBe(true);
      expect(input.scopeKey).toContain("thread-123");

      const turnLog = logInfoSpy.mock.calls
        .map(([message]) => message)
        .find((message) => message.startsWith("cli turn:"));
      expect(turnLog).toContain("provider=codex-cli");
      expect(turnLog).toContain("model=gpt-5.4");
      expect(turnLog).toContain("outBytes=2 outHash=2689367b205c");
      expect(turnLog).not.toContain("ok");
    } finally {
      logInfoSpy.mockRestore();
    }
  });

  it("returns process diagnostics with byte counts and bounded output hashes", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 75,
        stdout: "ok",
        stderr: "warn\n",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const result = await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "codex-cli",
        model: "gpt-5.4",
      }),
    );

    expect(result.diagnostics?.process).toEqual({
      backendId: "codex-cli",
      processReason: "exit",
      exitCode: 0,
      exitSignal: null,
      durationMs: 75,
      stdoutBytes: 2,
      stdoutHash: "2689367b205c",
      stderrBytes: 5,
      stderrHash: "7597e6b3a377",
      useResume: false,
    });
  });

  it("rejects Gemini stream-json error results emitted with a zero exit code", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout:
          [
            JSON.stringify({
              type: "message",
              role: "assistant",
              content: "partial text",
              delta: true,
            }),
            JSON.stringify({
              type: "result",
              status: "error",
              error: {
                message: "Gemini stream failed",
              },
            }),
          ].join("\n") + "\n",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await expectRejectsWithFields(
      executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "google-gemini-cli",
          model: "gemini-3.1-pro-preview",
        }),
      ),
      {
        name: "FailoverError",
        message: "Gemini stream failed",
        reason: "unknown",
      },
    );
  });

  it("passes Codex system prompts through model_instructions_file", async () => {
    let promptFileText = "";
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { argv?: string[] };
      const configArg = requireArgAfter(input.argv, "-c");
      const match = requireRegexMatch(configArg, /^model_instructions_file="(.+)"$/);
      promptFileText = await fs.readFile(
        expectDefined(match[1], "match[1] test invariant"),
        "utf-8",
      );
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "codex-cli",
        model: "gpt-5.4",
      }),
    );

    expect(promptFileText).toBe("You are a helpful assistant.");
  });

  it("cancels the managed CLI run when the abort signal fires", async () => {
    const abortController = new AbortController();
    let resolveWait:
      | ((value: {
          reason:
            | "manual-cancel"
            | "overall-timeout"
            | "no-output-timeout"
            | "spawn-error"
            | "signal"
            | "exit";
          exitCode: number | null;
          exitSignal: NodeJS.Signals | number | null;
          durationMs: number;
          stdout: string;
          stderr: string;
          timedOut: boolean;
          noOutputTimedOut: boolean;
        }) => void)
      | undefined;
    const cancel = vi.fn((reason?: string) => {
      if (!resolveWait) {
        throw new Error("Expected managed CLI wait resolver to be initialized");
      }
      resolveWait({
        reason: reason === "manual-cancel" ? "manual-cancel" : "signal",
        exitCode: null,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });
    supervisorSpawnMock.mockResolvedValueOnce({
      pid: 1234,
      startedAtMs: Date.now(),
      stdin: undefined,
      wait: vi.fn(
        async () =>
          await new Promise((resolve) => {
            resolveWait = resolve;
          }),
      ),
      cancel,
    });

    const context = buildPreparedCliRunContext({
      provider: "codex-cli",
      model: "gpt-5.4",
    });
    context.params.abortSignal = abortController.signal;

    const runPromise = executePreparedCliRun(context);

    await vi.waitFor(() => {
      expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    });
    abortController.abort();

    await expectRejectsWithFields(runPromise, { name: "AbortError" });
    expect(cancel).toHaveBeenCalledWith("manual-cancel");
  });

  it("streams Claude text deltas from stream-json stdout", async () => {
    const agentEvents: Array<{ stream: string; text?: string; delta?: string }> = [];
    const stop = onAgentEvent((evt) => {
      agentEvents.push({
        stream: evt.stream,
        text: typeof evt.data.text === "string" ? evt.data.text : undefined,
        delta: typeof evt.data.delta === "string" ? evt.data.delta : undefined,
      });
    });
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      input.onStdout?.(
        [
          JSON.stringify({ type: "init", session_id: "session-123" }),
          JSON.stringify({
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
          }),
        ].join("\n") + "\n",
      );
      input.onStdout?.(
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: " world" } },
        }) + "\n",
      );
      input.onStdout?.(
        JSON.stringify({
          type: "result",
          session_id: "session-123",
          result: "Hello world",
        }) + "\n",
      );
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    try {
      const result = await executePreparedCliRun(buildPreparedCliRunContext({}));

      expect(result.text).toBe("Hello world");
      expect(agentEvents).toEqual([
        { stream: "assistant", text: "Hello", delta: "Hello" },
        { stream: "assistant", text: "Hello world", delta: " world" },
      ]);
    } finally {
      stop();
    }
  });

  it("suppresses Claude text delta events for side-question runs", async () => {
    const agentEvents: Array<{ stream: string; text?: string; delta?: string }> = [];
    const stop = onAgentEvent((evt) => {
      agentEvents.push({
        stream: evt.stream,
        text: typeof evt.data.text === "string" ? evt.data.text : undefined,
        delta: typeof evt.data.delta === "string" ? evt.data.delta : undefined,
      });
    });
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      input.onStdout?.(
        [
          JSON.stringify({ type: "init", session_id: "session-123" }),
          JSON.stringify({
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
          }),
          JSON.stringify({
            type: "result",
            session_id: "session-123",
            result: "Hello",
          }),
        ].join("\n") + "\n",
      );
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    try {
      const result = await executePreparedCliRun(
        buildPreparedCliRunContext({
          executionMode: "side-question",
          backend: { sessionMode: "none" },
        }),
      );

      expect(result.text).toBe("Hello");
      expect(agentEvents).toEqual([]);
    } finally {
      stop();
    }
  });

  it("keeps one managed Claude model call open until background task results drain", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    const writes: string[] = [];
    const cancel = vi.fn();
    const interimChunk =
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "live-trace" }),
        JSON.stringify({
          type: "assistant",
          session_id: "live-trace",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "working" }],
            usage: { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 20 },
          },
        }),
        JSON.stringify({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "task-1", task_type: "local_agent", description: "research" }],
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: "live-trace",
          result: "working",
          usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 25 },
        }),
      ].join("\n") + "\n";
    const finalChunk =
      [
        JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: [] }),
        JSON.stringify({
          type: "assistant",
          session_id: "live-trace",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "finished" }],
            usage: { input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 30 },
          },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: "live-trace",
          result: "finished",
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 2,
          },
        }),
      ].join("\n") + "\n";
    const stdin = {
      write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
        writes.push(data);
        stdoutListener?.(interimChunk);
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-model-call",
        pid: 2345,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel,
      };
    });
    const diagnostics = captureModelCallDiagnostics("run-live-model-call-background");

    try {
      const run = executePreparedCliRun(
        buildClaudeLiveRunContext({
          model: "claude-sonnet-4-6",
          runId: "run-live-model-call-background",
          prompt: "research this",
          config: {
            diagnostics: {
              enabled: true,
              otel: {
                enabled: true,
                traces: true,
                captureContent: true,
              },
            },
          },
        }),
      );
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      await waitForDiagnosticEventsDrained();
      expect(diagnostics.events.map(({ event }) => event.type)).toEqual(["model.call.started"]);

      stdoutListener?.(finalChunk);
      const output = await run;
      await waitForDiagnosticEventsDrained();

      expect(output.text).toContain("working");
      expect(output.text).toContain("finished");
      expect(output.usage).toEqual({
        input: 6,
        output: 2,
        cacheRead: 30,
        cacheWrite: undefined,
        total: undefined,
      });
      expectModelCallTypes(diagnostics, ["model.call.started", "model.call.completed"]);
      const completed = diagnostics.events[1];
      expect(completed?.event).toMatchObject({
        api: "claude-code",
        transport: "stdio-live",
        observationUnit: "turn",
        requestPayloadBytes: Buffer.byteLength(writes[0] ?? ""),
        responseStreamBytes: Buffer.byteLength(interimChunk) + Buffer.byteLength(finalChunk),
        usage: {
          input: 10,
          output: 3,
          cacheRead: 50,
          cacheWrite: 2,
        },
      });
      expect(completed?.privateData.modelContent?.outputMessages).toEqual([
        { role: "assistant", content: [{ type: "text", text: "working" }] },
        { role: "assistant", content: [{ type: "text", text: "finished" }] },
      ]);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      diagnostics.stop();
    }
  });

  it("emits one terminal model-call error for a managed Claude result failure", async () => {
    mockClaudeLiveRun(supervisorSpawnMock, {
      runId: "live-model-call-error",
      pid: 2346,
      events: [
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "live-error",
          result: "managed turn failed",
          usage: { input_tokens: 8, output_tokens: 2, cache_read_input_tokens: 40 },
        },
      ],
    });
    const diagnostics = captureModelCallDiagnostics("run-live-model-call-error");

    try {
      await expect(
        executePreparedCliRun(
          buildClaudeLiveRunContext({
            model: "claude-sonnet-4-6",
            runId: "run-live-model-call-error",
          }),
        ),
      ).rejects.toThrow(/managed turn failed/i);
      await waitForDiagnosticEventsDrained();

      expectModelCallTypes(diagnostics, ["model.call.started", "model.call.error"]);
      expect(diagnostics.events[1]?.event).toMatchObject({
        transport: "stdio-live",
        usage: { input: 8, output: 2, cacheRead: 40 },
      });
    } finally {
      diagnostics.stop();
    }
  });

  it("reuses a Claude live session process across turns", async () => {
    const logInfoSpy = vi.spyOn(cliBackendLog, "info").mockImplementation(() => undefined);
    const agentEvents: unknown[] = [];
    const stop = onAgentEvent((evt) => {
      if (evt.stream === "assistant") {
        agentEvents.push(evt.data);
      }
    });
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: ({ data, emit }) => {
        const prompt = (JSON.parse(data) as { message: { content: string } }).message.content;
        const text = prompt === "first" ? "one" : "two";
        emit([
          { type: "system", subtype: "init", session_id: "live-session-1" },
          {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text },
            },
          },
          { type: "result", session_id: "live-session-1", result: text },
        ]);
      },
    });

    try {
      const firstContext = buildClaudeLiveRunContext({
        prompt: "first",
        backend: {
          args: ["-p", "--strict-mcp-config", "--mcp-config", "/tmp/mcp-one.json"],
          resumeArgs: [
            "-p",
            "--resume",
            "{sessionId}",
            "--strict-mcp-config",
            "--mcp-config",
            "/tmp/mcp-one.json",
          ],
        },
        mcpConfigHash: "same-mcp-config",
      });
      const first = await executePreparedCliRun(firstContext);
      const liveGeneration = getClaudeLiveSessionGenerationForOwner({
        backendId: "claude-cli",
        sessionId: "s1",
      });
      expect(liveGeneration).toBeDefined();
      const secondContext = buildClaudeLiveRunContext({
        prompt: "second",
        backend: {
          args: ["-p", "--strict-mcp-config", "--mcp-config", "/tmp/mcp-two.json"],
          resumeArgs: [
            "-p",
            "--resume",
            "{sessionId}",
            "--strict-mcp-config",
            "--mcp-config",
            "/tmp/mcp-two.json",
          ],
        },
        mcpConfigHash: "same-mcp-config",
      });
      secondContext.requiredClaudeLiveSessionGeneration = liveGeneration;
      const second = await executePreparedCliRun(secondContext, "live-session-1");

      const changedContext = buildClaudeLiveRunContext({
        model: "opus",
        prompt: "changed",
        backend: {
          args: ["-p"],
          resumeArgs: ["-p", "--resume", "{sessionId}"],
        },
        mcpConfigHash: "same-mcp-config",
      });
      changedContext.requiredClaudeLiveSessionGeneration = liveGeneration;
      await expect(executePreparedCliRun(changedContext, "live-session-1")).rejects.toMatchObject({
        reason: "session_expired",
        code: "cli_live_session_changed",
      });

      const spawnInput = mockCallArg(supervisorSpawnMock) as {
        argv?: string[];
        stdinMode?: string;
      };
      expect(first.text).toBe("one");
      expect(second.text).toBe("two");
      expect(supervisorSpawnMock).toHaveBeenCalledOnce();
      expect(spawnInput.stdinMode).toBe("pipe-open");
      expect(spawnInput.argv).toContain("--input-format");
      expect(spawnInput.argv).toContain("--output-format");
      expect(spawnInput.argv).toContain("stream-json");
      expect(spawnInput.argv).toContain("--replay-user-messages");
      expect(spawnInput.argv).not.toContain("--session-id");
      expect(spawnInput.argv).toContain("/tmp/mcp-one.json");
      expect(
        live.writes.map(
          (entry) => (JSON.parse(entry) as { message: { content: string } }).message.content,
        ),
      ).toEqual(["first", "second"]);
      expect(agentEvents).toEqual([
        { text: "one", delta: "one" },
        { text: "two", delta: "two" },
      ]);
      const turnLogs = logInfoSpy.mock.calls
        .map(([message]) => message)
        .filter((message) => message.startsWith("claude live session turn:"));
      expect(turnLogs).toHaveLength(2);
      expect(turnLogs[0]).toContain("outBytes=3 outHash=7692c3ad3540");
      expect(turnLogs[1]).toContain("outBytes=3 outHash=3fc4ccfe7458");
      expect(turnLogs.join("\n")).not.toContain("one");
      expect(turnLogs.join("\n")).not.toContain("two");
    } finally {
      logInfoSpy.mockRestore();
      stop();
    }
  });

  it("requires the exact warm Claude process even without native resume args", async () => {
    const liveRuns = Array.from({ length: 3 }, () =>
      mockClaudeLiveRun(supervisorSpawnMock, {
        pid: 2346,
        events: [
          { type: "system", subtype: "init", session_id: "live-session-1" },
          { type: "result", session_id: "live-session-1", result: "one" },
        ],
      }),
    );

    const firstContext = buildPreparedCliRunContext({
      prompt: "first",
      backend: { args: ["-p"], resumeArgs: [], liveSession: "claude-stdio" },
    });
    expect((await executePreparedCliRun(firstContext)).text).toBe("one");
    const liveGeneration = getClaudeLiveSessionGenerationForOwner({
      backendId: "claude-cli",
      sessionId: "s1",
    });
    expect(liveGeneration).toBeDefined();

    resetClaudeLiveSessionsForTest();
    const missingContext = buildPreparedCliRunContext({
      prompt: "second",
      backend: { args: ["-p"], resumeArgs: [], liveSession: "claude-stdio" },
    });
    missingContext.requiredClaudeLiveSessionGeneration = liveGeneration;

    await expect(executePreparedCliRun(missingContext, "live-session-1")).rejects.toMatchObject({
      reason: "session_expired",
      code: "cli_live_session_missing",
    });

    const replacementContext = buildPreparedCliRunContext({
      prompt: "replacement",
      backend: { args: ["-p"], resumeArgs: [], liveSession: "claude-stdio" },
    });
    expect((await executePreparedCliRun(replacementContext)).text).toBe("one");
    await expect(executePreparedCliRun(missingContext, "live-session-1")).rejects.toMatchObject({
      reason: "session_expired",
      code: "cli_live_session_changed",
    });
    missingContext.openClawHistoryPrompt = "bounded OpenClaw history\n\nsecond";
    expect((await executePreparedCliRun(missingContext)).text).toBe("one");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(3);
    expect(
      (JSON.parse(liveRuns[2]?.writes.at(-1) ?? "") as { message: { content: string } }).message
        .content,
    ).toBe("bounded OpenClaw history\n\nsecond");
  });

  it("keeps pre-tool commentary out of an empty-result Claude live reply", async () => {
    const agentEvents: Array<{ stream: string; data: unknown }> = [];
    const stop = onAgentEvent((event) => {
      agentEvents.push({ stream: event.stream, data: event.data });
    });
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "live-empty-result" },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Let me check." },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "tool-1", name: "Read", input: {} },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Final answer." },
          },
        },
        { type: "result", session_id: "live-empty-result", result: "" },
      ],
    });

    try {
      const result = await executePreparedCliRun(
        buildClaudeLiveRunContext({
          emitCommentaryText: true,
        }),
      );

      expect(result.text).toBe("Final answer.");
      expect(agentEvents).toContainEqual({
        stream: "item",
        data: expect.objectContaining({
          kind: "preamble",
          progressText: "Let me check.",
        }),
      });
      expect(agentEvents).toContainEqual({
        stream: "assistant",
        data: { text: "Final answer.", delta: "Final answer." },
      });
    } finally {
      stop();
    }
  });

  it("extends the live no-output watchdog to the blocked-tool floor while a tool is outstanding", async () => {
    const toolErrorEvents: Array<Record<string, unknown>> = [];
    const stopDiagnostics = onTrustedToolExecutionEvent((event) => {
      if (event.type === "tool.execution.error") {
        toolErrorEvents.push(event as unknown as Record<string, unknown>);
      }
    });
    let stdoutListener: ((chunk: string) => void) | undefined;
    const cancel = vi.fn();
    const stdin = {
      write: vi.fn((_data: string, callback?: (error?: Error | null) => void) => {
        stdoutListener?.(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-quiet-tool" }),
            JSON.stringify({
              type: "assistant",
              message: {
                content: [{ type: "tool_use", id: "tool-quiet-1", name: "Bash", input: {} }],
              },
            }),
          ].join("\n") + "\n",
        );
        callback?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        pid: 2345,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel,
      };
    });

    const run = executePreparedCliRun(
      buildClaudeLiveRunContext({
        timeoutMs: 3_600_000,
      }),
    );
    const rejection = expect(run).rejects.toThrow(/produced no output for 900s/);
    await vi.waitFor(() => {
      expect(stdin.write).toHaveBeenCalledOnce();
    });

    // Fake the clock only after the spawn path settled, then emit one more
    // stdout line so the watchdog re-arms on the faked setTimeout/Date.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    stdoutListener?.(
      `${JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "running" } },
      })}\n`,
    );

    // Base watchdog (600s cap for a 1h budget) must not kill the quiet tool.
    await vi.advanceTimersByTimeAsync(650_000);
    expect(cancel).not.toHaveBeenCalled();

    // The blocked-tool floor (15min of quiet) still terminates a wedged tool.
    try {
      await vi.advanceTimersByTimeAsync(300_000);
      expect(cancel).toHaveBeenCalledWith("manual-cancel");
      await rejection;
      // Watchdog-killed turns must keep timeout provenance for active tools.
      expect(toolErrorEvents).toContainEqual(
        expect.objectContaining({
          toolCallId: "tool-quiet-1",
          terminalReason: "timed_out",
        }),
      );
    } finally {
      stopDiagnostics();
    }
  });

  it("keeps non-capture live prepared backend cleanup with the whole-run owner", async () => {
    mockClaudeLiveRun(supervisorSpawnMock, {
      runId: "live-cleanup-run",
      pid: 2346,
      events: [
        { type: "system", subtype: "init", session_id: "live-session-cleanup" },
        { type: "result", session_id: "live-session-cleanup", result: "ok" },
      ],
    });
    const preparedBackendCleanup = vi.fn(async () => {});
    const context = buildClaudeLiveRunContext({
      prompt: "first",
      backend: {
        args: ["-p", "--strict-mcp-config", "--mcp-config", "/tmp/mcp-cleanup.json"],
      },
      mcpConfigHash: "cleanup-mcp-config",
    });
    context.preparedBackend.cleanup = preparedBackendCleanup;

    const result = await executePreparedCliRun(context);

    expect(result.text).toBe("ok");
    expect(context.preparedBackend.cleanup).toBe(preparedBackendCleanup);
    expect(preparedBackendCleanup).not.toHaveBeenCalled();

    resetClaudeLiveSessionsForTest();
    expect(preparedBackendCleanup).not.toHaveBeenCalled();
    await context.preparedBackend.cleanup?.();
    expect(preparedBackendCleanup).toHaveBeenCalledOnce();
  });

  it("keeps captured live prepared backend cleanup with the whole-run owner", async () => {
    const mcpConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-cli-captured-mcp-config-"),
    );
    const mcpConfigPath = path.join(mcpConfigDir, "mcp.json");
    await fs.writeFile(
      mcpConfigPath,
      `${JSON.stringify(
        {
          mcpServers: {
            openclaw: {
              type: "http",
              url: "http://127.0.0.1:23119/mcp",
              headers: {},
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    try {
      mockClaudeLiveRun(supervisorSpawnMock, {
        cancelable: true,
        pid: 2347,
        events: [
          { type: "system", subtype: "init", session_id: "captured-live-cleanup" },
          { type: "result", session_id: "captured-live-cleanup", result: "ok" },
        ],
      });
      const preparedBackendCleanup = vi.fn(async () => {});
      const context = buildClaudeLiveRunContext({
        prompt: "first",
        backend: {
          args: ["-p", "--strict-mcp-config", "--mcp-config", mcpConfigPath],
        },
        mcpConfigHash: "captured-cleanup-mcp-config",
        mcpDeliveryCapture: true,
      });
      context.preparedBackend.cleanup = preparedBackendCleanup;

      const result = await executePreparedCliRun(context);

      expect(result.text).toBe("ok");
      expect(context.preparedBackend.cleanup).toBe(preparedBackendCleanup);
      expect(preparedBackendCleanup).not.toHaveBeenCalled();

      await context.preparedBackend.cleanup?.();
      expect(preparedBackendCleanup).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(mcpConfigDir, { recursive: true, force: true });
    }
  });

  it("preserves completed output when system prompt cleanup fails after delivery", async () => {
    const cleanupError = new Error("system prompt cleanup failed");
    const logWarnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    setCliRunnerExecuteTestDeps({
      writeCliSystemPromptFile: async () => ({
        filePath: "/tmp/system-prompt.md",
        cleanup: async () => {
          throw cleanupError;
        },
      }),
    });
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const captureHandle = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: { action: "send", target: "chat123", message: "done" },
      });
      if (!captureHandle) {
        throw new Error("Expected message delivery capture");
      }
      recordMcpLoopbackToolCallResult({
        captureHandle,
        toolName: "message",
        args: { action: "send", target: "chat123", message: "done" },
        result: { status: "sent" },
        outcome: "completed",
      });
      markMcpLoopbackToolCallFinished(captureHandle);
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });
    const context = buildPreparedCliRunContext({
      provider: "codex-cli",
      model: "gpt-5.4",
      mcpDeliveryCapture: true,
    });

    const result = await executePreparedCliRun(context);
    setCliRunnerExecuteTestDeps({ writeCliSystemPromptFile });

    expect(result.text).toBe("done");
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(logWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("outer resource cleanup failed after confirmed message delivery"),
    );
  });

  it("emits a model-call error when successful Claude output is followed by cleanup failure", async () => {
    const runId = "run-claude-cleanup-failure";
    const diagnostics = captureModelCallDiagnostics(runId);
    const cleanupError = new Error("system prompt cleanup failed");
    setCliRunnerExecuteTestDeps({
      writeCliSystemPromptFile: async () => ({
        filePath: "/tmp/system-prompt.md",
        cleanup: async () => {
          throw cleanupError;
        },
      }),
    });
    mockSuccessfulCliRun(CLAUDE_OK_JSONL);

    try {
      await expect(
        executePreparedCliRun(
          buildPreparedCliRunContext({
            model: "claude-sonnet-4-6",
            runId,
          }),
        ),
      ).rejects.toThrow("system prompt cleanup failed");
      await waitForDiagnosticEventsDrained();

      expectModelCallTypes(diagnostics, ["model.call.started", "model.call.error"]);
      expect(diagnostics.events[1]?.event.callId).toBe(diagnostics.events[0]?.event.callId);
    } finally {
      diagnostics.stop();
      setCliRunnerExecuteTestDeps({ writeCliSystemPromptFile });
    }
  });

  it("wraps primitive and frozen failures to preserve delivery evidence", () => {
    const evidence = { didSendViaMessagingTool: true };
    const primitive = attachCliMessagingDeliveryEvidence("failed", evidence);
    const frozen = attachCliMessagingDeliveryEvidence(Object.freeze(new Error("frozen")), evidence);

    expect(primitive).toBeInstanceOf(Error);
    expect(frozen).toBeInstanceOf(Error);
    expect(getCliMessagingDeliveryEvidence(primitive)?.didSendViaMessagingTool).toBe(true);
    expect(getCliMessagingDeliveryEvidence(frozen)?.didSendViaMessagingTool).toBe(true);
  });

  it("accepts Claude live stream-json lines larger than 256 KiB", async () => {
    const largeText = "x".repeat(270 * 1024);
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [{ type: "result", session_id: "live-session-large", result: largeText }],
    });

    const result = await executePreparedCliRun(buildClaudeLiveRunContext());

    expect(result.text).toHaveLength(largeText.length);
    expect(result.text).toBe(largeText);
  });

  it("reports Claude live session reply backends as streaming until the turn finishes", async () => {
    let markWriteReady: (() => void) | undefined;
    const writeReady = new Promise<void>((resolve) => {
      markWriteReady = resolve;
    });
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: () => {
        markWriteReady?.();
      },
    });
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "live-session-reply",
      resetTriggered: false,
    });
    operation.setPhase("running");
    const context = buildClaudeLiveRunContext({
      sessionId: "live-session-reply",
      sessionKey: "agent:main:main",
      prompt: "hello",
    });

    const run = executePreparedCliRun({
      ...context,
      params: {
        ...context.params,
        replyOperation: operation,
      },
    });

    await writeReady;
    expect(replyRunRegistry.isStreaming("agent:main:main")).toBe(true);

    live.emit([
      { type: "system", subtype: "init", session_id: "live-session-reply" },
      { type: "result", session_id: "live-session-reply", result: "done" },
    ]);

    const result = await run;
    expect(result.text).toBe("done");
    expect(replyRunRegistry.isStreaming("agent:main:main")).toBe(false);
    operation.complete();
  });

  it("reuses a Claude live session when resumed turns omit the system prompt arg", async () => {
    let turn = 0;
    mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: ({ emit }) => {
        turn += 1;
        emit([
          { type: "system", subtype: "init", session_id: "live-system" },
          { type: "result", session_id: "live-system", result: turn === 1 ? "one" : "two" },
        ]);
      },
    });

    const backend = {
      resumeArgs: ["-p", "--output-format", "stream-json", "--resume={sessionId}"],
      liveSession: "claude-stdio" as const,
    };
    const first = await executePreparedCliRun(
      buildPreparedCliRunContext({
        prompt: "first",
        backend,
      }),
    );
    const second = await executePreparedCliRun(
      buildPreparedCliRunContext({
        prompt: "second",
        backend,
      }),
      "live-system",
    );

    expect(first.text).toBe("one");
    expect(second.text).toBe("two");
    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
  });

  it("serializes concurrent Claude live session creation for the same key", async () => {
    let releaseSpawn: (() => void) | undefined;
    let turn = 0;
    const spawnReady = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      beforeSpawn: () => spawnReady,
      onWrite: ({ emit }) => {
        turn += 1;
        emit([
          { type: "system", subtype: "init", session_id: "live-concurrent" },
          {
            type: "result",
            session_id: "live-concurrent",
            result: turn === 1 ? "one" : "two",
          },
        ]);
      },
    });

    const backend = {
      liveSession: "claude-stdio" as const,
    };
    const first = executePreparedCliRun(
      buildPreparedCliRunContext({
        prompt: "first",
        backend,
      }),
    );
    const second = executePreparedCliRun(
      buildPreparedCliRunContext({
        prompt: "second",
        backend,
      }),
    );
    await vi.waitFor(() => expect(supervisorSpawnMock).toHaveBeenCalledOnce());
    releaseSpawn?.();

    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.text).toSorted()).toEqual(["one", "two"]);
    expect(live.stdin.write).toHaveBeenCalledTimes(2);
    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
  });

  it("recovers when a required warm Claude process exits during reuse cleanup", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    let resolveExit: ((exit: RunExit) => void) | undefined;
    const exited = new Promise<RunExit>((resolve) => {
      resolveExit = resolve;
    });
    let turn = 0;
    const stdin = {
      write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
        turn += 1;
        stdoutListener?.(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-race" }),
            JSON.stringify({ type: "result", session_id: "live-race", result: `turn-${turn}` }),
          ].join("\n") + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        pid: 2350,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => exited),
        cancel: vi.fn(),
      };
    });
    const context = buildPreparedCliRunContext({
      prompt: "first",
      backend: { args: ["-p"], resumeArgs: [], liveSession: "claude-stdio" },
    });
    const getProcessSupervisorForTest = () => ({
      spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
        supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
      cancel: vi.fn(),
      cancelScope: vi.fn(),
      getRecord: vi.fn(),
    });
    const first = await runClaudeLiveSessionTurn({
      context,
      args: context.preparedBackend.backend.args ?? [],
      env: {},
      prompt: "first",
      useResume: false,
      noOutputTimeoutMs: 1_000,
      getProcessSupervisor: getProcessSupervisorForTest,
      onAssistantDelta: () => {},
      cleanup: async () => {},
    });
    expect(first.output.text).toBe("turn-1");
    const generation = getClaudeLiveSessionGenerationForOwner({
      backendId: "claude-cli",
      sessionId: "s1",
    });
    expect(generation).toBeDefined();

    let markCleanupStarted: (() => void) | undefined;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    let releaseCleanup: (() => void) | undefined;
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const reuse = runClaudeLiveSessionTurn({
      context,
      args: context.preparedBackend.backend.args ?? [],
      env: {},
      prompt: "second",
      useResume: false,
      requiredSessionGeneration: generation,
      noOutputTimeoutMs: 1_000,
      getProcessSupervisor: getProcessSupervisorForTest,
      onAssistantDelta: () => {},
      cleanup: async () => {
        markCleanupStarted?.();
        await cleanupReleased;
      },
    });
    await cleanupStarted;
    resolveExit?.({
      reason: "exit",
      exitCode: 0,
      exitSignal: null,
      durationMs: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    });
    await vi.waitFor(() =>
      expect(
        getClaudeLiveSessionGenerationForOwner({ backendId: "claude-cli", sessionId: "s1" }),
      ).toBeUndefined(),
    );
    releaseCleanup?.();

    await expect(reuse).rejects.toMatchObject({
      reason: "session_expired",
      code: "cli_live_session_missing",
    });
    expect(stdin.write).toHaveBeenCalledOnce();
  });

  it("counts pending Claude live session creates against the session cap", async () => {
    let releaseSpawn: (() => void) | undefined;
    const spawnReady = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      const spawnIndex = supervisorSpawnMock.mock.calls.length;
      await spawnReady;
      const stdin = {
        write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
          input.onStdout?.(
            [
              JSON.stringify({
                type: "system",
                subtype: "init",
                session_id: `live-cap-${spawnIndex}`,
              }),
              JSON.stringify({
                type: "result",
                session_id: `live-cap-${spawnIndex}`,
                result: `ok-${spawnIndex}`,
              }),
            ].join("\n") + "\n",
          );
          cb?.();
        }),
        end: vi.fn(),
      };
      return {
        runId: `live-run-${spawnIndex}`,
        pid: 2300 + spawnIndex,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    const backend = {
      liveSession: "claude-stdio" as const,
    };
    const runs = Array.from({ length: 17 }, (_, index) =>
      (() => {
        const context = buildPreparedCliRunContext({
          runId: `run-live-cap-${index}`,
          prompt: `prompt ${index}`,
          sessionId: `session-${index}`,
          backend,
        });
        return runClaudeLiveSessionTurn({
          context,
          args: context.preparedBackend.backend.args ?? [],
          env: {},
          prompt: `prompt ${index}`,
          useResume: false,
          noOutputTimeoutMs: 1_000,
          getProcessSupervisor: () => ({
            spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
              supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
            cancel: vi.fn(),
            cancelScope: vi.fn(),
            getRecord: vi.fn(),
          }),
          onAssistantDelta: () => {},
          cleanup: async () => {},
        });
      })(),
    );
    const rejectedRun = runs[16];
    const rejectedRunExpectation = expect(rejectedRun).rejects.toThrow(
      "Too many Claude CLI live sessions are active.",
    );

    await vi.waitFor(() => expect(supervisorSpawnMock).toHaveBeenCalledTimes(16));
    await rejectedRunExpectation;
    releaseSpawn?.();
    await expect(Promise.all(runs.slice(0, 16))).resolves.toHaveLength(16);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(16);
  });

  it("preserves Claude resume args when building live session argv", () => {
    const backend = buildClaudeLiveBackend();

    const args = buildClaudeLiveArgs({
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--resume",
        "claude-session",
        "--session-id",
        "openclaw-session",
        "--append-system-prompt",
        "old prompt",
        "--append-system-prompt-file",
        "/tmp/system-prompt.md",
      ],
      backend,
      systemPrompt: "current prompt",
      useResume: true,
    });

    expect(args).toContain("--resume");
    expect(args).toContain("claude-session");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("openclaw-session");
    expect(args).not.toContain("--append-system-prompt-file");
    expect(args).not.toContain("/tmp/system-prompt.md");
    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("old prompt");
    expect(args).not.toContain("current prompt");
  });

  it("adds Claude stream-json output format when building live session argv", () => {
    const backend = buildClaudeLiveBackend({ args: ["-p"] });

    const args = buildClaudeLiveArgs({
      args: ["-p"],
      backend,
      systemPrompt: "current prompt",
      useResume: false,
    });

    expect(requireArgAfter(args, "--input-format")).toBe("stream-json");
    expect(requireArgAfter(args, "--output-format")).toBe("stream-json");
    expect(requireArgAfter(args, "--permission-prompt-tool")).toBe("stdio");
  });

  it("answers Claude live control_request can_use_tool with allow when exec policy is full/no-ask", async () => {
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      events: buildClaudeControlRequestEvents({
        requestId: "req-allow",
        toolUseId: "tool-allow-1",
        input: { command: "ls" },
        sessionId: "live-control-allow",
      }),
      pid: 3001,
    });

    const result = await executePreparedCliRun(
      buildClaudeLiveRunContext({
        prompt: "hello",
        config: { tools: { exec: { security: "full", ask: "off" } } },
      }),
    );
    expect(result.text).toBe("ok");
    expectClaudeControlDecision(live, {
      behavior: "allow",
      requestId: "req-allow",
      toolUseId: "tool-allow-1",
      updatedInput: { command: "ls" },
    });
  });

  it("honors allow-once from a Claude native tool Gateway approval", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "claude-native-allow-once",
      decision: "allow-once",
    });
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      events: buildClaudeControlRequestEvents({
        requestId: "req-allow-once",
        toolUseId: "tool-allow-once-1",
        input: { command: "ls" },
        sessionId: "live-control-allow-once",
      }),
      pid: 3011,
    });

    const result = await executePreparedCliRun(
      buildClaudeLiveRunContext({
        prompt: "hello",
        config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      }),
    );

    expect(result.text).toBe("ok");
    await vi.waitFor(() =>
      expect(live.writes.some((entry) => entry.includes('"control_response"'))).toBe(true),
    );
    expectClaudeControlDecision(live, {
      behavior: "allow",
      requestId: "req-allow-once",
      toolUseId: "tool-allow-once-1",
      updatedInput: { command: "ls" },
    });
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.any(Object),
      expect.objectContaining({
        pluginId: "claude-cli",
        toolName: "Bash",
        toolCallId: "tool-allow-once-1",
      }),
      { expectFinal: false },
    );
  });

  it("sends full reviewer detail for oversized non-Bash tool input", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "claude-native-bounded-detail",
      decision: "allow-once",
    });
    const content = `line one ${"x".repeat(500)} line end`;
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      events: buildClaudeControlRequestEvents({
        requestId: "req-write-bounded-detail",
        toolUseId: "tool-write-bounded-detail-1",
        toolName: "Write",
        input: { file_path: "/tmp/out.txt", content },
        sessionId: "live-control-write-bounded-detail",
      }),
      pid: 3012,
    });

    const result = await executePreparedCliRun(
      buildClaudeLiveRunContext({
        prompt: "hello",
        config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      }),
    );

    expect(result.text).toBe("ok");
    await vi.waitFor(() =>
      expect(live.writes.some((entry) => entry.includes('"control_response"'))).toBe(true),
    );
    expectClaudeControlDecision(live, {
      behavior: "allow",
      requestId: "req-write-bounded-detail",
      toolUseId: "tool-write-bounded-detail-1",
      updatedInput: { file_path: "/tmp/out.txt", content },
    });
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.any(Object),
      expect.objectContaining({
        detail: JSON.stringify({ file_path: "/tmp/out.txt", content }),
        allowedDecisions: ["allow-once", "deny"],
      }),
      { expectFinal: false },
    );
  });

  it("fails closed when a Claude native tool Gateway approval is unavailable", async () => {
    mockCallGatewayTool.mockRejectedValueOnce(new Error("gateway unavailable"));
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      events: buildClaudeControlRequestEvents({
        requestId: "req-approval-unavailable",
        toolUseId: "tool-approval-unavailable-1",
        input: { command: "ls" },
        sessionId: "live-control-approval-unavailable",
      }),
      pid: 3013,
    });

    const result = await executePreparedCliRun(
      buildClaudeLiveRunContext({
        prompt: "hello",
        config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      }),
    );

    expect(result.text).toBe("ok");
    await vi.waitFor(() =>
      expect(live.writes.some((entry) => entry.includes('"control_response"'))).toBe(true),
    );
    expectClaudeControlDecision(live, {
      behavior: "deny",
      requestId: "req-approval-unavailable",
      messageIncludes: "OpenClaw approval was not granted",
    });
  });

  it("denies oversized Claude Bash approval requests before calling the Gateway", async () => {
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      events: buildClaudeControlRequestEvents({
        requestId: "req-bash-oversized",
        toolUseId: "tool-bash-oversized-1",
        input: { command: "x".repeat(PLUGIN_APPROVAL_DETAIL_MAX_LENGTH) },
        sessionId: "live-control-bash-oversized",
      }),
      pid: 3014,
    });

    const result = await executePreparedCliRun(
      buildClaudeLiveRunContext({
        prompt: "hello",
        config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      }),
    );

    expect(result.text).toBe("ok");
    await vi.waitFor(() =>
      expect(live.writes.some((entry) => entry.includes('"control_response"'))).toBe(true),
    );
    expectClaudeControlDecision(live, {
      behavior: "deny",
      requestId: "req-bash-oversized",
      messageIncludes: "too large to display",
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("reports Claude live stream progress without timer heartbeats", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date("2026-05-28T00:00:00.000Z"));
    const diagnosticEvents: string[] = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (event.type === "run.progress" || event.type.startsWith("tool.execution.")) {
        diagnosticEvents.push(event.type);
      }
    });
    let stdoutListener: ((chunk: string) => void) | undefined;
    const stdin = {
      write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
        stdoutListener?.(
          [
            JSON.stringify({
              type: "system",
              subtype: "init",
              session_id: "live-diagnostics",
            }),
            JSON.stringify({
              type: "assistant",
              session_id: "live-diagnostics",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "mcp_tool_use",
                    id: "tool-live-1",
                    name: "mcp__team__lookup",
                    input: { query: "status" },
                  },
                  {
                    type: "server_tool_use",
                    id: "tool-live-2",
                    name: "web_search",
                    input: { query: "release status" },
                  },
                ],
              },
            }),
          ].join("\n") + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        pid: 3060,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    try {
      const context = buildClaudeLiveRunContext({
        sessionId: "session-live-diagnostics",
        sessionKey: "agent:main:diagnostics",
        prompt: "hello",
        timeoutMs: 120_000,
      });
      const resultPromise = runClaudeLiveSessionTurn({
        context,
        args: context.preparedBackend.backend.args ?? [],
        env: {},
        prompt: "hello",
        useResume: false,
        noOutputTimeoutMs: 120_000,
        getProcessSupervisor: () => ({
          spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
            supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
          cancel: vi.fn(),
          cancelScope: vi.fn(),
          getRecord: vi.fn(),
        }),
        onAssistantDelta: () => {},
        cleanup: async () => {},
      });

      await waitForDiagnosticEventsDrained();
      await vi.waitFor(() =>
        expect(
          getDiagnosticSessionActivitySnapshot({
            sessionKey: "agent:main:diagnostics",
          }).activeToolName,
        ).toBe("mcp__team__lookup"),
      );
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionKey: "agent:main:diagnostics" })
          .lastProgressReason,
      ).toBe("cli_live:tool_started");

      await vi.advanceTimersByTimeAsync(10_000);
      await waitForDiagnosticEventsDrained();
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionKey: "agent:main:diagnostics" })
          .lastProgressReason,
      ).toBe("cli_live:tool_started");
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionKey: "agent:main:diagnostics" })
          .lastProgressAgeMs,
      ).toBeGreaterThanOrEqual(10_000);

      stdoutListener?.(
        [
          JSON.stringify({
            type: "user",
            session_id: "live-diagnostics",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-live-1",
                  content: "lookup failed",
                  is_error: true,
                },
                {
                  type: "tool_result",
                  tool_use_id: "tool-live-2",
                  content: "done",
                },
              ],
            },
          }),
          JSON.stringify({
            type: "assistant",
            session_id: "live-diagnostics",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
            },
          }),
          JSON.stringify({
            type: "result",
            session_id: "live-diagnostics",
            result: "ok",
          }),
        ].join("\n") + "\n",
      );

      await expect(resultPromise).resolves.toMatchObject({ output: { text: "ok" } });
      await waitForDiagnosticEventsDrained();
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionKey: "agent:main:diagnostics" })
          .activeToolName,
      ).toBeUndefined();
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionKey: "agent:main:diagnostics" })
          .lastProgressReason,
      ).toBe("cli_live:result");
      expect(diagnosticEvents.filter((event) => event === "tool.execution.started")).toHaveLength(
        2,
      );
      expect(diagnosticEvents).toContain("tool.execution.completed");
      expect(diagnosticEvents).toContain("tool.execution.error");
    } finally {
      stopDiagnostics();
    }
  });

  it("preserves loopback policy blocks for Claude live tools", async () => {
    const diagnosticEvents: Array<Record<string, unknown>> = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (
        event.type.startsWith("tool.execution.") &&
        "toolCallId" in event &&
        event.toolCallId === "tool-live-blocked"
      ) {
        diagnosticEvents.push(event as unknown as Record<string, unknown>);
      }
    });
    let stdoutListener: ((chunk: string) => void) | undefined;
    let captureKey = "";
    const stdin = {
      write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
        const captureHandle = markMcpLoopbackToolCallStarted({
          captureKey,
          toolName: "message",
          args: { action: "react" },
        });
        if (!captureHandle) {
          throw new Error("Expected live tool capture");
        }
        recordMcpLoopbackToolCallResult({
          captureHandle,
          toolName: "message",
          args: { action: "react" },
          outcome: "blocked",
          deniedReason: "plugin-approval",
        });
        markMcpLoopbackToolCallFinished(captureHandle);
        stdoutListener?.(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-blocked" }),
            JSON.stringify({
              type: "assistant",
              session_id: "live-blocked",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "mcp_tool_use",
                    id: "tool-live-blocked",
                    name: "mcp__openclaw__message",
                    input: { action: "react" },
                  },
                ],
              },
            }),
            JSON.stringify({
              type: "user",
              session_id: "live-blocked",
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tool-live-blocked",
                    content: "blocked",
                    is_error: true,
                  },
                ],
              },
            }),
            JSON.stringify({ type: "result", session_id: "live-blocked", result: "ok" }),
          ].join("\n") + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    const liveRunLifecycle = createCancelableLiveRunLifecycle();
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as {
        env?: Record<string, string>;
        onStdout?: (chunk: string) => void;
      };
      stdoutListener = input.onStdout;
      captureKey = input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "";
      return {
        pid: 3061,
        startedAtMs: Date.now(),
        stdin,
        ...liveRunLifecycle,
      };
    });
    const context = buildClaudeLiveRunContext({
      sessionId: "session-live-blocked",
      sessionKey: "agent:main:blocked",
      prompt: "hello",
    });
    context.mcpDeliveryCapture = true;

    try {
      await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "ok" });
      await waitForDiagnosticEventsDrained();
    } finally {
      stopDiagnostics();
    }

    expect(diagnosticEvents).toMatchObject([
      { type: "tool.execution.started", toolCallId: "tool-live-blocked" },
      {
        type: "tool.execution.blocked",
        toolCallId: "tool-live-blocked",
        deniedReason: "plugin-approval",
      },
    ]);
    expect(liveRunLifecycle.cancel).toHaveBeenCalledWith("manual-cancel");
  });

  it("keeps identical parallel Claude live tool outcomes explicitly unknown", async () => {
    const diagnosticEvents: Array<Record<string, unknown>> = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (
        event.type.startsWith("tool.execution.") &&
        "toolCallId" in event &&
        typeof event.toolCallId === "string" &&
        event.toolCallId.startsWith("tool-live-identical-")
      ) {
        diagnosticEvents.push(event as unknown as Record<string, unknown>);
      }
    });
    let stdoutListener: ((chunk: string) => void) | undefined;
    let captureKey = "";
    const toolArgs = { action: "react", emoji: "same" };
    const stdin = {
      write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
        stdoutListener?.(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-identical" }),
            JSON.stringify({
              type: "assistant",
              session_id: "live-identical",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "mcp_tool_use",
                    id: "tool-live-identical-a",
                    name: "mcp__openclaw__message",
                    input: toolArgs,
                  },
                  {
                    type: "mcp_tool_use",
                    id: "tool-live-identical-b",
                    name: "mcp__openclaw__message",
                    input: toolArgs,
                  },
                ],
              },
            }),
          ].join("\n") + "\n",
        );
        const captureHandle = markMcpLoopbackToolCallStarted({
          captureKey,
          toolName: "message",
          args: toolArgs,
        });
        if (!captureHandle) {
          throw new Error("Expected live tool capture");
        }
        recordMcpLoopbackToolCallResult({
          captureHandle,
          toolName: "message",
          args: toolArgs,
          outcome: "failed",
        });
        markMcpLoopbackToolCallFinished(captureHandle);
        stdoutListener?.(
          [
            JSON.stringify({
              type: "user",
              session_id: "live-identical",
              message: {
                role: "user",
                content: [
                  { type: "tool_result", tool_use_id: "tool-live-identical-a", content: "ok" },
                  { type: "tool_result", tool_use_id: "tool-live-identical-b", content: "ok" },
                ],
              },
            }),
            JSON.stringify({ type: "result", session_id: "live-identical", result: "ok" }),
          ].join("\n") + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    const liveRunLifecycle = createCancelableLiveRunLifecycle();
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as {
        env?: Record<string, string>;
        onStdout?: (chunk: string) => void;
      };
      stdoutListener = input.onStdout;
      captureKey = input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "";
      return {
        pid: 3062,
        startedAtMs: Date.now(),
        stdin,
        ...liveRunLifecycle,
      };
    });
    const context = buildClaudeLiveRunContext({
      sessionId: "session-live-identical",
      sessionKey: "agent:main:live-identical",
      prompt: "hello",
    });
    context.mcpDeliveryCapture = true;

    try {
      await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "ok" });
      await waitForDiagnosticEventsDrained();
    } finally {
      stopDiagnostics();
    }

    expect(diagnosticEvents).toMatchObject([
      { type: "tool.execution.started", toolCallId: "tool-live-identical-a" },
      { type: "tool.execution.started", toolCallId: "tool-live-identical-b" },
      {
        type: "tool.execution.error",
        toolCallId: "tool-live-identical-a",
        errorCode: "tool_outcome_unknown",
      },
      {
        type: "tool.execution.error",
        toolCallId: "tool-live-identical-b",
        errorCode: "tool_outcome_unknown",
      },
    ]);
    expect(liveRunLifecycle.cancel).toHaveBeenCalledWith("manual-cancel");
  });

  it.each([
    [
      "client timeout",
      "tool_use",
      "Bash",
      Object.assign(new Error("gateway timeout"), { name: "TimeoutError" }),
      "TimeoutError",
      { terminalReason: "timed_out" },
    ],
    [
      "client cancellation",
      "tool_use",
      "Bash",
      new Error("operator cancelled"),
      "AbortError",
      { terminalReason: "cancelled" },
    ],
    [
      "server-native timeout",
      "server_tool_use",
      "web_search",
      Object.assign(new Error("gateway timeout"), { name: "TimeoutError" }),
      "TimeoutError",
      { errorCode: "tool_outcome_unknown" },
    ],
    [
      "server-native cancellation",
      "server_tool_use",
      "web_search",
      new Error("operator cancelled"),
      "AbortError",
      { errorCode: "tool_outcome_unknown" },
    ],
  ] as const)(
    "classifies active Claude live tools on %s",
    async (_, toolType, toolName, abortReason, expectedErrorName, expectedOutcome) => {
      const abortController = new AbortController();
      const diagnosticEvents: Array<Record<string, unknown>> = [];
      const stopDiagnostics = onInternalDiagnosticEvent((event) => {
        if (event.type === "tool.execution.error") {
          diagnosticEvents.push(event as unknown as Record<string, unknown>);
        }
      });
      let stdoutListener: ((chunk: string) => void) | undefined;
      const stdin = {
        write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
          stdoutListener?.(
            [
              JSON.stringify({ type: "system", subtype: "init", session_id: "live-timeout" }),
              JSON.stringify({
                type: "assistant",
                session_id: "live-timeout",
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: toolType,
                      id: "tool-live-timeout",
                      name: toolName,
                      input: { query: "status" },
                    },
                  ],
                },
              }),
            ].join("\n") + "\n",
          );
          cb?.();
        }),
        end: vi.fn(),
      };
      supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
        const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
        stdoutListener = input.onStdout;
        return {
          pid: 3061,
          startedAtMs: Date.now(),
          stdin,
          wait: vi.fn(() => new Promise(() => {})),
          cancel: vi.fn(),
        };
      });

      try {
        const context = buildClaudeLiveRunContext({
          sessionId: "session-live-timeout",
          sessionKey: "agent:main:timeout",
        });
        context.params.abortSignal = abortController.signal;
        const resultPromise = runClaudeLiveSessionTurn({
          context,
          args: context.preparedBackend.backend.args ?? [],
          env: {},
          prompt: "hello",
          useResume: false,
          noOutputTimeoutMs: 120_000,
          getProcessSupervisor: () => ({
            spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
              supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
            cancel: vi.fn(),
            cancelScope: vi.fn(),
            getRecord: vi.fn(),
          }),
          onAssistantDelta: () => {},
          cleanup: async () => {},
        });

        await vi.waitFor(() => expect(stdoutListener).toBeDefined());
        abortController.abort(abortReason);
        await expectRejectsWithFields(resultPromise, { name: expectedErrorName });
        await waitForDiagnosticEventsDrained();
        expect(diagnosticEvents).toContainEqual(
          expect.objectContaining({
            toolCallId: "tool-live-timeout",
            ...expectedOutcome,
          }),
        );
        if (toolType === "server_tool_use") {
          const terminal = diagnosticEvents.find(
            (event) => event.toolCallId === "tool-live-timeout",
          );
          expect(terminal).not.toHaveProperty("terminalReason");
        }
      } finally {
        stopDiagnostics();
      }
    },
  );

  it("answers Claude live control_request can_use_tool with deny when the user rejects approval", async () => {
    const diagnosticEvents: Array<Record<string, unknown>> = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (
        event.type.startsWith("tool.execution.") &&
        "toolCallId" in event &&
        event.toolCallId === "tool-deny-1"
      ) {
        diagnosticEvents.push(event as unknown as Record<string, unknown>);
      }
    });
    const controlEvents = buildClaudeControlRequestEvents({
      requestId: "req-deny",
      toolUseId: "tool-deny-1",
      input: { command: "rm -rf /" },
      sessionId: "live-control-deny",
    });
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: ({ data, emit, writeIndex }) => {
        if (writeIndex === 0) {
          emit(controlEvents.slice(0, 2));
          return;
        }
        if (!data.includes('"control_response"')) {
          return;
        }
        emit([
          {
            type: "assistant",
            session_id: "live-control-deny",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tool-deny-1",
                  name: "Bash",
                  input: { command: "rm -rf /" },
                },
              ],
            },
          },
          {
            type: "user",
            session_id: "live-control-deny",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-deny-1",
                  content: "denied",
                  is_error: true,
                },
              ],
            },
          },
          { type: "result", session_id: "live-control-deny", result: "ok" },
        ]);
      },
      pid: 3002,
    });

    let result;
    try {
      result = await executePreparedCliRun(
        buildClaudeLiveRunContext({
          prompt: "hello",
          config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
        }),
      );
      await vi.waitFor(() =>
        expect(live.writes.some((entry) => entry.includes('"control_response"'))).toBe(true),
      );
      await waitForDiagnosticEventsDrained();
    } finally {
      stopDiagnostics();
    }
    expect(result.text).toBe("ok");
    expectClaudeControlDecision(live, {
      behavior: "deny",
      requestId: "req-deny",
      messageIncludes: "OpenClaw user denied Claude native tool use (Bash).",
    });
    expect(diagnosticEvents).toMatchObject([
      {
        type: "tool.execution.started",
        toolCallId: "tool-deny-1",
        toolName: "Bash",
        paramsSummary: { kind: "object" },
      },
      {
        type: "tool.execution.blocked",
        toolCallId: "tool-deny-1",
        toolName: "Bash",
        deniedReason: "cli_live_exec_policy",
      },
    ]);
    expect(diagnosticEvents).toHaveLength(2);
    expect(JSON.stringify(diagnosticEvents)).not.toContain("rm -rf");
    expect(requireArgAfter(live.spawnInput.argv, "--permission-mode")).toBe("default");
  });

  it("reuses a Claude native tool allow-always grant within the live process", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "claude-native-allow-always",
      decision: "allow-always",
    });
    let promptCount = 0;
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: ({ data, emit }) => {
        if (data.includes('"control_response"')) {
          return;
        }
        promptCount += 1;
        emit(
          buildClaudeControlRequestEvents({
            requestId: `req-grant-${promptCount}`,
            toolUseId: `tool-grant-${promptCount}`,
            toolName: "Write",
            input: {
              file_path: `/tmp/grant-${promptCount}.txt`,
              content: `content ${promptCount}`,
            },
            sessionId: "live-control-allow-always",
          }),
        );
      },
      pid: 3012,
    });
    const buildContext = (runId: string, prompt: string) =>
      buildClaudeLiveRunContext({
        runId,
        prompt,
        sessionId: "session-allow-always",
        sessionKey: "agent:main:allow-always",
        config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      });

    await expect(
      executePreparedCliRun(buildContext("run-grant-1", "first")),
    ).resolves.toMatchObject({ text: "ok" });
    await vi.waitFor(() =>
      expect(live.writes.filter((entry) => entry.includes('"control_response"'))).toHaveLength(1),
    );
    await expect(
      executePreparedCliRun(buildContext("run-grant-2", "second")),
    ).resolves.toMatchObject({ text: "ok" });
    await vi.waitFor(() =>
      expect(live.writes.filter((entry) => entry.includes('"control_response"'))).toHaveLength(2),
    );

    expect(mockCallGatewayTool).toHaveBeenCalledTimes(1);
    expectClaudeControlDecision(live, {
      behavior: "allow",
      requestId: "req-grant-1",
      toolUseId: "tool-grant-1",
      updatedInput: { file_path: "/tmp/grant-1.txt", content: "content 1" },
    });
    const secondResponse = live.writes.find(
      (entry) => entry.includes('"control_response"') && entry.includes("req-grant-2"),
    );
    expect(secondResponse).toContain('"behavior":"allow"');
  });

  it("prompts on every Claude native tool request when exec ask is always", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "claude-native-always-seed",
      decision: "allow-always",
    });
    let promptCount = 0;
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: ({ data, emit }) => {
        if (data.includes('"control_response"')) {
          return;
        }
        promptCount += 1;
        emit(
          buildClaudeControlRequestEvents({
            requestId: `req-always-${promptCount}`,
            toolUseId: `tool-always-${promptCount}`,
            toolName: "Write",
            input: {
              file_path: `/tmp/always-${promptCount}.txt`,
              content: `content ${promptCount}`,
            },
            sessionId: "live-control-ask-always",
          }),
        );
      },
      pid: 3015,
    });
    const buildContext = (runId: string, prompt: string, ask: "always" | "on-miss") =>
      buildClaudeLiveRunContext({
        runId,
        prompt,
        sessionId: "session-ask-always",
        sessionKey: "agent:main:ask-always",
        sessionEntry: { execAsk: ask } as PreparedCliRunContext["params"]["sessionEntry"],
        config: { tools: { exec: { security: "full", ask: "on-miss" } } },
      });

    await expect(
      executePreparedCliRun(buildContext("run-always-seed", "seed", "on-miss")),
    ).resolves.toMatchObject({ text: "ok" });
    await vi.waitFor(() =>
      expect(live.writes.filter((entry) => entry.includes('"control_response"'))).toHaveLength(1),
    );
    mockCallGatewayTool.mockClear();
    mockCallGatewayTool
      .mockResolvedValueOnce({
        id: "claude-native-always-1",
        decision: "allow-once",
      })
      .mockResolvedValueOnce({
        id: "claude-native-always-2",
        decision: "allow-once",
      });

    await expect(
      executePreparedCliRun(buildContext("run-always-1", "first", "always")),
    ).resolves.toMatchObject({ text: "ok" });
    await vi.waitFor(() =>
      expect(live.writes.filter((entry) => entry.includes('"control_response"'))).toHaveLength(2),
    );
    await expect(
      executePreparedCliRun(buildContext("run-always-2", "second", "always")),
    ).resolves.toMatchObject({ text: "ok" });
    await vi.waitFor(() =>
      expect(live.writes.filter((entry) => entry.includes('"control_response"'))).toHaveLength(3),
    );

    expect(mockCallGatewayTool).toHaveBeenCalledTimes(2);
    for (const call of mockCallGatewayTool.mock.calls) {
      expect(call[2]).toMatchObject({ allowedDecisions: ["allow-once", "deny"] });
    }
    const firstResponse = live.writes.find(
      (entry) => entry.includes('"control_response"') && entry.includes("req-always-2"),
    );
    const secondResponse = live.writes.find(
      (entry) => entry.includes('"control_response"') && entry.includes("req-always-3"),
    );
    expect(firstResponse).toContain('"behavior":"allow"');
    expect(secondResponse).toContain('"behavior":"allow"');
  });

  it("does not create exec approvals file while resolving Claude live policy", async () => {
    await withTempOpenClawHome(async (home) => {
      const approvalsPath = path.join(home, ".openclaw", "exec-approvals.json");
      const live = mockClaudeLiveRun(supervisorSpawnMock, {
        events: [
          { type: "system", subtype: "init", session_id: "live-no-approvals-file" },
          { type: "result", session_id: "live-no-approvals-file", result: "ok" },
        ],
        pid: 3009,
      });

      const result = await executePreparedCliRun(
        buildClaudeLiveRunContext({
          prompt: "hello",
          config: {
            tools: { exec: { security: "allowlist", ask: "on-miss" } },
          } as PreparedCliRunContext["params"]["config"],
        }),
      );

      expect(result.text).toBe("ok");
      expect(requireArgAfter(live.spawnInput.argv, "--permission-mode")).toBe("default");
      await expectPathMissing(approvalsPath);
    });
  });

  it.each<ClaudeControlPolicyTestCase>([
    {
      name: "allows tools when no exec policy is configured (default deployment)",
      requestId: "req-default-allow",
      toolUseId: "tool-default-allow-1",
      input: { command: "echo hi" },
      expected: { behavior: "allow", updatedInput: { command: "echo hi" } },
    },
    {
      name: "denies tools when approval defaults are restrictive",
      requestId: "req-approval-default-deny",
      toolUseId: "tool-approval-default-deny-1",
      input: { command: "ls" },
      expected: { behavior: "deny", messageIncludes: "OpenClaw user denied" },
      approvals: {
        version: 1,
        defaults: { security: "allowlist", ask: "on-miss" },
        agents: {},
      },
      context: {
        backend: {
          liveSession: "claude-stdio",
          args: ["-p", "--output-format", "stream-json", "--permission-mode", "bypassPermissions"],
        },
      },
      expectedPermissionMode: "default",
    },
    {
      name: "denies tools when session exec ask is restrictive",
      requestId: "req-session-ask-deny",
      toolUseId: "tool-session-ask-deny-1",
      input: { command: "ls" },
      expected: { behavior: "deny", messageIncludes: "OpenClaw user denied" },
      context: {
        backend: {
          liveSession: "claude-stdio",
          args: ["-p", "--output-format", "stream-json", "--permission-mode", "bypassPermissions"],
        },
        sessionEntry: { execAsk: "always" } as PreparedCliRunContext["params"]["sessionEntry"],
        config: { tools: { exec: { security: "full", ask: "off" } } },
      },
      expectedPermissionMode: "default",
    },
    {
      name: "denies tools when agent approvals are restrictive",
      requestId: "req-agent-approval-deny",
      toolUseId: "tool-agent-approval-deny-1",
      input: { command: "ls" },
      expected: { behavior: "deny", messageIncludes: "security=deny" },
      approvals: { version: 1, agents: { reviewer: { security: "deny" } } },
      context: {
        agentId: "reviewer",
        backend: {
          liveSession: "claude-stdio",
          args: ["-p", "--output-format", "stream-json", "--permission-mode", "bypassPermissions"],
        },
        config: { tools: { exec: { security: "full", ask: "off" } } },
      },
      expectedPermissionMode: "default",
    },
    {
      name: "denies tools when session-key agent approvals are restrictive",
      requestId: "req-session-key-approval-deny",
      toolUseId: "tool-session-key-approval-deny-1",
      input: { command: "ls" },
      expected: { behavior: "deny", messageIncludes: "security=deny" },
      approvals: { version: 1, agents: { reviewer: { security: "deny" } } },
      context: {
        sessionKey: "agent:reviewer:main",
        backend: {
          liveSession: "claude-stdio",
          args: ["-p", "--output-format", "stream-json", "--permission-mode", "bypassPermissions"],
        },
        config: { tools: { exec: { security: "full", ask: "off" } } },
      },
      expectedPermissionMode: "default",
    },
    {
      name: "allows tools when OpenClaw exec is YOLO despite raw --permission-mode default",
      requestId: "req-permmode-allow",
      toolUseId: "tool-permmode-allow-1",
      input: { command: "ls" },
      expected: { behavior: "allow" },
      context: {
        backend: {
          liveSession: "claude-stdio",
          args: ["-p", "--output-format", "stream-json", "--permission-mode", "default"],
        },
        config: { tools: { exec: { security: "full", ask: "off" } } },
      },
    },
  ])("answers Claude live control_request can_use_tool: $name", async (testCase) => {
    const run = async () => {
      const live = mockClaudeLiveRun(supervisorSpawnMock, {
        events: buildClaudeControlRequestEvents({
          requestId: testCase.requestId,
          toolUseId: testCase.toolUseId,
          input: testCase.input,
          sessionId: `live-control-${testCase.requestId}`,
        }),
      });
      const result = await executePreparedCliRun(
        buildClaudeLiveRunContext({
          ...testCase.context,
        }),
      );

      expect(result.text).toBe("ok");
      await vi.waitFor(() =>
        expect(live.writes.some((entry) => entry.includes('"control_response"'))).toBe(true),
      );
      expectClaudeControlDecision(live, {
        ...testCase.expected,
        requestId: testCase.requestId,
        ...(testCase.expected.behavior === "allow" ? { toolUseId: testCase.toolUseId } : {}),
      });
      if (testCase.expectedPermissionMode) {
        expect(requireArgAfter(live.spawnInput.argv, "--permission-mode")).toBe(
          testCase.expectedPermissionMode,
        );
      }
    };

    if (testCase.approvals) {
      await withTempExecApprovalsFile(testCase.approvals, run);
    } else {
      await run();
    }
  });

  it("cleans live-turn resources when capture activation fails before spawn", async () => {
    const cleanup = vi.fn(async () => undefined);
    const context = buildPreparedCliRunContext({
      mcpDeliveryCapture: true,
    });

    await expect(
      runClaudeLiveSessionTurn({
        context,
        args: [],
        env: {},
        prompt: "hi",
        useResume: false,
        noOutputTimeoutMs: 1_000,
        getProcessSupervisor: () => ({
          spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
            supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
          cancel: vi.fn(),
          cancelScope: vi.fn(),
          getRecord: vi.fn(),
        }),
        onAssistantDelta: () => {},
        onMcpCaptureReady: () => {
          throw new Error("grant activation failed");
        },
        cleanup,
      }),
    ).rejects.toThrow("grant activation failed");

    expect(cleanup).toHaveBeenCalledOnce();
    expect(supervisorSpawnMock).not.toHaveBeenCalled();
  });

  it("uses a fresh Claude live process and capture key for every captured turn", async () => {
    const logWarnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    const captureKeys: string[] = [];
    const turnResults = ["first-ok", "resume-ok", "env-ok", "fresh-ok"];
    let turnIndex = 0;
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const spawnIndex = supervisorSpawnMock.mock.calls.length;
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      const cancel = vi.fn();
      cancels.push(cancel);
      let resolveExit: (() => void) | undefined;
      const exited = new Promise<{
        reason: "manual-cancel";
        exitCode: null;
        exitSignal: null;
        durationMs: number;
        stdout: string;
        stderr: string;
        timedOut: false;
        noOutputTimedOut: false;
      }>((resolve) => {
        resolveExit = () =>
          resolve({
            reason: "manual-cancel",
            exitCode: null,
            exitSignal: null,
            durationMs: 1,
            stdout: "",
            stderr: "",
            timedOut: false,
            noOutputTimedOut: false,
          });
      });
      cancel.mockImplementation(() => resolveExit?.());
      return {
        runId: `live-run-${spawnIndex}`,
        pid: 2345 + spawnIndex,
        startedAtMs: Date.now(),
        stdin: {
          write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
            const result = turnResults[turnIndex] ?? "ok";
            turnIndex += 1;
            input.onStdout?.(
              [
                JSON.stringify({ type: "system", subtype: "init", session_id: "live-session" }),
                JSON.stringify({
                  type: "result",
                  session_id: "live-session",
                  result,
                }),
              ].join("\n") + "\n",
            );
            cb?.();
          }),
          end: vi.fn(),
        },
        wait: vi.fn(() => exited),
        cancel,
      };
    });
    const runTurn = async (runId: string, args: string[], env: Record<string, string>) => {
      const context = buildClaudeLiveRunContext({
        runId,
        backend: {
          resumeArgs: ["-p", "--output-format", "stream-json", "--resume", "{sessionId}"],
        },
        mcpDeliveryCapture: true,
      });
      const result = await runClaudeLiveSessionTurn({
        context,
        args,
        env,
        prompt: "hi",
        useResume: args.some((entry) => entry.startsWith("--resume")),
        noOutputTimeoutMs: 1_000,
        getProcessSupervisor: () => ({
          spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
            supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
          cancel: vi.fn(),
          cancelScope: vi.fn(),
          getRecord: vi.fn(),
        }),
        onAssistantDelta: () => {},
        onMcpCaptureReady: (captureKey) => captureKeys.push(captureKey),
        cleanup: async () => {
          if (runId === "run-live-resume") {
            throw new Error("captured cleanup failed");
          }
        },
      });
      return result.output.text;
    };
    const freshArgs = ["-p", "--output-format", "stream-json"];
    const resumeArgs = ["-p", "--output-format", "stream-json", "--resume", "live-session"];

    await expect(
      runTurn("run-live-fresh", freshArgs, { ANTHROPIC_BASE_URL: "https://one.example" }),
    ).resolves.toBe("first-ok");
    await expect(
      runTurn("run-live-resume", resumeArgs, { ANTHROPIC_BASE_URL: "https://one.example" }),
    ).resolves.toBe("resume-ok");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
    expect(cancels[0]).toHaveBeenCalledWith("manual-cancel");
    expect(cancels[1]).toHaveBeenCalledWith("manual-cancel");
    expect(captureKeys[1]).not.toBe(captureKeys[0]);

    await expect(
      runTurn("run-live-env-change", resumeArgs, { ANTHROPIC_BASE_URL: "https://two.example" }),
    ).resolves.toBe("env-ok");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(3);
    expect(cancels[2]).toHaveBeenCalledWith("manual-cancel");
    expect(captureKeys[2]).not.toBe(captureKeys[1]);

    await expect(
      runTurn("run-live-fresh-retry", freshArgs, {
        ANTHROPIC_BASE_URL: "https://two.example",
      }),
    ).resolves.toBe("fresh-ok");

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(4);
    expect(cancels[3]).toHaveBeenCalledWith("manual-cancel");
    expect(captureKeys[3]).not.toBe(captureKeys[2]);
    expect(logWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Claude live session cleanup failed: captured cleanup failed"),
    );
  });

  it("ignores non-JSON stdout lines from Claude live sessions", async () => {
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        "Claude CLI warning",
        { type: "system", subtype: "init", session_id: "live-mixed" },
        { type: "result", session_id: "live-mixed", result: "mixed-ok" },
      ],
    });

    const result = await executePreparedCliRun(
      buildPreparedCliRunContext({ backend: { liveSession: "claude-stdio" } }),
    );
    expect(result.text).toBe("mixed-ok");
  });

  it("fails Claude live turns on is_error results", async () => {
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "live-error" },
        {
          type: "result",
          session_id: "live-error",
          is_error: true,
          result: "Credit balance is too low",
        },
      ],
    });

    await expectRejectsWithFields(
      executePreparedCliRun(
        buildPreparedCliRunContext({ backend: { liveSession: "claude-stdio" } }),
      ),
      { name: "FailoverError", message: "Credit balance is too low" },
    );
  });

  it("surfaces Claude live max-turn results with run and session recovery context", async () => {
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "live-max-turns" },
        {
          type: "result",
          subtype: "error_max_turns",
          session_id: "live-max-turns",
          num_turns: 2,
          stop_reason: "tool_use",
          terminal_reason: "max_turns",
          errors: ["Reached maximum number of turns (1)"],
        },
      ],
    });

    await expectRejectsWithFields(
      executePreparedCliRun(
        buildClaudeLiveRunContext({
          runId: "run-live-max-turns",
        }),
      ),
      {
        name: "FailoverError",
        message:
          "Claude CLI stopped after reaching the maximum number of turns (limit: 1). " +
          "OpenClaw run: run-live-max-turns. OpenClaw session: s1. " +
          "Claude session: live-max-turns. Tool actions may already have run; verify their effects before retrying. " +
          "Retry with a higher --max-turns value or a narrower task.",
        sessionId: "s1",
        reason: "unknown",
        code: "cli_max_turns",
        rawError: "Reached maximum number of turns (1)",
      },
    );
  });

  it.each([
    {
      name: "marks Claude live stderr context overflows as retryable",
      exitCode: 1,
      stderr: "Prompt is too long",
      events: [{ type: "system", subtype: "init", session_id: "live-overflow" }],
      expected: {
        name: "FailoverError",
        reason: "context_overflow",
        code: "cli_context_overflow",
        status: 413,
      },
    },
    {
      name: "marks quiet Claude live exit-zero turns as retryable empty responses",
      exitCode: 0,
      stderr: "",
      events: [],
      expected: {
        name: "FailoverError",
        reason: "empty_response",
        code: "cli_unknown_empty_failure",
      },
    },
    {
      name: "preserves Claude live stderr classification on exit-zero failures",
      exitCode: 0,
      stderr: "Prompt is too long",
      events: [],
      expected: {
        name: "FailoverError",
        reason: "context_overflow",
        code: "cli_context_overflow",
      },
    },
  ])("$name", async (testCase) => {
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: testCase.events,
      exitOnWrite: {
        reason: "exit",
        exitCode: testCase.exitCode,
        exitSignal: null,
        durationMs: 1,
        stdout: "",
        stderr: testCase.stderr,
        timedOut: false,
        noOutputTimedOut: false,
      },
    });

    await expectRejectsWithFields(
      executePreparedCliRun(
        buildPreparedCliRunContext({ backend: { liveSession: "claude-stdio" } }),
      ),
      testCase.expected,
    );
  });

  it("fails when Claude exits before a live turn starts", async () => {
    mockClaudeLiveRun(supervisorSpawnMock, {
      exitImmediately: {
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 1,
        stdout: "",
        stderr: "startup failed",
        timedOut: false,
        noOutputTimedOut: false,
      },
    });

    await expect(executePreparedCliRun(buildClaudeLiveRunContext())).rejects.toThrow(
      "Claude CLI live session closed before handling the turn",
    );
  });

  it("restarts the Claude live process after request abort", async () => {
    const abortController = new AbortController();
    let stdoutListener: ((chunk: string) => void) | undefined;
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      const spawnIndex = supervisorSpawnMock.mock.calls.length;
      const cancel = vi.fn();
      cancels.push(cancel);
      const stdin = {
        write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
          if (spawnIndex === 2) {
            stdoutListener?.(
              [
                JSON.stringify({ type: "system", subtype: "init", session_id: "live-abort-2" }),
                JSON.stringify({
                  type: "result",
                  session_id: "live-abort-2",
                  result: "second-ok",
                }),
              ].join("\n") + "\n",
            );
          }
          cb?.();
        }),
        end: vi.fn(),
      };
      return {
        runId: `live-run-${spawnIndex}`,
        pid: 2345 + spawnIndex,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(
          () =>
            new Promise((resolve) => {
              if (spawnIndex === 1) {
                cancel.mockImplementationOnce(() => {
                  resolve({
                    reason: "manual-cancel",
                    exitCode: null,
                    exitSignal: null,
                    durationMs: 50,
                    stdout: "",
                    stderr: "",
                    timedOut: false,
                    noOutputTimedOut: false,
                  });
                });
              }
            }),
        ),
        cancel,
      };
    });

    const firstContext = buildClaudeLiveRunContext({});
    firstContext.params.abortSignal = abortController.signal;
    const first = executePreparedCliRun(firstContext);

    await vi.waitFor(() => {
      expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    });
    abortController.abort();

    await expectRejectsWithFields(first, { name: "AbortError" });
    expect(cancels[0]).toHaveBeenCalledWith("manual-cancel");
    stdoutListener?.(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "live-abort" }),
        JSON.stringify({
          type: "result",
          session_id: "live-abort",
          result: "discarded",
        }),
      ].join("\n") + "\n",
    );

    const second = await executePreparedCliRun(buildClaudeLiveRunContext({}));

    expect(second.text).toBe("second-ok");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
  });

  it("fails Claude live turns without unhandled rejection when stdin write is stuck", async () => {
    vi.useFakeTimers();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    const cancel = vi.fn();
    let pendingWriteCallback: ((err?: Error | null) => void) | undefined;
    const stdin = {
      write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
        pendingWriteCallback = cb;
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementationOnce(async () => ({
      pid: 2345,
      startedAtMs: Date.now(),
      stdin,
      wait: vi.fn(() => new Promise(() => {})),
      cancel: vi.fn((reason: string) => {
        cancel(reason);
        pendingWriteCallback?.(new Error("stdin closed"));
      }),
    }));

    try {
      const context = buildClaudeLiveRunContext({
        timeoutMs: 10_000,
      });
      const run = runClaudeLiveSessionTurn({
        context,
        args: context.preparedBackend.backend.args ?? [],
        env: {},
        prompt: "stuck write",
        useResume: false,
        noOutputTimeoutMs: 1_000,
        getProcessSupervisor: () => ({
          spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
            supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
          cancel: vi.fn(),
          cancelScope: vi.fn(),
          getRecord: vi.fn(),
        }),
        onAssistantDelta: () => {},
        cleanup: async () => {},
      });
      const runExpectation = expectRejectsWithFields(run, {
        name: "FailoverError",
        message: "CLI produced no output for 1s and was terminated.",
      });

      await vi.advanceTimersByTimeAsync(1_000);

      await runExpectation;
      await Promise.resolve();
      expect(unhandledRejections).toEqual([]);
      expect(cancel).toHaveBeenCalledWith("manual-cancel");
      expect(stdin.write).toHaveBeenCalledOnce();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("restarts Claude live sessions when selected skills change", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-skills-"));
    const weatherDir = path.join(workspaceDir, "skills", "weather");
    const gitDir = path.join(workspaceDir, "skills", "git");
    await fs.mkdir(weatherDir, { recursive: true });
    await fs.mkdir(gitDir, { recursive: true });
    await fs.writeFile(path.join(weatherDir, "SKILL.md"), "weather instructions\n", "utf-8");
    await fs.writeFile(path.join(gitDir, "SKILL.md"), "git instructions\n", "utf-8");

    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const spawnIndex = supervisorSpawnMock.mock.calls.length;
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      const cancel = vi.fn();
      cancels.push(cancel);
      const stdin = {
        write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
          const text = spawnIndex === 1 ? "weather-ok" : "git-ok";
          input.onStdout?.(
            [
              JSON.stringify({ type: "system", subtype: "init", session_id: `live-${spawnIndex}` }),
              JSON.stringify({
                type: "result",
                session_id: `live-${spawnIndex}`,
                result: text,
              }),
            ].join("\n") + "\n",
          );
          cb?.();
        }),
        end: vi.fn(),
      };
      return {
        runId: `live-run-${spawnIndex}`,
        pid: 2345 + spawnIndex,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel,
      };
    });

    try {
      const first = await executePreparedCliRun(
        buildClaudeLiveRunContext({
          prompt: "first",
          workspaceDir,
          skillsSnapshot: {
            prompt: "weather",
            skills: [{ name: "weather" }],
            resolvedSkills: [
              {
                name: "weather",
                description: "Weather instructions.",
                filePath: path.join(weatherDir, "SKILL.md"),
                baseDir: weatherDir,
                source: "test",
                sourceInfo: {
                  path: weatherDir,
                  source: "test",
                  scope: "project",
                  origin: "top-level",
                  baseDir: weatherDir,
                },
                disableModelInvocation: false,
              },
            ],
          },
        }),
      );
      const second = await executePreparedCliRun(
        buildClaudeLiveRunContext({
          prompt: "second",
          workspaceDir,
          skillsSnapshot: {
            prompt: "git",
            skills: [{ name: "git" }],
            resolvedSkills: [
              {
                name: "git",
                description: "Git instructions.",
                filePath: path.join(gitDir, "SKILL.md"),
                baseDir: gitDir,
                source: "test",
                sourceInfo: {
                  path: gitDir,
                  source: "test",
                  scope: "project",
                  origin: "top-level",
                  baseDir: gitDir,
                },
                disableModelInvocation: false,
              },
            ],
          },
        }),
      );

      expect(first.text).toBe("weather-ok");
      expect(second.text).toBe("git-ok");
      expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
      expect(cancels[0]).toHaveBeenCalledWith("manual-cancel");
      expect(cancels[1]).not.toHaveBeenCalled();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("closes idle Claude live sessions after ten minutes", async () => {
    vi.useFakeTimers();
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "live-session-idle" },
        { type: "result", session_id: "live-session-idle", result: "idle-ok" },
      ],
    });

    try {
      const result = await executePreparedCliRun(
        buildClaudeLiveRunContext({
          prompt: "idle",
        }),
      );

      expect(result.text).toBe("idle-ok");
      expect(live.lifecycle.cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000 - 1);
      expect(live.lifecycle.cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(live.lifecycle.cancel).toHaveBeenCalledWith("manual-cancel");
      expect(
        live.writes.map(
          (entry) => (JSON.parse(entry) as { message: { content: string } }).message.content,
        ),
      ).toEqual(["idle"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not surface stale stderr after a later Claude live exit", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    let stderrListener: ((chunk: string) => void) | undefined;
    let resolveExit:
      | ((value: {
          reason: "exit";
          exitCode: number;
          exitSignal: null;
          durationMs: number;
          stdout: string;
          stderr: string;
          timedOut: false;
          noOutputTimedOut: false;
        }) => void)
      | undefined;
    const wait = new Promise<{
      reason: "exit";
      exitCode: number;
      exitSignal: null;
      durationMs: number;
      stdout: string;
      stderr: string;
      timedOut: false;
      noOutputTimedOut: false;
    }>((resolve) => {
      resolveExit = resolve;
    });
    let writeCount = 0;
    const stdin = {
      write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
        writeCount += 1;
        if (writeCount === 1) {
          stderrListener?.("stale stderr from first turn");
          stdoutListener?.(
            [
              JSON.stringify({ type: "system", subtype: "init", session_id: "live-stderr" }),
              JSON.stringify({
                type: "result",
                session_id: "live-stderr",
                result: "first-ok",
              }),
            ].join("\n") + "\n",
          );
          cb?.();
          return;
        }
        cb?.();
        if (!resolveExit) {
          throw new Error("Expected Claude live exit resolver to be initialized");
        }
        resolveExit({
          reason: "exit",
          exitCode: 1,
          exitSignal: null,
          durationMs: 50,
          stdout: "",
          stderr: "",
          timedOut: false,
          noOutputTimedOut: false,
        });
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as {
        onStdout?: (chunk: string) => void;
        onStderr?: (chunk: string) => void;
      };
      stdoutListener = input.onStdout;
      stderrListener = input.onStderr;
      return {
        runId: "live-run",
        pid: 2345,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => wait),
        cancel: vi.fn(),
      };
    });

    const first = await executePreparedCliRun(
      buildClaudeLiveRunContext({
        prompt: "first",
      }),
    );
    const second = executePreparedCliRun(
      buildClaudeLiveRunContext({
        prompt: "second",
      }),
    );

    expect(first.text).toBe("first-ok");
    await expectRejectsWithFields(second, {
      name: "FailoverError",
      message: "Claude CLI failed.",
    });
  });

  it("surfaces nested Claude stream-json API errors instead of raw event output", async () => {
    const { message, jsonl } = createClaudeApiErrorFixture();

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 50,
        stdout: jsonl,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const run = executePreparedCliRun(buildPreparedCliRunContext({}));

    await expectRejectsWithFields(run, {
      name: "FailoverError",
      message,
      reason: "billing",
      status: 402,
    });
  });

  it("sanitizes dangerous backend env overrides before spawn", async () => {
    mockSuccessfulCliRun();
    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "codex-cli",
        model: "gpt-5.4",
        backend: {
          env: {
            NODE_OPTIONS: "--require ./malicious.js",
            LD_PRELOAD: "/tmp/pwn.so",
            PATH: "/tmp/evil",
            HOME: "/tmp/evil-home",
            SAFE_KEY: "ok",
          },
        },
      }),
      "thread-123",
    );

    const input = mockCallArg(supervisorSpawnMock) as {
      env?: Record<string, string | undefined>;
    };
    expect(input.env?.SAFE_KEY).toBe("ok");
    expect(input.env?.PATH).toBe(process.env.PATH);
    expect(input.env?.HOME).toBe(process.env.HOME);
    expect(input.env?.NODE_OPTIONS).toBeUndefined();
    expect(input.env?.LD_PRELOAD).toBeUndefined();
  });

  it.each([
    {
      name: "applies clearEnv after sanitizing backend env overrides",
      baseEnv: { SAFE_CLEAR: "from-base" },
      backend: { env: { SAFE_KEEP: "keep-me" }, clearEnv: ["SAFE_CLEAR"] },
      expected: { SAFE_KEEP: "keep-me", SAFE_CLEAR: undefined },
    },
    {
      name: "can preserve selected clearEnv keys for live CLI backend probes",
      baseEnv: { SAFE_CLEAR: "from-base" },
      preserve: ["SAFE_CLEAR"],
      backend: { clearEnv: ["SAFE_CLEAR", "SAFE_DROP"] },
      expected: { SAFE_CLEAR: "from-base", SAFE_DROP: undefined },
    },
    {
      name: "keeps explicit backend env overrides even when clearEnv drops inherited values",
      baseEnv: { SAFE_OVERRIDE: "from-base" },
      backend: { env: { SAFE_OVERRIDE: "from-override" }, clearEnv: ["SAFE_OVERRIDE"] },
      expected: { SAFE_OVERRIDE: "from-override" },
    },
  ])("$name", async (testCase) => {
    Object.assign(process.env, testCase.baseEnv);
    if (testCase.preserve) {
      process.env.OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV = JSON.stringify(testCase.preserve);
    }
    try {
      mockSuccessfulCliRun();
      await executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "codex-cli",
          model: "gpt-5.4",
          backend: testCase.backend as Partial<PreparedCliRunContext["preparedBackend"]["backend"]>,
        }),
        "thread-123",
      );

      const input = mockCallArg(supervisorSpawnMock) as {
        env?: Record<string, string | undefined>;
      };
      for (const [key, value] of Object.entries(testCase.expected)) {
        expect(input.env?.[key]).toBe(value);
      }
    } finally {
      delete process.env.OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV;
      for (const key of Object.keys(testCase.baseEnv)) {
        delete process.env[key];
      }
    }
  });

  it("keeps selected Claude auth authoritative over ambient and configured credentials", async () => {
    vi.stubEnv("OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV", '["ANTHROPIC_API_KEY"]');
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-api-key");
    mockSuccessfulCliRun(CLAUDE_OK_JSONL);

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        model: "claude-sonnet-4-6",
        preparedEnv: {
          CLAUDE_CODE_OAUTH_TOKEN: "selected-oauth-token",
          CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
        },
        backend: {
          env: { ANTHROPIC_API_KEY: "configured-api-key" },
          clearEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
        },
      }),
    );

    const input = mockCallArg(supervisorSpawnMock) as {
      env?: Record<string, string | undefined>;
    };
    expect(input.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(input.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("selected-oauth-token");
  });

  it("clears claude-cli provider-routing, auth, telemetry, compaction, and host-managed env", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example.com/v1");
    vi.stubEnv("ANTHROPIC_API_TOKEN", "env-api-token");
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "x-test-header: env");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "env-oauth-token");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "env-auth-token");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "env-oauth-token");
    vi.stubEnv("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "1048576");
    vi.stubEnv("CLAUDE_CODE_REMOTE", "1");
    vi.stubEnv("ANTHROPIC_UNIX_SOCKET", "/tmp/anthropic.sock");
    vi.stubEnv("OTEL_LOGS_EXPORTER", "none");
    vi.stubEnv("OTEL_METRICS_EXPORTER", "none");
    vi.stubEnv("OTEL_TRACES_EXPORTER", "none");
    vi.stubEnv("OTEL_EXPORTER_OTLP_PROTOCOL", "none");
    vi.stubEnv("OTEL_SDK_DISABLED", "true");
    vi.stubEnv("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "1");
    mockSuccessfulCliRun(CLAUDE_OK_JSONL);

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        model: "claude-sonnet-4-6",
        preparedEnv: {
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000",
        },
        backend: {
          env: {
            SAFE_KEEP: "ok",
            ANTHROPIC_BASE_URL: "https://override.example.com/v1",
            CLAUDE_CODE_OAUTH_TOKEN: "override-oauth-token",
            CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
          },
          clearEnv: [
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_API_TOKEN",
            "ANTHROPIC_CUSTOM_HEADERS",
            "ANTHROPIC_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
            "CLAUDE_CODE_REMOTE",
            "ANTHROPIC_UNIX_SOCKET",
            "OTEL_LOGS_EXPORTER",
            "OTEL_METRICS_EXPORTER",
            "OTEL_TRACES_EXPORTER",
            "OTEL_EXPORTER_OTLP_PROTOCOL",
            "OTEL_SDK_DISABLED",
          ],
        },
      }),
    );

    const input = mockCallArg(supervisorSpawnMock) as {
      env?: Record<string, string | undefined>;
    };
    expect(input.env?.SAFE_KEEP).toBe("ok");
    expect(input.env?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
    expect(input.env?.ANTHROPIC_BASE_URL).toBe("https://override.example.com/v1");
    expect(input.env?.ANTHROPIC_API_TOKEN).toBeUndefined();
    expect(input.env?.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(input.env?.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
    expect(input.env?.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(input.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(input.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("override-oauth-token");
    expect(input.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("100000");
    expect(input.env?.CLAUDE_CODE_REMOTE).toBeUndefined();
    expect(input.env?.ANTHROPIC_UNIX_SOCKET).toBeUndefined();
    expect(input.env?.OTEL_LOGS_EXPORTER).toBeUndefined();
    expect(input.env?.OTEL_METRICS_EXPORTER).toBeUndefined();
    expect(input.env?.OTEL_TRACES_EXPORTER).toBeUndefined();
    expect(input.env?.OTEL_EXPORTER_OTLP_PROTOCOL).toBeUndefined();
    expect(input.env?.OTEL_SDK_DISABLED).toBeUndefined();
  });

  it("formats CLI auth env diagnostics as key names without secret values", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-host");
    vi.stubEnv("ANTHROPIC_API_TOKEN", "token-host");
    vi.stubEnv("GEMINI_CLI_SYSTEM_SETTINGS_PATH", "/tmp/host-gemini-settings.json");
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-host");

    const log = buildCliEnvAuthLog({
      ANTHROPIC_API_TOKEN: "token-child",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      GEMINI_CLI_HOME: "/tmp/child-gemini-home",
      OPENAI_API_KEY: "sk-openai-child",
    });

    expect(log).toMatch(/host=.*ANTHROPIC_API_KEY/);
    expect(log).toMatch(/host=.*ANTHROPIC_API_TOKEN/);
    expect(log).toMatch(/host=.*OPENAI_API_KEY/);
    expect(log).toMatch(/child=.*ANTHROPIC_API_TOKEN/);
    expect(log).toMatch(/child=.*CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST/);
    expect(log).toMatch(/child=.*OPENAI_API_KEY/);
    expect(log).toMatch(/cleared=.*ANTHROPIC_API_KEY/);
    expect(log).toMatch(/runtimeHost=.*GEMINI_CLI_SYSTEM_SETTINGS_PATH/);
    expect(log).toMatch(/runtimeChild=.*GEMINI_CLI_HOME/);
    expect(log).toMatch(/runtimeCleared=.*GEMINI_CLI_SYSTEM_SETTINGS_PATH/);
    expect(log).not.toContain("sk-ant-host");
    expect(log).not.toContain("token-child");
    expect(log).not.toContain("/tmp/child-gemini-home");
    expect(log).not.toContain("sk-openai-child");
  });

  it("prepends bootstrap warnings to the CLI prompt body", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    const context = buildPreparedCliRunContext({
      provider: "codex-cli",
      model: "gpt-5.4",
    });
    context.reusableCliSession = { mode: "reuse", sessionId: "thread-123" };
    context.bootstrapPromptWarningLines = [
      "[Bootstrap truncation warning]",
      "- AGENTS.md: 200 raw -> 20 injected",
    ];

    await executePreparedCliRun(context, "thread-123");

    const input = mockCallArg(supervisorSpawnMock) as {
      argv?: string[];
      input?: string;
    };
    const promptCarrier = [input.input ?? "", ...(input.argv ?? [])].join("\n");

    expect(promptCarrier).toContain("[Bootstrap truncation warning]");
    expect(promptCarrier).toContain("- AGENTS.md: 200 raw -> 20 injected");
    expect(promptCarrier).toContain("hi");
  });

  it("loads workspace bootstrap files into the Claude CLI system prompt", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-cli-bootstrap-context-"),
    );

    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      [
        "# AGENTS.md",
        "",
        "Read SOUL.md and IDENTITY.md before replying.",
        "Use the injected workspace bootstrap files as standing instructions.",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "SOUL-SECRET\n", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), "IDENTITY-SECRET\n", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "USER.md"), "USER-SECRET\n", "utf-8");

    setCliRunnerPrepareTestDeps({
      makeBootstrapWarn: realMakeBootstrapWarn,
      resolveBootstrapContextForRun: realResolveBootstrapContextForRun,
    });

    try {
      const { contextFiles } = await realResolveBootstrapContextForRun({
        workspaceDir,
      });
      const allArgs = buildCliAgentSystemPrompt({
        workspaceDir,
        modelDisplay: "claude-cli/sonnet",
        contextFiles,
        tools: [],
      });
      const agentsPath = path.join(workspaceDir, "AGENTS.md");
      const soulPath = path.join(workspaceDir, "SOUL.md");
      const identityPath = path.join(workspaceDir, "IDENTITY.md");
      const userPath = path.join(workspaceDir, "USER.md");
      expect(allArgs).toContain("# Project Context");
      expect(allArgs).toContain(`## ${agentsPath}`);
      expect(allArgs).toContain("Read SOUL.md and IDENTITY.md before replying.");
      expect(allArgs).toContain(`## ${soulPath}`);
      expect(allArgs).toContain("SOUL-SECRET");
      expect(allArgs).toContain(
        "SOUL.md: persona/tone. Follow it unless higher-priority instructions override.",
      );
      expect(allArgs).toContain(`## ${identityPath}`);
      expect(allArgs).toContain("IDENTITY-SECRET");
      expect(allArgs).toContain(`## ${userPath}`);
      expect(allArgs).toContain("USER-SECRET");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      restoreCliRunnerPrepareTestDeps();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
