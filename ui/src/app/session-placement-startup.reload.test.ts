import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { PendingSessionPlacementRecoveryState } from "../pages/new-session/session-placement-recovery-state.ts";
import {
  createPlacementStartupHarness,
  flushStartupMicrotasks,
} from "./session-placement-startup.test-support.ts";
import type { ApplicationPlacementStartup } from "./session-placement-startup.ts";
import * as chunkRecovery from "./stale-chunk-reload.ts";

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

it.each(["snapshot", "reload"])("releases New Session Reset recovery before %s", async (next) => {
  const reload = vi
    .spyOn(chunkRecovery, "retryStaleChunkReloadWhenReachable")
    .mockResolvedValue(false);
  const loader = vi.fn(() =>
    Promise.reject(new Error("Failed to fetch dynamically imported module: /assets/startup.js")),
  );
  const { startup, input, gateway } = createPlacementStartupHarness(vi.fn(), {
    loadRuntime: loader,
  });
  sessionStorage.clear();
  const pending = new PendingSessionPlacementRecoveryState();
  expect(
    pending.stageCreate({
      ...input.recovery,
      createParams: { agentId: input.recovery.agentId, message: "", worktree: true },
    }),
  ).not.toBeNull();
  const key = pending.sessionKey;
  startup.resumeRecovery();
  await flushStartupMicrotasks();
  expect(startup.hasPendingTurn(key)).toBe(true);
  startup.retry(key);
  const canReload = reload.mock.calls[0]?.[0]?.canReload;
  expect(canReload?.()).toBe(true);

  pending.clear();
  if (next === "snapshot") {
    vi.mocked(gateway.subscribe).mock.calls[0]?.[0](gateway.snapshot);
  }
  expect(canReload?.()).toBe(false);
  expect(sessionStorage.length).toBe(0);
  expect(startup.hasPendingTurn(key)).toBe(false);
  expect(startup.get(key)).toBeNull();
  expect(loader).toHaveBeenCalledOnce();
  startup.dispose();
});

it.each(["pending", "failed"])(
  "retains a restored %s attempt through session and profile notifications",
  async (phase) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const loading = createDeferred<{ default: () => ApplicationPlacementStartup }>();
    const loader = vi.fn(() => loading.promise);
    const { startup, input, gateway, client } = createPlacementStartupHarness(vi.fn(), {
      loadRuntime: loader,
    });
    startup.resumeRecovery();
    if (phase === "failed") {
      loading.reject(new Error("startup chunk unavailable"));
      await flushStartupMicrotasks();
    }
    const status = startup.get(input.recovery.sessionKey);
    expect(status).toMatchObject({ phase, startedAt: 1_000 });

    for (const sessionKey of ["agent:cloud:other", input.recovery.sessionKey]) {
      now.mockReturnValue(2_000);
      gateway.snapshot.sessionKey = sessionKey;
      vi.mocked(gateway.subscribe).mock.calls[0]?.[0](gateway.snapshot);
      expect(startup.get(input.recovery.sessionKey)).toEqual(status);
    }
    gateway.snapshot.selfUser = { id: "proof-operator", name: "Updated operator" };
    vi.mocked(gateway.subscribe).mock.calls[0]?.[0](gateway.snapshot);
    await flushStartupMicrotasks();
    expect(loader).toHaveBeenCalledOnce();
    expect(startup.get(input.recovery.sessionKey)).toEqual(status);
    client.recoveryScopeReady = false;
    gateway.snapshot.phase = "reconnecting";
    vi.mocked(gateway.subscribe).mock.calls[0]?.[0](gateway.snapshot);
    expect(startup.get(input.recovery.sessionKey)).toBeNull();
    expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(true);
    Object.assign(gateway.snapshot, {
      client: { ...client, recoveryScopeReady: true },
      phase: "connected",
    });
    vi.mocked(gateway.subscribe).mock.calls[0]?.[0](gateway.snapshot);
    expect(startup.get(input.recovery.sessionKey)).toEqual(status);
    expect(loader).toHaveBeenCalledOnce();
    startup.dispose();
  },
);

it.each(["credentials", "scope", "gateway"])(
  "retires a restored reload owner after its %s changes",
  async (change) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const reload = vi
      .spyOn(chunkRecovery, "retryStaleChunkReloadWhenReachable")
      .mockResolvedValue(false);
    const loader = vi.fn(() =>
      Promise.reject(new Error("Failed to fetch dynamically imported module: /assets/startup.js")),
    );
    const { startup, input, gateway, client } = createPlacementStartupHarness(vi.fn(), {
      loadRuntime: loader,
    });
    startup.resumeRecovery();
    await flushStartupMicrotasks();
    startup.retry(input.recovery.sessionKey);
    const canReload = reload.mock.calls[0]?.[0]?.canReload;
    expect(canReload?.()).toBe(true);

    now.mockReturnValue(2_000);
    if (change === "credentials") {
      Object.assign(gateway, { connectionRevision: 1 });
    }
    if (change === "scope") {
      client.recoveryScope = "principal-b";
    }
    if (change === "gateway") {
      gateway.connection.gatewayUrl = "ws://other.example";
    }
    vi.mocked(gateway.subscribe).mock.calls[0]?.[0](gateway.snapshot);
    expect(canReload?.()).toBe(false);
    expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(change === "credentials");
    if (change === "credentials") {
      expect(startup.get(input.recovery.sessionKey)).toMatchObject({
        phase: "failed",
        startedAt: 2_000,
      });
    } else {
      expect(startup.get(input.recovery.sessionKey)).toBeNull();
      client.recoveryScope = input.recovery.recoveryScope;
      gateway.connection.gatewayUrl = input.recovery.gatewayUrl;
      vi.mocked(gateway.subscribe).mock.calls[0]?.[0](gateway.snapshot);
      expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(true);
      expect(canReload?.()).toBe(false);
    }
    await flushStartupMicrotasks();
    expect(loader).toHaveBeenCalledOnce();
    startup.dispose();
  },
);

it.each(["credentials", "disposal", "memory-only"])(
  "does not reload a restored startup after %s custody prevents it",
  async (change) => {
    const reload = vi
      .spyOn(chunkRecovery, "retryStaleChunkReloadWhenReachable")
      .mockResolvedValue(false);
    const loadRuntime = vi.fn(() =>
      Promise.reject(
        new Error("Failed to fetch dynamically imported module: /assets/startup-runtime.js"),
      ),
    );
    const { startup, input, gateway } = createPlacementStartupHarness(vi.fn(), { loadRuntime });
    startup.resumeRecovery();
    if (change === "memory-only") {
      startup.start({
        ...input,
        persistRecovery: false,
        recovery: { ...input.recovery, sessionKey: "agent:cloud:incognito" },
      });
    }
    await flushStartupMicrotasks();
    startup.retry(input.recovery.sessionKey);
    expect(reload).toHaveBeenCalledOnce();
    const canReload = reload.mock.calls[0]?.[0]?.canReload;
    expect(canReload?.()).toBe(change !== "memory-only");
    if (change === "credentials") {
      Object.assign(gateway, { connectionRevision: 1 });
    } else if (change === "disposal") {
      startup.dispose();
    }
    expect(canReload?.()).toBe(false);
    expect(loadRuntime).toHaveBeenCalledOnce();
    startup.dispose();
  },
);
