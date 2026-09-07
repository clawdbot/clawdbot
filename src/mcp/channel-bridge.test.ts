// Channel MCP bridge tests cover request bridging between MCP and channel APIs.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OpenClawChannelBridge } from "./channel-bridge.js";
import type { QueueEvent, WaitFilter } from "./channel-shared.js";

const ONE_MINUTE_MS = 60 * 1_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const SWEEP_INTERVAL_MS = 5 * ONE_MINUTE_MS;
const APPROVAL_DEFAULT_TTL_MS = 30 * ONE_MINUTE_MS;

// Test view that exposes the private map/timer fields and the methods we
// exercise. Defined as a standalone shape (not an intersection with the class)
// because mixing public/private constituents collapses to `never` under tsgo.
type BridgeInternals = {
  queue: QueueEvent[];
  pendingClaudePermissions: Map<string, unknown>;
  pendingApprovals: Map<string, unknown>;
  pendingSweepInterval: NodeJS.Timeout | null;
  pollEvents: (
    filter: WaitFilter,
    limit?: number,
  ) => {
    events: QueueEvent[];
    nextCursor: number;
  };
  waitForEvent: (filter: WaitFilter, timeoutMs?: number) => Promise<QueueEvent | null>;
  handleClaudePermissionRequest: (params: {
    requestId: string;
    toolName: string;
    description: string;
    inputPreview: string;
  }) => Promise<void>;
  handleGatewayEvent: (event: {
    event: string;
    payload?: Record<string, unknown>;
  }) => Promise<void>;
  handleSessionMessageEvent: (payload: {
    sessionKey: string;
    senderIsOwner?: boolean;
    message: { role: string; content: unknown };
  }) => Promise<void>;
  listPendingApprovals: () => unknown[];
  close: () => Promise<void>;
  server: { server: { notification: (n: unknown) => Promise<void> } } | null;
  sendNotification: (notification: { method: string }) => Promise<void>;
};

function makeBridge(verbose = false): BridgeInternals {
  return new OpenClawChannelBridge({} as never, {
    claudeChannelMode: "off",
    verbose,
  }) as unknown as BridgeInternals;
}

describe("OpenClawChannelBridge — Claude permission authorization", () => {
  test.each([
    { name: "non-owner", senderIsOwner: false, role: "user" },
    { name: "missing owner metadata", senderIsOwner: undefined, role: "user" },
    { name: "assistant message", senderIsOwner: true, role: "assistant" },
  ])("does not resolve a pending permission from a $name reply", async (reply) => {
    const bridge = makeBridge();
    const notification = vi.fn(async () => undefined);
    bridge.server = { server: { notification } };
    try {
      await bridge.handleClaudePermissionRequest({
        requestId: "abcde",
        toolName: "Bash",
        description: "run npm test",
        inputPreview: "{}",
      });

      await bridge.handleSessionMessageEvent({
        sessionKey: "agent:main:telegram:group:-100123",
        senderIsOwner: reply.senderIsOwner,
        message: {
          role: reply.role,
          content: [{ type: "text", text: "yes abcde" }],
        },
      });

      expect(notification).not.toHaveBeenCalled();
      expect(bridge.pendingClaudePermissions.has("abcde")).toBe(true);
      expect(bridge.queue.at(-1)).toMatchObject({ type: "message", text: "yes abcde" });
    } finally {
      await bridge.close();
    }
  });

  test("resolves a pending permission from an owner user reply", async () => {
    const bridge = makeBridge();
    const notification = vi.fn(async () => undefined);
    bridge.server = { server: { notification } };
    try {
      await bridge.handleClaudePermissionRequest({
        requestId: "abcde",
        toolName: "Bash",
        description: "run npm test",
        inputPreview: "{}",
      });

      await bridge.handleSessionMessageEvent({
        sessionKey: "agent:main:telegram:group:-100123",
        senderIsOwner: true,
        message: {
          role: "user",
          content: [{ type: "text", text: "yes abcde" }],
        },
      });

      expect(notification).toHaveBeenCalledWith({
        method: "notifications/claude/channel/permission",
        params: { request_id: "abcde", behavior: "allow" },
      });
      expect(bridge.pendingClaudePermissions.has("abcde")).toBe(false);
    } finally {
      await bridge.close();
    }
  });
});

describe("OpenClawChannelBridge — pendingClaudePermissions / pendingApprovals memory bounds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  test("handleClaudePermissionRequest entries are evicted after TTL by the sweeper", async () => {
    const bridge = makeBridge();
    try {
      await bridge.handleClaudePermissionRequest({
        requestId: "abcde",
        toolName: "Bash",
        description: "run npm test",
        inputPreview: "{}",
      });
      expect(bridge.pendingClaudePermissions.size).toBe(1);
      expect(bridge.pendingSweepInterval).not.toBeNull();

      vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
      expect(bridge.pendingClaudePermissions.size).toBe(1);

      vi.advanceTimersByTime(ONE_HOUR_MS);
      expect(bridge.pendingClaudePermissions.size).toBe(0);
    } finally {
      await bridge.close();
    }
  });

  test("trackApproval entries are evicted at expiresAtMs by the sweeper", async () => {
    const bridge = makeBridge();
    try {
      await bridge.handleGatewayEvent({
        event: "exec.approval.requested",
        payload: {
          id: "approval-1",
          createdAtMs: 0,
          expiresAtMs: 10 * ONE_MINUTE_MS,
        },
      });
      expect(bridge.pendingApprovals.size).toBe(1);

      vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
      expect(bridge.pendingApprovals.size).toBe(1);

      vi.advanceTimersByTime(SWEEP_INTERVAL_MS + ONE_MINUTE_MS);
      expect(bridge.pendingApprovals.size).toBe(0);
    } finally {
      await bridge.close();
    }
  });

  test("trackApproval falls back to a default TTL when expiresAtMs is absent", async () => {
    const bridge = makeBridge();
    try {
      await bridge.handleGatewayEvent({
        event: "plugin.approval.requested",
        payload: { id: "approval-2", createdAtMs: 0 },
      });
      expect(bridge.pendingApprovals.size).toBe(1);

      vi.advanceTimersByTime(APPROVAL_DEFAULT_TTL_MS - ONE_MINUTE_MS);
      expect(bridge.pendingApprovals.size).toBe(1);

      vi.advanceTimersByTime(SWEEP_INTERVAL_MS + ONE_MINUTE_MS);
      expect(bridge.pendingApprovals.size).toBe(0);
    } finally {
      await bridge.close();
    }
  });

  test("trackApproval evicts entries even when both createdAtMs and expiresAtMs are absent", async () => {
    const bridge = makeBridge();
    try {
      await bridge.handleGatewayEvent({
        event: "exec.approval.requested",
        payload: { id: "approval-3" },
      });
      expect(bridge.pendingApprovals.size).toBe(1);

      vi.advanceTimersByTime(APPROVAL_DEFAULT_TTL_MS - ONE_MINUTE_MS);
      expect(bridge.pendingApprovals.size).toBe(1);

      vi.advanceTimersByTime(SWEEP_INTERVAL_MS + ONE_MINUTE_MS);
      expect(bridge.pendingApprovals.size).toBe(0);
    } finally {
      await bridge.close();
    }
  });

  test("listPendingApprovals filters expired entries before the next sweep tick", async () => {
    const bridge = makeBridge();
    try {
      await bridge.handleGatewayEvent({
        event: "exec.approval.requested",
        payload: {
          id: "approval-early-expiry",
          createdAtMs: 0,
          expiresAtMs: ONE_MINUTE_MS,
        },
      });
      expect(bridge.pendingApprovals.size).toBe(1);

      vi.advanceTimersByTime(2 * ONE_MINUTE_MS);

      expect(bridge.listPendingApprovals()).toHaveLength(0);
      expect(bridge.pendingApprovals.size).toBe(0);
      expect(bridge.pendingSweepInterval).toBeNull();
    } finally {
      await bridge.close();
    }
  });

  test("close() clears both pending maps, stops the sweeper interval, and leaves no scheduled timers", async () => {
    const bridge = makeBridge();
    await bridge.handleClaudePermissionRequest({
      requestId: "abcde",
      toolName: "Bash",
      description: "run npm test",
      inputPreview: "{}",
    });
    await bridge.handleGatewayEvent({
      event: "exec.approval.requested",
      payload: { id: "approval-1", createdAtMs: 0, expiresAtMs: ONE_HOUR_MS },
    });
    expect(bridge.pendingClaudePermissions.size).toBe(1);
    expect(bridge.pendingApprovals.size).toBe(1);
    expect(bridge.pendingSweepInterval).not.toBeNull();

    await bridge.close();

    expect(bridge.pendingClaudePermissions.size).toBe(0);
    expect(bridge.pendingApprovals.size).toBe(0);
    expect(bridge.pendingSweepInterval).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("handleClaudePermissionRequest is a no-op after close(), preventing post-close accumulation", async () => {
    const bridge = makeBridge();
    await bridge.close();

    await bridge.handleClaudePermissionRequest({
      requestId: "fghij",
      toolName: "Bash",
      description: "after close",
      inputPreview: "{}",
    });
    await bridge.handleGatewayEvent({
      event: "exec.approval.requested",
      payload: { id: "approval-after-close" },
    });

    expect(bridge.pendingClaudePermissions.size).toBe(0);
    expect(bridge.pendingApprovals.size).toBe(0);
    expect(bridge.pendingSweepInterval).toBeNull();
  });

  test("a failed notification still emits exactly one diagnostic record with verbose off", async () => {
    const bridge = makeBridge(false);
    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(String(chunk));
        return true;
      });
    bridge.server = {
      server: {
        notification: () => Promise.reject(new Error("transport closed")),
      },
    };
    try {
      await bridge.sendNotification({ method: "channel/event" });

      expect(writes).toHaveLength(1);
      expect(writes[0]).toBe("openclaw mcp: notification channel/event failed\n");
      expect(writes[0]).not.toContain("transport closed");
    } finally {
      writeSpy.mockRestore();
      await bridge.close();
    }
  });

  test("sweeper interval is not started before any pending entry is added", async () => {
    const bridge = makeBridge();
    try {
      expect(bridge.pendingSweepInterval).toBeNull();
      vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 4);
      expect(bridge.pendingSweepInterval).toBeNull();
    } finally {
      await bridge.close();
    }
  });

  test("sweeper self-terminates once both maps drain, restoring lazy-init", async () => {
    const bridge = makeBridge();
    try {
      await bridge.handleClaudePermissionRequest({
        requestId: "abcde",
        toolName: "Bash",
        description: "run npm test",
        inputPreview: "{}",
      });
      expect(bridge.pendingSweepInterval).not.toBeNull();

      vi.advanceTimersByTime(ONE_HOUR_MS + SWEEP_INTERVAL_MS);
      expect(bridge.pendingClaudePermissions.size).toBe(0);
      expect(bridge.pendingApprovals.size).toBe(0);
      expect(bridge.pendingSweepInterval).toBeNull();
      expect(vi.getTimerCount()).toBe(0);

      await bridge.handleClaudePermissionRequest({
        requestId: "fghij",
        toolName: "Bash",
        description: "second request after drain",
        inputPreview: "{}",
      });
      expect(bridge.pendingSweepInterval).not.toBeNull();
    } finally {
      await bridge.close();
    }
  });

  test("pollEvents clamps direct caller limits to the public MCP event window", async () => {
    const bridge = makeBridge();
    try {
      for (let cursor = 1; cursor <= 250; cursor += 1) {
        bridge.queue.push({
          cursor,
          type: "message",
          sessionKey: "agent:main:main",
          raw: { sessionKey: "agent:main:main" },
        });
      }

      const result = bridge.pollEvents({ afterCursor: 0 }, 10_000);

      expect(result.events).toHaveLength(200);
      expect(result.nextCursor).toBe(200);
    } finally {
      await bridge.close();
    }
  });

  test("waitForEvent clamps oversized direct caller timeouts before arming timers", async () => {
    const bridge = makeBridge();
    try {
      let resolved = false;
      const waited = bridge.waitForEvent({ afterCursor: 0 }, 3_000_000_000).then((event) => {
        resolved = true;
        return event;
      });
      await Promise.resolve();

      vi.advanceTimersByTime(299_999);
      await Promise.resolve();
      expect(resolved).toBe(false);

      vi.advanceTimersByTime(1);
      await expect(waited).resolves.toBeNull();
      expect(resolved).toBe(true);
    } finally {
      await bridge.close();
    }
  });
});
