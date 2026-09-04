import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { preparePublishedModelCatalogOwnerIdentity } from "./prepared-model-catalog-owner.js";
import {
  createPreparedModelCatalogWorker,
  createPreparedModelCatalogWorkerInput,
} from "./prepared-model-catalog-worker.js";
import {
  EXTERNAL_AUTH_PATH_ENV,
  HARNESS_ID,
  PLUGIN_ID,
  PROVIDER_ID,
  writeFixturePlugin,
} from "./prepared-model-catalog-worker.test-support.js";
import { startSerializedSnapshotBuildBatch } from "./prepared-model-runtime.build.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest, waitForWorkers } = usePreparedCatalogWorkerFixtures();

const DRIFTED_OWNER_FINGERPRINT = "owner-generation-drifted";

/** A prepared generation whose owner hands its worker a real lifecycle plan. */
async function createMismatchFixture() {
  const root = makeTempDir("openclaw-model-catalog-mismatch-");
  const stateDir = path.join(root, "state");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const workspaceDir = path.join(root, "workspace");
  const marker = path.join(root, "worker-marker.txt");
  const externalAuthPath = path.join(root, "external-auth.txt");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const pluginFile = writeFixturePlugin({ root, spinMs: 0 });
  fs.writeFileSync(externalAuthPath, "A", "utf8");
  const env = {
    ...process.env,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_WORKER_CATALOG_MARKER: marker,
    [EXTERNAL_AUTH_PATH_ENV]: externalAuthPath,
  };
  const config = {
    agents: {
      defaults: {
        model: `${PROVIDER_ID}/sqlite-model`,
        models: { [`${PROVIDER_ID}/sqlite-model`]: { agentRuntime: { id: HARNESS_ID } } },
      },
    },
    plugins: {
      allow: [PLUGIN_ID],
      load: { paths: [pluginFile] },
      entries: { [PLUGIN_ID]: { enabled: true } },
    },
  } satisfies OpenClawConfig;
  const input = {
    agentId: "main",
    agentDir,
    inheritedAuthDir: agentDir,
    workspaceDir,
    config,
    env,
  };
  let current = true;
  const isCurrent = () => current;
  retireAfterTest(() => {
    current = false;
  });
  const build = (
    await startSerializedSnapshotBuildBatch(
      [
        {
          input,
          catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
          isGenerationCurrent: isCurrent,
          isBuildCurrent: isCurrent,
        },
      ],
      new Map(),
      30_000,
      "static",
      undefined,
      undefined,
    ).pending
  )[0]!;
  const workerInput = createPreparedModelCatalogWorkerInput({
    agentFacts: {
      input: { agentId: "main", agentDir, workspaceDir, config, env },
      env,
      authStore: { version: 1, profiles: {} },
      credentials: {},
      providerIds: [PROVIDER_ID],
      configuredModelRefs: [],
      configuredRuntimeModels: [],
      runtimeCapabilityModels: [],
      configuredGeneratedCatalogPluginIds: [],
      templateAuthStorage: AuthStorage.inMemory({}),
    } satisfies PreparedModelRuntimeAgentFacts,
    pluginMetadataSnapshot: build.pluginGeneration.pluginMetadataSnapshot,
    preferBuiltPluginArtifacts: build.pluginGeneration.preferBuiltPluginArtifacts,
  });
  return { agentDir, marker, isCurrent, workerInput };
}

function trackSpawnedWorkers(
  run: (spawned: readonly Worker[]) => Promise<void>,
  onSpawn?: (worker: Worker) => void,
) {
  const spawned: Worker[] = [];
  const workerChannel = channel("worker_threads");
  const trackWorker = (message: unknown) => {
    if (isRecord(message) && message.worker instanceof Worker) {
      spawned.push(message.worker);
      onSpawn?.(message.worker);
    }
  };
  workerChannel.subscribe(trackWorker);
  return run(spawned).finally(() => workerChannel.unsubscribe(trackWorker));
}

describe("prepared model catalog worker generation mismatch", () => {
  beforeEach(() => {
    vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-worker-empty-codex-"));
  });

  it("retires a worker that reconstructs another generation instead of publishing its facts", async () => {
    const fixture = await createMismatchFixture();
    await trackSpawnedWorkers(async (spawned) => {
      const worker = createPreparedModelCatalogWorker({
        input: { ...fixture.workerInput, generationFingerprint: DRIFTED_OWNER_FINGERPRINT },
        isCurrent: fixture.isCurrent,
      });

      const mismatch = await worker
        .loadAuth({ providerIds: [PROVIDER_ID] })
        .catch((error: unknown) => error);
      expect(mismatch).toBeInstanceOf(Error);
      expect(mismatch).toMatchObject({
        name: "PreparedModelCatalogGenerationMismatchError",
        agentDir: fixture.agentDir,
        generationFingerprint: DRIFTED_OWNER_FINGERPRINT,
        reconstructedFingerprint: fixture.workerInput.generationFingerprint,
      });
      expect(spawned).toHaveLength(1);

      // Retired, not wedged: the next request rebuilds a worker from the same plan and
      // reports the same typed outcome rather than a cached terminal error.
      await expect(worker.loadCatalog()).rejects.toMatchObject({
        name: "PreparedModelCatalogGenerationMismatchError",
      });
      expect(spawned).toHaveLength(2);
      expect(fs.existsSync(fixture.marker)).toBe(false);
    });
  });

  it("fences queued requests behind a transient mismatch and rebuilds a matching worker", async () => {
    const fixture = await createMismatchFixture();
    // Inject a mismatch only at the first worker clone boundary. This drives the real owner,
    // pool, and worker without depending on the production-only environmental trigger.
    let drifted = true;
    const transientInput = { ...fixture.workerInput };
    Object.defineProperty(transientInput, "generationFingerprint", {
      enumerable: true,
      get: () => (drifted ? DRIFTED_OWNER_FINGERPRINT : fixture.workerInput.generationFingerprint),
    });
    await trackSpawnedWorkers(async (spawned) => {
      const worker = createPreparedModelCatalogWorker({
        input: transientInput,
        isCurrent: fixture.isCurrent,
      });

      // Concurrent auth + catalog: the second request queues behind the first on the single
      // worker. The mismatch must fence the pool before that successor can dispatch.
      const [auth, catalog] = await Promise.all([
        worker.loadAuth({ providerIds: [PROVIDER_ID] }).catch((error: unknown) => error),
        worker.loadCatalog().catch((error: unknown) => error),
      ]);
      expect(auth).toMatchObject({ name: "PreparedModelCatalogGenerationMismatchError" });
      expect(catalog).toMatchObject({ name: "PreparedModelCatalogGenerationMismatchError" });
      expect(catalog).toMatchObject({
        agentDir: fixture.agentDir,
        generationFingerprint: DRIFTED_OWNER_FINGERPRINT,
        reconstructedFingerprint: fixture.workerInput.generationFingerprint,
      });
      expect(spawned).toHaveLength(1);
      // The queued catalog request never ran on the retired worker: no catalog hook executed.
      expect(fs.existsSync(fixture.marker)).toBe(false);
      await waitForWorkers();

      // Not latched: once the injection clears, the same owner rebuilds from its prepared facts
      // and publishes the full catalog.
      drifted = false;
      const recovered = await worker.loadCatalog();
      expect(spawned).toHaveLength(2);
      expect(recovered.entries).toContainEqual(
        expect.objectContaining({ provider: PROVIDER_ID, id: "account-scoped-model" }),
      );
      expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\ndone\n");
      await expect(worker.loadAuth({ providerIds: [PROVIDER_ID] })).resolves.toMatchObject({
        authStore: expect.objectContaining({ version: 1 }),
      });
      expect(spawned).toHaveLength(2);
    });
  });

  it("keeps a replacement worker alive when an old mismatch finishes retiring", async () => {
    const fixture = await createMismatchFixture();
    const stopped = createDeferredCore();
    const releaseTermination = createDeferredCore();
    const replacementStarted = createDeferredCore();
    let restoreTermination: (() => void) | undefined;
    let drifted = true;
    const transientInput = { ...fixture.workerInput };
    Object.defineProperty(transientInput, "generationFingerprint", {
      enumerable: true,
      get: () => (drifted ? DRIFTED_OWNER_FINGERPRINT : fixture.workerInput.generationFingerprint),
    });
    await trackSpawnedWorkers(
      async (spawned) => {
        const worker = createPreparedModelCatalogWorker({
          input: transientInput,
          isCurrent: fixture.isCurrent,
        });
        const auth = worker
          .loadAuth({ providerIds: [PROVIDER_ID] })
          .catch((error: unknown) => error);
        const queued = worker.loadCatalog().catch((error: unknown) => error);
        let replacement: ReturnType<typeof worker.loadCatalog> | undefined;
        try {
          // The queued catch can retire the old pool while the active request still
          // awaits termination. An independent caller need not await either public result.
          await Promise.race([
            stopped.promise,
            Promise.all([auth, queued]).then(() => {
              throw new Error("Expected the old worker's held termination");
            }),
          ]);
          drifted = false;
          replacement = worker.loadCatalog();
          const outcome = replacement.catch((error: unknown) => error);
          await Promise.race([
            replacementStarted.promise,
            outcome.then(() => {
              throw new Error("Expected an independent replacement worker");
            }),
          ]);
          expect(spawned).toHaveLength(2);

          releaseTermination.resolve();
          const initial = await Promise.all([auth, queued]);
          for (const failure of initial) {
            expect(failure).toMatchObject({ name: "PreparedModelCatalogGenerationMismatchError" });
          }
          expect(await outcome).toMatchObject({
            entries: expect.arrayContaining([
              expect.objectContaining({ provider: PROVIDER_ID, id: "account-scoped-model" }),
            ]),
          });
          await expect(worker.loadAuth({ providerIds: [PROVIDER_ID] })).resolves.toMatchObject({
            authStore: expect.objectContaining({ version: 1 }),
          });
          expect(spawned).toHaveLength(2);
        } finally {
          releaseTermination.resolve();
          await Promise.allSettled([auth, queued, replacement]);
          restoreTermination?.();
        }
      },
      (worker) => {
        if (restoreTermination) {
          replacementStarted.resolve();
          return;
        }
        const terminate = worker.terminate.bind(worker);
        const spy = vi.spyOn(worker, "terminate").mockImplementation(async () => {
          const code = await terminate();
          stopped.resolve();
          await releaseTermination.promise;
          return code;
        });
        restoreTermination = () => spy.mockRestore();
      },
    );
  });
});
