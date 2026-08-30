import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../auth-profiles/runtime-snapshots.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";

export function usePreparedCatalogWorkerFixtures() {
  const waitTimeoutMs = 30_000;
  const retirements = new Set<() => void>();
  const workers = new Set<Worker>();
  // Synchronous capture also covers failures before a worker request is awaited.
  const workerChannel = channel("worker_threads");
  function trackWorker(message: unknown): void {
    if (!isRecord(message) || !(message.worker instanceof Worker)) {
      throw new Error("worker_threads diagnostics omitted the created Worker");
    }
    workers.add(message.worker);
  }
  async function waitForWorkers(): Promise<void> {
    // Retirement removes exit listeners; Node's threadId still records actual termination.
    await expect
      .poll(() => [...workers].map((worker) => worker.threadId).filter((id) => id !== -1), {
        timeout: waitTimeoutMs,
      })
      .toEqual([]);
  }
  beforeEach(() => workerChannel.subscribe(trackWorker));
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(async () => {
      // Direct snapshots bypass registered owners. Fence them even when worker warmup times out,
      // before late continuations can use a removed fixture or enter the next test's catalog queue.
      for (const retire of retirements) {
        retire();
      }
      retirements.clear();
      resetPreparedModelRuntimeSnapshotsForTest();
      try {
        await waitForWorkers();
      } finally {
        // Keep a failed retirement assertion, but never leave its threads in the next test.
        await Promise.all([...workers].map((worker) => worker.terminate()));
        workerChannel.unsubscribe(trackWorker);
        workers.clear();
        clearRuntimeAuthProfileStoreSnapshots();
        closeOpenClawAgentDatabasesForTest();
        cleanup();
      }
    });
  });
  return {
    makeTempDir: (prefix: string) => tempDirs.make(prefix),
    retireAfterTest: (retire: () => void) => {
      retirements.add(retire);
    },
    waitForWorkers,
    waitForMarker: async (marker: string): Promise<void> => {
      await expect.poll(() => fs.existsSync(marker), { timeout: waitTimeoutMs }).toBe(true);
    },
  };
}

export function writeSyntheticAuthDiscoveryFixture(params: {
  root: string;
  pluginDir: string;
  harnessId: string;
  unrelatedId: string;
}): void {
  const probePath = path.join(params.root, "synthetic-auth-probes.txt");
  fs.writeFileSync(
    path.join(params.pluginDir, "provider-discovery.cjs"),
    `const fs = require("node:fs");
module.exports = {
  id: ${JSON.stringify(params.harnessId)},
  hookAliases: [${JSON.stringify(params.unrelatedId)}],
  label: "Worker catalog fixture synthetic auth",
  auth: [],
  resolveSyntheticAuth({ provider }) {
    fs.appendFileSync(${JSON.stringify(probePath)}, provider + "\\n");
    return provider === ${JSON.stringify(params.harnessId)}
      ? { apiKey: "native-login-not-real", source: "fixture native login", mode: "oauth" }
      : undefined;
  },
};
`,
    "utf8",
  );
}

export function markPluginMetadataSnapshotProvided(
  snapshot: PluginMetadataSnapshot,
): PluginMetadataSnapshot {
  return { ...snapshot, registrySource: "provided", registryDiagnostics: [] };
}
