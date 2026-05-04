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

  it("skips empty retry instructions when merging revise decisions", async () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_agent_finalize",
          handler: vi.fn().mockResolvedValue({
            action: "revise",
            reason: "needs a retry but forgot the instruction",
            retry: { instruction: "   ", idempotencyKey: "empty-retry" },
          }),
        },
        {
          hookName: "before_agent_finalize",
          handler: vi.fn().mockResolvedValue({
            action: "revise",
            reason: "rerun the focused tests",
            retry: {
              instruction: " rerun the focused tests ",
              idempotencyKey: "valid-retry",
              maxAttempts: 1,
            },
          }),
        },
      ]),
    );

    await expect(runner.runBeforeAgentFinalize(EVENT, TEST_PLUGIN_AGENT_CTX)).resolves.toEqual({
      action: "revise",
      reason: "needs a retry but forgot the instruction\n\nrerun the focused tests",
      retry: {
        instruction: "rerun the focused tests",
        idempotencyKey: "valid-retry",
        maxAttempts: 1,
      },
    });
  });

  it("skips malformed retry instructions when merging revise decisions", async () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_agent_finalize",
          handler: vi.fn().mockResolvedValue({
            action: "revise",
            reason: "malformed retry payload should not crash",
            retry: { instruction: 123, idempotencyKey: "bad-retry" } as never,
          }),
        },
        {
          hookName: "before_agent_finalize",
          handler: vi.fn().mockResolvedValue({
            action: "revise",
            reason: "valid retry still applies",
            retry: {
              instruction: " rerun the focused tests ",
              idempotencyKey: "valid-retry",
            },
          }),
        },
      ]),
    );

    await expect(runner.runBeforeAgentFinalize(EVENT, TEST_PLUGIN_AGENT_CTX)).resolves.toEqual({
      action: "revise",
      reason: "malformed retry payload should not crash\n\nvalid retry still applies",
      retry: {
        instruction: "rerun the focused tests",
        idempotencyKey: "valid-retry",
      },
    });
  });

  it("preserves multiple valid retry candidates for budget evaluation", async () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_agent_finalize",
          handler: vi.fn().mockResolvedValue({
            action: "revise",
            reason: "retry generated artifacts",
            retry: {
              instruction: "regenerate artifacts",
              idempotencyKey: "artifacts",
              maxAttempts: 1,
            },
          }),
        },
        {
          hookName: "before_agent_finalize",
          handler: vi.fn().mockResolvedValue({
            action: "revise",
            reason: "retry focused tests",
            retry: {
              instruction: "rerun focused tests",
              idempotencyKey: "tests",
              maxAttempts: 1,
            },
          }),
        },
      ]),
    );

    const result = await runner.runBeforeAgentFinalize(EVENT, TEST_PLUGIN_AGENT_CTX);

    expect(result).toEqual({
      action: "revise",
      reason: "retry generated artifacts\n\nretry focused tests",
      retry: {
        instruction: "regenerate artifacts",
        idempotencyKey: "artifacts",
        maxAttempts: 1,
      },
    });
    expect(Object.getOwnPropertyDescriptor(result, "retryCandidates")?.enumerable).toBe(false);
    expect(
      (Object.getOwnPropertyDescriptor(result, "retryCandidates")?.value as unknown[])?.map(
        (retry) => (retry as { idempotencyKey?: string }).idempotencyKey,
      ),
    ).toEqual(["artifacts", "tests"]);
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
