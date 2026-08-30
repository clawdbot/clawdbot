import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { ensureDevicePairSetupBootstrapToken } from "../../infra/device-bootstrap.js";
import { decodePairingSetupCode } from "../../pairing/setup-code.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createWorkerNodeEnrollmentManager } from "./node-enrollment.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";
import { createWorkerBootstrapArtifactTransferService } from "./worker-bootstrap-artifact-transfer-service.js";

vi.mock("../../infra/device-bootstrap.js", () => ({
  ensureDevicePairSetupBootstrapToken: vi.fn(async ({ setupId }: { setupId: string }) => ({
    status: "pending",
    token: "bootstrap-token",
    expiresAtMs: 10_000,
    setupId,
  })),
}));

const PUBLIC_ORIGIN = "https://gateway.example.test";
const PLUGIN_PUBLIC_URL = "wss://pairing.example.test";
const LOCAL_TLS_FINGERPRINT = "c".repeat(64);
const REMOTE_TLS_FINGERPRINT = "d".repeat(64);

function createConfig(pluginPublicUrl?: string): OpenClawConfig {
  return {
    gateway: {
      bind: "loopback",
      publicOrigin: PUBLIC_ORIGIN,
      auth: { mode: "token", token: "gateway-token" },
    },
    ...(pluginPublicUrl
      ? {
          plugins: {
            entries: { "device-pair": { config: { publicUrl: pluginPublicUrl } } },
          },
        }
      : {}),
  };
}

describe("worker node enrollment", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerEnvironmentStore;
  let transfer: ReturnType<typeof createWorkerBootstrapArtifactTransferService>;
  let managers: ReturnType<typeof createWorkerNodeEnrollmentManager>[];

  const artifact = () => ({
    tarballPath: path.join(root, "node-runtime.tgz"),
    tarballSha256: "a".repeat(64),
    tarballBytes: 1,
    openclawVersion: "2026.8.1",
    buildId: "gateway-source-build",
    enabledPluginIds: ["runtime-plugin"],
  });
  const createManager = (
    overrides: Partial<Parameters<typeof createWorkerNodeEnrollmentManager>[0]> = {},
  ) => {
    const manager = createWorkerNodeEnrollmentManager({
      store,
      getConfig: () => createConfig(),
      resolveAvailability: async () => ({ available: false }),
      prepareArtifact: async () => artifact(),
      transfer,
      ...overrides,
    });
    managers.push(manager);
    return manager;
  };
  const createProvisioning = (nodeDeviceId?: string) => {
    const record = store.createIntent({
      environmentId: "worker-enrollment",
      providerId: "fake-provider",
      profileId: "test-profile",
      profileSnapshot: { settings: {} },
      provisionOperationId: "provision:worker-enrollment",
    });
    return store.transition({
      environmentId: record.environmentId,
      from: "requested",
      to: "provisioning",
      ...(nodeDeviceId ? { patch: { nodeDeviceId } } : {}),
    });
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-node-enrollment-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerEnvironmentStore({ database, now: () => 1_000 });
    transfer = createWorkerBootstrapArtifactTransferService();
    managers = [];
    await fs.writeFile(artifact().tarballPath, "x");
  });

  afterEach(async () => {
    for (const manager of managers) {
      manager.stop();
    }
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(
    [
      {
        name: "uses gateway.publicOrigin when the plugin has no pairing override",
        config: {
          ...createConfig(),
          gateway: { ...createConfig().gateway, tls: { enabled: true } },
        },
        expectedUrl: "wss://gateway.example.test",
        expectedFingerprint: undefined,
      },
      {
        name: "prefers the device-pair plugin publicUrl over gateway.publicOrigin",
        config: createConfig(PLUGIN_PUBLIC_URL),
        expectedUrl: PLUGIN_PUBLIC_URL,
        expectedFingerprint: undefined,
      },
      {
        name: "pins direct Gateway TLS",
        config: {
          gateway: {
            bind: "custom",
            customBindHost: "192.168.50.20",
            port: 19443,
            tls: { enabled: true },
            auth: { mode: "token", token: "gateway-token" },
          },
        } satisfies OpenClawConfig,
        expectedUrl: "wss://192.168.50.20:19443",
        expectedFingerprint: LOCAL_TLS_FINGERPRINT,
      },
      {
        name: "pins the configured remote Gateway TLS",
        config: {
          gateway: {
            remote: { url: "wss://remote.example.test", tlsFingerprint: REMOTE_TLS_FINGERPRINT },
            auth: { mode: "token", token: "gateway-token" },
          },
        } satisfies OpenClawConfig,
        expectedUrl: "wss://remote.example.test",
        expectedFingerprint: REMOTE_TLS_FINGERPRINT,
      },
    ].flatMap((testCase) => ["connect", "resume"].map((mode) => Object.assign({ mode }, testCase))),
  )("$name ($mode)", async ({ config, expectedUrl, expectedFingerprint, mode }) => {
    const record = createProvisioning(mode === "resume" ? "existing-node" : undefined);
    const manager = createManager({
      getConfig: () => config,
      getLocalTlsFingerprint: () => LOCAL_TLS_FINGERPRINT,
    });

    const enrollment = await manager.begin(record);

    expect(enrollment.mode).toBe(mode);
    if (enrollment.mode === "connect") {
      const setup = decodePairingSetupCode(enrollment.setupCode, { nowMs: 0 });
      expect(setup.url).toBe(expectedUrl);
      expect(setup.tlsFingerprint).toBe(expectedFingerprint);
    } else {
      expect(enrollment.deviceId).toBe("existing-node");
    }
    expect(enrollment.nodeBootstrap).toMatchObject({
      url: `${expectedUrl.replace(/^wss:/u, "https:")}/__openclaw__/worker-bootstrap/artifacts/${artifact().tarballSha256}`,
      sha256: artifact().tarballSha256,
      bytes: 1,
      openclawVersion: "2026.8.1",
      enabledPluginIds: ["runtime-plugin"],
    });
    expect(enrollment.nodeBootstrap.tlsFingerprint).toBe(expectedFingerprint);
    const authorization = transfer.authorize({
      token: enrollment.nodeBootstrap.token,
      artifactKey: enrollment.nodeBootstrap.sha256,
    });
    expect(authorization).toBeDefined();
    const opened = await transfer.openFile(authorization!);
    expect(await opened?.handle.readFile("utf8")).toBe("x");
    await opened?.handle.close();
  });

  it("aborts pending enrollment waits idempotently and rejects enrollment after shutdown", async () => {
    const intent = store.createIntent({
      environmentId: "worker-enrollment-stop",
      providerId: "fake-provider",
      profileId: "test-profile",
      profileSnapshot: { settings: {} },
      provisionOperationId: "provision:worker-enrollment-stop",
    });
    const record = store.transition({
      environmentId: intent.environmentId,
      from: "requested",
      to: "provisioning",
      patch: { nodeDeviceId: "device-pending" },
    });
    const manager = createManager();
    const enrollment = await manager.begin(record);
    const waiting = enrollment.waitForDeviceId();
    const waitRejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });

    manager.stop();
    manager.stop();

    await waitRejected;
    expect(enrollment.signal?.aborted).toBe(true);
    const ensureEnrollment = vi.spyOn(store, "ensureNodeEnrollment");
    await expect(manager.begin(record)).rejects.toMatchObject({ name: "AbortError" });
    expect(ensureEnrollment).not.toHaveBeenCalled();
  });

  it.each(["close", "retire", "shutdown", "destroy"] as const)(
    "revokes bootstrap download authority on %s",
    async (reason) => {
      const record = createProvisioning();
      const manager = createManager();
      const enrollment = await manager.begin(record);
      const request = {
        token: enrollment.nodeBootstrap.token,
        artifactKey: enrollment.nodeBootstrap.sha256,
      };
      const authorization = transfer.authorize(request)!;
      expect(transfer.isAuthorizationCurrent(authorization)).toBe(true);

      if (reason === "close") {
        manager.close(enrollment);
      } else if (reason === "retire") {
        await manager.retire(record);
      } else if (reason === "shutdown") {
        manager.stop();
      } else {
        store.requestDestroy({ environmentId: record.environmentId, state: "provisioning" });
      }

      expect(transfer.isAuthorizationCurrent(authorization)).toBe(false);
      expect(transfer.authorizationSignal(authorization).aborted).toBe(true);
      expect(transfer.authorize(request)).toBeUndefined();
      await expect(transfer.openFile(authorization)).resolves.toBeNull();
    },
  );

  it("replaces enrollment authority without allowing stale or copied handles to close its successor", async () => {
    const record = createProvisioning();
    const manager = createManager();
    const previous = await manager.begin(record);
    const replacement = await manager.begin(record);
    expect(previous.signal?.aborted).toBe(true);
    expect(
      transfer.authorize({
        token: previous.nodeBootstrap.token,
        artifactKey: previous.nodeBootstrap.sha256,
      }),
    ).toBeUndefined();

    manager.close(previous);
    manager.close({ ...replacement });
    await expect(
      manager.begin({ ...record, provisionOperationId: "retired-provision" }),
    ).rejects.toThrow("no longer provisioning");
    const authorization = transfer.authorize({
      token: replacement.nodeBootstrap.token,
      artifactKey: replacement.nodeBootstrap.sha256,
    })!;
    expect(transfer.isAuthorizationCurrent(authorization)).toBe(true);
    manager.close(replacement);
    expect(transfer.isAuthorizationCurrent(authorization)).toBe(false);
  });

  it("does not let an older pending enrollment replace a newer enrollment", async () => {
    const record = createProvisioning();
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    let preparations = 0;
    const manager = createManager({
      prepareArtifact: async () => {
        preparations += 1;
        if (preparations === 1) {
          entered.resolve();
          await resume.promise;
        }
        return artifact();
      },
    });
    const pending = manager.begin(record);
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    const current = await manager.begin(record);
    const authorization = transfer.authorize({
      token: current.nodeBootstrap.token,
      artifactKey: current.nodeBootstrap.sha256,
    })!;
    expect(transfer.isAuthorizationCurrent(authorization)).toBe(true);

    resume.resolve();
    await rejected;

    expect(current.signal?.aborted).toBe(false);
    expect(transfer.isAuthorizationCurrent(authorization)).toBe(true);
    const opened = await transfer.openFile(authorization);
    expect(await opened?.handle.readFile("utf8")).toBe("x");
    await opened?.handle.close();
  });

  it.each(["artifact", "pairing"] as const)(
    "does not grant download authority after teardown during %s preparation",
    async (stage) => {
      const record = createProvisioning();
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const prepareArtifact = async () => {
        if (stage === "artifact") {
          entered.resolve();
          await resume.promise;
        }
        return artifact();
      };
      if (stage === "pairing") {
        vi.mocked(ensureDevicePairSetupBootstrapToken).mockImplementationOnce(
          async ({ setupId }) => {
            entered.resolve();
            await resume.promise;
            return { status: "pending", token: "bootstrap-token", expiresAtMs: 10_000, setupId };
          },
        );
      }
      const manager = createManager({ prepareArtifact });
      const beginning = manager.begin(record);
      const rejected = expect(beginning).rejects.toThrow(
        /cannot begin node enrollment|no longer provisioning|authority is unavailable/u,
      );
      await entered.promise;
      store.requestDestroy({ environmentId: record.environmentId, state: "provisioning" });
      resume.resolve();
      await rejected;
    },
  );

  it("does not return a connected device after teardown during its availability check", async () => {
    const record = createProvisioning("device-pending");
    const entered = createDeferredCore();
    const availability = createDeferredCore<{ available: true }>();
    const manager = createManager({
      resolveAvailability: async () => {
        entered.resolve();
        return await availability.promise;
      },
    });
    const enrollment = await manager.begin(record);
    const waiting = enrollment.waitForDeviceId();
    const rejected = expect(waiting).rejects.toThrow(/no longer current/u);
    await entered.promise;
    store.requestDestroy({ environmentId: record.environmentId, state: "provisioning" });
    availability.resolve({ available: true });
    await rejected;
  });
});
