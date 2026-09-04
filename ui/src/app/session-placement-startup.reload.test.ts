import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  pauseSessionPlacementRecovery,
  readSessionPlacementRecovery,
  writeSessionPlacementRecovery,
} from "../lib/sessions/session-placement-recovery.ts";
import * as toast from "../lib/toast.ts";
import { PendingSessionPlacementRecoveryState } from "../pages/new-session/session-placement-recovery-state.ts";
import {
  createPlacementStartupHarness,
  flushStartupMicrotasks,
} from "./session-placement-startup.test-support.ts";
import type { ApplicationPlacementStartup } from "./session-placement-startup.ts";
import * as chunkRecovery from "./stale-chunk-reload.ts";

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["restored", "explicit", "paused"])(
  "reloads a saved %s startup after a cached import failure",
  async (kind) => {
    const reload = vi
      .spyOn(chunkRecovery, "retryStaleChunkReloadWhenReachable")
      .mockResolvedValue(false);
    const loadRuntime = vi.fn(() =>
      Promise.reject(new Error("Failed to fetch dynamically imported module: /assets/startup.js")),
    );
    const { startup, input } = createPlacementStartupHarness(vi.fn(), { loadRuntime });
    try {
      if (kind !== "restored") {
        startup.start(input);
      } else {
        startup.resumeRecovery();
      }
      await flushStartupMicrotasks();
      if (kind === "paused") {
        startup.pause(input.recovery.sessionKey, "Stopped before startup", {
          readSessionPlacementRecovery,
          pauseSessionPlacementRecovery,
        });
        await flushStartupMicrotasks();
      }
      const importsBeforeRetry = loadRuntime.mock.calls.length;
      expect(startup.get(input.recovery.sessionKey)).toMatchObject({
        phase: "failed",
        retryable: true,
      });
      startup.retry(input.recovery.sessionKey);
      expect(reload).toHaveBeenCalledOnce();
      expect(reload.mock.calls[0]?.[0]?.canReload?.()).toBe(true);
      expect(loadRuntime).toHaveBeenCalledTimes(importsBeforeRetry);
    } finally {
      startup.dispose();
    }
  },
);

it.each(["Incognito", "failed pause write"])(
  "keeps unsaved input after %s while explaining blocked recovery on both sessions",
  async (cause) => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const reload = vi.fn();
    const loadRuntime = vi.fn(() =>
      Promise.reject(new Error("Failed to fetch dynamically imported module: /assets/startup.js")),
    );
    const { startup, input, gateway } = createPlacementStartupHarness(vi.fn(), { loadRuntime });
    const privateKey = "agent:cloud:incognito";
    const saved = Object.entries(sessionStorage);
    try {
      startup.resumeRecovery();
      await flushStartupMicrotasks();
      const memoryInput = {
        ...input,
        persistRecovery: cause !== "Incognito",
        recovery: { ...input.recovery, sessionKey: privateKey, message: "private unsent text" },
      };
      if (memoryInput.persistRecovery) {
        expect(writeSessionPlacementRecovery(memoryInput.recovery)).toBe(true);
      }
      startup.start(memoryInput);
      await flushStartupMicrotasks();
      if (cause === "failed pause write") {
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
        startup.pause(privateKey, "Stopped before startup", {
          readSessionPlacementRecovery,
          pauseSessionPlacementRecovery,
        });
        await flushStartupMicrotasks();
        vi.stubGlobal("sessionStorage", storage);
      }
      for (const key of [input.recovery.sessionKey, privateKey]) {
        expect(startup.hasPendingTurn(key)).toBe(true);
        expect(startup.get(key)).toMatchObject({
          phase: "failed",
          retryable: false,
          error: "Recovery needs a reload. Unsaved starts will be lost.",
        });
      }
      startup.retry(input.recovery.sessionKey);
      expect(
        await chunkRecovery.scheduleStaleChunkReload({
          reload,
          storage: sessionStorage,
          buildId: `unsaved-${cause}`,
        }),
      ).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      expect(Object.entries(sessionStorage)).toEqual(saved);
      expect(startup.hasPendingTurn(privateKey)).toBe(true);

      // Credential replacement retires this input's authority; it cannot block the new owner.
      Object.assign(gateway, { connectionRevision: gateway.connectionRevision + 1 });
      vi.mocked(gateway.subscribe).mock.calls[0]?.[0](gateway.snapshot);
      expect(startup.get(privateKey)).toBeNull();
      expect(startup.get(input.recovery.sessionKey)).toMatchObject({
        phase: "failed",
        retryable: true,
      });
      expect(
        await chunkRecovery.scheduleStaleChunkReload({
          reload,
          storage: sessionStorage,
          buildId: `unsaved-${cause}`,
        }),
      ).toBe(true);
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      startup.dispose();
    }
  },
);

it.each(["current", "start", "credentials", "scope", "gateway", "dispose"])(
  "binds explicit discard to the captured startup owner: %s",
  async (change) => {
    const reload = vi.spyOn(chunkRecovery, "reloadControlUiDocument").mockImplementation(() => {});
    const loadRuntime = vi.fn(() =>
      Promise.reject(new Error("Failed to fetch dynamically imported module: /assets/startup.js")),
    );
    const { startup, input, gateway, client } = createPlacementStartupHarness(vi.fn(), {
      loadRuntime,
    });
    try {
      startup.start({ ...input, persistRecovery: false });
      await flushStartupMicrotasks();
      const discard = startup.get(input.recovery.sessionKey)?.discardAndReload;
      expect(discard).toBeTypeOf("function");
      if (change === "start") {
        startup.start({
          ...input,
          persistRecovery: false,
          recovery: { ...input.recovery, messageId: "newer-input" },
        });
      } else if (change === "credentials") {
        Object.assign(gateway, { connectionRevision: 1 });
      } else if (change === "scope") {
        client.recoveryScope = "replacement-scope";
      } else if (change === "gateway") {
        gateway.connection.gatewayUrl = "ws://replacement.example";
      } else if (change === "dispose") {
        startup.dispose();
      }
      discard?.();
      expect(reload).toHaveBeenCalledTimes(change === "current" ? 1 : 0);
      if (change === "current") {
        expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(true);
      }
    } finally {
      startup.dispose();
    }
  },
);

it("rejects a retained toast action when another unsaved start joins the same pending import", async () => {
  const show = vi.spyOn(toast, "showToast").mockReturnValue(false);
  const reload = vi.spyOn(chunkRecovery, "reloadControlUiDocument").mockImplementation(() => {});
  const loading = createDeferred<{ default: () => ApplicationPlacementStartup }>();
  const loadRuntime = vi.fn(() => loading.promise);
  const { startup, input } = createPlacementStartupHarness(vi.fn(), { loadRuntime });
  try {
    startup.start({ ...input, persistRecovery: false });
    expect(await chunkRecovery.retryStaleChunkReloadWhenReachable()).toBe(false);
    const discard = show.mock.calls[0]?.[0].onAction;
    expect(discard).toBeTypeOf("function");
    startup.start({
      ...input,
      persistRecovery: false,
      recovery: { ...input.recovery, sessionKey: "agent:cloud:another-unsaved-start" },
    });
    expect(loadRuntime).toHaveBeenCalledOnce();
    discard?.();
    expect(reload).not.toHaveBeenCalled();
  } finally {
    startup.dispose();
  }
});

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
