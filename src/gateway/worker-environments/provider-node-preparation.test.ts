import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { bindCloudWorkerSetupCompletion } from "../../infra/device-pairing-cloud-worker.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { NodeWorkerBundleInstaller } from "../../node-host/node-worker-bundle-installer.js";
import { resolveNodeWorkerEntry } from "../../node-host/node-worker-entry.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  readWorkerBundleDirectoryManifest,
} from "../../shared/worker-bundle-archive.js";
import { hashWorkerBundleManifest } from "../../shared/worker-bundle-hash.js";
import { parseNodeWorkerWorkspaceRetainInput } from "../../worker/node-workspace-retain-protocol.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import { createNodeWorkspaceRetainCoordinator } from "./node-workspace-retain-coordinator.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerNodeProvisioning } from "./provider-node-provisioning.js";
import { createWorkerEnvironmentService } from "./service.js";
import * as support from "./service.test-support.js";

describe("prepared node registration ownership", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["unchanged", "ready workers", "total capacity", "provider"] as const)(
    "rechecks reserve allocation policy after installation preparation: %s",
    async (change) => {
      const { store, config, root } = support.testState;
      const repository = path.join(root, "source");
      await fs.mkdir(repository);
      await requireGit(repository, ["init", "--quiet"]);
      await requireGit(repository, ["config", "user.name", "Preparation Test"]);
      await requireGit(repository, ["config", "user.email", "preparation@example.invalid"]);
      await fs.writeFile(path.join(repository, "input.txt"), "committed source\n");
      await requireGit(repository, ["add", "."]);
      await requireGit(repository, ["commit", "--quiet", "-m", "source"]);
      const release = createDeferredCore();
      const provision = vi.fn<WorkerProvider["provision"]>(async () => {
        throw new Error("allocation boundary reached");
      });
      const resolveAllocation = vi.fn(async () => {
        throw new Error("allocation does not exist");
      });
      const destroy = vi.fn(async () => {});
      const provider = support.createProvider({
        supportedExecutionModes: ["worker-turn"],
        requiresNodeEnrollment: true,
        supportsProjectPreparation: () => true,
        resolvePreparationTarget: () => ({ machineClass: "small", platform: "linux", arch: "x64" }),
        resolvePreparedIdleTimeoutMs: () => 60_000,
        provision,
        resolveAllocation,
        destroy,
      });
      const prepareInstallation = vi.fn(async () => {
        await release.promise;
        return support.BUNDLE_ARTIFACT;
      });
      const service = createWorkerEnvironmentService({
        store,
        getConfig: () => config,
        resolveProvider: (id) => (id === provider.id ? provider : undefined),
        projectNamespace: "gateway",
        prepareInstallation,
        bootstrapWorker: support.testState.bootstrapWorker,
        prepareNodeArtifacts: async () => ({
          artifacts: {
            nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
            enabledPluginIds: [...support.NODE_BOOTSTRAP.enabledPluginIds],
            workerBundleHash: support.BUNDLE_HASH,
            workerArchiveSha256: support.BUNDLE_ARTIFACT.tarballSha256,
            openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
            protocolFeatures: [],
          },
          assertCurrent: () => {},
        }),
        prepareNodeEnrollment: async () => {
          throw new Error("fixture never enrolls");
        },
        executeInference: async () => ({ type: "error", reason: "cancelled", message: "unused" }),
        now: () => support.testState.nowMs,
      });
      support.testState.service = service;
      try {
        const intent = await service.prepareProjectIntent("development", {
          projectPath: repository,
          executionMode: "worker-turn",
        });
        expect(intent.preparationKey).toBeDefined();
        const reserve = store.createIntent({
          environmentId: "queued-reserve",
          providerId: intent.providerId,
          profileId: "development",
          profileSnapshot: intent.profileSnapshot,
          provisionOperationId: "queued-reserve-operation",
          preparation: {
            key: intent.preparationKey!,
            demandAtMs: support.testState.nowMs,
            expiresAtMs: support.testState.nowMs + 60_000,
          },
        });
        service.schedulePreparedRefill();
        await support.waitForFast(() => expect(prepareInstallation).toHaveBeenCalledOnce());
        expect(provision).not.toHaveBeenCalled();
        if (change === "ready workers") {
          support.getDevelopmentProfile().readyWorkers = 0;
        } else if (change === "total capacity") {
          config.cloudWorkers!.preparedPool = { maxTotal: 0 };
        } else if (change === "provider") {
          support.getDevelopmentProfile().provider = "replacement";
        }
        release.resolve();
        await support.waitForFast(() =>
          expect(store.get(reserve.environmentId)?.lastError).not.toBeNull(),
        );
        expect(provision).toHaveBeenCalledTimes(change === "unchanged" ? 1 : 0);
        if (change === "unchanged") {
          expect(provision.mock.calls[0]?.[2]?.project?.preparation?.purpose).toBe("reserve");
        }
        expect(store.get(reserve.environmentId)).toMatchObject({
          state: change === "unchanged" ? "provisioning" : "requested",
          destroyRequestedAtMs: change === "unchanged" ? null : support.testState.nowMs,
        });
        if (change !== "unchanged") {
          await service.reconcileOnce();
          await support.waitForFast(() =>
            expect(store.get(reserve.environmentId)?.state).toBe("failed"),
          );
        }
        expect(resolveAllocation).not.toHaveBeenCalled();
        expect(destroy).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await service.stop();
      }
    },
  );

  it("keeps the installed worker launchable while registration spans two retention sweeps", async () => {
    const { store, root, stateDb } = support.testState;
    const source = path.join(root, "bundle-source");
    await fs.mkdir(source);
    await fs.writeFile(
      path.join(source, "worker.mjs"),
      'console.log("prepared-worker-started");\n',
      {
        mode: 0o700,
      },
    );
    const bundleHash = hashWorkerBundleManifest(
      await readWorkerBundleDirectoryManifest({
        root: source,
        limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
      }),
    );
    const archivePath = path.join(root, "worker.tgz");
    await tar.create({ cwd: source, file: archivePath, gzip: true }, ["worker.mjs"]);
    const archive = await fs.readFile(archivePath);
    const artifact = {
      ...support.BUNDLE_ARTIFACT,
      bundleHash,
      tarballPath: archivePath,
      tarballSha256: createHash("sha256").update(archive).digest("hex"),
      tarballBytes: archive.length,
    };
    const receipt = { ...support.BOOTSTRAP_RECEIPT, bundleHash };
    const coldId = "cold-worker";
    store.createIntent({
      environmentId: coldId,
      providerId: "fake",
      profileId: "development",
      provisionOperationId: "cold",
      profileSnapshot: { settings: {} },
    });
    store.transition({ environmentId: coldId, from: "requested", to: "provisioning" });
    store.transition({
      environmentId: coldId,
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: "cold-lease",
        nodeDeviceId: "cold-node",
        ...support.readyPatch(coldId),
        bootstrapReceipt: receipt,
      },
    });
    store.transition({
      environmentId: coldId,
      from: "ready",
      to: "attached",
      patch: support.attachedPatch(coldId, "cold-session"),
    });
    const environmentId = "registering-worker";
    const deviceId = "registering-node";
    const gatewayNamespace = "gateway-test";
    const preparationKey = "a".repeat(64);
    const cacheKey = "e".repeat(64);
    store.createIntent({
      environmentId,
      providerId: "fake",
      profileId: "development",
      provisionOperationId: "registering",
      profileSnapshot: {
        settings: {},
        project: {
          key: preparationKey,
          root,
          baseCommit: "b".repeat(40),
          preparation: {
            key: preparationKey,
            cacheKey,
            contractVersion: 1,
            target: { machineClass: "small", platform: "linux", arch: "x64" },
            artifacts: {
              nodeBootstrapSha256: "c".repeat(64),
              enabledPluginIds: [],
              workerBundleHash: bundleHash,
              workerArchiveSha256: artifact.tarballSha256,
              openclawVersion: artifact.openclawVersion,
              protocolFeatures: [],
            },
          },
        },
      },
    });
    store.transition({ environmentId, from: "requested", to: "provisioning" });
    const enrolled = store.ensureNodeEnrollment(environmentId);
    if (!enrolled.nodeSetupId) {
      throw new Error("Expected node setup");
    }
    bindCloudWorkerSetupCompletion({
      db: stateDb.db,
      completion: {
        setupId: enrolled.nodeSetupId,
        deviceId,
        completedAtMs: support.testState.nowMs,
      },
    });
    const installer = new NodeWorkerBundleInstaller({ root });
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-length": archive.length }).end(archive);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected bound fixture server");
    }
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const patch = {
      leaseId: "registering-lease",
      nodeDeviceId: deviceId,
      sharedHost: false,
      desktop: null,
    };
    const provisioning = createWorkerNodeProvisioning({
      store,
      isStopping: () => false,
      prepareInstallation: async () => artifact,
      ensureNodeWorkerBundle: async () =>
        await installer.ensure({
          input: {
            gatewayNamespace,
            build: receipt,
            archive: {
              token: "A".repeat(43),
              sha256: artifact.tarballSha256,
              bytes: archive.length,
            },
          },
          gatewayUrl: `ws://127.0.0.1:${address.port}`,
        }),
      registerPreparedWorkspace: async ({ assertCurrent }) => {
        assertCurrent();
        entered.resolve();
        await release.promise;
        assertCurrent();
      },
      commitReady: () =>
        store.transition({
          environmentId,
          from: "provisioning",
          to: "ready",
          patch: {
            ...patch,
            ...support.readyPatch(environmentId),
            bootstrapReceipt: receipt,
          },
        }),
      failBootstrap: async (_record, _lease, _provider, error) => {
        throw error;
      },
      move: (record, to, transitionPatch) =>
        store.transition({ environmentId, from: record.state, to, patch: transitionPatch }),
      serviceError: (_code, message) => new Error(message),
    });
    const completion = provisioning.finish(
      store.ensureNodeEnrollment(environmentId),
      { leaseId: patch.leaseId, sharedHost: false, node: { deviceId } },
      support.createProvider(),
      patch,
      artifact,
      undefined,
      {
        preparationKey,
        cacheKey,
        workspaceDir: "/prepared/workspace",
        homeDir: "/prepared/home",
        sourceManifestRef: `sha256:${"d".repeat(64)}`,
      },
    );
    const transport: NodeWorkerSupervisorTransport = {
      hasCurrentRunner: () => true,
      isCurrent: () => true,
      listCurrentNodes: async () => [
        {
          nodeId: deviceId,
          connId: "connection",
          pairingIdentity: "pairing",
          pairingGeneration: "generation",
          clientId: "node-host",
          clientMode: "node",
          protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
          commands: [],
          workerHost: { enabled: true, capacity: { total: 1, available: 1 }, bundleRetention: 1 },
        },
      ],
      invoke: async ({ params }) => {
        const input = parseNodeWorkerWorkspaceRetainInput(JSON.stringify(params));
        const result = await installer.retain({
          gatewayNamespace: input.gatewayNamespace,
          bundleHashes: input.bundleHashes ?? [],
          acknowledgedGeneration: input.acknowledgedBundleGeneration,
        });
        return {
          ok: true,
          payloadJSON: JSON.stringify({
            applied: true,
            deleted: 0,
            hasMore: result.hasMore,
            bundleGeneration: result.generation,
          }),
        };
      },
    };
    const coordinator = createNodeWorkspaceRetainCoordinator({
      gatewayNamespace,
      environments: support.createService(support.createProvider()),
      placements: { list: () => [], listPendingWorkspaceResults: () => [] },
      warn: vi.fn(),
    });
    coordinator.bindTransport(transport);
    try {
      await Promise.race([entered.promise, completion]);
      expect(store.get(environmentId)?.state).toBe("provisioning");
      expect(store.get(environmentId)?.bootstrapReceipt).toBeNull();
      await coordinator.start();
      await coordinator.schedule(deviceId);
      release.resolve();
      await expect(completion).resolves.toMatchObject({ state: "ready" });
      await coordinator.schedule(deviceId);
      const entry = resolveNodeWorkerEntry({
        bundleRoot: root,
        expectedBundleHash: bundleHash,
        gatewayNamespace,
      });
      const result = await promisify(execFile)(process.execPath, [entry], { timeout: 5_000 });
      expect(result.stdout.trim()).toBe("prepared-worker-started");
      store.transition({ environmentId, from: "ready", to: "orphaned" });
      await coordinator.schedule(deviceId);
      await expect(installer.inspect({ gatewayNamespace, bundleHash })).resolves.toMatchObject({
        status: "missing",
      });
      expect(store.get(coldId)?.state).toBe("attached");
    } finally {
      release.resolve();
      await completion.catch(() => undefined);
      await coordinator.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("retains both reserve slots after foreground timeouts until their raw provider calls settle", async () => {
    const { store, config, root, stateDb } = support.testState;
    support.getDevelopmentProfile().readyWorkers = 3;
    const repository = path.join(root, "source");
    await fs.mkdir(repository);
    await requireGit(repository, ["init", "--quiet"]);
    await requireGit(repository, ["config", "user.name", "Preparation Test"]);
    await requireGit(repository, ["config", "user.email", "preparation@example.invalid"]);
    await fs.writeFile(path.join(repository, "input.txt"), "committed source\n");
    await requireGit(repository, ["add", "."]);
    await requireGit(repository, ["commit", "--quiet", "-m", "source"]);
    const release = createDeferredCore();
    let active = 0;
    let maximumActive = 0;
    const target = { machineClass: "small", platform: "linux", arch: "x64" };
    const provision = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await release.promise;
        throw new Error("provider fixture settled without returning a lease");
      } finally {
        active -= 1;
      }
    });
    const provider = support.createProvider({
      supportedExecutionModes: ["worker-turn"],
      requiresNodeEnrollment: true,
      provisionBeforeInstallation: true,
      supportsProjectPreparation: () => true,
      resolvePreparationTarget: () => target,
      resolvePreparedIdleTimeoutMs: () => 60_000,
      provision,
    });
    const service = createWorkerEnvironmentService({
      store,
      getConfig: () => config,
      resolveProvider: () => provider,
      projectNamespace: "gateway",
      prepareInstallation: async () => support.BUNDLE_ARTIFACT,
      bootstrapWorker: support.testState.bootstrapWorker,
      prepareNodeArtifacts: async () => ({
        artifacts: {
          nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
          enabledPluginIds: [...support.NODE_BOOTSTRAP.enabledPluginIds],
          workerBundleHash: support.BUNDLE_HASH,
          workerArchiveSha256: support.BUNDLE_ARTIFACT.tarballSha256,
          openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
          protocolFeatures: [],
        },
        assertCurrent: () => {},
      }),
      prepareNodeEnrollment: async () => {
        throw new Error("fixture never enrolls");
      },
      executeInference: async () => ({ type: "error", reason: "cancelled", message: "unused" }),
      now: () => support.testState.nowMs,
      providerCallTimeoutMs: 20,
    });
    support.testState.service = service;
    const intent = await service.prepareProjectIntent("development", {
      projectPath: repository,
      executionMode: "worker-turn",
    });
    store.createIntent({
      environmentId: "source",
      providerId: provider.id,
      profileId: "development",
      profileSnapshot: intent.profileSnapshot,
      provisionOperationId: "source-operation",
    });
    store.transition({ environmentId: "source", from: "requested", to: "provisioning" });
    store.transition({
      environmentId: "source",
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: "source-lease",
        nodeDeviceId: "source-node",
        sharedHost: false,
        ...support.readyPatch("source"),
      },
    });
    const attached = store.transition({
      environmentId: "source",
      from: "ready",
      to: "attached",
      patch: support.attachedPatch("source", "source-session"),
    });
    const placements = createWorkerSessionPlacementStore({
      database: stateDb,
      now: () => support.testState.nowMs,
    });
    let placement = placements.startDispatch({
      sessionId: "source-session",
      sessionKey: "agent:main:source-session",
      agentId: "main",
      executionMode: "worker-turn",
    });
    // Attachment precedes successful activation, which owns reserve demand.
    for (const step of [
      { to: "provisioning", patch: { environmentId: attached.environmentId } },
      { to: "syncing", patch: { workerBundleHash: support.BUNDLE_HASH } },
      {
        to: "starting",
        patch: { remoteWorkspaceDir: "/workspace", workspaceBaseManifestRef: "manifest" },
      },
      { to: "active", patch: { activeOwnerEpoch: attached.ownerEpoch } },
    ] as const) {
      placement = placements.transition({
        sessionId: placement.sessionId,
        from: placement.state,
        to: step.to,
        expectedGeneration: placement.generation,
        patch: step.patch,
      });
    }
    service.schedulePreparedRefill();
    try {
      await support.waitForFast(() => expect(provision).toHaveBeenCalledTimes(2));
      await support.waitForFast(() => {
        expect(
          store
            .list()
            .filter((record) => record.preparation && record.lastError?.includes("timed out"))
            .length,
        ).toBeGreaterThanOrEqual(2);
      });
      await setImmediate();
      expect(active).toBe(2);
      expect(provision).toHaveBeenCalledTimes(2);
      expect(
        store.list().filter((record) => record.preparation && record.state === "requested"),
      ).toHaveLength(1);
      release.resolve();
      await support.waitForFast(() => expect(provision).toHaveBeenCalledTimes(3));
      expect(maximumActive).toBe(2);
      expect(active).toBe(0);
    } finally {
      release.resolve();
      await service.stop();
    }
  });

  it.each([false, true, undefined])(
    "registers a prepared workspace only with an explicit dedicated lease (sharedHost: %s)",
    async (sharedHost) => {
      const { store, config, root, stateDb } = support.testState;
      const repository = path.join(root, "source");
      await fs.mkdir(repository);
      await requireGit(repository, ["init", "--quiet"]);
      await requireGit(repository, ["config", "user.name", "Preparation Test"]);
      await requireGit(repository, ["config", "user.email", "preparation@example.invalid"]);
      await fs.writeFile(path.join(repository, "input.txt"), "committed source\n");
      await requireGit(repository, ["add", "."]);
      await requireGit(repository, ["commit", "--quiet", "-m", "source"]);
      const deviceId = "prepared-service-node";
      const target = { machineClass: "small", platform: "linux", arch: "x64" };
      const registerPreparedWorkspace = vi.fn<
        NonNullable<support.WorkerEnvironmentServiceOptions["registerPreparedWorkspace"]>
      >(async ({ assertCurrent }) => assertCurrent());
      const destroy = vi.fn(async () => {});
      const provision = vi.fn<WorkerProvider["provision"]>(
        async (_profile, _operation, options) => {
          const project = options?.project;
          if (!project?.preparation || !options?.beginNodeEnrollment) {
            throw new Error("Expected admitted project and node enrollment");
          }
          expect(project.preparation.purpose).toBe("session");
          const base = `/home/worker/.openclaw-worker/prepared/gateway/${project.preparation.cacheKey}`;
          const runScript = vi
            .fn()
            .mockResolvedValueOnce(JSON.stringify({ ready: true }))
            .mockResolvedValueOnce(
              JSON.stringify({
                workspaceDir: `${base}/workspace`,
                homeDir: `${base}/home`,
                sourceManifestRef: `sha256:${"d".repeat(64)}`,
              }),
            );
          await project.prepare({ runScript, runScriptWithBudget: runScript, upload: vi.fn() });
          await options.beginNodeEnrollment();
          return {
            leaseId: "prepared-service-lease",
            node: { deviceId },
            ...(sharedHost === undefined ? {} : { sharedHost }),
          };
        },
      );
      const provider = support.createProvider({
        supportedExecutionModes: ["worker-turn"],
        requiresNodeEnrollment: true,
        provisionBeforeInstallation: true,
        supportsProjectPreparation: () => true,
        resolvePreparationTarget: () => target,
        provision,
        destroy,
      });
      const service = createWorkerEnvironmentService({
        store,
        getConfig: () => config,
        resolveProvider: () => provider,
        projectNamespace: "gateway",
        prepareInstallation: async () => support.BUNDLE_ARTIFACT,
        bootstrapWorker: support.testState.bootstrapWorker,
        prepareNodeArtifacts: async () => ({
          artifacts: {
            nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
            enabledPluginIds: [...support.NODE_BOOTSTRAP.enabledPluginIds],
            workerBundleHash: support.BUNDLE_HASH,
            workerArchiveSha256: support.BUNDLE_ARTIFACT.tarballSha256,
            openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
            protocolFeatures: [],
          },
          assertCurrent: () => {},
        }),
        prepareNodeEnrollment: async (record) => {
          const enrolled = store.ensureNodeEnrollment(record.environmentId);
          if (!enrolled.nodeSetupId) {
            throw new Error("Expected persisted enrollment setup");
          }
          bindCloudWorkerSetupCompletion({
            db: stateDb.db,
            completion: {
              setupId: enrolled.nodeSetupId,
              deviceId,
              completedAtMs: support.testState.nowMs,
            },
          });
          return {
            mode: "connect",
            setupId: enrolled.nodeSetupId,
            setupCode: "setup-code",
            nodeBootstrap: support.NODE_BOOTSTRAP,
            openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
            displayName: "Prepared service test",
            waitForDeviceId: async () => deviceId,
          };
        },
        ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT),
        registerPreparedWorkspace,
        executeInference: async () => ({ type: "error", reason: "cancelled", message: "unused" }),
        now: () => support.testState.nowMs,
      });
      support.testState.service = service;
      const creation = service.create(
        "development",
        "prepared-service",
        undefined,
        "worker-turn",
        repository,
      );
      if (sharedHost === false) {
        await expect(creation).resolves.toMatchObject({
          state: "ready",
          nodeDeviceId: deviceId,
          sharedHost: false,
        });
        expect(registerPreparedWorkspace).toHaveBeenCalledOnce();
        expect(destroy).not.toHaveBeenCalled();
      } else {
        await expect(creation).rejects.toMatchObject({
          code: "bootstrap_failure",
          message: expect.stringContaining(
            "Prepared worker requires its dedicated registered workspace",
          ),
        });
        expect(registerPreparedWorkspace).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["before-registration", "during-registration", "after-ready"] as const)(
    "does not recreate a prepared binding when its owner closes %s",
    async (phase) => {
      const store = support.testState.store;
      const key = "a".repeat(64);
      const cacheKey = "e".repeat(64);
      const deviceId = "fresh-prepared-node";
      const environmentId = "prepared-registration";
      store.createIntent({
        environmentId,
        providerId: "fake",
        profileId: "development",
        provisionOperationId: "prepare-registration",
        profileSnapshot: {
          settings: { region: "test" },
          project: {
            key,
            root: support.testState.root,
            baseCommit: "b".repeat(40),
            preparation: {
              key,
              cacheKey,
              contractVersion: 1,
              target: { machineClass: "small", platform: "linux", arch: "x64" },
              artifacts: {
                nodeBootstrapSha256: "c".repeat(64),
                enabledPluginIds: [],
                workerBundleHash: support.BUNDLE_HASH,
                workerArchiveSha256: support.BUNDLE_ARTIFACT.tarballSha256,
                openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
                protocolFeatures: [],
              },
            },
          },
        },
      });
      store.transition({ environmentId, from: "requested", to: "provisioning" });
      const enrolled = store.ensureNodeEnrollment(environmentId);
      if (!enrolled.nodeSetupId) {
        throw new Error("Missing enrollment setup");
      }
      bindCloudWorkerSetupCompletion({
        db: support.testState.stateDb.db,
        completion: {
          setupId: enrolled.nodeSetupId,
          deviceId,
          completedAtMs: support.testState.nowMs,
        },
      });
      const record = store.ensureNodeEnrollment(environmentId);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let retainedAssert: (() => void) | undefined;
      const registerPreparedWorkspace = vi.fn(async (params: { assertCurrent: () => void }) => {
        retainedAssert = params.assertCurrent;
        params.assertCurrent();
        if (phase === "during-registration") {
          entered.resolve();
          await release.promise;
          params.assertCurrent();
        }
      });
      const patch = { leaseId: "prepared-lease", sharedHost: false, desktop: null };
      const commitReady = vi.fn(() =>
        store.transition({
          environmentId,
          from: "provisioning",
          to: "ready",
          patch: { ...patch, nodeDeviceId: deviceId, ...support.readyPatch(environmentId) },
        }),
      );
      const provisioning = createWorkerNodeProvisioning({
        store,
        isStopping: () => false,
        prepareInstallation: async () => support.BUNDLE_ARTIFACT,
        ensureNodeWorkerBundle: async () => {
          if (phase === "before-registration") {
            entered.resolve();
            await release.promise;
          }
          return support.BOOTSTRAP_RECEIPT;
        },
        registerPreparedWorkspace,
        commitReady,
        failBootstrap: async (_record, _lease, _provider, error) => {
          throw error;
        },
        move: (current, to, transitionPatch) =>
          store.transition({ environmentId, from: current.state, to, patch: transitionPatch }),
        serviceError: (_code, message) => new Error(message),
      });
      const completion = provisioning.finish(
        record,
        { leaseId: patch.leaseId, sharedHost: false, node: { deviceId } },
        support.createProvider(),
        patch,
        support.BUNDLE_ARTIFACT,
        undefined,
        {
          preparationKey: key,
          cacheKey,
          workspaceDir: "/prepared/workspace",
          homeDir: "/prepared/home",
          sourceManifestRef: `sha256:${"d".repeat(64)}`,
        },
      );
      const settled = completion.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        if (phase !== "after-ready") {
          await Promise.race([entered.promise, settled]);
          if (phase === "during-registration") {
            expect(registerPreparedWorkspace).toHaveBeenCalledOnce();
          }
          // A ready owner with no node binding row is still used; missing state
          // cannot authorize registration under a retained provisioning callback.
          store.transition({
            environmentId,
            from: "provisioning",
            to: "ready",
            patch: { ...patch, nodeDeviceId: deviceId, ...support.readyPatch(environmentId) },
          });
          release.resolve();
          expect(await settled).toMatchObject({ error: { name: "AbortError" } });
          expect(commitReady).not.toHaveBeenCalled();
        } else {
          expect(await settled).toMatchObject({ value: { state: "ready" } });
          expect(commitReady).toHaveBeenCalledOnce();
        }
        expect(registerPreparedWorkspace).toHaveBeenCalledTimes(
          phase === "before-registration" ? 0 : 1,
        );
        if (phase !== "before-registration") {
          expect(retainedAssert).toBeTypeOf("function");
          expect(() => retainedAssert!()).toThrow("Worker provisioning operation is closed");
        }
      } finally {
        release.resolve();
        await settled;
      }
    },
  );
});
