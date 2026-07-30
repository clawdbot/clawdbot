import type { CompactEmbeddedAgentSessionParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import type { ClaudeAppServerClient, NotificationHandler } from "./client.js";
import { ClaudeAppServerRpcError } from "./client.js";
import { maybeCompactClaudeAppServerSession } from "./compact.js";
import type { ClaudeAppServerBindingStore } from "./thread-store.js";
import { createClaudeTestBindingStore } from "./thread-store.test-helpers.js";

/**
 * Unit coverage for the harness-owned compaction hook: binding resolution,
 * the request/notification round-trip against a scripted fake client, the
 * old-bridge (-32601) downgrade path, and timeout/exit guards. The bridge
 * side of the exchange is pinned by the bridge repo's own
 * tests/thread-compact.test.ts; end-to-end behavior is covered by the live
 * proof script (see PR notes).
 */

const THREAD_ID = "11111111-2222-3333-4444-555555555555";
const IDENTITY = { sessionKey: "agent:main:direct:tester", sessionId: "session-1" };

async function makeBoundStore(): Promise<ClaudeAppServerBindingStore> {
  const store = createClaudeTestBindingStore();
  await store.write(IDENTITY, { threadId: THREAD_ID, cwd: "/tmp" });
  return store;
}

function makeParams(): CompactEmbeddedAgentSessionParams {
  return {
    sessionId: IDENTITY.sessionId,
    sessionKey: IDENTITY.sessionKey,
    workspaceDir: "/tmp",
    currentTokenCount: 995_000,
  } as CompactEmbeddedAgentSessionParams;
}

type FakeClientScript = {
  /** Respond to thread/compact/start. Throw to simulate an RPC error. */
  onCompactStart?: (params: unknown) => unknown;
  /** Notifications to emit (async, after the request resolves). */
  emit?: Array<{ method: string; params: unknown }>;
  /** Simulate the bridge process dying after the request. */
  exitAfterRequest?: Error;
};

function makeFakeClient(script: FakeClientScript): ClaudeAppServerClient {
  const notificationHandlers: NotificationHandler[] = [];
  const exitHandlers: Array<(error: Error) => void> = [];
  const fake = {
    onNotification(handler: NotificationHandler) {
      notificationHandlers.push(handler);
      return () => {
        const idx = notificationHandlers.indexOf(handler);
        if (idx >= 0) {
          notificationHandlers.splice(idx, 1);
        }
      };
    },
    onExit(listener: (error: Error) => void) {
      exitHandlers.push(listener);
      return () => {
        const idx = exitHandlers.indexOf(listener);
        if (idx >= 0) {
          exitHandlers.splice(idx, 1);
        }
      };
    },
    async request(method: string, params?: unknown) {
      if (method !== "thread/compact/start") {
        throw new Error(`unexpected method ${method}`);
      }
      const response = script.onCompactStart
        ? script.onCompactStart(params)
        : { turn: { id: "turn-1", status: "inProgress", items: [] } };
      queueMicrotask(() => {
        for (const notification of script.emit ?? []) {
          for (const handler of notificationHandlers.slice()) {
            handler({ method: notification.method, params: notification.params as never });
          }
        }
        if (script.exitAfterRequest) {
          for (const listener of exitHandlers.slice()) {
            listener(script.exitAfterRequest);
          }
        }
      });
      return response;
    },
  };
  return fake as unknown as ClaudeAppServerClient;
}

describe("maybeCompactClaudeAppServerSession", () => {
  it("fails with missing_thread_binding when the session has no bound thread", async () => {
    const result = await maybeCompactClaudeAppServerSession(makeParams(), {
      bindingStore: createClaudeTestBindingStore(),
      clientFactory: () => makeFakeClient({}),
    });

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.failure?.reason).toBe("missing_thread_binding");
  });

  it("maps a successful compaction onto the compact result", async () => {
    const bindingStore = await makeBoundStore();
    const client = makeFakeClient({
      emit: [
        {
          method: "thread/compact/completed",
          params: {
            threadId: THREAD_ID,
            turnId: "turn-1",
            compacted: true,
            trigger: "manual",
            preTokens: 950_000,
            postTokens: 41_000,
            durationMs: 5100,
          },
        },
      ],
    });

    const result = await maybeCompactClaudeAppServerSession(makeParams(), {
      bindingStore,
      clientFactory: () => client,
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.tokensBefore).toBe(950_000);
    expect(result.result?.tokensAfter).toBe(41_000);
    const details = result.result?.details as Record<string, unknown>;
    expect(details.backend).toBe("claude-bridge");
    expect(details.threadId).toBe(THREAD_ID);
    expect(details.trigger).toBe("manual");
  });

  it("falls back to the caller's token count when the SDK omits boundary accounting", async () => {
    const bindingStore = await makeBoundStore();
    const client = makeFakeClient({
      emit: [
        {
          method: "thread/compact/completed",
          params: { threadId: THREAD_ID, turnId: "turn-1", compacted: true },
        },
      ],
    });

    const result = await maybeCompactClaudeAppServerSession(makeParams(), {
      bindingStore,
      clientFactory: () => client,
    });

    expect(result.ok).toBe(true);
    expect(result.result?.tokensBefore).toBe(995_000);
    expect(result.result?.tokensAfter).toBeUndefined();
  });

  it("ignores completions for other threads", async () => {
    const bindingStore = await makeBoundStore();
    const client = makeFakeClient({
      emit: [
        {
          method: "thread/compact/completed",
          params: { threadId: "some-other-thread", compacted: true },
        },
        {
          method: "thread/compact/completed",
          params: {
            threadId: THREAD_ID,
            compacted: false,
            error: { message: "summarization request failed" },
          },
        },
      ],
    });

    const result = await maybeCompactClaudeAppServerSession(makeParams(), {
      bindingStore,
      clientFactory: () => client,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("summarization request failed");
  });

  it("maps -32601 to an actionable old-bridge failure without raising the version floor", async () => {
    const bindingStore = await makeBoundStore();
    const client = makeFakeClient({
      onCompactStart: () => {
        throw new ClaudeAppServerRpcError(
          "Method not found: thread/compact/start",
          -32601,
          undefined,
          "thread/compact/start",
        );
      },
    });

    const result = await maybeCompactClaudeAppServerSession(makeParams(), {
      bindingStore,
      clientFactory: () => client,
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe("unsupported_bridge_compaction");
    expect(result.reason).toMatch(/>= 0\.7\.0/);
  });

  it("fails cleanly when the bridge exits mid-compaction", async () => {
    const bindingStore = await makeBoundStore();
    const client = makeFakeClient({
      exitAfterRequest: new Error("claude-bridge stopped"),
    });

    const result = await maybeCompactClaudeAppServerSession(makeParams(), {
      bindingStore,
      clientFactory: () => client,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exited during compaction/);
  });

  it("times out when no completion notification ever arrives", async () => {
    const bindingStore = await makeBoundStore();
    const client = makeFakeClient({});

    const result = await maybeCompactClaudeAppServerSession(makeParams(), {
      bindingStore,
      clientFactory: () => client,
      completionTimeoutMs: 50,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/did not complete within 50ms/);
  });
});
