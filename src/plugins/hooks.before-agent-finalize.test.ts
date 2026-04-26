import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-helpers.js";

const EVENT = {
  runId: "run-1",
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  turnId: "turn-1",
  provider: "codex",
  model: "gpt-5.4",
  cwd: "/repo",
  transcriptPath: "/tmp/session.jsonl",
  stopHookActive: false,
  lastAssistantMessage: "done",
};

describe("before_agent_finalize hook runner", () => {
  it("returns undefined when no hooks are registered", async () => {
    const runner = createHookRunner(createMockPluginRegistry([]));

    await expect(
      runner.runBeforeAgentFinalize(EVENT, TEST_PLUGIN_AGENT_CTX),
    ).resolves.toBeUndefined();
  });

  it("returns a revise decision with the hook reason", async () => {
    const handler = vi.fn().mockResolvedValue({
      action: "revise",
      reason: "run the focused tests before finalizing",
    });
    const runner = createHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_finalize", handler }]),
    );

    await expect(runner.runBeforeAgentFinalize(EVENT, TEST_PLUGIN_AGENT_CTX)).resolves.toEqual({
      action: "revise",
      reason: "run the focused tests before finalizing",
    });
    expect(handler).toHaveBeenCalledWith(EVENT, TEST_PLUGIN_AGENT_CTX);
  });

  it("joins multiple revise reasons so the harness can request one follow-up pass", async () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_agent_finalize",
          handler: vi.fn().mockResolvedValue({ action: "revise", reason: "fix lint" }),
        },
        {
          hookName: "before_agent_finalize",
          handler: vi.fn().mockResolvedValue({ action: "revise", reason: "then rerun tests" }),
        },
      ]),
    );

    await expect(runner.runBeforeAgentFinalize(EVENT, TEST_PLUGIN_AGENT_CTX)).resolves.toEqual({
      action: "revise",
      reason: "fix lint\n\nthen rerun tests",
    });
  });

  it("lets finalize override earlier revise decisions", async () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_agent_finalize",
          handler: vi.fn().mockResolvedValue({ action: "revise", reason: "keep going" }),
        },
        {
          hookName: "before_agent_finalize",
          handler: vi.fn().mockResolvedValue({ action: "finalize", reason: "enough" }),
        },
      ]),
    );

    await expect(runner.runBeforeAgentFinalize(EVENT, TEST_PLUGIN_AGENT_CTX)).resolves.toEqual({
      action: "finalize",
      reason: "enough",
    });
  });

  it("hasHooks reports correctly", () => {
    const runner = createHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_finalize", handler: vi.fn() }]),
    );

    expect(runner.hasHooks("before_agent_finalize")).toBe(true);
    expect(runner.hasHooks("agent_end")).toBe(false);
  });
});
