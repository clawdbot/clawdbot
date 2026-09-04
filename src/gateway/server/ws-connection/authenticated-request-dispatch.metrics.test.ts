import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../../agents/admitted-run-context.js";
import {
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createLazyCoreHandlers } from "../../server-methods/lazy-core-handlers.js";
import type { GatewayRequestHandler, RespondFn } from "../../server-methods/types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";
import { createGatewayRpcDiagnostics } from "./request-diagnostics.js";
// Compile the real router before timed cases; family preparation remains controlled below.
import "../../server-methods.js";

const scheduling = vi.hoisted(() => ({ start: vi.fn<() => Promise<void> | null>() }));
vi.mock("./request-start.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./request-start.js")>()),
  scheduleGatewayRequestStart: scheduling.start,
}));

beforeEach(() => {
  resetDiagnosticEventsForTest();
  scheduling.start.mockReset().mockImplementation(() => Promise.resolve());
});
afterEach(() => {
  vi.restoreAllMocks();
  resetDiagnosticEventsForTest();
});

function observeRequests() {
  const events: Extract<DiagnosticEventPayload, { type: "gateway.rpc" }>[] = [];
  const finished = createDeferredCore();
  const unsubscribe = onInternalDiagnosticEvent(
    (event) => {
      if (event.type === "gateway.rpc") {
        events.push(event);
        if (event.phase === "dispatch") {
          finished.resolve();
        }
      }
    },
    { include: ["gateway.rpc"] },
  );
  onTestFinished(unsubscribe);
  return { events, finished: finished.promise };
}

function createRequest(handler: GatewayRequestHandler, method = "health") {
  const observed = observeRequests();
  const socket = new EventEmitter();
  const client = createOperatorWsClient({ socket });
  const harness = createDispatchTestHarness({ extraHandlers: { [method]: handler } });
  return {
    ...observed,
    ...harness,
    client,
    socket,
    dispatch: () =>
      harness.dispatcher.dispatch(
        { type: "req", id: "private-request-id", method, params: {} },
        client,
      ),
  };
}

describe("authenticated Gateway RPC diagnostics", () => {
  it.each(["family", "nested family", "family rejection"])(
    "keeps %s preparation separate from actual handler entry",
    async (preparation) => {
      let now = 100;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const reached = createDeferredCore();
      const release = createDeferredCore();
      const handler: GatewayRequestHandler = ({ respond }) => {
        now = 240;
        respond(true);
      };
      const observed = observeRequests();
      const client = createOperatorWsClient();
      const harness = createDispatchTestHarness({
        extraHandlers: createLazyCoreHandlers({
          methods: ["health"],
          loadHandlers: async () => {
            reached.resolve();
            await release.promise;
            if (preparation === "family rejection") {
              throw new Error("expected handler preparation failure");
            }
            const handlers = { health: handler };
            return preparation === "nested family"
              ? createLazyCoreHandlers({ methods: ["health"], loadHandlers: async () => handlers })
              : handlers;
          },
        }),
      });
      try {
        await harness.dispatcher.dispatch(
          { type: "req", id: "prepared", method: "health" },
          client,
        );
        await reached.promise;
        now = 200;
        release.resolve();
        await observed.finished;
        await waitForDiagnosticEventsDrained();
        if (preparation === "family rejection") {
          expect(observed.events.some((event) => event.phase === "handler")).toBe(false);
          expect(observed.events.at(-1)).toMatchObject({ phase: "dispatch", outcome: "threw" });
          return;
        }
        expect(observed.events.find((event) => event.phase === "handler")).toMatchObject({
          admissionMs: 100,
          durationMs: 40,
          outcome: "returned",
        });
      } finally {
        release.resolve();
        await observed.finished;
      }
    },
  );

  it("separates start admission, first response, and handler settlement without delaying ACK", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const queue = createDeferredCore();
    const queued = createDeferredCore();
    scheduling.start.mockImplementation(() => {
      queued.resolve();
      return queue.promise;
    });
    const completion = createDeferredCore();
    const fixture = createRequest(async ({ respond }) => {
      now = 150;
      respond(true, { accepted: true });
      await completion.promise;
      respond(true, { final: true });
    });
    try {
      await fixture.dispatch();
      await queued.promise;
      now = 120;
      queue.resolve();
      expect(await fixture.awaitResponseFrame("private-request-id")).toMatchObject({
        payload: { accepted: true },
      });
      await waitForDiagnosticEventsDrained();
      expect(fixture.events.filter((event) => event.phase === "response")).toMatchObject([
        { outcome: "ok", durationMs: 50 },
      ]);
      expect(fixture.events.some((event) => event.phase === "handler")).toBe(false);
      now = 220;
      completion.resolve();
      await fixture.finished;
      expect(fixture.events.filter((event) => event.phase === "handler")).toMatchObject([
        { outcome: "returned", durationMs: 100, admissionMs: 20 },
      ]);
      expect(fixture.events.filter((event) => event.phase === "dispatch")).toMatchObject([
        { outcome: "returned", durationMs: 120, queueWaitMs: 20, response: "sent" },
      ]);
      expect(fixture.events.filter((event) => event.phase === "received")).toHaveLength(1);
      expect(fixture.events.filter((event) => event.phase === "response")).toHaveLength(1);
      expect(JSON.stringify(fixture.events)).not.toContain("private-request-id");
    } finally {
      queue.resolve();
      completion.resolve();
      await fixture.finished;
    }
  });

  it("records a first response after handler return without reopening dispatch", async () => {
    let retainedRespond: RespondFn | undefined;
    const fixture = createRequest(({ respond }) => {
      retainedRespond = respond;
    });
    await fixture.dispatch();
    await fixture.finished;
    expect(fixture.events.at(-1)).toMatchObject({ phase: "dispatch", response: "none" });
    retainedRespond?.(true, { late: true });
    retainedRespond?.(true, { later: true });
    await waitForDiagnosticEventsDrained();
    expect(fixture.events.filter((event) => event.phase === "response")).toHaveLength(1);
    expect(fixture.events.filter((event) => event.phase === "handler")).toHaveLength(1);
    expect(fixture.events.filter((event) => event.phase === "dispatch")).toHaveLength(1);
  });

  it.each([true, false])(
    "preserves captured trace presence for late responses (trace=%s)",
    async (hasTrace) => {
      let retainedRespond: RespondFn | undefined;
      const fixture = createRequest(({ respond }) => {
        retainedRespond = respond;
      });
      const traceId = "11111111111111111111111111111111";
      await fixture.dispatcher.dispatch(
        {
          type: "req",
          id: "trace-request",
          method: "health",
          params: {},
          ...(hasTrace ? { traceparent: `00-${traceId}-1111111111111111-01` } : {}),
        },
        fixture.client,
      );
      await fixture.finished;
      const unrelated = createDiagnosticTraceContext({ parentSpanId: "2222222222222222" });
      runWithDiagnosticTraceContext(unrelated, () => {
        retainedRespond?.(true);
        expect(getActiveDiagnosticTraceContext()).toEqual(unrelated);
      });
      await waitForDiagnosticEventsDrained();
      expect(
        fixture.events
          .filter((event) => event.phase !== "received")
          .every((event) => event.trace?.traceId === (hasTrace ? traceId : undefined)),
      ).toBe(true);
    },
  );

  it.each(
    (["shared-auth", "runtime"] as const).flatMap((reason) => [
      {
        reason,
        parent: "valid",
        traceparent: "00-11111111111111111111111111111111-1111111111111111-01",
      },
      {
        reason,
        parent: "invalid",
        traceparent: "00-00000000000000000000000000000000-1111111111111111-01",
      },
      { reason, parent: "absent", traceparent: undefined },
    ]),
  )(
    "preserves supplied parent semantics through early $reason denial (parent=$parent)",
    async ({ reason, parent, traceparent }) => {
      const { events, finished } = observeRequests();
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true));
      const client = createOperatorWsClient();
      const ambient = createDiagnosticTraceContext();
      const authority = vi.fn(() => false);
      const harness = createDispatchTestHarness({
        extraHandlers: { health: handler },
        getRequiredSharedGatewaySessionGeneration: () => "new-generation",
        buildRequestContext: () => ({ validateAgentRuntimeApprovalAuthority: authority }),
      });
      if (reason === "shared-auth") {
        client.usesSharedGatewayAuth = true;
        client.sharedGatewaySessionGeneration = "previous-generation";
      } else {
        const operationalRunInstance = createOperationalRunInstanceRef("early-denial");
        client.internal = {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:test",
            operationalRunInstance,
            delegatedAuthority: {
              kind: "local",
              operationalRunInstance,
              lifecycleGeneration: "test-generation",
              claimId: "test-claim",
            },
          },
        };
      }
      await runWithDiagnosticTraceContext(ambient, () =>
        harness.dispatcher.dispatch(
          { type: "req", id: "early-denial", method: "health", params: {}, traceparent },
          client,
        ),
      );
      await finished;
      expect(handler).not.toHaveBeenCalled();
      const phases = events.filter((event) => event.phase !== "received");
      expect(phases.map((event) => event.phase)).toEqual(
        reason === "runtime" ? ["response", "dispatch"] : ["dispatch"],
      );
      expect(phases.at(-1)).toMatchObject({ phase: "dispatch", outcome: "rejected" });
      if (parent === "valid") {
        expect(
          phases.every((event) => event.trace?.traceId === "11111111111111111111111111111111"),
        ).toBe(true);
        expect(phases.every((event) => event.trace?.parentSpanId === "1111111111111111")).toBe(
          true,
        );
      } else {
        expect(phases.every((event) => event.trace?.traceId === ambient.traceId)).toBe(true);
        expect(phases.every((event) => event.trace?.parentSpanId === undefined)).toBe(true);
      }
      if (reason === "runtime") {
        expect(authority).toHaveBeenCalledWith(client.internal?.agentRuntimeIdentity);
        expect(harness.send).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
      } else {
        expect(harness.send).not.toHaveBeenCalled();
      }
      expect(harness.close).toHaveBeenCalledWith(4001, expect.any(String));
      expect(getActiveDiagnosticTraceContext()).toBeUndefined();
    },
  );

  it.each(["authorization", "capacity"])(
    "records %s rejection without a handler sample",
    async (reason) => {
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true));
      const fixture = createRequest(handler, "tasks.list");
      if (reason === "authorization") {
        fixture.client.connect.scopes = [];
      } else {
        scheduling.start.mockReturnValue(null);
      }
      await fixture.dispatch();
      await fixture.finished;
      expect(handler).not.toHaveBeenCalled();
      expect(fixture.events.some((event) => event.phase === "handler")).toBe(false);
      expect(fixture.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ phase: "response", outcome: "error" }),
          expect.objectContaining({ phase: "dispatch", outcome: "rejected" }),
        ]),
      );
      if (reason === "capacity") {
        expect(fixture.events.at(-1)).not.toHaveProperty("queueWaitMs");
      }
    },
  );

  it("keeps disconnected ordinary work alive and records unavailable delivery separately", async () => {
    const entered = createDeferredCore();
    const completion = createDeferredCore();
    const fixture = createRequest(async ({ respond, signal }) => {
      expect(signal).toBeUndefined();
      entered.resolve();
      await completion.promise;
      respond(true, { done: true });
      respond(true, { duplicate: true });
    });
    try {
      await fixture.dispatch();
      await entered.promise;
      expect(fixture.socket.listenerCount("close")).toBe(0);
      fixture.socket.emit("close");
      fixture.send.mockReturnValue({ kind: "unavailable" });
      completion.resolve();
      await fixture.finished;
      expect(fixture.events.filter((event) => event.phase === "response")).toMatchObject([
        { outcome: "unavailable" },
      ]);
      expect(fixture.events.at(-1)).toMatchObject({
        phase: "dispatch",
        outcome: "returned",
        response: "unavailable",
      });
    } finally {
      completion.resolve();
      await fixture.finished;
    }
  });

  it.each(["sent", "unavailable"] as const)(
    "measures serialization fallback only when its send is %s",
    async (fallback) => {
      const fixture = createRequest(({ respond }) => respond(true, {}));
      fixture.send
        .mockReturnValueOnce({
          kind: "serialization",
          error: new Error("synthetic encoding fault"),
        })
        .mockReturnValueOnce({ kind: fallback });
      await fixture.dispatch();
      await fixture.finished;
      expect(fixture.send).toHaveBeenCalledTimes(2);
      expect(fixture.events.filter((event) => event.phase === "response")).toMatchObject([
        { outcome: fallback === "sent" ? "error" : "unavailable" },
      ]);
    },
  );

  it("records suppressed delivery after authority revocation without changing handler settlement", async () => {
    const entered = createDeferredCore();
    const completion = createDeferredCore();
    const fixture = createRequest(async ({ respond }) => {
      entered.resolve();
      await completion.promise;
      respond(true, { private: "must not send" });
    });
    try {
      await fixture.dispatch();
      await entered.promise;
      fixture.client.invalidated = true;
      completion.resolve();
      await fixture.finished;
      expect(fixture.send).not.toHaveBeenCalled();
      expect(fixture.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ phase: "response", outcome: "suppressed" }),
          expect.objectContaining({ phase: "handler", outcome: "returned" }),
          expect.objectContaining({ phase: "dispatch", response: "suppressed" }),
        ]),
      );
    } finally {
      completion.resolve();
      await fixture.finished;
    }
  });

  it("reports request-owned cancellation separately from transport delivery failure", async () => {
    const entered = createDeferredCore();
    const fixture = createRequest(async ({ signal }) => {
      const cancelled = createDeferredCore();
      signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
      entered.resolve();
      await cancelled.promise;
    }, "sessions.companion.ask");
    await fixture.dispatch();
    await entered.promise;
    fixture.socket.emit("close");
    await fixture.finished;
    expect(fixture.events.at(-1)).toMatchObject({
      phase: "dispatch",
      outcome: "cancelled",
      response: "none",
    });
    expect(fixture.events.some((event) => event.phase === "response")).toBe(false);
    expect(fixture.socket.listenerCount("close")).toBe(0);
  });

  it("distinguishes a throwing handler from the error response it sends", async () => {
    const fixture = createRequest(() => {
      throw new Error("synthetic handler failure");
    });
    await fixture.dispatch();
    await fixture.finished;
    expect(fixture.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "handler", outcome: "threw" }),
        expect.objectContaining({ phase: "response", outcome: "error" }),
        expect.objectContaining({ phase: "dispatch", outcome: "threw" }),
      ]),
    );
    expect(JSON.stringify(fixture.events)).not.toContain("synthetic handler failure");
  });

  it("takes no clocks or registry lookups when diagnostics are disabled or uninterested", () => {
    const clock = vi.spyOn(performance, "now");
    const registry = vi.fn();
    expect(createGatewayRpcDiagnostics("health", registry, {})).toBeUndefined();
    const stopPublic = onDiagnosticEvent(() => {});
    onTestFinished(stopPublic);
    expect(createGatewayRpcDiagnostics("health", registry, {})).toBeUndefined();
    stopPublic();
    const unsubscribe = onInternalDiagnosticEvent(() => {}, { include: ["gateway.rpc"] });
    setDiagnosticsEnabledForProcess(false);
    expect(createGatewayRpcDiagnostics("health", registry, {})).toBeUndefined();
    unsubscribe();
    expect(clock).not.toHaveBeenCalled();
    expect(registry).not.toHaveBeenCalled();
  });

  it("collapses arbitrary request method names into fixed labels", async () => {
    const { events } = observeRequests();
    for (let index = 0; index < 1000; index++) {
      createGatewayRpcDiagnostics(`private-method-${index}`, undefined, {});
    }
    createGatewayRpcDiagnostics("private-plugin-method", undefined, {
      "private-plugin-method": () => {},
    });
    await waitForDiagnosticEventsDrained();
    expect(new Set(events.map((event) => event.method))).toEqual(new Set(["unknown", "other"]));
    expect(JSON.stringify(events)).not.toContain("private-");
  });
});
