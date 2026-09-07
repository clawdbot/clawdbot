import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  BUILD_STAMP_FILE,
  resolveGitHead,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata.mts";
import { createDeferred } from "../../test/helpers/promise.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createGatewayKernel } from "./server-kernel.js";
import type { GatewayServer } from "./server-public.js";

describe("createGatewayKernel", () => {
  beforeAll(async () => {
    // The runner prepares compiled plugin dependencies before admitting workers.
    // This fixture still exercises the source Gateway lifecycle owners.
    const root = process.cwd();
    const head = resolveGitHead({ cwd: root });
    expect(head).toMatch(/^[0-9a-f]{40}$/u);
    await fs.access(path.join(root, "dist/index.js"));
    for (const [file, field] of [
      [BUILD_STAMP_FILE, "head"],
      [RUNTIME_POSTBUILD_STAMP_FILE, "head"],
      ["build-info.json", "commit"],
    ] as const) {
      const metadata = JSON.parse(await fs.readFile(path.join(root, "dist", file), "utf8"));
      expect(metadata[field], file).toBe(head);
    }
  });

  it.for(["kernel", "public"] as const)(
    "retains shutdown dependencies after connection-sidecar failure during %s close",
    async (entry) => {
      const port = await getFreePort();
      const state = await createOpenClawTestState({
        label: `gateway-${entry}-sidecar-retention`,
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
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
          VITEST: "1",
        },
      });
      const token = "gateway-sidecar-retention-token";
      const stopEntered = createDeferred();
      const releaseStop = createDeferred();
      const lateStopEntered = createDeferred();
      const releaseLateStop = createDeferred();
      const dependencyStopEntered = createDeferred();
      const stopError = new Error("remote worker stop failed");
      let failStop = true;
      let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
      let server: GatewayServer | undefined;
      let closing: Promise<unknown> | undefined;
      let cleanupComplete = false;
      const createKernel = createGatewayKernel;
      const factory = vi
        .spyOn(await import("./server-kernel.js"), "createGatewayKernel")
        .mockImplementation(async (...args) => {
          kernel = await createKernel(...args);
          return kernel;
        });
      const sidecar = {
        stop: vi.fn(async () => {
          stopEntered.resolve();
          await releaseStop.promise;
          if (failStop) {
            throw stopError;
          }
        }),
      };
      try {
        await state.writeConfig({
          gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
        });
        state.applyEnv();
        const options = {
          auth: { mode: "token" as const, token },
          bind: "loopback" as const,
          controlUiEnabled: false,
          sidecarStartup: "defer" as const,
        };
        if (entry === "public") {
          const { startGatewayServerCore } = await import("./server-start.js");
          server = await startGatewayServerCore(port, options);
          await server.startupSettled;
        } else {
          kernel = await createGatewayKernel(port, options);
          kernel.kernel.setDispatchReady(true);
        }
        if (!kernel) {
          throw new Error("Expected the real Gateway kernel");
        }
        const activeKernel = kernel;
        activeKernel.registerConnectionDependentSidecars([sidecar]);
        const closeTransport = vi.fn(() => releaseConnection());
        const releaseConnection = activeKernel.connectionWork.registerConnection(closeTransport);
        const dependencyStop = vi.fn(async () => {
          dependencyStopEntered.resolve();
        });
        activeKernel.registerGatewayLifetimeSidecars([{ stop: dependencyStop }]);
        const terminalDispose = vi.spyOn(activeKernel.terminalSessions, "disposeAll");
        const closePrelude = vi.spyOn(activeKernel.watchNodeHttpRuntime, "close");
        const gatewayStop = vi.spyOn(activeKernel.shutdownRuntime, "runGlobalGatewayStopSafely");
        const secrets = getActiveSecretsRuntimeConfigSnapshot();
        expect(secrets).not.toBeNull();
        closing = (server ? server.close() : activeKernel.closeOnStartupFailure()).catch(
          (error: unknown) => error,
        );
        await stopEntered.promise;
        const lateSidecar = {
          stop: vi.fn(async () => {
            lateStopEntered.resolve();
            await releaseLateStop.promise;
          }),
        };
        activeKernel.registerConnectionDependentSidecars([lateSidecar]);
        expect(closeTransport).not.toHaveBeenCalled();
        releaseStop.resolve();
        await lateStopEntered.promise;
        expect(closeTransport).not.toHaveBeenCalled();
        releaseLateStop.resolve();
        // Observe the failed owner's boundary without waiting for a later teardown stall.
        await Promise.race([closing, dependencyStopEntered.promise]);
        expect(closeTransport).not.toHaveBeenCalled();
        expect(dependencyStop).not.toHaveBeenCalled();
        expect(terminalDispose).not.toHaveBeenCalled();
        expect(closePrelude).not.toHaveBeenCalled();
        expect(gatewayStop).not.toHaveBeenCalled();
        expect(getActiveSecretsRuntimeConfigSnapshot()).toEqual(secrets);
        expect(await closing).toMatchObject({ errors: [{ cause: stopError }] });
        expect(sidecar.stop).toHaveBeenCalledTimes(2);
        expect(lateSidecar.stop).toHaveBeenCalledOnce();
        // The public close retains its failure; only the retained kernel owner may retry.
        failStop = false;
        await activeKernel.closeOnStartupFailure();
        cleanupComplete = true;
        expect(closeTransport).toHaveBeenCalledOnce();
        expect(dependencyStop).toHaveBeenCalledOnce();
        expect(sidecar.stop).toHaveBeenCalledTimes(3);
      } finally {
        // Join the original failure before changing its fault or releasing fixture state.
        releaseStop.resolve();
        releaseLateStop.resolve();
        try {
          await closing;
          failStop = false;
          if (kernel && !cleanupComplete) {
            await kernel.closeOnStartupFailure();
            cleanupComplete = true;
          }
          if (cleanupComplete) {
            await state.cleanup();
          }
        } finally {
          factory.mockRestore();
          vi.restoreAllMocks();
        }
      }
    },
  );
});
