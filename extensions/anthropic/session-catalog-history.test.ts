import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { importClaudeHistory } from "./session-catalog-history.js";

const appended: Array<Record<string, unknown>> = [];

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  withSessionTranscriptWriteLock: async (
    _params: unknown,
    run: (transcript: {
      appendMessage: (input: { message: Record<string, unknown> }) => Promise<void>;
    }) => Promise<void>,
  ) => {
    await run({
      appendMessage: async ({ message }) => {
        appended.push(message);
      },
    });
  },
}));

describe("importClaudeHistory", () => {
  it("tags imported native user rows so self-echo provenance excludes them", async () => {
    appended.length = 0;
    await importClaudeHistory({
      items: [
        { type: "userMessage", text: "continue", uuid: "u-1" },
        { type: "assistantMessage", text: "done", uuid: "a-1" },
      ],
      threadId: "thread-1",
      sessionFile: "/tmp/unused.jsonl",
      sessionId: "session-1",
      sessionKey: "agent:main:catalog-adopt",
      agentId: "main",
      config: {} as OpenClawConfig,
    });

    const userRow = appended.find((message) => message.role === "user");
    // mirrorOrigin keeps imported native prompts out of ownRecentUserTexts; without
    // it a repeated external prompt like "continue" is swallowed as self-echo.
    expect(userRow?.["__openclaw"]).toMatchObject({ mirrorOrigin: "claude-catalog-import" });
    const assistantRow = appended.find((message) => message.role === "assistant");
    expect(assistantRow).toBeDefined();
    expect(assistantRow?.["__openclaw"]).toBeUndefined();
  });
});
