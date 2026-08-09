/** Shared test fixtures for reply queue and typing-controller tests. */
import { vi } from "vitest";
import type { FollowupRun } from "./queue.js";
import type { TypingController } from "./typing.js";

/** Creates a typed mock typing controller with optional method overrides. */
export function createMockTypingController(
  overrides: Partial<TypingController> = {},
): TypingController {
  return {
    onReplyStart: vi.fn(async () => {}),
    startTypingLoop: vi.fn(async () => {}),
    startTypingOnText: vi.fn(async () => {}),
    refreshTypingTtl: vi.fn(),
    isActive: vi.fn(() => false),
    markRunComplete: vi.fn(),
    markDispatchIdle: vi.fn(),
    cleanup: vi.fn(),
    ...overrides,
  };
}

/** Creates a minimal queued follow-up run fixture. */
export function createMockFollowupRun(
  overrides: Partial<Omit<FollowupRun, "run">> & { run?: Partial<FollowupRun["run"]> } = {},
): FollowupRun {
  const skipProviderRuntimeHints = process.env.OPENCLAW_TEST_FAST === "1";
  const base: FollowupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    originatingTo: "channel:C1",
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      agentAccountId: "primary",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {
        prompt: "",
        skills: [],
      },
      provider: "anthropic",
      model: "claude",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      skipProviderRuntimeHints,
    },
  };
  return {
    ...base,
    ...overrides,
    run: {
      ...base.run,
      ...overrides.run,
    },
  };
}
