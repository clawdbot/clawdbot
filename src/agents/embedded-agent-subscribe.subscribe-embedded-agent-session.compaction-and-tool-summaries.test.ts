// Compaction retry state, fenced retry output, and tool summaries.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { onAgentEvent } from "../infra/agent-events.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";
import { makeZeroUsageSnapshot } from "./usage.js";

type SessionEventHandler = (evt: unknown) => void;

function completedCompactionEnd(willRetry = true, tokensBefore = 100, tokensAfter = 50) {
  return {
    type: "compaction_end",
    reason: willRetry ? "overflow" : "threshold",
    outcome: {
      status: "completed",
      tokensBefore,
      tokensAfter,
      willRetry,
    },
  } as const;
}

const skippedCompactionEnd = () =>
  ({
    type: "compaction_end",
    reason: "threshold",
    outcome: { status: "skipped", reason: "Nothing to compact (session too small)" },
  }) as const;

describe("fenced output and compaction retries", () => {
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
      listener(completedCompactionEnd());
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
      listener(completedCompactionEnd());
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
      listener(skippedCompactionEnd());
    }

    await waitPromise;
    expect(resolved).toBe(true);
    expect(subscription.isCompacting()).toBe(false);
  });

  it("resets assistant usage to a zero snapshot after a completed compaction without retry", () => {
    // A completed compaction rewrites history, so the surviving assistant usage
    // refers to the old context and must reset to a zero snapshot. Only a
    // completed end does this; a failed/aborted end keeps live usage intact.
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
      listener(completedCompactionEnd(false));
    }

    const usage = (session.messages?.[0] as { usage?: unknown } | undefined)?.usage;
    expect(usage).toEqual(makeZeroUsageSnapshot());
  });
});

describe("canvas presenter summaries", () => {
  it("includes the hosted document target in present summaries", async () => {
    const onToolResult = vi.fn();

    const toolHarness = createSubscribedSessionHarness({
      runId: "run-canvas-tool",
      verboseLevel: "on",
      onToolResult,
    });

    toolHarness.emit({
      type: "tool_execution_start",
      toolName: "canvas",
      toolCallId: "tool-canvas-1",
      args: {
        action: "present",
        target: "/__openclaw__/canvas/documents/widget/index.html",
      },
    });

    // Wait for async handler to complete
    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(1);
    const payload = onToolResult.mock.calls.at(0)?.[0];
    expect(payload.text).toContain("🖼️");
    expect(payload.text).toContain("Canvas");
    expect(payload.text).toContain("/__openclaw__/canvas/documents/widget/index.html");
  });
  it("skips tool summaries when shouldEmitToolResult is false", () => {
    const onToolResult = vi.fn();

    const toolHarness = createSubscribedSessionHarness({
      runId: "run-tool-off",
      shouldEmitToolResult: () => false,
      onToolResult,
    });

    toolHarness.emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-2",
      args: { path: "/tmp/b.txt" },
    });

    expect(onToolResult).not.toHaveBeenCalled();
  });
  it("emits tool summaries when shouldEmitToolResult overrides verbose", async () => {
    const onToolResult = vi.fn();

    const toolHarness = createSubscribedSessionHarness({
      runId: "run-tool-override",
      verboseLevel: "off",
      shouldEmitToolResult: () => true,
      onToolResult,
    });

    toolHarness.emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-3",
      args: { path: "/tmp/c.txt" },
    });

    // Wait for async handler to complete
    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(1);
  });
});

function toolResultPayloadAt(
  onToolResult: ReturnType<typeof vi.fn>,
  index: number,
): {
  text?: string;
} {
  // Tool summary assertions only need text payloads from onToolResult calls.
  const [payload] = onToolResult.mock.calls[index] ?? [];
  if (!payload || typeof payload !== "object") {
    throw new Error(`expected tool result payload for call ${index + 1}`);
  }
  return payload as { text?: string };
}

describe("subscribeEmbeddedAgentSession", () => {
  it("forwards max-attempt failure text to the observable compaction event", () => {
    const onCompactionEvent = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run-compaction-failure",
      onAgentEvent: onCompactionEvent,
    });
    const failure =
      "Context overflow recovery failed after 3 compact-and-retry attempts. Try reducing context or switching to a larger-context model.";

    emit({
      type: "compaction_end",
      reason: "overflow",
      outcome: { status: "failed", reason: failure },
    });

    expect(onCompactionEvent).toHaveBeenCalledWith({
      stream: "compaction",
      data: expect.objectContaining({ phase: "end", completed: false, reason: failure }),
    });
  });

  it("waits for multiple compaction retries before resolving", async () => {
    // Each retrying compaction requires a matching agent_end before waiters are
    // released, preventing early continuation during repeated overflow repairs.
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-3",
    });

    emit(completedCompactionEnd());
    emit(completedCompactionEnd());

    let resolved = false;
    const waitPromise = subscription.waitForCompactionRetry().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    emit({ type: "agent_end" });

    await Promise.resolve();
    expect(resolved).toBe(false);

    emit({ type: "agent_end" });

    await waitPromise;
    expect(resolved).toBe(true);
  });

  it("does not count compaction until end event", () => {
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-compaction-count",
    });

    emit({ type: "compaction_start" });
    expect(subscription.getCompactionCount()).toBe(0);

    // willRetry with result — counter IS incremented (overflow compaction succeeded)
    emit(completedCompactionEnd(true, 20_000, 12_345));
    expect(subscription.getCompactionCount()).toBe(1);
    expect(subscription.getLastCompactionTokensAfter()).toBe(12_345);

    // willRetry=false with result — counter incremented again
    emit(completedCompactionEnd(false, 12_345, 6_789));
    expect(subscription.getCompactionCount()).toBe(2);
    expect(subscription.getLastCompactionTokensAfter()).toBe(6_789);
  });

  it("clears the completed assistant when compaction schedules a retry", () => {
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-compaction-assistant",
    });
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "Reply before compaction" }],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistant });
    expect(subscription.getCurrentAttemptAssistant()).toEqual(assistant);
    expect(subscription.assistantTexts).toEqual(["Reply before compaction"]);

    emit(completedCompactionEnd());
    expect(subscription.getCurrentAttemptAssistant()).toBeUndefined();
    expect(subscription.assistantTexts).toEqual([]);
  });

  it("does not count compaction when result is absent", () => {
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-compaction-no-result",
    });

    // No result (e.g. aborted or cancelled) — counter stays at 0
    emit(skippedCompactionEnd());
    expect(subscription.getCompactionCount()).toBe(0);

    emit({
      type: "compaction_end",
      reason: "threshold",
      outcome: { status: "aborted" },
    });
    expect(subscription.getCompactionCount()).toBe(0);
  });

  it("emits compaction events on the agent event bus", () => {
    const { emit } = createSubscribedSessionHarness({
      runId: "run-compaction",
    });
    const events: Array<{ phase: string; willRetry?: boolean }> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId !== "run-compaction") {
        return;
      }
      if (evt.stream !== "compaction") {
        return;
      }
      const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
      events.push({
        phase,
        willRetry: typeof evt.data?.willRetry === "boolean" ? evt.data.willRetry : undefined,
      });
    });

    emit({ type: "compaction_start" });
    emit(completedCompactionEnd());
    emit(skippedCompactionEnd());

    stop();

    expect(events).toEqual([
      { phase: "start" },
      { phase: "end", willRetry: true },
      { phase: "end", willRetry: false },
    ]);
  });

  it("rejects compaction wait with AbortError when unsubscribed", async () => {
    const abortCompaction = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-abort-on-unsubscribe",
      sessionExtras: { isCompacting: true, abortCompaction },
    });

    emit({ type: "compaction_start" });

    const waitPromise = subscription.waitForCompactionRetry();
    subscription.unsubscribe();

    const firstAbort = await waitPromise.catch((error: unknown) => error);
    expect(firstAbort).toBeInstanceOf(Error);
    expect((firstAbort as Error).name).toBe("AbortError");
    const secondAbort = await subscription
      .waitForCompactionRetry()
      .catch((error: unknown) => error);
    expect(secondAbort).toBeInstanceOf(Error);
    expect((secondAbort as Error).name).toBe("AbortError");
    expect(abortCompaction).toHaveBeenCalledTimes(1);
  });

  it("emits tool summaries at tool start when verbose is on", async () => {
    const onToolResult = vi.fn();
    const toolHarness = createSubscribedSessionHarness({
      runId: "run-tool",
      verboseLevel: "on",
      onToolResult,
    });

    toolHarness.emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-1",
      args: { path: "/tmp/a.txt" },
    });

    // Wait for async handler to complete
    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(1);
    const payload = toolResultPayloadAt(onToolResult, 0);
    expect(payload?.text).toContain("/tmp/a.txt");

    toolHarness.emit({
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "tool-1",
      isError: false,
      result: "ok",
    });

    expect(onToolResult).toHaveBeenCalledTimes(1);
  });

  it.each(["exec", "server.exec"])(
    "hides command metadata for %s unless full verbose mode is enabled",
    async (toolName) => {
      const onToolResult = vi.fn();
      const toolHarness = createSubscribedSessionHarness({
        runId: "run-exec-on",
        verboseLevel: "on",
        onToolResult,
      });

      toolHarness.emit({
        type: "tool_execution_start",
        toolName,
        toolCallId: "tool-exec-on",
        args: { command: "echo private-sentinel" },
      });

      await Promise.resolve();

      const payload = toolResultPayloadAt(onToolResult, 0);
      expect(payload?.text).toContain(toolName === "exec" ? "Exec" : "Server.exec");
      expect(payload?.text).not.toContain("private-sentinel");
    },
  );

  it("includes browser action metadata in tool summaries", async () => {
    const onToolResult = vi.fn();

    const toolHarness = createSubscribedSessionHarness({
      runId: "run-browser-tool",
      verboseLevel: "on",
      onToolResult,
    });

    toolHarness.emit({
      type: "tool_execution_start",
      toolName: "browser",
      toolCallId: "tool-browser-1",
      args: { action: "snapshot", targetUrl: "https://example.com" },
    });

    // Wait for async handler to complete
    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(1);
    const payload = toolResultPayloadAt(onToolResult, 0);
    expect(payload?.text).toContain("🌐");
    expect(payload?.text).toContain("Browser");
    expect(payload?.text).toContain("https://example.com");
  });

  it("emits exec output in full verbose mode and includes PTY indicator", async () => {
    const onToolResult = vi.fn();

    const toolHarness = createSubscribedSessionHarness({
      runId: "run-exec-full",
      verboseLevel: "full",
      onToolResult,
    });

    toolHarness.emit({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-exec-1",
      args: { command: "claude", pty: true },
    });

    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(1);
    const summary = toolResultPayloadAt(onToolResult, 0);
    expect(summary?.text).toContain("pty");
    expect(summary?.text).toContain("claude");

    toolHarness.emit({
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: "tool-exec-1",
      isError: false,
      result: { content: [{ type: "text", text: "hello\nworld" }] },
    });

    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(2);
    const output = toolResultPayloadAt(onToolResult, 1);
    expect(output?.text).toContain("hello");
    expect(output?.text).toContain("```txt");

    toolHarness.emit({
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "tool-read-1",
      isError: false,
      result: { content: [{ type: "text", text: "file data" }] },
    });

    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(3);
    const readOutput = toolResultPayloadAt(onToolResult, 2);
    expect(readOutput?.text).toContain("file data");
  });
});
