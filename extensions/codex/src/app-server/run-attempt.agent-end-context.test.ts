// Codex tests cover the agent-end context handed to OpenClaw side effects.
import path from "node:path";
import * as agentHarnessRuntime from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt agent-end context", () => {
  it("hands the foreground prompt context to agent-end side effects", async () => {
    const sessionFile = path.join(tempDir, "agent-end-context.jsonl");
    const workspaceDir = path.join(tempDir, "agent-end-context-workspace");
    const harness = createStartedThreadHarness();
    const runAgentEndSideEffects = vi.spyOn(agentHarnessRuntime, "runAgentEndSideEffects");
    const params = createParams(sessionFile, workspaceDir);
    params.messageChannel = "discord";
    params.memberRoleIds = ["maintainer-role"];

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const ctx = runAgentEndSideEffects.mock.calls.at(-1)?.[0]?.ctx;
    expect(ctx?.foregroundPromptContext?.memberRoleIds).toEqual(["maintainer-role"]);
    expect(typeof ctx?.foregroundPromptContext?.agentDir).toBe("string");
  });
});
