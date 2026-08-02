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
    const onRegistered = vi.fn();
    const events: Array<{ event: string; payload: unknown }> = [];
    broker.subscribe((event) => {
      events.push(event);
    });

    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
      onRegistered,
    });
    const approval = expectDefined(
      broker.listPending()[0],
      "broker.listPending()[0] test invariant",
    );

    expect(approval?.request.toolName).toBe("skill_workshop");
    expect(onRegistered).toHaveBeenCalledWith({ id: approval.id });
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

  it("registers identity before a requested-event subscriber resolves synchronously", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const order: string[] = [];
    broker.subscribe((event) => {
      order.push(event.event);
      if (event.event === "plugin.approval.requested") {
        broker.resolve(event.payload.id, "allow-once");
      }
    });

    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
      onRegistered: () => {
        order.push("registered");
      },
    });

    await expect(resultPromise).resolves.toEqual({
      outcome: "resolved",
      decision: "allow-once",
    });
    expect(order).toEqual(["registered", "plugin.approval.requested", "plugin.approval.resolved"]);
    expect(broker.listPending()).toEqual([]);
  });

  it("does not publish a request resolved during registration", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const events: Array<{ event: string; payload: unknown }> = [];
    broker.subscribe((event) => {
      events.push(event);
    });

    const result = await broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
      onRegistered: ({ id }) => {
        expect(broker.resolve(id, "allow-once")).toBe(true);
      },
    });

    expect(result).toEqual({ outcome: "resolved", decision: "allow-once" });
    expect(events.map((event) => event.event)).toEqual(["plugin.approval.resolved"]);
    expect(broker.listPending()).toEqual([]);
  });

  it("rejects when registration resolves and then aborts the run", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const controller = new AbortController();
    const abortReason = new Error("run aborted after registration resolution");

    await expect(
      broker.request({
        request: requestPayload(),
        timeoutMs: 5_000,
        signal: controller.signal,
        onRegistered: ({ id }) => {
          expect(broker.resolve(id, "allow-once")).toBe(true);
          controller.abort(abortReason);
        },
      }),
    ).rejects.toBe(abortReason);
  });

  it("rejects when a requested-event listener resolves and then aborts the run", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const controller = new AbortController();
    const abortReason = new Error("run aborted after requested resolution");
    broker.subscribe((event) => {
      if (event.event === "plugin.approval.requested") {
        expect(broker.resolve(event.payload.id, "allow-once")).toBe(true);
        controller.abort(abortReason);
      }
    });

    await expect(
      broker.request({
        request: requestPayload(),
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
  });

  it("does not publish a request after registration stops the broker", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const events: Array<{ event: string; payload: unknown }> = [];
    const stopReason = new Error("broker stopped during registration");
    broker.subscribe((event) => {
      events.push(event);
    });

    await expect(
      broker.request({
        request: requestPayload(),
        timeoutMs: 5_000,
        onRegistered: () => {
          broker.stop(stopReason);
        },
      }),
    ).rejects.toBe(stopReason);

    expect(events.map((event) => event.event)).toEqual(["plugin.approval.removed"]);
    expect(broker.listPending()).toEqual([]);
  });

  it("removes the pending approval when registration notification fails", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const events: Array<{ event: string; payload: unknown }> = [];
    const controller = new AbortController();
    const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
    broker.subscribe((event) => {
      events.push(event);
    });

    await expect(
      broker.request({
        request: requestPayload(),
        timeoutMs: 5_000,
        signal: controller.signal,
        onRegistered: () => {
          throw new Error("registration failed");
        },
      }),
    ).rejects.toThrow("registration failed");
    expect(broker.listPending()).toEqual([]);
    expect(events).toEqual([
      {
        event: "plugin.approval.removed",
        payload: { id: expect.stringMatching(/^plugin:/) },
      },
    ]);
    expect(removeAbortListener).not.toHaveBeenCalled();
    controller.abort(new Error("run aborted later"));
    expect(events).toHaveLength(1);
  });

  it("does not publish an approval when registration aborts its run", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const events: Array<{ event: string; payload: unknown }> = [];
    const controller = new AbortController();
    const abortReason = new Error("run aborted during registration");
    broker.subscribe((event) => {
      events.push(event);
    });

    await expect(
      broker.request({
        request: requestPayload(),
        timeoutMs: 5_000,
        signal: controller.signal,
        onRegistered: () => {
          controller.abort(abortReason);
        },
      }),
    ).rejects.toBe(abortReason);

    expect(broker.listPending()).toEqual([]);
    expect(events).toEqual([
      {
        event: "plugin.approval.removed",
        payload: { id: expect.stringMatching(/^plugin:/) },
      },
    ]);
  });

  it("isolates requested-event listener failures from approval state", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    broker.subscribe(() => {
      throw new Error("listener failed");
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
    await expect(resultPromise).resolves.toEqual({
      outcome: "resolved",
      decision: "allow-once",
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

    await expect(resultPromise).resolves.toEqual({ outcome: "timed-out" });
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

  it("accepts new subscriptions and approvals after a lifecycle stop", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const firstResult = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    broker.stop(new Error("first lifecycle stopped"));
    await expect(firstResult).rejects.toThrow("first lifecycle stopped");

    const events: string[] = [];
    broker.subscribe((event) => {
      events.push(event.event);
    });
    const secondResult = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    const approval = expectDefined(
      broker.listPending()[0],
      "broker.listPending()[0] test invariant",
    );
    expect(broker.resolve(approval.id, "allow-once")).toBe(true);

    await expect(secondResult).resolves.toEqual({
      outcome: "resolved",
      decision: "allow-once",
    });
    expect(events).toEqual(["plugin.approval.requested", "plugin.approval.resolved"]);
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
