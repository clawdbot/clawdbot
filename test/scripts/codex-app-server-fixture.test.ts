import { describe, expect, it } from "vitest";
import { createFakeThreadStartResponse } from "../../scripts/e2e/lib/codex-app-server-fixture.mjs";

describe("createFakeThreadStartResponse", () => {
  it.each([
    { expected: null, params: {} },
    { expected: "project-1", params: { projectId: "project-1" } },
  ])("returns the protocol-required projectId as $expected", ({ expected, params }) => {
    const response = createFakeThreadStartResponse({
      params,
      sessionId: "session-1",
      threadId: "thread-1",
      version: "0.149.1",
    });

    expect(response.thread.projectId).toBe(expected);
  });
});
