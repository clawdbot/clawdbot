import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { requestCloudWorkerStop } from "../components/cloud-worker-stop.runtime.ts";
import {
  pauseSessionPlacementRecovery,
  readSessionPlacementRecovery,
  writeSessionPlacementRecovery,
} from "../lib/sessions/session-placement-recovery.ts";
import createRuntime from "./session-placement-startup.runtime.ts";
import {
  createPlacementStartupHarness,
  createStartupPlacement,
  flushStartupMicrotasks,
} from "./session-placement-startup.test-support.ts";
import { createApplicationPlacementStartup } from "./session-placement-startup.ts";

const recoveryAccess = { readSessionPlacementRecovery, pauseSessionPlacementRecovery };

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createStopHarness(phase: string) {
  const moduleLoad = createDeferred<{ default: typeof createRuntime }>();
  const dispatch = createDeferred<{ placement: ReturnType<typeof createStartupPlacement> }>();
  const reclaim = createDeferred<{ ok: true }>();
  let nextDispatch = 0;
  const request = vi.fn((method: string, params: { idempotencyKey?: string }) => {
    if (method === "sessions.dispatch") {
      return nextDispatch++ === 0
        ? dispatch.promise
        : Promise.resolve({ placement: createStartupPlacement("active", 2) });
    }
    if (method === "sessions.reclaim") {
      return reclaim.promise;
    }
    if (method === "sessions.send") {
      return Promise.resolve({ status: "started", runId: params.idempotencyKey });
    }
    throw new Error(`Unexpected ${method}`);
  });
  const { startup, input, client, gateway, dependencies } = createPlacementStartupHarness(request, {
    loadRuntime: () => moduleLoad.promise,
    recoveryBeforeStartup: phase === "lazy-recovery",
  });
  const stopClient = gateway.snapshot.client;
  if (!stopClient) {
    throw new Error("Expected the startup fixture client");
  }
  expect(stopClient).toBe(client);
  return {
    startup,
    input,
    client,
    stopClient,
    gateway,
    dependencies,
    request,
    moduleLoad,
    dispatch,
    reclaim,
  };
}

function blockStorageWrites() {
  const storage = sessionStorage;
  vi.stubGlobal("sessionStorage", {
    get length() {
      return storage.length;
    },
    key: storage.key.bind(storage),
    getItem: storage.getItem.bind(storage),
    removeItem: storage.removeItem.bind(storage),
    setItem: () => {
      throw new Error("quota");
    },
  });
}

function reconnectGateway(
  gateway: ReturnType<typeof createPlacementStartupHarness>["gateway"],
  client: ReturnType<typeof createPlacementStartupHarness>["client"],
) {
  for (const phase of ["reconnecting", "connected"] as const) {
    client.recoveryScopeReady = phase === "connected";
    Object.assign(gateway.snapshot, { phase });
    for (const [listener] of vi.mocked(gateway.subscribe).mock.calls) {
      listener(gateway.snapshot);
    }
  }
}

describe("cloud Stop owns the held initial turn", () => {
  it.each([
    { phase: "dispatching", persistent: true, storageFails: false },
    { phase: "dispatching", persistent: false, storageFails: false },
    { phase: "lazy-start", persistent: true, storageFails: false },
    { phase: "lazy-start", persistent: false, storageFails: false },
    { phase: "lazy-recovery", persistent: true, storageFails: false },
    { phase: "dispatching", persistent: true, storageFails: true },
    { phase: "lazy-start", persistent: true, storageFails: true },
  ] as const)(
    "pauses $phase (persistent: $persistent, storage failure: $storageFails) before reclaim and rejects late active dispatch until explicit Retry",
    async ({ phase, persistent, storageFails }) => {
      const {
        startup,
        input,
        client,
        stopClient,
        gateway,
        dependencies,
        request,
        moduleLoad,
        dispatch,
        reclaim,
      } = createStopHarness(phase);
      let activeStartup = startup;
      input.persistRecovery = persistent;
      if (!persistent) {
        sessionStorage.clear();
      }
      try {
        if (phase === "lazy-recovery") {
          startup.resumeRecovery();
        } else {
          startup.start(input);
        }
        if (phase === "dispatching") {
          moduleLoad.resolve({ default: createRuntime });
          await vi.waitFor(() =>
            expect(request).toHaveBeenCalledWith("sessions.dispatch", expect.anything()),
          );
        }
        if (storageFails) {
          blockStorageWrites();
        }
        const stopped = requestCloudWorkerStop(
          stopClient,
          { key: input.recovery.sessionKey },
          startup,
        );
        expect(request).toHaveBeenCalledWith("sessions.reclaim", expect.anything(), {
          timeoutMs: null,
        });
        moduleLoad.resolve({ default: createRuntime });
        dispatch.resolve({ placement: createStartupPlacement("active", 1) });
        await flushStartupMicrotasks();
        await flushStartupMicrotasks();
        expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(0);
        const saved = readSessionPlacementRecovery(
          input.recovery.gatewayUrl,
          input.recovery.recoveryScope,
          input.recovery.sessionKey,
        );
        if (persistent && !storageFails) {
          expect(saved).toMatchObject({
            phase: "paused",
            reason: "not-sent",
            messageId: input.recovery.messageId,
          });
        } else {
          expect(saved).toBeNull();
        }
        reclaim.resolve({ ok: true });
        await stopped;
        reconnectGateway(gateway, client);
        await flushStartupMicrotasks();
        expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(0);
        expect(startup.get(input.recovery.sessionKey)).toMatchObject({
          phase: "failed",
          action: "retry",
          initialTurn: { text: input.recovery.message, sendRunId: input.recovery.messageId },
        });
        expect(request.mock.calls.filter(([method]) => method === "sessions.reclaim")).toHaveLength(
          1,
        );
        vi.unstubAllGlobals();
        if (persistent && !storageFails) {
          startup.dispose();
          activeStartup = createApplicationPlacementStartup(dependencies, async () => ({
            default: createRuntime,
          }));
          activeStartup.resumeRecovery();
          await vi.waitFor(() =>
            expect(activeStartup.get(input.recovery.sessionKey)?.action).toBe("retry"),
          );
          expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(
            0,
          );
        }
        activeStartup.retry(input.recovery.sessionKey);
        await vi.waitFor(() =>
          expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(
            1,
          ),
        );
      } finally {
        reclaim.resolve({ ok: true });
        activeStartup.dispose();
      }
    },
  );
  it("pauses only the stopped session while another initial turn completes", async () => {
    const dispatch = createDeferred<{ placement: ReturnType<typeof createStartupPlacement> }>();
    const request = vi.fn((method: string, params: { idempotencyKey?: string }) =>
      method === "sessions.dispatch"
        ? dispatch.promise
        : Promise.resolve({ status: "started", runId: params.idempotencyKey }),
    );
    const { startup, input, client, gateway } = createPlacementStartupHarness(request);
    const stopClient = gateway.snapshot.client;
    if (!stopClient) {
      throw new Error("Expected the startup fixture client");
    }
    expect(stopClient).toBe(client);
    try {
      startup.start(input);
      startup.start({
        ...input,
        recovery: {
          ...input.recovery,
          sessionKey: "agent:cloud:other",
          messageId: "other-message",
        },
      });
      await vi.waitFor(() =>
        expect(
          request.mock.calls.filter(([method]) => method === "sessions.dispatch"),
        ).toHaveLength(2),
      );
      await requestCloudWorkerStop(stopClient, { key: input.recovery.sessionKey }, startup);
      dispatch.resolve({ placement: createStartupPlacement("active", 1) });
      await vi.waitFor(() =>
        expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(1),
      );
      expect(request).toHaveBeenCalledWith(
        "sessions.send",
        expect.objectContaining({ key: "agent:cloud:other", idempotencyKey: "other-message" }),
      );
      expect(startup.get(input.recovery.sessionKey)?.action).toBe("retry");
    } finally {
      startup.dispose();
    }
  });

  it.each(["disposed", "credential", "connection"] as const)(
    "does not pause a retired %s owner",
    async (retirement) => {
      const moduleLoad = createDeferred<{ default: typeof createRuntime }>();
      const request = vi.fn();
      const { startup, input, client, gateway } = createPlacementStartupHarness(request, {
        loadRuntime: () => moduleLoad.promise,
      });
      startup.start(input);
      if (retirement === "disposed") {
        startup.dispose();
      } else if (retirement === "credential") {
        client.recoveryScope = "principal-b";
      } else {
        Object.assign(gateway, { connectionRevision: gateway.connectionRevision + 1 });
        Object.assign(gateway.connection, { gatewayUrl: "ws://replacement.example" });
      }
      startup.pause(input.recovery.sessionKey, "stopped", recoveryAccess);
      expect(
        readSessionPlacementRecovery(
          input.recovery.gatewayUrl,
          input.recovery.recoveryScope,
          input.recovery.sessionKey,
        )?.phase,
      ).toBe("dispatching");
      expect(request).not.toHaveBeenCalled();
      startup.dispose();
      moduleLoad.resolve({ default: createRuntime });
      await flushStartupMicrotasks();
    },
  );

  it.each(["credential", "message"] as const)(
    "does not pause a replaced live %s owner",
    async (replacement) => {
      const dispatch = createDeferred<{ placement: ReturnType<typeof createStartupPlacement> }>();
      const request = vi.fn((_method: string) => dispatch.promise);
      const { startup, input, client } = createPlacementStartupHarness(request);
      try {
        startup.start(input);
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith("sessions.dispatch", expect.anything()),
        );
        const replacementRecovery = { ...input.recovery, messageId: "replacement-message" };
        if (replacement === "credential") {
          client.recoveryScope = "principal-b";
        } else {
          expect(writeSessionPlacementRecovery(replacementRecovery)).toBe(true);
        }
        startup.pause(input.recovery.sessionKey, "stopped", recoveryAccess);
        dispatch.resolve({ placement: createStartupPlacement("active", 1) });
        await flushStartupMicrotasks();
        expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(0);
        expect(
          readSessionPlacementRecovery(
            input.recovery.gatewayUrl,
            input.recovery.recoveryScope,
            input.recovery.sessionKey,
          ),
        ).toMatchObject({
          phase: "dispatching",
          messageId:
            replacement === "message" ? replacementRecovery.messageId : input.recovery.messageId,
        });
      } finally {
        startup.dispose();
      }
    },
  );
  it.each([true, false])(
    "keeps delivery uncertain when Stop follows an in-flight send (persistent: %s)",
    async (persistent) => {
      const sent = createDeferred<{ status: string; runId: string }>();
      const request = vi.fn((method: string) => {
        if (method === "sessions.dispatch") {
          return Promise.resolve({ placement: createStartupPlacement("active", 1) });
        }
        if (method === "sessions.send") {
          return sent.promise;
        }
        if (method === "chat.history") {
          return Promise.resolve({ messages: [] });
        }
        if (method === "sessions.reclaim") {
          return Promise.resolve({ ok: true });
        }
        throw new Error(`Unexpected ${method}`);
      });
      const { startup, input, client, gateway } = createPlacementStartupHarness(request);
      const stopClient = gateway.snapshot.client;
      if (!stopClient) {
        throw new Error("Expected the startup fixture client");
      }
      expect(stopClient).toBe(client);
      input.persistRecovery = persistent;
      if (!persistent) {
        sessionStorage.clear();
      }
      try {
        startup.start(input);
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith("sessions.send", expect.anything()),
        );
        await requestCloudWorkerStop(stopClient, { key: input.recovery.sessionKey }, startup);
        sent.resolve({ status: "started", runId: input.recovery.messageId });
        await flushStartupMicrotasks();
        expect(startup.get(input.recovery.sessionKey)).toMatchObject({
          phase: "failed",
          action: "check-delivery",
          initialTurn: { sendRunId: input.recovery.messageId, sendState: "unconfirmed" },
        });
        startup.retry(input.recovery.sessionKey);
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith("chat.history", expect.anything()),
        );
        await flushStartupMicrotasks();
        for (const method of ["sessions.dispatch", "sessions.send", "sessions.reclaim"]) {
          expect(request.mock.calls.filter(([name]) => name === method)).toHaveLength(1);
        }
        expect(startup.get(input.recovery.sessionKey)?.action).toBe("check-delivery");
      } finally {
        startup.dispose();
      }
    },
  );
});
