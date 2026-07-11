// Control UI tests cover tool-title request eligibility and the title store.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  configureToolTitleFetcher,
  getToolCallTitle,
  resetToolTitlesForTest,
  resolveToolTitleRequest,
  setToolTitleForTest,
} from "./tool-titles.ts";

const LONG_GENERIC_ARGS = {
  title: "Investigate flaky gateway reconnect loop on the staging cluster",
  description: "The websocket reconnect loop spins when the auth token expires mid-session.",
};

describe("resolveToolTitleRequest", () => {
  afterEach(() => {
    resetToolTitlesForTest();
  });

  it("requests titles for commands of at least 12 characters", () => {
    const request = resolveToolTitleRequest("bash", { command: "git status --short" });

    expect(request).not.toBeNull();
    expect(request?.input).toBe("git status --short");
    expect(request?.key).toMatch(/^t/);
  });

  it.each([
    ["a short command", "bash", { command: "ls -la" }],
    ["a read call", "read", { path: "/repo/a-very-long-path/to/some/file.ts" }],
    ["an edit call", "edit", { path: "/repo/a.ts", oldText: "x".repeat(200), newText: "y" }],
    ["a write call", "write", { path: "/repo/a.ts", content: "x".repeat(200) }],
    ["a search call", "grep", { pattern: "x".repeat(200) }],
    ["a fetch call", "web_fetch", { url: `https://x.dev/${"a".repeat(200)}` }],
    ["a generic call with short args", "mcp__linear__create_issue", { title: "Fix bug" }],
  ])("does not request a title for %s", (_label, name, args) => {
    expect(resolveToolTitleRequest(name, args)).toBeNull();
  });

  it("requests titles for generic tools with at least 120 chars of serialized args", () => {
    const request = resolveToolTitleRequest("mcp__linear__create_issue", LONG_GENERIC_ARGS);

    expect(request).not.toBeNull();
    expect(request?.input).toBe(JSON.stringify(LONG_GENERIC_ARGS));
  });

  it("keys equal name and args to the same digest", () => {
    const first = resolveToolTitleRequest("bash", { command: "pnpm install --frozen" });
    const second = resolveToolTitleRequest("bash", { command: "pnpm install --frozen" });

    expect(first?.key).toBe(second?.key);
  });
});

describe("getToolCallTitle", () => {
  afterEach(() => {
    resetToolTitlesForTest();
  });

  it("returns a stored title for the resolved request key", () => {
    const args = { command: "git log --oneline -5" };
    const request = resolveToolTitleRequest("bash", args);
    if (!request) {
      throw new Error("expected an eligible title request");
    }
    setToolTitleForTest(request.key, "Checked recent commits");

    expect(getToolCallTitle("bash", args)).toBe("Checked recent commits");
  });

  it("returns undefined for eligible calls without a stored title", () => {
    expect(getToolCallTitle("bash", { command: "git log --oneline -5" })).toBeUndefined();
  });

  it("returns undefined for ineligible calls even when a title exists", () => {
    setToolTitleForTest("some-key", "Never shown");

    expect(getToolCallTitle("read", { path: "/repo/a.ts" })).toBeUndefined();
  });
});

describe("title fetch batching", () => {
  afterEach(() => {
    configureToolTitleFetcher({ client: null, sessionKey: null, onTitlesChanged: null });
    resetToolTitlesForTest();
    vi.useRealTimers();
  });

  it("notifies every pane that contributed rows to a title batch", async () => {
    vi.useFakeTimers();
    const client = {
      request: vi.fn(async (_method: string, params: unknown) => {
        const items = (params as { items: Array<{ id: string }> }).items;
        return { titles: Object.fromEntries(items.map((item) => [item.id, "Titled"])) };
      }),
    } as unknown as GatewayBrowserClient;
    const notifyA = vi.fn();
    const notifyB = vi.fn();

    // Two panes on the same session/agent enqueue into one batch.
    configureToolTitleFetcher({
      client,
      sessionKey: "agent:a:main",
      agentId: "a",
      onTitlesChanged: notifyA,
    });
    getToolCallTitle("bash", { command: "pnpm run build --filter ui" });
    configureToolTitleFetcher({
      client,
      sessionKey: "agent:a:main",
      agentId: "a",
      onTitlesChanged: notifyB,
    });
    getToolCallTitle("bash", { command: "pnpm test ui/src/pages/chat" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(notifyA).toHaveBeenCalled();
    expect(notifyB).toHaveBeenCalled();
  });

  it("stops requesting for the session once the gateway reports titles disabled", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ titles: {}, disabled: true }));
    const client = { request } as unknown as GatewayBrowserClient;

    configureToolTitleFetcher({
      client,
      sessionKey: "agent:a:main",
      agentId: "a",
      onTitlesChanged: null,
    });
    getToolCallTitle("bash", { command: "pnpm run build --filter ui" });
    await vi.advanceTimersByTimeAsync(1_000);
    // A different eligible call after the disabled response must not schedule.
    getToolCallTitle("bash", { command: "pnpm test ui/src/pages/chat" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("sends queued items with the session and agent captured at schedule time", async () => {
    vi.useFakeTimers();
    const requests: Array<{ sessionKey: string; agentId?: string }> = [];
    const client = {
      request: vi.fn(async (_method: string, params: unknown) => {
        requests.push(params as { sessionKey: string; agentId?: string });
        return { titles: {} };
      }),
    } as unknown as GatewayBrowserClient;

    // Pane A schedules, then pane B re-renders (and reconfigures) before the
    // debounce fires; the request must keep pane A's session and agent.
    configureToolTitleFetcher({
      client,
      sessionKey: "global",
      agentId: "alice",
      onTitlesChanged: null,
    });
    getToolCallTitle("bash", { command: "pnpm run build --filter ui" });
    configureToolTitleFetcher({
      client,
      sessionKey: "agent:b:main",
      agentId: "b",
      onTitlesChanged: null,
    });
    getToolCallTitle("bash", { command: "pnpm test ui/src/pages/chat" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(requests).toEqual([
      expect.objectContaining({ sessionKey: "global", agentId: "alice" }),
      expect.objectContaining({ sessionKey: "agent:b:main", agentId: "b" }),
    ]);
  });
});
