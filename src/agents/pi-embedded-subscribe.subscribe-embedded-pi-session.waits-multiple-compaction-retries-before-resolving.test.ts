import { describe, expect, it, vi } from "vitest";
import { onAgentEvent } from "../infra/agent-events.js";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession", () => {
  it("waits for multiple compaction retries before resolving", async () => {
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-3",
    });

    emit({ type: "compaction_end", willRetry: true });
    emit({ type: "compaction_end", willRetry: true });

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
    emit({
      type: "compaction_end",
      willRetry: true,
      result: { summary: "s", tokensAfter: 12_345 },
    });
    expect(subscription.getCompactionCount()).toBe(1);
    expect(subscription.getLastCompactionTokensAfter()).toBe(12_345);

    // willRetry=false with result — counter incremented again
    emit({
      type: "compaction_end",
      willRetry: false,
      result: { summary: "s2", tokensAfter: 6_789 },
    });
    expect(subscription.getCompactionCount()).toBe(2);
    expect(subscription.getLastCompactionTokensAfter()).toBe(6_789);
  });

  it("does not count compaction when result is absent", () => {
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-compaction-no-result",
    });

    // No result (e.g. aborted or cancelled) — counter stays at 0
    emit({ type: "compaction_end", willRetry: false, result: undefined });
    expect(subscription.getCompactionCount()).toBe(0);

    emit({ type: "compaction_end", willRetry: false, aborted: true });
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
    emit({ type: "compaction_end", willRetry: true });
    emit({ type: "compaction_end", willRetry: false });

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
    const payload = onToolResult.mock.calls.at(0)?.[0];
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
    const payload = onToolResult.mock.calls.at(0)?.[0];
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
    const summary = onToolResult.mock.calls.at(0)?.[0];
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
    const output = onToolResult.mock.calls.at(1)?.[0];
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
    const readOutput = onToolResult.mock.calls.at(2)?.[0];
    expect(readOutput?.text).toContain("file data");
  });
});
