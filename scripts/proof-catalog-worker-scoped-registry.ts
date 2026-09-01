/**
 * Production-boundary proof for the openclaw-crb2 model-catalog worker scope.
 *
 * This starts the real prepared-runtime build and worker against the bundled manifests installed
 * in this checkout. The worker itself resolves the scoped registry, imports contributors, builds
 * the full catalog, and runs the fail-closed coverage guard before returning. No catalog rows are
 * synthesized by this script.
 *
 * Run: pnpm tsx scripts/proof-catalog-worker-scoped-registry.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unregisterResolvedAgentDir } from "../src/agents/agent-dir-registry.js";
import { preparePublishedModelCatalogOwnerIdentity } from "../src/agents/prepared-model-catalog-owner.js";
import { resolveModelCatalogPluginScope } from "../src/agents/prepared-model-catalog-plugin-scope.js";
import { loadPreparedModelRuntimeAuth } from "../src/agents/prepared-model-runtime-auth.js";
import { startSerializedSnapshotBuild } from "../src/agents/prepared-model-runtime.build.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-worker-proof-"));
const stateDir = path.join(root, "state");
const agentDir = path.join(stateDir, "agents", "proof", "agent");
const workspaceDir = path.join(root, "workspace");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(workspaceDir, { recursive: true });

const config = {} satisfies OpenClawConfig;
const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
const input = {
  agentId: "proof",
  agentDir,
  inheritedAuthDir: agentDir,
  workspaceDir,
  config,
  env,
  readOnly: true,
};
let current = true;

try {
  const build = startSerializedSnapshotBuild(
    {
      input,
      catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
      isGenerationCurrent: () => current,
    },
    new Map(),
    180_000,
    "static",
  );
  const prepared = await build.pending;
  const metadata = prepared.pluginGeneration.pluginMetadataSnapshot;
  const scope = resolveModelCatalogPluginScope(metadata);

  assert.ok(metadata.manifestRegistry.plugins.length > 0, "installed manifest registry is empty");
  assert.ok(scope.pluginIds.length > 0, "worker scope is empty");
  assert.ok(scope.excludedPluginIds.length > 0, "worker scope did not exclude any plugin");

  const catalog = await prepared.snapshot.loadFullModelCatalog?.();
  assert.ok(catalog, "prepared runtime omitted the full-catalog worker");
  assert.ok(catalog.entries.length > 0, "real worker returned an empty catalog");

  const providers = new Set([
    ...catalog.entries.map((entry) => entry.provider),
    ...catalog.routeVariants.map((entry) => entry.provider),
    ...(catalog.staticEntries ?? []).map((entry) => entry.provider),
    ...(catalog.providerOutcomes ?? []).map((outcome) => outcome.provider),
  ]);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        boundary: "prepared-runtime-full-catalog-worker",
        installedManifestCount: metadata.manifestRegistry.plugins.length,
        scopedPluginCount: scope.pluginIds.length,
        excludedPluginCount: scope.excludedPluginIds.length,
        expectedProviderCount: scope.expectedProviderIds.length,
        returnedEntryCount: catalog.entries.length,
        returnedProviderCount: providers.size,
      },
      null,
      2,
    ),
  );

  current = false;
  await Promise.allSettled([
    loadPreparedModelRuntimeAuth(prepared.snapshot, { providerIds: [] }),
    build.completion,
  ]);
} finally {
  current = false;
  unregisterResolvedAgentDir({ agentId: "proof", agentDir, env });
  fs.rmSync(root, { recursive: true, force: true });
}
