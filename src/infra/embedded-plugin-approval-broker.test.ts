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

    expect(approval.approvalKind).toBe("plugin");
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

  it("isolates a failed listener when announcing a request", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const events: string[] = [];
    broker.subscribe((event) => {
      if (event.event === "plugin.approval.requested") {
        throw new Error("request listener failed");
      }
    });
    broker.subscribe((event) => {
      events.push(event.event);
    });

    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    const approval = expectDefined(
      broker.listPending()[0],
      "broker.listPending()[0] test invariant",
    );

    expect(broker.resolve(approval.id, "allow-once")).toBe(true);
    await expect(resultPromise).resolves.toMatchObject({ decision: "allow-once" });
    expect(events).toEqual(["plugin.approval.requested", "plugin.approval.resolved"]);
    expect(broker.listPending()).toEqual([]);
  });

  it("isolates a failed listener when announcing a resolution", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const events: string[] = [];
    broker.subscribe((event) => {
      if (event.event === "plugin.approval.resolved") {
        throw new Error("resolution listener failed");
      }
    });
    broker.subscribe((event) => {
      events.push(event.event);
    });

    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    const approval = expectDefined(
      broker.listPending()[0],
      "broker.listPending()[0] test invariant",
    );

    expect(() => broker.resolve(approval.id, "allow-once")).not.toThrow();
    await expect(resultPromise).resolves.toMatchObject({ decision: "allow-once" });
    expect(events).toEqual(["plugin.approval.requested", "plugin.approval.resolved"]);
    expect(broker.listPending()).toEqual([]);
  });

  it("isolates failed listeners while stopping every pending request", async () => {
    vi.useFakeTimers();
    const broker = new EmbeddedPluginApprovalBroker();
    const removedIds: string[] = [];
    broker.subscribe((event) => {
      if (event.event === "plugin.approval.removed") {
        throw new Error("removal listener failed");
      }
    });
    broker.subscribe((event) => {
      if (event.event === "plugin.approval.removed") {
        removedIds.push(event.payload.id);
      }
    });
    const first = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    const second = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    let stopError: unknown;

    try {
      broker.stop(new Error("local TUI stopped"));
    } catch (error) {
      stopError = error;
    }
    const settlementsPromise = Promise.allSettled([first, second]);
    await vi.runAllTimersAsync();
    const settlements = await settlementsPromise;

    expect(stopError).toBeUndefined();
    expect(settlements.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(removedIds).toHaveLength(2);
    expect(new Set(removedIds).size).toBe(2);
    expect(broker.listPending()).toEqual([]);
  });
});
