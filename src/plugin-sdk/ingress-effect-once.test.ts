import { mkdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { createIngressEffectOnce } from "./ingress-effect-once.js";

const EFFECT_ONCE_PARAMS = {
  pluginId: "test-ingress-effect-once",
  namespacePrefix: "test.ingress-effect-once",
  ttlMs: 60_000,
  stateMaxEntries: 100,
};

let stateDir = "";

beforeEach(async () => {
  resetPluginStateStoreForTests();
  stateDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ingress-effect-once-")),
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

afterEach(async () => {
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
  if (stateDir) {
    await fs.rm(stateDir, { recursive: true, force: true });
    stateDir = "";
  }
});

describe("createIngressEffectOnce", () => {
  it("executes an effect once and reports its replay", async () => {
    const effectOnce = createIngressEffectOnce(EFFECT_ONCE_PARAMS);
    const run = vi.fn(async () => "written");

    await expect(
      effectOnce.runOnce({ eventId: "event-1", effect: "config-write", run }),
    ).resolves.toEqual({ kind: "executed", value: "written" });
    await expect(
      effectOnce.runOnce({ eventId: "event-1", effect: "config-write", run }),
    ).resolves.toEqual({ kind: "replayed" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("releases a failed claim so an in-flight sibling executes on retry", async () => {
    const effectOnce = createIngressEffectOnce(EFFECT_ONCE_PARAMS);
    const failure = new Error("write failed");
    let rejectFirst!: (error: unknown) => void;
    const firstRun = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    const retryRun = vi.fn(async () => "retried");

    const first = effectOnce.runOnce({
      eventId: "event-2",
      effect: "config-write",
      run: firstRun,
    });
    await vi.waitFor(() => expect(firstRun).toHaveBeenCalledOnce());
    const retry = effectOnce.runOnce({
      eventId: "event-2",
      effect: "config-write",
      run: retryRun,
    });
    await Promise.resolve();
    rejectFirst(failure);

    await expect(first).rejects.toBe(failure);
    await expect(retry).resolves.toEqual({ kind: "executed", value: "retried" });
    expect(retryRun).toHaveBeenCalledOnce();
  });

  it("settles concurrent same-key claims with one execution", async () => {
    const effectOnce = createIngressEffectOnce(EFFECT_ONCE_PARAMS);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run = vi.fn(async () => {
      await gate;
      return "cleared";
    });

    const first = effectOnce.runOnce({ eventId: "event-3", effect: "storage-clear", run });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const second = effectOnce.runOnce({ eventId: "event-3", effect: "storage-clear", run });
    finish();

    await expect(first).resolves.toEqual({ kind: "executed", value: "cleared" });
    await expect(second).resolves.toEqual({ kind: "replayed" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps distinct effects on one event independent", async () => {
    const effectOnce = createIngressEffectOnce(EFFECT_ONCE_PARAMS);

    await expect(
      effectOnce.runOnce({
        eventId: "event-4",
        effect: "config-write",
        run: async () => "configured",
      }),
    ).resolves.toEqual({ kind: "executed", value: "configured" });
    await expect(
      effectOnce.runOnce({
        eventId: "event-4",
        effect: "visible-ack",
        run: async () => "acknowledged",
      }),
    ).resolves.toEqual({ kind: "executed", value: "acknowledged" });
  });

  it("isolates queue-local event ids by factory namespace", async () => {
    const firstQueue = createIngressEffectOnce({
      ...EFFECT_ONCE_PARAMS,
      namespacePrefix: "test.ingress-effect-once.account-a",
    });
    const secondQueue = createIngressEffectOnce({
      ...EFFECT_ONCE_PARAMS,
      namespacePrefix: "test.ingress-effect-once.account-b",
    });

    await expect(
      firstQueue.runOnce({
        eventId: "event-local-1",
        effect: "config-write",
        run: async () => "first",
      }),
    ).resolves.toEqual({ kind: "executed", value: "first" });
    await expect(
      secondQueue.runOnce({
        eventId: "event-local-1",
        effect: "config-write",
        run: async () => "second",
      }),
    ).resolves.toEqual({ kind: "executed", value: "second" });
  });

  it("keeps normalized-prefix collisions isolated", async () => {
    const slashQueue = createIngressEffectOnce({
      ...EFFECT_ONCE_PARAMS,
      namespacePrefix: "test/queue",
    });
    const dashQueue = createIngressEffectOnce({
      ...EFFECT_ONCE_PARAMS,
      namespacePrefix: "test-queue",
    });
    const slashRun = vi.fn(async () => "slash");
    const dashRun = vi.fn(async () => "dash");

    await expect(
      slashQueue.runOnce({
        eventId: "event-local-collision",
        effect: "config-write",
        run: slashRun,
      }),
    ).resolves.toEqual({ kind: "executed", value: "slash" });
    await expect(
      dashQueue.runOnce({
        eventId: "event-local-collision",
        effect: "config-write",
        run: dashRun,
      }),
    ).resolves.toEqual({ kind: "executed", value: "dash" });
    expect(slashRun).toHaveBeenCalledOnce();
    expect(dashRun).toHaveBeenCalledOnce();
  });

  it("persists completed effects across fresh factory instances", async () => {
    const first = createIngressEffectOnce(EFFECT_ONCE_PARAMS);
    await expect(
      first.runOnce({
        eventId: "event-5",
        effect: "config-write",
        run: async () => "written",
      }),
    ).resolves.toEqual({ kind: "executed", value: "written" });

    resetPluginStateStoreForTests();
    const replayRun = vi.fn(async () => "unexpected");
    const second = createIngressEffectOnce(EFFECT_ONCE_PARAMS);
    await expect(
      second.runOnce({ eventId: "event-5", effect: "config-write", run: replayRun }),
    ).resolves.toEqual({ kind: "replayed" });
    expect(replayRun).not.toHaveBeenCalled();
  });

  it("rejects before executing when durable state cannot be read", async () => {
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.writeFile(stateDir, "not a directory");
    const onDiskError = vi.fn();
    const run = vi.fn(async () => "unsafe");
    const effectOnce = createIngressEffectOnce({ ...EFFECT_ONCE_PARAMS, onDiskError });

    await expect(
      effectOnce.runOnce({ eventId: "event-read-error", effect: "config-write", run }),
    ).rejects.toThrow("Failed to open the plugin state database");
    expect(onDiskError).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a failed durable commit and settles its in-flight waiter", async () => {
    const onDiskError = vi.fn();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run = vi.fn(async () => {
      await gate;
      resetPluginStateStoreForTests();
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.writeFile(stateDir, "not a directory");
      return "already-visible";
    });
    const waiterRun = vi.fn(async () => "unsafe-retry");
    const effectOnce = createIngressEffectOnce({ ...EFFECT_ONCE_PARAMS, onDiskError });

    const first = effectOnce.runOnce({
      eventId: "event-write-error",
      effect: "visible-ack",
      run,
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const waiter = effectOnce.runOnce({
      eventId: "event-write-error",
      effect: "visible-ack",
      run: waiterRun,
    });
    finish();

    await expect(first).rejects.toThrow("Failed to open the plugin state database");
    await expect(waiter).rejects.toThrow("Failed to open the plugin state database");
    expect(onDiskError).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(waiterRun).not.toHaveBeenCalled();
  });

  it("propagates a transient commit failure to its in-flight waiter", async () => {
    let repairedStateDir = false;
    const onDiskError = vi.fn(() => {
      if (repairedStateDir) {
        return;
      }
      repairedStateDir = true;
      rmSync(stateDir, { recursive: true, force: true });
      mkdirSync(stateDir, { recursive: true });
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run = vi.fn(async () => {
      await gate;
      resetPluginStateStoreForTests();
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.writeFile(stateDir, "not a directory");
      return "already-visible";
    });
    const waiterRun = vi.fn(async () => "unsafe-retry");
    const effectOnce = createIngressEffectOnce({ ...EFFECT_ONCE_PARAMS, onDiskError });

    const first = effectOnce.runOnce({
      eventId: "event-transient-write-error",
      effect: "visible-ack",
      run,
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const waiter = effectOnce.runOnce({
      eventId: "event-transient-write-error",
      effect: "visible-ack",
      run: waiterRun,
    });
    finish();

    await expect(first).rejects.toThrow("Failed to open the plugin state database");
    await expect(waiter).rejects.toThrow("Failed to open the plugin state database");
    expect(onDiskError).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(waiterRun).not.toHaveBeenCalled();
  });

  it("evicts old records when state capacity is smaller than the replay window", async () => {
    const effectOnce = createIngressEffectOnce({
      ...EFFECT_ONCE_PARAMS,
      stateMaxEntries: 1,
      memoryMaxSize: 1,
    });
    const firstRun = vi.fn(async () => "first");

    await effectOnce.runOnce({ eventId: "event-cap-1", effect: "config-write", run: firstRun });
    await effectOnce.runOnce({
      eventId: "event-cap-2",
      effect: "config-write",
      run: async () => "second",
    });
    await effectOnce.runOnce({
      eventId: "event-cap-1",
      effect: "config-write",
      run: firstRun,
    });

    expect(firstRun).toHaveBeenCalledTimes(2);
  });
});
