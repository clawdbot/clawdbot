/**
 * Test: session_start & session_end hook wiring
 *
 * Tests the hook runner methods directly since session init is deeply integrated.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";
import type {
  PluginHookSessionContext,
  PluginHookSessionEndEvent,
  PluginHookSessionStartEvent,
} from "./types.js";

async function expectSessionHookCall(params: {
  hookName: "session_start" | "session_end";
  event: PluginHookSessionStartEvent | PluginHookSessionEndEvent;
  sessionCtx: PluginHookSessionContext & { sessionKey: string; agentId: string };
}) {
  const handler = vi.fn();
  const { runner } = createHookRunnerWithRegistry([{ hookName: params.hookName, handler }]);

  if (params.hookName === "session_start") {
    await runner.runSessionStart(params.event as PluginHookSessionStartEvent, params.sessionCtx);
  } else {
    await runner.runSessionEnd(params.event as PluginHookSessionEndEvent, params.sessionCtx);
  }

  expect(handler).toHaveBeenCalledWith(params.event, params.sessionCtx);
}

describe("session hook runner methods", () => {
  const sessionCtx = { sessionId: "abc-123", sessionKey: "agent:main:abc", agentId: "main" };

  it.each([
    {
      name: "runSessionStart invokes registered session_start hooks",
      hookName: "session_start" as const,
      event: { sessionId: "abc-123", sessionKey: "agent:main:abc", resumedFrom: "old-session" },
    },
    {
      name: "runSessionEnd invokes registered session_end hooks",
      hookName: "session_end" as const,
      event: {
        sessionId: "abc-123",
        sessionKey: "agent:main:abc",
        messageCount: 42,
        reason: "daily" as const,
        sessionFile: "/tmp/abc-123.jsonl.reset.2026-04-02T10-00-00.000Z",
        transcriptArchived: true,
        nextSessionId: "def-456",
      },
    },
  ] as const)("$name", async ({ hookName, event }) => {
    await expectSessionHookCall({ hookName, event, sessionCtx });
  });

  it("hasHooks returns true for registered session hooks", () => {
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "session_start", handler: vi.fn() },
    ]);

    expect(runner.hasHooks("session_start")).toBe(true);
    expect(runner.hasHooks("session_end")).toBe(false);
  });
});
