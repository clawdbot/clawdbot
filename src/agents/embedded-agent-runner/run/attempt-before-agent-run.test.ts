import { describe, expect, it, vi } from "vitest";
import type { GlobalHookRunnerRegistry } from "../../../plugins/hook-registry.types.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentRunEvent,
  PluginHookRegistration,
} from "../../../plugins/hook-types.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import type { AgentMessage } from "../../runtime/index.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { SessionManager } from "../../sessions/index.js";
import { runEmbeddedAttemptBeforeAgentRun } from "./attempt-before-agent-run.js";

function createRegistry(hooks: PluginHookRegistration[] = []): GlobalHookRunnerRegistry {
  return { hooks: [], typedHooks: hooks, plugins: [] };
}

const hookContext: PluginHookAgentContext = {
  runId: "run-1",
  agentId: "agent-1",
  sessionKey: "session-1",
  sessionId: "sid-1",
};

function createInput(hooks: PluginHookRegistration[] = []) {
  const sessionManager = guardSessionManager(SessionManager.inMemory());
  const state = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "original prompt" }],
        timestamp: 1,
      },
    ] as AgentMessage[],
  };
  const activeSession = {
    get messages() {
      return state.messages;
    },
    agent: { state },
  };
  const lock = { acquisitions: 0 };
  const withOwnedSessionWriteLock = async <T>(operation: () => Promise<T> | T): Promise<T> => {
    lock.acquisitions += 1;
    return await operation();
  };
  return {
    input: {
      attempt: {
        runId: "run-1",
        agentAccountId: "account-1",
        senderId: "sender-1",
        senderIsOwner: true,
      },
      activeSession,
      hookContext,
      hookMessages: state.messages,
      hookRunner: createHookRunner(createRegistry(hooks)),
      modelPrompt: "model prompt",
      sessionManager,
      systemPrompt: "system prompt",
      withOwnedSessionWriteLock,
    },
    lock,
    sessionManager,
    state,
  };
}

describe("runEmbeddedAttemptBeforeAgentRun", () => {
  it("does nothing when no gate is registered", async () => {
    const { input, lock, sessionManager } = createInput();

    await expect(runEmbeddedAttemptBeforeAgentRun(input)).resolves.toBeUndefined();

    expect(lock.acquisitions).toBe(0);
    expect(sessionManager.buildSessionContext().messages).toEqual([]);
  });

  it("passes cloned prompt context and leaves passing turns unchanged", async () => {
    const handler = vi.fn(async (event: PluginHookBeforeAgentRunEvent) => {
      const first = event.messages[0] as Extract<AgentMessage, { role: "user" }>;
      first.content = "mutated by hook";
      return { outcome: "pass" as const };
    });
    const { input, lock, state } = createInput([
      { pluginId: "policy", hookName: "before_agent_run", handler, source: "test" },
    ]);
    input.modelPrompt = "[media attached: /tmp/a.png (image/png)]\ninspect this";

    await expect(runEmbeddedAttemptBeforeAgentRun(input)).resolves.toBeUndefined();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "[media attached: /tmp/a.png (image/png)]\ninspect this",
        systemPrompt: "system prompt",
        channelId: undefined,
        accountId: "account-1",
        senderId: "sender-1",
        senderIsOwner: true,
      }),
      hookContext,
    );
    expect(state.messages[0]).toEqual(
      expect.objectContaining({ content: [{ type: "text", text: "original prompt" }] }),
    );
    expect(lock.acquisitions).toBe(0);
  });

  it("persists one redacted blocked turn across retries", async () => {
    const handler = vi.fn(async () => ({
      outcome: "block" as const,
      reason: "unsafe input",
      message: "Request blocked.",
    }));
    const { input, lock, sessionManager, state } = createInput([
      { pluginId: "policy", hookName: "before_agent_run", handler, source: "test" },
    ]);

    const first = await runEmbeddedAttemptBeforeAgentRun(input);
    const second = await runEmbeddedAttemptBeforeAgentRun(input);

    expect(first).toEqual({ blockedBy: "policy", promptError: expect.any(Error) });
    expect(first?.promptError.message).toBe(
      "Your message could not be sent: Request blocked. (blocked by policy)",
    );
    expect(second?.blockedBy).toBe("policy");
    expect(lock.acquisitions).toBe(1);
    expect(handler).toHaveBeenCalledTimes(2);
    const persistedMessages = sessionManager.buildSessionContext().messages;
    expect(persistedMessages).toHaveLength(1);
    expect(persistedMessages[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: [
          {
            type: "text",
            text: "Your message could not be sent: Request blocked. (blocked by policy)",
          },
        ],
        idempotencyKey: "hook-block:before_agent_run:user:run-1",
        __openclaw: {
          beforeAgentRunBlocked: {
            blockedBy: "policy",
            blockedAt: expect.any(Number),
          },
        },
      }),
    );
    expect(state.messages).toEqual(persistedMessages);
  });

  it("fails closed and persists a safe turn when the hook runner throws", async () => {
    const handler = vi.fn(async () => {
      throw new Error("policy unavailable");
    });
    const { input, lock, sessionManager } = createInput([
      { pluginId: "policy", hookName: "before_agent_run", handler, source: "test" },
    ]);

    const outcome = await runEmbeddedAttemptBeforeAgentRun(input);

    expect(outcome?.blockedBy).toBe("before_agent_run");
    expect(outcome?.promptError.message).toBe(
      "Your message could not be sent: blocked by before_agent_run",
    );
    expect(lock.acquisitions).toBe(1);
    expect(sessionManager.buildSessionContext().messages).toEqual([
      expect.objectContaining({
        role: "user",
        idempotencyKey: "hook-block:before_agent_run:user:run-1",
      }),
    ]);
  });
});
