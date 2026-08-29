import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMatrixQaFaultProxy } from "../substrate/fault-proxy.js";
import type { MatrixQaCliSession } from "./scenario-runtime-cli.js";
import { runMatrixQaE2eeCliEncryptionSetupBootstrapFailureScenario } from "./scenario-runtime-e2ee-cli-account.js";
import { MATRIX_QA_ROOM_KEY_BACKUP_VERSION_ENDPOINT } from "./scenario-runtime-e2ee-shared.js";
import {
  assertMatrixQaTestPortClosed,
  createMatrixQaE2eeTestContext,
} from "./scenario-runtime-e2ee.test-helpers.js";

const mocks = vi.hoisted(() => ({ createRuntime: vi.fn() }));
vi.mock("./scenario-runtime-e2ee-cli-runtime.js", () => ({
  createMatrixQaCliE2eeSetupRuntime: mocks.createRuntime,
}));
vi.mock("../substrate/client.js", () => ({
  createMatrixQaClient: () => ({
    registerWithToken: async () => ({
      accessToken: "account-test-token",
      deviceId: "OWNER",
      password: "test-password",
      userId: "@owner:matrix-qa.test",
    }),
    loginWithPassword: async () => ({
      accessToken: "cli-test-token",
      deviceId: "CLI",
      userId: "@owner:matrix-qa.test",
    }),
  }),
}));
vi.mock("../substrate/fault-proxy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../substrate/fault-proxy.js")>()),
  startMatrixQaFaultProxy: vi.fn(),
}));

describe("Matrix CLI bootstrap failure evidence and ownership", () => {
  let root: string;
  let proxy: Awaited<ReturnType<typeof startMatrixQaFaultProxy>>;
  let closed: boolean;
  let stopping: Promise<void> | undefined;
  let proxyCleanupFailure: Error | undefined;
  let beforeProxyStop: (() => Promise<void>) | undefined;
  const dispose = vi.fn(async () => {});
  const run = () =>
    runMatrixQaE2eeCliEncryptionSetupBootstrapFailureScenario(createMatrixQaE2eeTestContext());

  beforeEach(async () => {
    vi.resetAllMocks();
    closed = false;
    stopping = undefined;
    proxyCleanupFailure = undefined;
    beforeProxyStop = undefined;
    root = await mkdtemp(path.join(os.tmpdir(), "matrix-cli-bootstrap-"));
    const actual = await vi.importActual<typeof import("../substrate/fault-proxy.js")>(
      "../substrate/fault-proxy.js",
    );
    vi.mocked(startMatrixQaFaultProxy).mockImplementation(async (params) => {
      proxy = await actual.startMatrixQaFaultProxy(params);
      return {
        ...proxy,
        stop: async () => {
          await beforeProxyStop?.();
          stopping = proxy.stop().then(() => {
            closed = true;
          });
          await stopping;
          if (proxyCleanupFailure) {
            throw proxyCleanupFailure;
          }
        },
      };
    });
  });
  afterEach(async () => {
    await stopping;
    if (proxy && !closed) {
      await proxy.stop();
    }
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function configureCli(
    methods: string[],
    bootstrapError = "Matrix room key backup is not usable",
  ) {
    mocks.createRuntime.mockImplementation(async () => ({
      rootDir: root,
      dispose,
      start: (args: string[]): MatrixQaCliSession => ({
        args,
        endStdin: () => {},
        kill: () => {},
        writeStdin: async () => {},
        output: () => ({
          stdout: JSON.stringify({
            success: false,
            bootstrap: { success: false, error: bootstrapError },
          }),
          stderr: "",
        }),
        waitForOutput: async () => {
          throw new Error("unexpected waitForOutput");
        },
        wait: async () => {
          for (const method of methods) {
            const response = await fetch(
              `${proxy.baseUrl}${MATRIX_QA_ROOM_KEY_BACKUP_VERSION_ENDPOINT}`,
              {
                method,
                headers: { authorization: "Bearer cli-test-token" },
              },
            );
            await response.arrayBuffer();
          }
          throw new Error("synthetic CLI exit 1");
        },
      }),
    }));
  }

  it.each([{ methods: [] }, { methods: ["GET"] }])(
    "rejects CLI failure without POST evidence: %j",
    async ({ methods }) => {
      configureCli(methods);
      await expect(run()).rejects.toThrow("did not attempt faulted room-key backup creation");
      await assertMatrixQaTestPortClosed(proxy.baseUrl);
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it("accepts POST plus backup failure and rejects an unrelated CLI failure", async () => {
    configureCli(["GET", "POST"]);
    await expect(run()).resolves.toMatchObject({
      artifacts: { bootstrapSuccess: false, faultHitCount: 2 },
    });
    await assertMatrixQaTestPortClosed(proxy.baseUrl);
    closed = false;
    configureCli(["POST"], "unrelated failure");
    await expect(run()).rejects.toThrow("unexpected reason");
    await assertMatrixQaTestPortClosed(proxy.baseUrl);
  });

  it("closes the already-acquired proxy when runtime construction fails", async () => {
    const failure = new Error("runtime construction failed");
    mocks.createRuntime.mockRejectedValueOnce(failure);
    await expect(run()).rejects.toBe(failure);
    await assertMatrixQaTestPortClosed(proxy.baseUrl);
  });

  it("retains construction and proxy cleanup failures", async () => {
    const failure = new Error("runtime construction failed");
    proxyCleanupFailure = new Error("proxy stop failed");
    mocks.createRuntime.mockRejectedValueOnce(failure);
    await expect(run()).rejects.toMatchObject({
      cause: failure,
      errors: [failure, proxyCleanupFailure],
    });
    await assertMatrixQaTestPortClosed(proxy.baseUrl);
  });

  it("reports disposal and proxy cleanup failures instead of returning success", async () => {
    const disposalFailure = new Error("CLI disposal failed");
    proxyCleanupFailure = new Error("proxy stop failed");
    configureCli(["POST"]);
    dispose.mockRejectedValueOnce(disposalFailure);
    await expect(run()).rejects.toMatchObject({
      cause: disposalFailure,
      errors: [disposalFailure, proxyCleanupFailure],
    });
    await assertMatrixQaTestPortClosed(proxy.baseUrl);
  });

  it("joins proxy cleanup before returning a CLI disposal failure", async () => {
    const disposalFailure = new Error("CLI disposal failed");
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    beforeProxyStop = async () => {
      entered.resolve();
      await release.promise;
    };
    configureCli(["POST"]);
    dispose.mockRejectedValueOnce(disposalFailure);
    let settled = false;
    const operation = run().catch((error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await entered.promise;
      await setImmediate();
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      expect(await operation).toBe(disposalFailure);
    }
    await assertMatrixQaTestPortClosed(proxy.baseUrl);
  });
});
