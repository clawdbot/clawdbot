import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddedPluginApprovalBroker } from "./embedded-plugin-approval-broker.js";

function requestPayload() {
  return {
    title: "Apply workspace skill proposal",
    description: "Apply a pending workspace skill proposal into live workspace skills.",
    toolName: "skill_workshop",
    sessionKey: "agent:main:main",
    allowedDecisions: ["allow-once"] as const,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("EmbeddedPluginApprovalBroker", () => {
  it("lists, emits, and resolves pending approvals", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const events: Array<{ event: string; payload: unknown }> = [];
    broker.subscribe((event) => {
      events.push(event);
    });

    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    const approval = expectDefined(
      broker.listPending()[0],
      "broker.listPending()[0] test invariant",
    );

    expect(approval?.request.toolName).toBe("skill_workshop");
    expect(events[0]).toEqual({
      event: "plugin.approval.requested",
      payload: approval,
    });
    expect(broker.resolve(approval?.id, "allow-once")).toBe(true);
    await expect(resultPromise).resolves.toMatchObject({ decision: "allow-once" });
    expect(broker.listPending()).toEqual([]);
    expect(events[1]).toMatchObject({
      event: "plugin.approval.resolved",
      payload: { id: approval?.id, decision: "allow-once" },
    });
  });

  it("rejects decisions outside the request decision set", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    const approval = expectDefined(
      broker.listPending()[0],
      "broker.listPending()[0] test invariant",
    );

    expect(broker.resolve(approval?.id, "allow-always")).toBe(false);
    broker.stop();
    await expect(resultPromise).rejects.toThrow("embedded plugin approval broker stopped");
  });

  it("keeps deny available as the canonical fail-closed decision", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    const approval = expectDefined(
      broker.listPending()[0],
      "broker.listPending()[0] test invariant",
    );

    expect(broker.resolve(approval?.id, "deny")).toBe(true);
    await expect(resultPromise).resolves.toMatchObject({ decision: "deny" });
  });

  it("times out pending approvals", async () => {
    vi.useFakeTimers();
    const broker = new EmbeddedPluginApprovalBroker();
    const events: Array<{ event: string; payload: unknown }> = [];
    broker.subscribe((event) => {
      events.push(event);
    });
    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(resultPromise).resolves.toMatchObject({ decision: null });
    expect(broker.listPending()).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      event: "plugin.approval.removed",
      payload: { id: expect.stringMatching(/^plugin:/) },
    });
  });

  it("removes approvals when the embedded run is aborted", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const events: Array<{ event: string; payload: unknown }> = [];
    broker.subscribe((event) => {
      events.push(event);
    });
    const controller = new AbortController();
    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    controller.abort(new Error("run aborted"));

    await expect(resultPromise).rejects.toThrow("run aborted");
    expect(broker.listPending()).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      event: "plugin.approval.removed",
      payload: { id: expect.stringMatching(/^plugin:/) },
    });
  });

  it("rejects pending approvals when stopped", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });

    broker.stop(new Error("local TUI stopped"));

    await expect(resultPromise).rejects.toThrow("local TUI stopped");
    expect(broker.listPending()).toEqual([]);
  });
});
