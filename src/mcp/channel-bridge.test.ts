import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OpenClawChannelBridge } from "./channel-bridge.js";

const ONE_MINUTE_MS = 60 * 1_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const SWEEP_INTERVAL_MS = 5 * ONE_MINUTE_MS;
const APPROVAL_DEFAULT_TTL_MS = 30 * ONE_MINUTE_MS;

// Test view that exposes the private map/timer fields and the methods we
// exercise. Defined as a standalone shape (not an intersection with the class)
// because mixing public/private constituents collapses to `never` under tsgo.
type BridgeInternals = {
  pendingClaudePermissions: Map<string, unknown>;
  pendingApprovals: Map<string, unknown>;
  pendingSweepInterval: NodeJS.Timeout | null;
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
  listPendingApprovals: () => unknown[];
  close: () => Promise<void>;
};

function makeBridge(): BridgeInternals {
  return new OpenClawChannelBridge({} as never, {
    claudeChannelMode: "off",
    verbose: false,
  }) as unknown as BridgeInternals;
}

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
});
