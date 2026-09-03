import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
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
import { createNodeBootstrapArtifactProvider } from "./node-bootstrap-artifact.js";
import { createWorkerNodeEnrollmentManager } from "./node-enrollment.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";
import {
  createWorkerBootstrapArtifactTransferHttpCallback,
  handleWorkerBootstrapArtifactTransferHttpRequest,
} from "./worker-bootstrap-artifact-transfer-http.js";
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
  let artifactProviders: ReturnType<typeof createNodeBootstrapArtifactProvider>[];

  const artifact = () => ({
    tarballPath: path.join(root, "node-runtime.tgz"),
    tarballSha256: "a".repeat(64),
    tarballBytes: 1,
    openclawVersion: "2026.8.1",
    buildId: "gateway-source-build",
    enabledPluginIds: ["runtime-plugin"],
  });
  const bundle = () => ({
    tarballPath: path.join(root, "worker-bundle.tgz"),
    tarballSha256: "b".repeat(64),
    tarballBytes: 6,
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
  const createRequested = () =>
    store.createIntent({
      environmentId: "worker-enrollment",
      providerId: "fake-provider",
      profileId: "test-profile",
      profileSnapshot: { settings: {} },
      provisionOperationId: "provision:worker-enrollment",
    });
  const createProvisioning = (nodeDeviceId?: string) => {
    const record = createRequested();
    return store.transition({
      environmentId: record.environmentId,
      from: "requested",
      to: "provisioning",
      ...(nodeDeviceId ? { patch: { nodeDeviceId } } : {}),
    });
  };

  const createArtifactProvider = async () => {
    const packageRoot = path.join(root, "gateway");
    await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.8.1", type: "module" }),
      ),
      fs.writeFile(path.join(packageRoot, "openclaw.mjs"), 'import "./dist/entry.js";'),
      fs.writeFile(path.join(packageRoot, "node-version.mjs"), "export const supported = true;"),
      fs.writeFile(path.join(packageRoot, "dist/entry.js"), "export const ready = true;"),
      fs.writeFile(
        path.join(packageRoot, "dist/build-info.json"),
        JSON.stringify({ version: "2026.8.1", buildId: "gateway-source-build" }),
      ),
    ]);
    const provider = createNodeBootstrapArtifactProvider({
      packageRoot,
      runningBuildId: "gateway-source-build",
      plugins: [],
    });
    artifactProviders.push(provider);
    return provider;
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-node-enrollment-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerEnvironmentStore({ database, now: () => 1_000 });
    transfer = createWorkerBootstrapArtifactTransferService();
    managers = [];
    artifactProviders = [];
    await fs.writeFile(artifact().tarballPath, "x");
    await fs.writeFile(bundle().tarballPath, "worker");
  });

  afterEach(async () => {
    for (const manager of managers) {
      manager.stop();
    }
    await Promise.all(artifactProviders.map((provider) => provider.close()));
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    "127.0.0.1",
    "127.42.0.1",
    "localhost",
    "[::1]",
    "169.254.10.2",
    "0.0.0.0",
    "[::]",
    "[fe80::1]",
    "[febf::1]",
  ])("rejects unreachable cloud Gateway host %s before preparing artifacts", async (host) => {
    const prepareArtifact = vi.fn(async () => artifact());
    const manager = createManager({
      getConfig: () => createConfig(`http://${host}:19821`),
      prepareArtifact,
    });

    await expect(manager.prepare(createRequested())).rejects.toThrow(
      new Error(
        `Cloud node bootstrap resolved a Gateway address that a cloud worker cannot reach (ws://${host}:19821, from plugins.entries.device-pair.config.publicUrl). Set gateway.publicOrigin (or plugins.entries.device-pair.config.publicUrl) to a URL reachable from the worker, such as a Tailscale Funnel or a reverse-proxied public origin with gateway.trustedProxies, then redispatch.`,
      ),
    );
    expect(prepareArtifact).not.toHaveBeenCalled();
  });

  it("prepares artifacts for a public cloud Gateway host", async () => {
    const prepareArtifact = vi.fn(async () => artifact());
    const manager = createManager({ prepareArtifact });

    await expect(manager.prepare(createRequested())).resolves.toBeUndefined();
    expect(prepareArtifact).toHaveBeenCalledOnce();
  });

  it("releases requested-state preflight artifact custody without aborting its caller", async () => {
    const record = createRequested();
    const provider = await createArtifactProvider();
    let consumerSignal: AbortSignal | undefined;
    const manager = createManager({
      prepareArtifact: async (_record, signal) => {
        consumerSignal = signal;
        return await provider.prepare(signal);
      },
    });
    const caller = new AbortController();
    const ensureEnrollment = vi.spyOn(store, "ensureNodeEnrollment");
    const grant = vi.spyOn(transfer, "prepare");
    await manager.prepare(record, caller.signal);
    expect(consumerSignal?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    expect(ensureEnrollment).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
    expect(store.get(record.environmentId)).toMatchObject({
      state: "requested",
      nodeSetupId: null,
      nodeDeviceId: null,
    });
    await provider.close();
  });

  it.each(["caller", "shutdown"] as const)(
    "cancels requested-state preflight on %s while its shared producer drains",
    async (reason) => {
      const record = createRequested();
      const provider = await createArtifactProvider();
      const stagingRoot = path.join(root, "held-artifact");
      await fs.mkdir(stagingRoot);
      const entered = createDeferredCore();
      const resume = createDeferredCore<string>();
      const makeTemp = vi.spyOn(fs, "mkdtemp").mockImplementationOnce(async () => {
        entered.resolve();
        return await resume.promise;
      });
      const manager = createManager({
        prepareArtifact: async (_record, signal) => await provider.prepare(signal),
      });
      const caller = new AbortController();
      const ensureEnrollment = vi.spyOn(store, "ensureNodeEnrollment");
      const grant = vi.spyOn(transfer, "prepare");
      const completed = vi.fn();
      const pending = manager.prepare(record, caller.signal).then(
        () => completed({ ready: true }),
        (error: unknown) => completed({ error }),
      );
      let closing: Promise<void> | undefined;
      try {
        await entered.promise;
        if (reason === "caller") {
          caller.abort(new DOMException("Stop preflight", "AbortError"));
        } else {
          manager.stop();
        }
        await vi.waitFor(() =>
          expect(completed).toHaveBeenCalledExactlyOnceWith({
            error: expect.objectContaining({ name: "AbortError" }),
          }),
        );
        expect(caller.signal.aborted).toBe(reason === "caller");
        expect(ensureEnrollment).not.toHaveBeenCalled();
        expect(grant).not.toHaveBeenCalled();
        expect(store.get(record.environmentId)).toMatchObject({
          state: "requested",
          nodeSetupId: null,
          nodeDeviceId: null,
        });
        const closed = vi.fn();
        closing = provider.close().then(closed);
        await expect(fs.access(stagingRoot)).resolves.toBeUndefined();
        expect(closed).not.toHaveBeenCalled();
        resume.resolve(stagingRoot);
        await closing;
        await expect(fs.access(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        resume.resolve(stagingRoot);
        manager.stop();
        await pending;
        await closing;
        makeTemp.mockRestore();
      }
    },
  );

  it("grants artifact access before enrollment without creating a setup identity or credential", async () => {
    const record = createProvisioning();
    const manager = createManager();
    const ensureEnrollment = vi.spyOn(store, "ensureNodeEnrollment");
    vi.mocked(ensureDevicePairSetupBootstrapToken).mockClear();
    const runtime = await manager.prepareRuntime(record, bundle());
    expect(ensureEnrollment).not.toHaveBeenCalled();
    expect(ensureDevicePairSetupBootstrapToken).not.toHaveBeenCalled();
    expect(store.get(record.environmentId)).toMatchObject({
      nodeSetupId: null,
      nodeDeviceId: null,
    });
    const authorization = transfer.authorize({
      token: runtime.nodeBootstrap.token,
      artifactKey: runtime.nodeBootstrap.sha256,
    })!;
    const opened = await transfer.openFile(authorization);
    expect(await opened?.handle.readFile("utf8")).toBe("x");
    await opened?.handle.close();
    expect(runtime.workerBundle).toMatchObject({
      sha256: bundle().tarballSha256,
      bytes: 6,
      packageRelativePath: `worker-artifacts/${bundle().tarballSha256}.tgz`,
    });
    const bundleAuthorization = transfer.authorize({
      token: runtime.workerBundle.token,
      artifactKey: runtime.workerBundle.sha256,
    })!;
    const bundleOpened = await transfer.openFile(bundleAuthorization);
    expect(await bundleOpened?.handle.readFile("utf8")).toBe("worker");
    await bundleOpened?.handle.close();
    const enrollment = await manager.begin(record);
    expect(enrollment).not.toHaveProperty("workerBundle");
    expect(runtime.signal?.aborted).toBe(true);
    expect(transfer.isAuthorizationCurrent(authorization)).toBe(false);
    expect(transfer.isAuthorizationCurrent(bundleAuthorization)).toBe(false);
    manager.closeRuntime(runtime);
    manager.close({ ...enrollment });
    expect(enrollment.signal?.aborted).toBe(false);
    expect(
      transfer.authorize({
        token: enrollment.nodeBootstrap.token,
        artifactKey: enrollment.nodeBootstrap.sha256,
      }),
    ).toBeDefined();
  });

  it.each(["close", "shutdown", "destroy", "operation-abort", "replacement"] as const)(
    "revokes runtime preparation on %s",
    async (reason) => {
      const record = createProvisioning();
      const manager = createManager();
      const operation = new AbortController();
      const runtime = await manager.prepareRuntime(record, bundle(), operation.signal);
      const requests = [runtime.nodeBootstrap, runtime.workerBundle].map((descriptor) => ({
        token: descriptor.token,
        artifactKey: descriptor.sha256,
      }));
      const authorizations = requests.map((request) => transfer.authorize(request)!);
      if (reason === "close") {
        manager.closeRuntime(runtime);
      } else if (reason === "shutdown") {
        manager.stop();
      } else if (reason === "operation-abort") {
        operation.abort();
      } else if (reason === "replacement") {
        await manager.prepareRuntime(record, bundle());
      } else {
        store.requestDestroy({ environmentId: record.environmentId, state: "provisioning" });
      }
      for (const [index, authorization] of authorizations.entries()) {
        expect(transfer.isAuthorizationCurrent(authorization)).toBe(false);
        expect(transfer.authorize(requests[index]!)).toBeUndefined();
        await expect(transfer.openFile(authorization)).resolves.toBeNull();
      }
    },
  );

  it("serves both preparation archives through HTTP only while their exact owner is current", async () => {
    const callback = createWorkerBootstrapArtifactTransferHttpCallback(transfer);
    const server = http.createServer((req, res) => {
      void handleWorkerBootstrapArtifactTransferHttpRequest({
        req,
        res,
        clientIp: "127.0.0.1",
        callback,
      }).catch(() => res.writeHead(500).end());
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("HTTP proof server did not bind");
      }
      const testOrigin = `http://127.0.0.1:${address.port}`;
      const manager = createManager({
        prepareArtifact: async () => ({
          ...artifact(),
          tarballSha256: createHash("sha256").update("x").digest("hex"),
        }),
      });
      const preparedBundle = {
        ...bundle(),
        tarballSha256: createHash("sha256").update("worker").digest("hex"),
      };
      const record = createProvisioning();
      const ensureEnrollment = vi.spyOn(store, "ensureNodeEnrollment");
      vi.mocked(ensureDevicePairSetupBootstrapToken).mockClear();
      const requestPair = async (
        runtime: Awaited<ReturnType<typeof manager.prepareRuntime>>,
        status: number,
      ) => {
        for (const descriptor of [runtime.nodeBootstrap, runtime.workerBundle]) {
          // Route the advertised public URL to this test's local HTTP server.
          const downloadUrl = new URL(descriptor.url);
          expect(downloadUrl.origin).toBe(PUBLIC_ORIGIN);
          const response = await fetch(new URL(downloadUrl.pathname, testOrigin), {
            headers: { authorization: `Bearer ${descriptor.token}` },
          });
          expect(response.status).toBe(status);
          const body = Buffer.from(await response.arrayBuffer());
          if (status === 200) {
            expect(body.byteLength).toBe(descriptor.bytes);
            expect(createHash("sha256").update(body).digest("hex")).toBe(descriptor.sha256);
          }
        }
      };
      await requestPair(await manager.prepareRuntime(record, preparedBundle), 200);
      const closed = await manager.prepareRuntime(record, preparedBundle);
      manager.closeRuntime(closed);
      await requestPair(closed, 404);
      const previous = await manager.prepareRuntime(record, preparedBundle);
      const current = await manager.prepareRuntime(record, preparedBundle);
      await requestPair(previous, 404);
      await requestPair(current, 200);
      expect(ensureEnrollment).not.toHaveBeenCalled();
      expect(ensureDevicePairSetupBootstrapToken).not.toHaveBeenCalled();
      expect(store.get(record.environmentId)).toMatchObject({
        nodeSetupId: null,
        nodeDeviceId: null,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it.each(["enrollment", "operation-abort", "destroy"] as const)(
    "rejects late artifact preparation after %s",
    async (reason) => {
      const record = createProvisioning();
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      let preparations = 0;
      const manager = createManager({
        prepareArtifact: async () => {
          if (++preparations === 1) {
            entered.resolve();
            await resume.promise;
          }
          return artifact();
        },
      });
      const operation = new AbortController();
      const pending = manager.prepareRuntime(record, bundle(), operation.signal);
      const rejected = expect(pending).rejects.toThrow();
      await entered.promise;
      const enrollment = reason === "enrollment" ? await manager.begin(record) : undefined;
      if (reason === "operation-abort") {
        operation.abort();
      }
      if (reason === "destroy") {
        store.requestDestroy({ environmentId: record.environmentId, state: "provisioning" });
      }
      resume.resolve();
      await rejected;
      if (enrollment) {
        expect(enrollment.signal?.aborted).toBe(false);
        expect(
          transfer.authorize({
            token: enrollment.nodeBootstrap.token,
            artifactKey: enrollment.nodeBootstrap.sha256,
          }),
        ).toBeDefined();
      }
    },
  );

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

  it("does not split surrogate pairs when bounding the enrollment display name", async () => {
    const profileId = `${"x".repeat(50)}😀tail`;
    const requested = store.createIntent({
      environmentId: "worker-enrollment-display-name",
      providerId: "fake-provider",
      profileId,
      profileSnapshot: { settings: {} },
      provisionOperationId: "provision:worker-enrollment-display-name",
    });
    const record = store.transition({
      environmentId: requested.environmentId,
      from: "requested",
      to: "provisioning",
    });
    const manager = createManager();

    await expect(manager.begin(record)).resolves.toMatchObject({
      displayName: `Cloud worker ${"x".repeat(50)}`,
    });
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
