// Long fenced block and compaction retry tests cover Markdown-safe chunking and
// subscription state reset around automatic compaction retries.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  createParagraphChunkedBlockReplyHarness,
  emitAssistantTextDeltaAndEnd,
  expectFencedChunks,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";
import { makeZeroUsageSnapshot } from "./usage.js";

type SessionEventHandler = (evt: unknown) => void;

describe("subscribeEmbeddedAgentSession", () => {
  it("splits long single-line fenced blocks with reopen/close", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking: {
        minChars: 10,
        maxChars: 40,
      },
    });

    const text = `\`\`\`json\n${"x".repeat(120)}\n\`\`\``;
    emitAssistantTextDeltaAndEnd({ emit, text });
    await Promise.resolve();
    expectFencedChunks(onBlockReply.mock.calls, "```json");
  });
  it("waits for auto-compaction retry and clears buffered text", async () => {
    // A retrying compaction invalidates any assistant text buffered from the
    // failed attempt; waiters resolve only after the retry path reaches agent_end.
    const listeners: SessionEventHandler[] = [];
    const session = {
      subscribe: (listener: SessionEventHandler) => {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index !== -1) {
            listeners.splice(index, 1);
          }
        };
      },
    } as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"];

    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run-1",
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "oops" }],
    } as AssistantMessage;

    for (const listener of listeners) {
      listener({ type: "message_end", message: assistantMessage });
    }

    expect(subscription.assistantTexts.length).toBe(1);

    for (const listener of listeners) {
      listener({
        type: "compaction_end",
        willRetry: true,
      });
    }

    expect(subscription.isCompacting()).toBe(true);
    expect(subscription.assistantTexts.length).toBe(0);

    let resolved = false;
    const waitPromise = subscription.waitForCompactionRetry().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    for (const listener of listeners) {
      listener({ type: "agent_end" });
    }

    await waitPromise;
    expect(resolved).toBe(true);
  });

  it("clears the exact usage snapshot when compaction starts a new attempt", () => {
    const listeners: SessionEventHandler[] = [];
    const session = {
      subscribe: (listener: SessionEventHandler) => {
        listeners.push(listener);
        return () => {};
      },
    } as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"];
    const subscription = subscribeEmbeddedAgentSession({ session, runId: "run-usage-reset" });
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "before compaction" }],
      usage: {
        input: 100,
        output: 20,
        cacheRead: 300,
        cacheWrite: 0,
        totalTokens: 420,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } as AssistantMessage;

    for (const listener of listeners) {
      listener({ type: "message_end", message: assistantMessage });
    }
    expect(subscription.getLastAssistantUsage()).toMatchObject({
      input: 100,
      output: 20,
      cacheRead: 300,
      total: 420,
    });

    for (const listener of listeners) {
      listener({ type: "compaction_end", willRetry: true });
    }
    expect(subscription.getLastAssistantUsage()).toBeUndefined();
  });
  it("resolves after compaction ends without retry", async () => {
    const listeners: SessionEventHandler[] = [];
    const session = {
      subscribe: (listener: SessionEventHandler) => {
        listeners.push(listener);
        return () => {};
      },
    } as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"];

    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run-2",
    });

    for (const listener of listeners) {
      listener({ type: "compaction_start" });
    }

    expect(subscription.isCompacting()).toBe(true);

    let resolved = false;
    const waitPromise = subscription.waitForCompactionRetry().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    for (const listener of listeners) {
      listener({ type: "compaction_end", willRetry: false });
    }

    await waitPromise;
    expect(resolved).toBe(true);
    expect(subscription.isCompacting()).toBe(false);
  });

  it("resets assistant usage to a zero snapshot after compaction without retry", () => {
    // When compaction ends the active assistant message is synthetic, so usage
    // should reset to a zero snapshot instead of carrying stale token totals.
    const listeners: SessionEventHandler[] = [];
    const session = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "old" }],
          usage: {
            input: 120,
            output: 30,
            cacheRead: 5,
            cacheWrite: 0,
            totalTokens: 155,
            cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
          },
        },
      ],
      subscribe: (listener: SessionEventHandler) => {
        listeners.push(listener);
        return () => {};
      },
    } as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"];

    subscribeEmbeddedAgentSession({
      session,
      runId: "run-3",
    });

    for (const listener of listeners) {
      listener({ type: "compaction_end", willRetry: false });
    }

    const usage = (session.messages?.[0] as { usage?: unknown } | undefined)?.usage;
    expect(usage).toEqual(makeZeroUsageSnapshot());
  });
});
