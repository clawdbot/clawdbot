// Covers the CLI capture-boundary tracking that feeds successfulCronAdds into
// settlement continuation evidence for sessions_yield.
import { afterEach, describe, expect, it } from "vitest";
import {
  clearMcpLoopbackToolCallCapture,
  markMcpLoopbackToolCallStarted,
  recordMcpLoopbackToolCallResult,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";
import type { PreparedCliRunContext } from "./types.js";

function buildMinimalPreparedCliRunContext(runId: string): PreparedCliRunContext {
  const backend = {
    command: "agent-cli",
    args: [],
    output: "jsonl" as const,
    input: "stdin" as const,
    serialize: true,
  };
  return {
    params: {
      admittedRunContext: createTestAdmittedRunContext(runId),
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "model",
      timeoutMs: 1_000,
      runId,
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: { id: "codex-cli", config: backend, bundleMcp: false },
    preparedBackend: { backend, env: {} },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "model",
    normalizedModel: "model",
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

describe("createCliToolTracking shell-created cron adds", () => {
  afterEach(() => {
    clearMcpLoopbackToolCallCapture("test-cli-tool-tracking-shell-cron");
  });

  it("counts a successful shell-created cron add as continuation evidence", () => {
    const captureKey = "test-cli-tool-tracking-shell-cron";
    const tracking = createCliToolTracking(buildMinimalPreparedCliRunContext(captureKey));
    tracking.beginGatewayCapture(captureKey);
    const args = { command: "openclaw cron add --at +1h --message 'follow up' --name reminder" };
    const handle = markMcpLoopbackToolCallStarted({ captureKey, toolName: "exec", args });
    expect(handle).toBeDefined();
    recordMcpLoopbackToolCallResult({
      captureHandle: handle!,
      toolName: "exec",
      args,
      outcome: "completed",
      result: { details: { status: "completed", exitCode: 0 } },
    });

    const output = tracking.withExecutionEvidence({ text: "" });

    expect(output.successfulCronAdds).toBe(1);
  });

  it("does not count a failed shell-created cron add", () => {
    const captureKey = "test-cli-tool-tracking-shell-cron";
    const tracking = createCliToolTracking(buildMinimalPreparedCliRunContext(captureKey));
    tracking.beginGatewayCapture(captureKey);
    const args = { command: "openclaw cron add --at +1h --message 'follow up' --name reminder" };
    const handle = markMcpLoopbackToolCallStarted({ captureKey, toolName: "exec", args });
    expect(handle).toBeDefined();
    recordMcpLoopbackToolCallResult({
      captureHandle: handle!,
      toolName: "exec",
      args,
      outcome: "completed",
      result: {
        details: { status: "completed", exitCode: 1, aggregated: "Cron job name is required." },
      },
    });

    const output = tracking.withExecutionEvidence({ text: "" });

    expect(output.successfulCronAdds).toBeUndefined();
  });
});
