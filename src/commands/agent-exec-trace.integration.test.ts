import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunTerminalOutcomeError } from "../agents/agent-run-terminal-error.js";
import { buildAgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.js";
import {
  bindAgentCommandRunAccounting,
  createRunAccountingAccumulator,
  resolveAgentCommandRunAccounting,
} from "../agents/command/run-accounting.js";
import type { RuntimeEnv } from "../runtime.js";
import { normalizeAgentExecTrace, verifyAgentExecTrace } from "./agent-exec-trace.js";
import { agentExecCommand, type AgentExecCliOptions } from "./agent-exec.js";

const auditMocks = vi.hoisted(() => ({
  start: vi.fn(),
}));
const agentMocks = vi.hoisted(() => ({
  command: vi.fn(),
}));

vi.mock("./agent-local-audit.js", () => ({
  startAgentLocalAuditWriter: auditMocks.start,
}));
vi.mock("./agent.js", () => ({
  agentCommand: agentMocks.command,
}));

const tempRoots: string[] = [];

function createRuntime() {
  const log = vi.fn();
  const runtime: RuntimeEnv = {
    log,
    error: vi.fn(),
    exit: vi.fn(),
  };
  return { runtime, log };
}

async function makeConfig(config: Record<string, unknown>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-exec-trace-"));
  tempRoots.push(root);
  const configPath = path.join(root, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");
  return configPath;
}

function successResultWithAccounting(codeModeEngaged: boolean) {
  const result = {
    payloads: [{ text: "done" }],
    meta: {
      durationMs: 25,
      finalAssistantVisibleText: "done",
      agentMeta: {
        sessionId: "session-result",
        provider: "openai",
        model: "gpt-test",
        usage: { input: 10, output: 2, total: 12 },
        codeModeEngaged,
      },
    },
  };
  const accounting = createRunAccountingAccumulator(0);
  const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
  candidate.selectRuntime("embedded");
  candidate.beginAgentSubmission().settle("completed");
  candidate.markModelCallInstrumentationInstalled();
  candidate.beginModelCall().settle("completed");
  candidate.observeAgentDuration(result.meta.durationMs);
  candidate.observeEmbeddedAttempt({
    provider: "openai",
    model: "gpt-test",
    usage: {
      input: 10,
      cacheRead: 0,
      cacheWrite: 0,
      output: 2,
      reasoningTokens: 0,
      total: 12,
    },
    assistantTurns: 1,
    assistantTurnsObserved: true,
    assistantTurnsWithUsage: 1,
    toolSummary: { calls: 0, tools: [] },
    toolsObserved: true,
    codeModeEngaged,
    codeModeLifecycleObserved: false,
  });
  candidate.settle("returned");
  accounting.providerTransportObserver.onLogicalCallStarted({
    callId: "opaque-call-id",
    provider: "openai",
    model: "gpt-test",
    api: "responses",
  });
  accounting.providerTransportObserver.onTransportEvent({
    eventId: "invocation",
    type: "invocation",
    provider: "openai",
    model: "gpt-test",
    api: "responses",
    callId: "opaque-call-id",
    transport: "sse",
    ordinal: 1,
    attemptOrdinal: 1,
    hopOrdinal: 1,
    reason: "initial",
  });
  accounting.providerTransportObserver.onTransportEvent({
    eventId: "attempt",
    type: "attempt",
    provider: "openai",
    model: "gpt-test",
    api: "responses",
    callId: "opaque-call-id",
    transport: "sse",
    ordinal: 1,
    reason: "initial",
    outcome: "completed",
  });
  accounting.providerTransportObserver.onLogicalCallSettled("opaque-call-id", "completed", {
    state: "exact",
    tokens: 0,
  });
  accounting.providerTransportObserver.onLogicalCallFinalized("opaque-call-id");
  expect(bindAgentCommandRunAccounting(result.meta, accounting.project())).toBe(true);
  return result;
}

function terminalError(
  message: string,
  input: Parameters<typeof buildAgentRunTerminalOutcome>[0],
  nestedMarker?: Record<string, unknown>,
): AgentRunTerminalOutcomeError {
  return new AgentRunTerminalOutcomeError(
    Object.assign(new Error(message), nestedMarker),
    buildAgentRunTerminalOutcome(input),
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  auditMocks.start.mockReset();
  agentMocks.command.mockReset();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("agent exec trace integration", () => {
  it("consumes the bound receipt once and round-trips the persisted JSON trace", async () => {
    const { runtime, log } = createRuntime();
    const runResult = successResultWithAccounting(false);
    agentMocks.command.mockResolvedValue(runResult);

    const result = await agentExecCommand("inspect", { codeMode: "direct", json: true }, runtime);

    expect(resolveAgentCommandRunAccounting(runResult.meta)).toBeUndefined();
    expect(result.envelope.trace).toMatchObject({
      source: {
        kind: "agent_exec_source_facts",
        mode: { configured: false, engaged: false },
        invocationReceipt: { kind: "transport_invocation_receipt" },
      },
      projection: {
        metrics: {
          logicalModelCalls: { state: "exact", value: 1 },
          modelFacingApiCalls: { state: "exact", value: 1 },
        },
      },
      audit: { state: "valid" },
    });
    expect(JSON.stringify(result.envelope.trace)).not.toContain("opaque-call-id");
    const persisted = JSON.parse(String(log.mock.calls[0]?.[0])) as { trace?: unknown };
    const serializedTrace = JSON.stringify(persisted.trace);
    expect(verifyAgentExecTrace(serializedTrace)).toBe(true);
    expect(normalizeAgentExecTrace(serializedTrace)).toEqual(result.envelope.trace);
  });

  it("discards accounting prebound by an injected runner", async () => {
    const { runtime } = createRuntime();
    const runResult = successResultWithAccounting(true);

    const result = await agentExecCommand("inspect", { json: true }, runtime, {
      runAgent: vi.fn(async () => runResult),
    });

    expect(result.envelope.trace).toBeUndefined();
    expect(resolveAgentCommandRunAccounting(runResult.meta)).toBeUndefined();
  });

  it("copies mode from effective run config and ignores foreign trace overrides", async () => {
    const { runtime } = createRuntime();
    const config = await makeConfig({ tools: { codeMode: { enabled: true } } });
    const options = {
      config,
      json: true,
      codeModeConfigured: false,
      durationMs: 999_999,
      engagement: false,
      metrics: { logicalModelCalls: 999 },
      cleanup: { status: "failed" },
    } as AgentExecCliOptions & Record<string, unknown>;
    agentMocks.command.mockResolvedValue(successResultWithAccounting(true));

    const result = await agentExecCommand("inspect", options, runtime);

    expect(result.envelope.trace?.source.mode).toEqual({ configured: true, engaged: true });
    expect(result.envelope.trace?.projection.metrics.agentDurationMs).toEqual({
      state: "exact",
      value: 25,
    });
    expect(result.envelope.trace?.projection.metrics.logicalModelCalls).toEqual({
      state: "exact",
      value: 1,
    });
    expect(result.envelope.cleanup).toBeUndefined();
  });

  it.each([
    { global: true, agent: false, engaged: false },
    { global: false, agent: true, engaged: true },
  ] as const)(
    "applies the default agent Code Mode override over global $global",
    async ({ global, agent, engaged }) => {
      const { runtime } = createRuntime();
      const config = await makeConfig({
        agents: {
          entries: {
            "trace-agent": {
              default: true,
              tools: { codeMode: agent },
            },
          },
        },
        tools: { codeMode: global },
      });
      agentMocks.command.mockResolvedValue(successResultWithAccounting(engaged));

      const result = await agentExecCommand("inspect", { config, json: true }, runtime);

      expect(result.envelope.trace?.source.mode).toEqual({
        configured: agent,
        engaged,
      });
    },
  );

  it.each([
    { cli: "direct", configured: false, engaged: false },
    { cli: "code", configured: true, engaged: true },
  ] as const)(
    "applies CLI $cli over the default agent Code Mode override",
    async ({ cli, configured, engaged }) => {
      const { runtime } = createRuntime();
      const config = await makeConfig({
        agents: {
          entries: {
            "trace-agent": {
              default: true,
              tools: { codeMode: !configured },
            },
          },
        },
        tools: { codeMode: !configured },
      });
      agentMocks.command.mockResolvedValue(successResultWithAccounting(engaged));

      const result = await agentExecCommand(
        "inspect",
        { config, codeMode: cli, json: true },
        runtime,
      );

      expect(result.envelope.trace?.source.mode).toEqual({ configured, engaged });
    },
  );

  it.each([
    {
      label: "error",
      outcome: { status: "error", error: "task failed" },
      nestedMarker: { name: "TimeoutError" },
      expectedStatus: "error",
      expectedKind: "failed",
      expectedExitCode: 1,
    },
    {
      label: "timeout",
      outcome: {
        status: "timeout",
        error: "task timed out",
        timeoutPhase: "provider",
      },
      nestedMarker: { code: "ETIMEDOUT" },
      expectedStatus: "timeout",
      expectedKind: "timeout",
      expectedExitCode: 2,
    },
    {
      label: "cancel",
      outcome: {
        status: "error",
        error: "task cancelled",
        stopReason: "rpc",
      },
      nestedMarker: { code: "ETIMEDOUT" },
      expectedStatus: "error",
      expectedKind: "cancelled",
      expectedExitCode: 1,
    },
    {
      label: "blocked",
      outcome: {
        status: "error",
        error: "task blocked",
        livenessState: "blocked",
      },
      nestedMarker: { reason: "timeout" },
      expectedStatus: "error",
      expectedKind: "blocked",
      expectedExitCode: 1,
    },
  ] as const)(
    "keeps thrown task $label primary when cleanup also fails",
    async ({ outcome, nestedMarker, expectedStatus, expectedKind, expectedExitCode }) => {
      const { runtime } = createRuntime();
      const failure = terminalError(outcome.error, outcome, nestedMarker);
      vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup denied"));
      agentMocks.command.mockRejectedValue(failure);

      const result = await agentExecCommand("inspect", { json: true }, runtime);

      expect(result).toMatchObject({
        exitCode: expectedExitCode,
        envelope: {
          ok: false,
          status: expectedStatus,
          error: { kind: expectedKind, phase: "task" },
          cleanup: {
            status: "failed",
            error: { kind: "cleanup_error", phase: "cleanup" },
          },
        },
      });
      expect(result.envelope.error?.phase).not.toBe("infrastructure");
    },
  );

  it("preserves cleanup after a task error exposes a hostile cause accessor", async () => {
    const { runtime } = createRuntime();
    const failure = new Error("task failed");
    Object.defineProperty(failure, "cause", {
      get() {
        throw new Error("accessor invoked");
      },
    });
    vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup denied"));
    agentMocks.command.mockRejectedValue(failure);

    const result = await agentExecCommand("inspect", { json: true }, runtime);

    expect(result).toMatchObject({
      exitCode: 1,
      envelope: {
        status: "error",
        error: { message: "task failed", phase: "task" },
        cleanup: {
          status: "failed",
          error: { kind: "cleanup_error", phase: "cleanup" },
        },
      },
    });
  });

  it("preserves cleanup after a task error exposes a hostile prototype trap", async () => {
    const { runtime } = createRuntime();
    const failure = new Proxy(new Error("task failed"), {
      getPrototypeOf() {
        throw new Error("prototype trap");
      },
    });
    vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup denied"));
    agentMocks.command.mockRejectedValue(failure);

    const result = await agentExecCommand("inspect", { json: true }, runtime);

    expect(result).toMatchObject({
      exitCode: 1,
      envelope: {
        status: "error",
        error: { message: "Unknown error", phase: "task" },
        cleanup: {
          status: "failed",
          error: { kind: "cleanup_error", phase: "cleanup" },
        },
      },
    });
  });

  it("records audit-writer stop failure as cleanup without masking success early", async () => {
    const { runtime } = createRuntime();
    const config = await makeConfig({
      logging: { audit: { enabled: true, executionIdentity: true } },
    });
    const stop = vi.fn(async () => {
      throw new Error("audit stop denied");
    });
    auditMocks.start.mockReturnValue(stop);
    agentMocks.command.mockResolvedValue(successResultWithAccounting(false));

    const result = await agentExecCommand("inspect", { config, json: true }, runtime);

    expect(auditMocks.start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      exitCode: 1,
      envelope: {
        status: "error",
        error: {
          kind: "cleanup_error",
          phase: "cleanup",
          message: "Agent exec cleanup failed: audit stop denied",
        },
        cleanup: {
          status: "failed",
          error: { kind: "cleanup_error", phase: "cleanup" },
        },
      },
    });
  });

  it.each([false, 0, "", null, undefined])(
    "normalizes the first audit cleanup rejection for payload %#",
    async (reason) => {
      const { runtime } = createRuntime();
      const config = await makeConfig({
        logging: { audit: { enabled: true, executionIdentity: true } },
      });
      const stop = vi.fn(async () => {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Exercise hostile cleanup rejection payloads.
        await Promise.reject(reason);
      });
      auditMocks.start.mockReturnValue(stop);
      agentMocks.command.mockResolvedValue(successResultWithAccounting(false));
      vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("later temporary-state cleanup failure"));

      const result = await agentExecCommand("inspect", { config, json: true }, runtime);

      expect(result.exitCode).toBe(1);
      expect(result.envelope.error).toMatchObject({
        kind: "cleanup_error",
        phase: "cleanup",
        message:
          reason === ""
            ? "Agent exec cleanup failed: Error"
            : "Agent exec cleanup failed: Non-Error agent exec cleanup rejection",
      });
      expect(result.envelope.error?.message).not.toContain("later temporary-state cleanup failure");
    },
  );
});
