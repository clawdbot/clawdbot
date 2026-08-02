import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunApprovalHost } from "../agents/agent-run-approval.js";
import {
  activateMcpLoopbackClientGrantCapture,
  deactivateMcpLoopbackClientGrantCapture,
  mintAttachGrant,
  mintMcpLoopbackClientGrant,
  resolveAttachGrant,
  resolveMcpLoopbackClientGrant,
  resolveMcpLoopbackClientGrantAuthorization,
  revokeAttachGrant,
  revokeAttachGrantsForSession,
  revokeMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrantsForRuntime,
} from "./mcp-grant-store.js";

const T0 = 1_000_000_000_000;

describe("mcp-grant-store", () => {
  beforeEach(() => {
    revokeMcpLoopbackClientGrantsForRuntime("runtime-one");
    revokeMcpLoopbackClientGrantsForRuntime("runtime-two");
  });

  it("mints a grant bound to the sessionKey with a token and a TTL window", () => {
    const g = mintAttachGrant({ sessionKey: "agent:main:main", ttlMs: 60_000, nowMs: T0 });
    expect(g.sessionKey).toBe("agent:main:main");
    expect(g.token).toMatch(/^[0-9a-f]{64}$/);
    expect(g.issuedAtMs).toBe(T0);
    expect(g.expiresAtMs).toBe(T0 + 60_000);
  });

  it("requires a non-empty sessionKey", () => {
    expect(() => mintAttachGrant({ sessionKey: "  ", nowMs: T0 })).toThrow();
  });

  it("resolves a live grant and drops it once expired (TTL)", () => {
    const g = mintAttachGrant({ sessionKey: "agent:main:x", ttlMs: 1_000, nowMs: T0 });
    expect(resolveAttachGrant(g.token, T0)?.sessionKey).toBe("agent:main:x");
    expect(resolveAttachGrant(g.token, T0 + 999)?.sessionKey).toBe("agent:main:x");
    expect(resolveAttachGrant(g.token, T0 + 1_000)).toBeUndefined();
    expect(resolveAttachGrant(g.token, T0 + 1_001)).toBeUndefined();
  });

  it("returns undefined for an unknown token (no scope without a grant)", () => {
    expect(resolveAttachGrant("deadbeef", T0)).toBeUndefined();
  });

  it("binds the sessionKey to the grant (token carries scope identity, not the caller)", () => {
    const a = mintAttachGrant({ sessionKey: "agent:main:telegram:1", nowMs: T0 });
    const b = mintAttachGrant({ sessionKey: "agent:main:telegram:2", nowMs: T0 });
    expect(resolveAttachGrant(a.token, T0)?.sessionKey).toBe("agent:main:telegram:1");
    expect(resolveAttachGrant(b.token, T0)?.sessionKey).toBe("agent:main:telegram:2");
    expect(a.token).not.toBe(b.token);
  });

  it("revokes by token", () => {
    const g = mintAttachGrant({ sessionKey: "agent:main:x", nowMs: T0 });
    expect(revokeAttachGrant(g.token)).toBe(true);
    expect(resolveAttachGrant(g.token, T0)).toBeUndefined();
    expect(revokeAttachGrant(g.token)).toBe(false);
  });

  it("revokes every attach grant for one session", () => {
    const first = mintAttachGrant({ sessionKey: "agent:main:first", nowMs: T0 });
    const second = mintAttachGrant({ sessionKey: "agent:main:first", nowMs: T0 });
    const other = mintAttachGrant({ sessionKey: "agent:main:other", nowMs: T0 });

    expect(revokeAttachGrantsForSession(" agent:main:first ")).toBe(2);
    expect(resolveAttachGrant(first.token, T0)).toBeUndefined();
    expect(resolveAttachGrant(second.token, T0)).toBeUndefined();
    expect(resolveAttachGrant(other.token, T0)?.sessionKey).toBe("agent:main:other");
  });

  it("clamps TTL: default for non-positive, ceiling at 12h", () => {
    const def = mintAttachGrant({ sessionKey: "s", nowMs: T0 });
    expect(def.expiresAtMs).toBe(T0 + 60 * 60 * 1000);
    const zero = mintAttachGrant({ sessionKey: "s", ttlMs: 0, nowMs: T0 });
    expect(zero.expiresAtMs).toBe(T0 + 60 * 60 * 1000);
    const huge = mintAttachGrant({ sessionKey: "s", ttlMs: 999 * 60 * 60 * 1000, nowMs: T0 });
    expect(huge.expiresAtMs).toBe(T0 + 12 * 60 * 60 * 1000);
  });

  it("binds an immutable Gateway-selected context to a loopback client grant", () => {
    const approvalHost: AgentRunApprovalHost = {
      plugin: {
        request: async () => ({ outcome: "unavailable", reason: "test" }),
      },
    };
    const context = {
      sessionKey: " agent:main:telegram:group:1 ",
      sessionId: "session-1",
      messageProvider: "telegram",
      clientCaps: ["tool-events"],
      currentChannelId: "telegram:-1001",
      currentThreadTs: "42",
      currentMessageId: "message-1",
      currentInboundAudio: true,
      accountId: "account-1",
      inboundEventKind: "room_event" as const,
      sourceReplyDeliveryMode: "message_tool_only" as const,
      sourceReplyOnly: true,
      toolsAllow: ["message"],
      taskSuggestionDeliveryMode: "gateway" as const,
      requireExplicitMessageTarget: true,
      senderIsOwner: false,
    };
    const captureSessionMcpRuntime = vi.fn();
    const grant = mintMcpLoopbackClientGrant({
      context,
      runtimeOwnerToken: "runtime-one",
      approvalHost,
      captureSessionMcpRuntime,
    });
    expect(grant).not.toHaveProperty("approvalHost");
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-one",
      }),
    ).toBe(true);

    context.clientCaps.push("caller-mutation");
    context.sourceReplyOnly = false;
    context.toolsAllow.push("exec");
    grant.context.clientCaps?.push("return-value-mutation");
    grant.context.sourceReplyOnly = false;
    grant.context.toolsAllow?.push("write");

    const resolved = resolveMcpLoopbackClientGrant({
      token: grant.token,
      runtimeOwnerToken: "runtime-one",
      captureKey: "capture-one",
    });
    expect(resolved?.context).toEqual({
      ...context,
      sessionKey: "agent:main:telegram:group:1",
      clientCaps: ["tool-events"],
      sourceReplyOnly: true,
      toolsAllow: ["message"],
    });
    expect(resolved?.approvalHost).toBe(approvalHost);
    expect(resolved?.captureSessionMcpRuntime).toBe(captureSessionMcpRuntime);
    resolved?.captureSessionMcpRuntime?.({ sessionId: "session-1" } as never);
    expect(captureSessionMcpRuntime).toHaveBeenCalledWith({ sessionId: "session-1" });
  });

  it("admits only the active capture on the grant's Gateway runtime", () => {
    const grant = mintMcpLoopbackClientGrant({
      context: { sessionKey: "agent:main:first", senderIsOwner: false },
      runtimeOwnerToken: "runtime-one",
    });
    const resolve = (runtimeOwnerToken: string, captureKey: string) =>
      resolveMcpLoopbackClientGrant({
        token: grant.token,
        runtimeOwnerToken,
        captureKey,
      });
    const authorization = (runtimeOwnerToken: string, captureKey: string) =>
      resolveMcpLoopbackClientGrantAuthorization({
        token: grant.token,
        runtimeOwnerToken,
        captureKey,
      });

    expect(resolve("runtime-one", "capture-a")).toBeUndefined();
    expect(authorization("runtime-one", "capture-a")).toBe("capture-ended");
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: "runtime-other",
        captureKey: "capture-a",
      }),
    ).toBe(false);
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-a",
      }),
    ).toBe(true);
    expect(authorization("runtime-one", "capture-a")).toBe("active");
    expect(resolve("runtime-other", "capture-a")).toBeUndefined();
    expect(authorization("runtime-other", "capture-a")).toBe("grant-revoked");
    expect(resolve("runtime-one", "capture-forged")).toBeUndefined();
    const firstCapture = resolve("runtime-one", "capture-a");
    expect(firstCapture?.captureKey).toBe("capture-a");
    expect(firstCapture?.signal.aborted).toBe(false);

    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-b",
      }),
    ).toBe(true);
    expect(firstCapture?.signal.aborted).toBe(true);
    expect(resolve("runtime-one", "capture-a")).toBeUndefined();
    expect(authorization("runtime-one", "capture-a")).toBe("capture-ended");
    expect(authorization("runtime-one", "capture-b")).toBe("active");
    expect(
      deactivateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-a",
      }),
    ).toBe(false);
    const secondCapture = resolve("runtime-one", "capture-b");
    expect(secondCapture?.captureKey).toBe("capture-b");
    expect(secondCapture?.signal.aborted).toBe(false);
    expect(
      deactivateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-b",
      }),
    ).toBe(true);
    expect(secondCapture?.signal.aborted).toBe(true);
    expect(resolve("runtime-one", "capture-b")).toBeUndefined();
    expect(authorization("runtime-one", "capture-b")).toBe("capture-ended");
  });

  it("revokes client grants by token or exact Gateway runtime", () => {
    const mintForRuntime = (runtimeOwnerToken: string, sessionKey: string) =>
      mintMcpLoopbackClientGrant({
        context: { sessionKey, senderIsOwner: false },
        runtimeOwnerToken,
      });
    const first = mintForRuntime("runtime-one", "agent:main:first");
    const second = mintForRuntime("runtime-one", "agent:main:second");
    const successor = mintForRuntime("runtime-two", "agent:main:successor");
    for (const grant of [first, second, successor]) {
      expect(
        activateMcpLoopbackClientGrantCapture({
          token: grant.token,
          runtimeOwnerToken: grant === successor ? "runtime-two" : "runtime-one",
          captureKey: `capture-${grant.context.sessionKey}`,
        }),
      ).toBe(true);
    }
    const firstSignal = resolveMcpLoopbackClientGrant({
      token: first.token,
      runtimeOwnerToken: "runtime-one",
      captureKey: `capture-${first.context.sessionKey}`,
    })?.signal;
    const successorSignal = resolveMcpLoopbackClientGrant({
      token: successor.token,
      runtimeOwnerToken: "runtime-two",
      captureKey: `capture-${successor.context.sessionKey}`,
    })?.signal;

    expect(revokeMcpLoopbackClientGrantsForRuntime("runtime-one")).toBe(2);
    expect(firstSignal?.aborted).toBe(true);
    expect(successorSignal?.aborted).toBe(false);
    expect(revokeMcpLoopbackClientGrant(first.token)).toBe(false);
    expect(revokeMcpLoopbackClientGrant(successor.token)).toBe(true);
    expect(successorSignal?.aborted).toBe(true);
    expect(revokeMcpLoopbackClientGrant(successor.token)).toBe(false);
  });

  it("requires a session key for loopback client grants", () => {
    expect(() =>
      mintMcpLoopbackClientGrant({
        context: { sessionKey: "  ", senderIsOwner: false },
        runtimeOwnerToken: "runtime-one",
      }),
    ).toThrow(/sessionKey is required/);
    expect(() =>
      mintMcpLoopbackClientGrant({
        context: { sessionKey: "agent:main:main", senderIsOwner: false },
        runtimeOwnerToken: "  ",
      }),
    ).toThrow(/runtimeOwnerToken is required/);
  });
});
