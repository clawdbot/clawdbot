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
  it("falls back for invalid timestamps while preserving valid pre-epoch dates", async () => {
    appended.length = 0;
    const fallbackTimestamp = new Date("2026-07-18T12:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(fallbackTimestamp);
    try {
      await importClaudeHistory({
        items: [
          { type: "userMessage", text: "invalid", timestamp: "not-a-date", uuid: "u-1" },
          {
            type: "userMessage",
            text: "pre-epoch",
            timestamp: "1969-12-31T23:59:59.000Z",
            uuid: "u-2",
          },
        ],
        threadId: "thread-1",
        sessionFile: "/tmp/unused.jsonl",
        sessionId: "session-1",
        sessionKey: "agent:main:catalog-adopt",
        agentId: "main",
        config: {} as OpenClawConfig,
      });
    } finally {
      vi.useRealTimers();
    }

    expect(appended).toHaveLength(2);
    expect(appended.map((message) => message.timestamp)).toEqual([-1_000, fallbackTimestamp + 1]);
    expect(JSON.stringify(appended)).not.toContain('"timestamp":null');
  });

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

  it("omits empty native reasoning records instead of rendering a placeholder", async () => {
    appended.length = 0;
    await importClaudeHistory({
      items: [
        { type: "reasoning", content: [{ type: "thinking", thinking: "" }], uuid: "r-1" },
        { type: "assistantMessage", text: "AUTH_OK", uuid: "a-1" },
      ],
      threadId: "thread-1",
      sessionFile: "/tmp/unused.jsonl",
      sessionId: "session-1",
      sessionKey: "agent:main:catalog-adopt",
      agentId: "main",
      config: {} as OpenClawConfig,
    });

    expect(appended).toHaveLength(1);
    expect(JSON.stringify(appended)).toContain("AUTH_OK");
    expect(JSON.stringify(appended)).not.toContain("Unsupported Claude transcript item");
  });

  it("retains the placeholder for unsupported non-reasoning records", async () => {
    appended.length = 0;
    await importClaudeHistory({
      items: [{ type: "toolCall", content: [{ type: "tool_use" }], uuid: "t-1" }],
      threadId: "thread-1",
      sessionFile: "/tmp/unused.jsonl",
      sessionId: "session-1",
      sessionKey: "agent:main:catalog-adopt",
      agentId: "main",
      config: {} as OpenClawConfig,
    });

    expect(appended).toHaveLength(1);
    expect(JSON.stringify(appended)).toContain("Unsupported Claude transcript item");
  });
});
