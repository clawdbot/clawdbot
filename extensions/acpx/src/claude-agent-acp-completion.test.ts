import { ClaudeAcpAgent } from "@agentclientprotocol/claude-agent-acp";
import { describe, expect, it, vi } from "vitest";

type IteratorResultResolver = (value: IteratorResult<unknown>) => void;

class ManualAsyncIterator implements AsyncIterator<unknown> {
  private readonly pending: IteratorResultResolver[] = [];
  private readonly queued: IteratorResult<unknown>[] = [];

  next(): Promise<IteratorResult<unknown>> {
    const next = this.queued.shift();
    if (next) {
      return Promise.resolve(next);
    }
    return new Promise((resolve) => {
      this.pending.push(resolve);
    });
  }

  push(value: unknown): void {
    this.resolve({ value, done: false });
  }

  end(): void {
    this.resolve({ value: undefined, done: true });
  }

  private resolve(value: IteratorResult<unknown>): void {
    const pending = this.pending.shift();
    if (pending) {
      pending(value);
      return;
    }
    this.queued.push(value);
  }
}

function makeResultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "finished",
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: [],
    ...overrides,
  };
}

function makeIdleMessage() {
  return {
    type: "system",
    subtype: "session_state_changed",
    state: "idle",
    session_id: "session-1",
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("patched claude-agent-acp completion", () => {
  it("does not resolve a prompt on idle before the result message", async () => {
    const query = new ManualAsyncIterator();
    const agent = new ClaudeAcpAgent({
      sessionUpdate: vi.fn(),
      extNotification: vi.fn(),
    } as unknown as ConstructorParameters<typeof ClaudeAcpAgent>[0]);
    agent.sessions["session-1"] = {
      cancelled: false,
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
      contextWindowSize: 200_000,
      cwd: "/tmp",
      emitRawSDKMessages: false,
      input: {
        push: vi.fn(),
        end: vi.fn(),
      },
      nextPendingOrder: 0,
      pendingMessages: new Map(),
      promptRunning: false,
      query,
      settingsManager: {
        dispose: vi.fn(),
      },
    } as unknown as (typeof agent.sessions)[string];

    let resolved = false;
    const promptPromise = agent
      .prompt({
        sessionId: "session-1",
        prompt: [{ type: "text", text: "do work" }],
      })
      .then((value) => {
        resolved = true;
        return value;
      });

    query.push(makeIdleMessage());
    await flushMicrotasks();
    expect(resolved).toBe(false);

    query.push(makeResultMessage());
    await flushMicrotasks();
    expect(resolved).toBe(false);

    query.push(makeIdleMessage());
    const result = await promptPromise;
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage?.inputTokens).toBe(1);
    expect(result.usage?.outputTokens).toBe(1);
  });

  it("does not resolve a prompt after a task-notification result goes idle", async () => {
    const query = new ManualAsyncIterator();
    const agent = new ClaudeAcpAgent({
      sessionUpdate: vi.fn(),
      extNotification: vi.fn(),
    } as unknown as ConstructorParameters<typeof ClaudeAcpAgent>[0]);
    agent.sessions["session-1"] = {
      cancelled: false,
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
      contextWindowSize: 200_000,
      cwd: "/tmp",
      emitRawSDKMessages: false,
      input: {
        push: vi.fn(),
        end: vi.fn(),
      },
      nextPendingOrder: 0,
      pendingMessages: new Map(),
      promptRunning: false,
      query,
      settingsManager: {
        dispose: vi.fn(),
      },
    } as unknown as (typeof agent.sessions)[string];

    let resolved = false;
    const promptPromise = agent
      .prompt({
        sessionId: "session-1",
        prompt: [{ type: "text", text: "do foreground work" }],
      })
      .then((value) => {
        resolved = true;
        return value;
      });

    query.push(makeResultMessage({ origin: { kind: "task-notification" } }));
    await flushMicrotasks();
    expect(resolved).toBe(false);

    query.push(makeIdleMessage());
    await flushMicrotasks();
    expect(resolved).toBe(false);

    query.push(makeResultMessage());
    await flushMicrotasks();
    expect(resolved).toBe(false);

    query.push(makeIdleMessage());
    const result = await promptPromise;
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage?.inputTokens).toBe(2);
    expect(result.usage?.outputTokens).toBe(2);
  });
});
