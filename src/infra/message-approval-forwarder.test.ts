import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import { createMessageApprovalForwarder } from "./message-approval-forwarder.js";

const baseRequest = {
  id: "msg-req-1",
  request: {
    action: "send",
    channel: "telegram",
    to: "+1234567890",
    message: "Hello world",
    agentId: "main",
    sessionKey: "agent:main:main",
  },
  createdAtMs: 1000,
  expiresAtMs: 6000,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("message approval forwarder", () => {
  it("forwards to session target and resolves", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const cfg = {
      approvals: { message: { enabled: true, mode: "session" } },
    } as ClawdbotConfig;

    const forwarder = createMessageApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      nowMs: () => 1000,
      resolveSessionTarget: () => ({ channel: "slack", to: "U1" }),
    });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).toHaveBeenCalledTimes(1);

    await forwarder.handleResolved({
      id: baseRequest.id,
      decision: "allow",
      resolvedBy: "slack:U1",
      ts: 2000,
    });
    expect(deliver).toHaveBeenCalledTimes(2);

    await vi.runAllTimersAsync();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("forwards to explicit targets and expires", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const cfg = {
      approvals: {
        message: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "123" }],
        },
      },
    } as ClawdbotConfig;

    const forwarder = createMessageApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
    });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("filters by action", async () => {
    const deliver = vi.fn().mockResolvedValue([]);
    const cfg = {
      approvals: {
        message: {
          enabled: true,
          mode: "session",
          actions: ["broadcast"], // only broadcast, not send
        },
      },
    } as ClawdbotConfig;

    const forwarder = createMessageApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      nowMs: () => 1000,
      resolveSessionTarget: () => ({ channel: "slack", to: "U1" }),
    });

    await forwarder.handleRequested(baseRequest); // action is "send"
    expect(deliver).not.toHaveBeenCalled();
  });

  it("filters by channel", async () => {
    const deliver = vi.fn().mockResolvedValue([]);
    const cfg = {
      approvals: {
        message: {
          enabled: true,
          mode: "session",
          channels: ["slack"], // only slack, not telegram
        },
      },
    } as ClawdbotConfig;

    const forwarder = createMessageApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      nowMs: () => 1000,
      resolveSessionTarget: () => ({ channel: "slack", to: "U1" }),
    });

    await forwarder.handleRequested(baseRequest); // channel is "telegram"
    expect(deliver).not.toHaveBeenCalled();
  });

  it("filters by agentId", async () => {
    const deliver = vi.fn().mockResolvedValue([]);
    const cfg = {
      approvals: {
        message: {
          enabled: true,
          mode: "session",
          agentFilter: ["other-agent"], // not main
        },
      },
    } as ClawdbotConfig;

    const forwarder = createMessageApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      nowMs: () => 1000,
      resolveSessionTarget: () => ({ channel: "slack", to: "U1" }),
    });

    await forwarder.handleRequested(baseRequest); // agentId is "main"
    expect(deliver).not.toHaveBeenCalled();
  });

  it("includes message content in forwarded notification", async () => {
    const deliver = vi.fn().mockResolvedValue([]);
    const cfg = {
      approvals: { message: { enabled: true, mode: "session" } },
    } as ClawdbotConfig;

    const forwarder = createMessageApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      nowMs: () => 1000,
      resolveSessionTarget: () => ({ channel: "slack", to: "U1" }),
    });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).toHaveBeenCalledTimes(1);

    const call = deliver.mock.calls[0][0];
    expect(call.payloads[0].text).toContain("Message approval required");
    expect(call.payloads[0].text).toContain("Hello world");
    expect(call.payloads[0].text).toContain("send");
    expect(call.payloads[0].text).toContain("telegram");
  });

  it("truncates long messages", async () => {
    const deliver = vi.fn().mockResolvedValue([]);
    const cfg = {
      approvals: { message: { enabled: true, mode: "session" } },
    } as ClawdbotConfig;

    const forwarder = createMessageApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      nowMs: () => 1000,
      resolveSessionTarget: () => ({ channel: "slack", to: "U1" }),
    });

    const longMessage = "x".repeat(500);
    await forwarder.handleRequested({
      ...baseRequest,
      request: { ...baseRequest.request, message: longMessage },
    });

    const call = deliver.mock.calls[0][0];
    expect(call.payloads[0].text).toContain("...");
    expect(call.payloads[0].text.length).toBeLessThan(longMessage.length + 200);
  });
});
