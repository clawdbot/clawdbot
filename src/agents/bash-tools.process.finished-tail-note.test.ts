/**
 * Regression coverage for process poll on already-exited sessions.
 *
 * Polling a finished background session returns the retained 2000-char tail;
 * when the full aggregated output is longer, the response must announce the
 * slice (mirroring action=log) so callers never mistake a partial tail for the
 * complete output.
 */
import { afterEach, expect, test } from "vitest";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { addSession, appendOutput, markExited } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";

afterEach(() => {
  resetProcessRegistryForTests();
  resetDiagnosticSessionStateForTest();
});

function finishedPollHarness(sessionId: string, output: string) {
  const processTool = createProcessTool();
  const session = createProcessSessionFixture({
    id: sessionId,
    command: "test",
    backgrounded: true,
  });
  addSession(session);
  appendOutput(session, "stdout", output);
  markExited(session, 0, null, "completed");
  return processTool;
}

test("process poll on an exited session announces the retained tail slice", async () => {
  const processTool = finishedPollHarness("sess-truncated", "x".repeat(6410));

  const poll = await processTool.execute("toolcall", {
    action: "poll",
    sessionId: "sess-truncated",
  });

  expect(poll.details).toMatchObject({ status: "completed" });
  const text = poll.content[0]?.type === "text" ? poll.content[0].text : "";
  expect(text).toContain("[showing last 2000 of 6410 chars");
  expect(text).toContain("pass offset/limit to action=log to page the full output");
  // The full output must still be available to the caller through details.
  expect((poll.details as { aggregated?: string }).aggregated).toHaveLength(6410);
});

test("process poll on an exited session stays quiet when the tail is complete", async () => {
  const processTool = finishedPollHarness("sess-complete", "x".repeat(512));

  const poll = await processTool.execute("toolcall", {
    action: "poll",
    sessionId: "sess-complete",
  });

  expect(poll.details).toMatchObject({ status: "completed" });
  const text = poll.content[0]?.type === "text" ? poll.content[0].text : "";
  expect(text).toContain("x".repeat(512));
  expect(text).not.toContain("showing last");
  expect((poll.details as { aggregated?: string }).aggregated).toHaveLength(512);
});
