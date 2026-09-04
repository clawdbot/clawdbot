import path from "node:path";
import * as agentHarnessRuntime from "openclaw/plugin-sdk/agent-harness-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { formatSqliteSessionFileMarker } from "openclaw/plugin-sdk/sqlite-runtime-testing";
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
    const source = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      storePath: path.join(tempDir, "agent-end-context.sqlite"),
    };
    const sessionFile = formatSqliteSessionFileMarker(source);
    await upsertSessionEntry({
      ...source,
      entry: { sessionFile, sessionId: source.sessionId, updatedAt: Date.now() },
    });
    const workspaceDir = path.join(tempDir, "agent-end-context-workspace");
    const harness = createStartedThreadHarness();
    const runAgentEndSideEffects = vi.spyOn(agentHarnessRuntime, "runAgentEndSideEffects");
    const params = createParams(sessionFile, workspaceDir);
    params.sessionTarget = source;
    params.messageChannel = "discord";
    params.memberRoleIds = ["maintainer-role"];

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-1", text: "final answer" }],
        },
      },
    });
    await run;

    const ctx = runAgentEndSideEffects.mock.calls.at(-1)?.[0]?.ctx;
    expect(ctx?.foregroundPromptContext?.memberRoleIds).toEqual(["maintainer-role"]);
    expect(typeof ctx?.foregroundPromptContext?.agentDir).toBe("string");
    expect(
      runAgentEndSideEffects.mock.calls.at(-1)?.[0]?.skillExperienceReviewSource,
    ).toMatchObject(source);
  });
});
