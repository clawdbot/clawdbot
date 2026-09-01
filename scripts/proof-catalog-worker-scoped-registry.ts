/**
 * Real-behavior proof for the openclaw-crb2 model-catalog plugin scope.
 *
 * What is REAL here (no vitest, no mocks of the seam under test):
 *   - `resolveModelCatalogPluginScope()` — the exact production function the worker calls.
 *   - `assertPreparedModelCatalogWorkerCoverage()` — the production fail-crash guard.
 *   - The real bundled plugin manifests read off disk via the real metadata-snapshot builder,
 *     so the scope is computed against every plugin actually installed on this machine.
 *
 * What is stubbed: nothing between the entrypoint and the assertions.
 *
 * The claim being proved is NOT "the scope is small". It is "the scope loses nothing":
 * every provider the full manifest set can produce is still produced by the scoped set.
 *
 * Run: pnpm tsx scripts/proof-catalog-worker-scoped-registry.ts
 */
import assert from "node:assert/strict";

type ScopeModule = typeof import("../src/agents/prepared-model-catalog-plugin-scope.js");
type SnapshotModule = typeof import("../src/plugins/plugin-metadata-snapshot.js");

async function main(): Promise<void> {
  const { resolveModelCatalogPluginScope, assertPreparedModelCatalogWorkerCoverage } =
    (await import("../src/agents/prepared-model-catalog-plugin-scope.js")) as ScopeModule;
  const snapshotModule =
    (await import("../src/plugins/plugin-metadata-snapshot.js")) as SnapshotModule;

  const snapshot = snapshotModule.resolvePluginMetadataSnapshot({
    config: {},
    env: process.env,
    workspaceDir: process.cwd(),
  });

  const totalPlugins = snapshot.manifestRegistry?.plugins?.length ?? 0;
  assert.ok(totalPlugins > 0, "metadata snapshot produced zero manifest records");

  const scope = resolveModelCatalogPluginScope(snapshot);

  console.log("── scenario 1: the scope is a strict, non-degenerate narrowing ──");
  console.log(`   manifests on disk : ${totalPlugins}`);
  console.log(`   scoped in         : ${scope.pluginIds.length}`);
  console.log(`   excluded          : ${scope.excludedPluginIds.length}`);
  console.log(`   expected providers: ${scope.expectedProviderIds.length}`);
  assert.ok(scope.pluginIds.length > 0, "scope must never be empty");
  assert.ok(
    scope.excludedPluginIds.length > 0,
    "scope excluded nothing — the change would be a no-op on this machine",
  );

  console.log("── scenario 2: THE CLAIM — no expected provider is lost ──");
  // Every provider the manifests promise must be reachable from the scoped plugin set.
  // Recompute the producible set from the scoped plugins only, then run the production guard.
  const scoped = new Set(scope.pluginIds);
  const producedByScope = new Set<string>();
  for (const record of snapshot.manifestRegistry.plugins) {
    if (!scoped.has(record.id)) {
      continue;
    }
    for (const providerId of record.providers ?? []) {
      producedByScope.add(providerId);
    }
    for (const providerId of Object.keys(record.modelCatalog?.providers ?? {})) {
      producedByScope.add(providerId);
    }
  }
  for (const map of [
    snapshot.owners?.providers,
    snapshot.owners?.modelCatalogProviders,
    snapshot.owners?.cliBackends,
    snapshot.owners?.setupProviders,
  ]) {
    if (!map) {
      continue;
    }
    for (const [surfaceId, ownerIds] of map.entries()) {
      if (ownerIds.some((id) => scoped.has(id))) {
        producedByScope.add(surfaceId);
      }
    }
  }
  // Production guard, unmodified. Throws naming the missing ids if the scope lost anything.
  assertPreparedModelCatalogWorkerCoverage({
    scope,
    snapshot: {
      entries: [...producedByScope].map((provider) => ({ provider, id: "proof", name: provider })),
      routeVariants: [],
    },
    activeProviderIds: scope.expectedProviderIds,
  });
  console.log(`   ✓ all ${scope.expectedProviderIds.length} expected providers still produced`);

  console.log("── scenario 3: the fail-crash guard actually crashes ──");
  // A guard that never fires is not a guard. Drop one provider and require a throw.
  const victim = scope.expectedProviderIds[0];
  assert.ok(victim, "no expected providers to test the guard with");
  const truncated = new Set(producedByScope);
  truncated.delete(victim);
  assert.throws(
    () =>
      assertPreparedModelCatalogWorkerCoverage({
        scope,
        snapshot: {
          entries: [...truncated].map((provider) => ({ provider, id: "proof", name: provider })),
          routeVariants: [],
        },
        activeProviderIds: scope.expectedProviderIds,
      }),
    /dropped 1 expected provider/,
    "guard did NOT throw on a dropped provider — the safety net is inert",
  );
  console.log(`   ✓ guard threw when "${victim}" was removed`);

  console.log("── scenario 4: known model plugins survive the narrowing ──");
  // Spot-check the plugins whose absence would be most visible, including the agent-harness
  // trap (claude/codex/glm-bridge declare onAgentHarnesses and nothing else model-shaped).
  const installed = new Set(snapshot.manifestRegistry.plugins.map((p) => p.id));
  for (const id of ["openai", "anthropic", "zai", "claude", "codex", "glm-bridge", "copilot"]) {
    if (!installed.has(id)) {
      console.log(`   – ${id}: not installed here, skipped`);
      continue;
    }
    assert.ok(scoped.has(id), `model-relevant plugin "${id}" was excluded by the scope`);
    console.log(`   ✓ ${id} kept (${scope.keptReasons.get(id)?.join("+")})`);
  }

  console.log("\nPROOF PASSED");
}

await main();
