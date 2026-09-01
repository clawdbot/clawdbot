import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";
import {
  captureWarmImage,
  commandResult,
  createWarmProvider,
  provisionWarmProfile,
  LEASE_ID,
  OPERATION_ID,
  PROFILE,
} from "./crabbox-worker-warm-image.test-support.js";

const enrollment = (waitForDeviceId: () => Promise<string>) => ({
  mode: "connect" as const,
  setupCode: "setup-code",
  setupId: "setup-id",
  openclawVersion: "2026.8.1",
  nodeBootstrap: createNodeBootstrapFixture(),
  displayName: "Cancelled worker",
  waitForDeviceId,
});

describe("Crabbox provisioning cancellation", () => {
  it.each([
    "config",
    "warmup",
    "inspect",
    "profile setup",
    "desktop setup",
    "node enrollment setup",
    "enrollment diagnostics",
    "checkpoint inspect",
    "checkpoint fork",
  ])("cancels %s without releasing its command or launching later work", async (phase) => {
    const controller = new AbortController();
    const reason = new Error("worker stop requested");
    const started = createDeferred<void>();
    const closed = createDeferred<void>();
    let armed = false;
    let commandSignal: AbortSignal | undefined;
    const warm = phase.startsWith("checkpoint");
    const profile = { ...PROFILE, warmImage: warm, setup: "profile-setup", desktop: true };
    const { provider, calls, warn } = createWarmProvider(async ({ argv, options }) => {
      const command = argv[1] === "checkpoint" ? `checkpoint ${argv[2]}` : argv[1];
      const setup = options.input?.toString();
      const actual =
        command === "run"
          ? setup === "profile-setup"
            ? "profile setup"
            : setup?.includes("CRABBOX_NODE_ENROLLMENT_SCRIPT")
              ? "node enrollment setup"
              : setup?.includes("node.log tail:")
                ? "enrollment diagnostics"
                : "desktop setup"
          : command;
      if (!armed || actual !== phase) {
        return undefined;
      }
      commandSignal = options.signal;
      started.resolve();
      await closed.promise;
      return commandResult({ code: 2, stderr: "command interrupted" });
    });
    if (warm) {
      await captureWarmImage(provider, profile);
      calls.length = 0;
    }
    armed = true;
    let settled = false;
    const operation = provisionWarmProfile(provider, profile, OPERATION_ID, undefined, {
      signal: controller.signal,
      ...(phase === "enrollment diagnostics"
        ? {
            beginNodeEnrollment: async () =>
              enrollment(async () => {
                throw new Error("enrollment expired");
              }),
          }
        : {}),
    })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    await started.promise;
    const commandCount = calls.length;
    try {
      controller.abort(reason);
      await setImmediate();
      expect(commandSignal?.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(calls).toHaveLength(commandCount);
    } finally {
      closed.resolve();
      await operation;
    }
    expect(await operation).toEqual({ error: reason });
    expect(calls).toHaveLength(commandCount);
    expect(warn).not.toHaveBeenCalled();
    await provider.destroy({ leaseId: LEASE_ID, profile: { ...profile, warmImage: false } });
    expect(calls.at(-1)?.argv[1]).toBe("stop");
    expect(calls.at(-1)?.options.signal).toBeUndefined();
  });

  it("interrupts the real readiness delay before another probe or enrollment", async () => {
    const inspected = createDeferred<void>();
    const controller = new AbortController();
    const profile = { ...PROFILE, warmImage: false };
    let ready = false;
    const { provider, calls } = createWarmProvider(
      ({ argv }) => {
        if (argv[1] === "inspect") {
          inspected.resolve();
          return commandResult({
            stdout: JSON.stringify({
              id: LEASE_ID,
              state: "starting",
              ready,
              providerMetadata: { instanceProfileAttached: false },
            }),
          });
        }
        return undefined;
      },
      undefined,
      { sleep: undefined },
    );
    let settled = false;
    const operation = provisionWarmProfile(provider, profile, OPERATION_ID, undefined, {
      signal: controller.signal,
    })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await inspected.promise;
    // Let the resolved inspection enter the production timer; no fake timer or injected delay.
    await setImmediate();
    // Let a broken non-canceling path finish at its next probe instead of leaking a poller.
    ready = true;
    controller.abort();
    try {
      await setImmediate();
      expect(settled).toBe(true);
    } finally {
      await operation;
    }
    expect(await operation).toMatchObject({ name: "AbortError" });
    expect(calls.filter(({ argv }) => argv[1] === "inspect")).toHaveLength(1);
    expect(calls.some(({ argv }) => argv[1] === "run")).toBe(false);
  });

  it("does not activate keepalive or warm capture after a late enrollment result", async () => {
    const waiting = createDeferred<void>();
    const enrolled = createDeferred<string>();
    const controller = new AbortController();
    const { provider, calls } = createWarmProvider();
    const operation = provisionWarmProfile(provider, PROFILE, OPERATION_ID, undefined, {
      signal: controller.signal,
      beginNodeEnrollment: async () =>
        enrollment(async () => {
          waiting.resolve();
          return await enrolled.promise;
        }),
    }).catch((error: unknown) => error);
    await waiting.promise;
    controller.abort();
    enrolled.resolve("late-device");
    expect(await operation).toMatchObject({ name: "AbortError" });
    await setImmediate();
    expect(calls.some(({ argv }) => argv[1] === "heartbeat")).toBe(false);
    calls.length = 0;
    await provider.destroy({ leaseId: LEASE_ID, profile: PROFILE });
    expect(calls.map(({ argv }) => argv[1])).toEqual(["stop"]);
  });
});
