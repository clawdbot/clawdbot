import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createGatewayKernel } from "./server-kernel.js";
import type { GatewayServer } from "./server-public.js";

function createStartupTestState(label: string) {
  return createOpenClawTestState({
    label,
    layout: "home",
    env: {
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      VITEST: "1",
    },
  });
}

describe("Gateway startup lifetime", () => {
  it.for(["clean", "failed"] as const)(
    "joins deferred startup failure while reporting %s cleanup independently",
    async (cleanup, { signal }) => {
      const port = await getFreePort();
      const state = await createStartupTestState(`gateway-deferred-startup-${cleanup}-cleanup`);
      const startupError = new Error("deferred startup failed");
      const cleanupError = new Error("deferred startup cleanup failed");
      const startup = createDeferred();
      const startupFailure = startup.promise.catch((error: unknown) => error);
      const startupEntered = createDeferred();
      const drainEntered = createDeferred();
      const releaseStartup = () => startup.reject(startupError);
      signal.addEventListener("abort", releaseStartup, { once: true });
      let failCleanup = cleanup === "failed";
      let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
      let server: GatewayServer | undefined;
      let publishedStartup: Promise<void> | undefined;
      let startupOutcome: Promise<unknown> | undefined;
      let closeOutcome: Promise<unknown> | undefined;
      const createKernel = createGatewayKernel;
      const kernelFactory = vi
        .spyOn(await import("./server-kernel.js"), "createGatewayKernel")
        .mockImplementation(async (...args) => {
          kernel = await createKernel(...args);
          return kernel;
        });
      const startupModule = await import("./server-startup-finish.js");
      const finishStartup = startupModule.finishGatewayStartup;
      const startupFactory = vi
        .spyOn(startupModule, "finishGatewayStartup")
        .mockImplementation(async (...args) => {
          const result = await finishStartup(...args);
          const operation = result.startupSettled.then(async () => {
            startupEntered.resolve();
            await startup.promise;
          });
          publishedStartup = args[0].kernelRuntime.connectionWork.track(() => operation);
          startupOutcome = publishedStartup.catch((error: unknown) => error);
          return { ...result, startupSettled: publishedStartup };
        });
      const cleanupOwner = {
        stop: vi.fn(async () => {
          if (failCleanup) {
            throw cleanupError;
          }
        }),
      };
      try {
        const token = "gateway-deferred-startup-cleanup-token";
        await state.writeConfig({
          gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
        });
        state.applyEnv();
        const { startGatewayServerCore } = await import("./server-start.js");
        server = await startGatewayServerCore(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        await startupEntered.promise;
        expect(server.startupSettled).toBe(publishedStartup);
        if (!kernel) {
          throw new Error("Expected the real Gateway kernel");
        }
        const activeKernel = kernel;
        activeKernel.registerGatewayLifetimeSidecars([cleanupOwner]);
        const terminalDispose = vi.spyOn(activeKernel.terminalSessions, "disposeAll");
        const drain = activeKernel.connectionWork.drain.bind(activeKernel.connectionWork);
        vi.spyOn(activeKernel.connectionWork, "drain").mockImplementation(async () => {
          drainEntered.resolve();
          await drain();
        });
        const closeSettled = vi.fn();
        closeOutcome = server.close({ reason: "gateway startup failed" }).then(
          () => {
            closeSettled();
            return undefined;
          },
          (error: unknown) => {
            closeSettled();
            return error;
          },
        );
        await drainEntered.promise;
        await nextTurn();
        expect(closeSettled).not.toHaveBeenCalled();
        expect(terminalDispose).not.toHaveBeenCalled();
        expect(cleanupOwner.stop).not.toHaveBeenCalled();
        releaseStartup();
        expect(await startupOutcome).toBe(startupError);
        const outcome = await closeOutcome;
        if (cleanup === "failed") {
          expect(outcome).toMatchObject({ errors: [{ cause: cleanupError }] });
        } else {
          expect(outcome).toBeUndefined();
        }
        expect(terminalDispose).toHaveBeenCalledOnce();
        expect(cleanupOwner.stop).toHaveBeenCalled();
        await expect(server.startupSettled).rejects.toBe(startupError);
      } finally {
        releaseStartup();
        try {
          await Promise.all([startupFailure, startupOutcome]);
          const outcome = await closeOutcome;
          failCleanup = false;
          if (kernel && (!closeOutcome || outcome !== undefined)) {
            await kernel.closeOnStartupFailure();
          }
          await state.cleanup();
        } finally {
          signal.removeEventListener("abort", releaseStartup);
          startupFactory.mockRestore();
          kernelFactory.mockRestore();
          vi.restoreAllMocks();
        }
      }
    },
  );

  it("releases post-ready startup work after failure before joining cleanup", async () => {
    const port = await getFreePort();
    const state = await createStartupTestState("gateway-post-ready-startup-failure");
    const startupError = new Error("startup failed after post-attach installation");
    const emergencyRelease = createDeferred();
    const drainEntered = createDeferred<{ barrierReleased: boolean }>();
    const resumed = vi.fn<(state: { closing: boolean; listening: boolean }) => void>();
    let barrierReleased = false;
    let emergencyUsed = false;
    let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
    let postReadyWork: Promise<void> | undefined;
    let startupOutcome: Promise<unknown> | undefined;
    let unexpectedServer: GatewayServer | undefined;
    const startupModule = await import("./server-startup-finish.js");
    const finishStartup = startupModule.finishGatewayStartup;
    const startupFactory = vi
      .spyOn(startupModule, "finishGatewayStartup")
      .mockImplementation(async (params) => {
        const result = await finishStartup(params);
        await result.startupSettled;
        const owner = params.kernelRuntime;
        kernel = owner;
        const transport = owner.transportBridge.current();
        if (!transport?.httpServer.listening) {
          throw new Error("Expected the real Gateway listener before startup failure");
        }
        // Minimal boot skips this production continuation; retain the exact
        // public-start barrier and work owner used by nonminimal post-attach.
        const barrier = params.waitForPostReadyWork().then(() => {
          barrierReleased = true;
        });
        const operation = (async () => {
          const releasedBy = await Promise.race([
            barrier.then(() => "gateway" as const),
            emergencyRelease.promise.then(() => "fixture" as const),
          ]);
          emergencyUsed = releasedBy === "fixture";
          resumed({
            closing: owner.lifecycle.closePreludeStarted,
            listening: transport.httpServer.listening,
          });
        })();
        postReadyWork = owner.connectionWork.track(() => operation);
        const drain = owner.connectionWork.drain.bind(owner.connectionWork);
        vi.spyOn(owner.connectionWork, "drain").mockImplementation(async () => {
          drainEntered.resolve({ barrierReleased });
          await drain();
        });
        throw startupError;
      });
    try {
      const token = "gateway-post-ready-startup-token";
      await state.writeConfig({
        gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
      });
      state.applyEnv();
      const { startGatewayServerCore } = await import("./server-start.js");
      startupOutcome = startGatewayServerCore(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      }).then(
        (server) => {
          unexpectedServer = server;
          return undefined;
        },
        (error: unknown) => error,
      );
      const boundary = await Promise.race([drainEntered.promise, startupOutcome]);
      expect(boundary).toEqual({ barrierReleased: true });
      expect(await startupOutcome).toBe(startupError);
      await postReadyWork;
      expect(emergencyUsed).toBe(false);
      expect(resumed).toHaveBeenCalledExactlyOnceWith({ closing: true, listening: true });
      expect(kernel?.transportBridge.current()?.httpServer.listening).toBe(false);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(getActiveSecretsRuntimeConfigSnapshot()).toBeNull();
    } finally {
      // A broken catch path is already observable at drain entry. Release only
      // the synthetic tail here so its original cleanup can finish before state removal.
      emergencyRelease.resolve();
      try {
        await Promise.all([startupOutcome, postReadyWork]);
        await unexpectedServer?.close();
        await state.cleanup();
      } finally {
        startupFactory.mockRestore();
        vi.restoreAllMocks();
      }
    }
  });
});
