/**
 * Real-behavior proof for the app-server runtime-chooser bindings fix.
 *
 * What is REAL here (no vitest, no mocks of the seam under test):
 *   - `buildPreparedModelsProviderData()` from
 *     src/auto-reply/reply/commands-models.ts —
 *     the exact production function that builds `/models` provider data.
 *   - The real plugin registry (`setActivePluginRegistry` with a real empty
 *     registry), so no CLI runtime backends are registered. Every runtime choice
 *     observed below therefore comes from the app-server binding list under test,
 *     not from a CLI backend that happened to be registered.
 *   - `listAppServerRuntimeModelBackendBindings()` and the real bundled plugin
 *     manifests read off disk via `listBundledPluginMetadata()`.
 *   - The downstream selection lookup is reproduced exactly as the Discord model
 *     picker does it (extensions/discord/src/monitor/
 *     native-command-model-picker-interaction.ts): index into
 *     `runtimeChoicesByProvider.get(provider)` and read `.id`.
 *
 * What is stubbed: nothing between the entrypoint and the assertions. Providers
 * are declared inline in the config (a first-class production path) so the proof
 * needs no network and no ambient credentials.
 *
 * Scenarios:
 *   1. github-copilot — the bug. Before the fix the provider had NO chooser
 *      entry at all; after it, the Copilot runtime is offered and selectable.
 *   2. openai — regression guard. The pre-existing Codex chooser still works.
 *   3. A provider served by no app-server harness — stays absent from the
 *      chooser map, proving the fix did not blanket-add choosers everywhere.
 *   4. Disabled owner — a runtime whose bundled plugin is disabled is hidden
 *      instead of leaving a chooser entry that can only fail.
 *   5. Binding coverage — every agent harness declared by a real bundled
 *      manifest on disk has a binding row.
 *   6. `/model <provider>/<model> --runtime <runtime>` directive acceptance —
 *      the real `resolveModelRuntimeDirective()` accepts the same Copilot and
 *      Codex pairings the chooser offers.
 *   7. Directive gating — when the owning plugin is disabled, the directive is
 *      rejected with an actionable message instead of persisting an override
 *      that dead-ends the next turn in `ensureSelectedAgentHarnessPlugin()`.
 *      Proven for both bridge harnesses, and `applyModelRuntimeDirective()` is
 *      run to show nothing is written to the session entry.
 *   8. Gate exemptions — the built-in `openclaw` runtime and an incompatible
 *      runtime keep their existing outcomes.
 *   9. Next-turn consequence — the real `ensureSelectedAgentHarnessPlugin()`
 *      is run against the real (empty) registry a disabled owner produces. It
 *      throws for the override the pre-fix directive persisted, and the
 *      post-fix directive never persists that override, so the throw is
 *      unreachable. This closes the causal chain the review described without
 *      needing GitHub Copilot credentials.
 *
 * Run: pnpm tsx scripts/proof-app-server-runtime-chooser-bindings.ts
 */
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

type CommandsModelsModule = typeof import("../src/auto-reply/reply/commands-models.js");
type BindingsModule = typeof import("../src/agents/app-server-runtime-bindings.js");
type BundledMetadataModule = typeof import("../src/plugins/bundled-plugin-metadata.js");
type PluginRuntimeModule = typeof import("../src/plugins/runtime.js");
type RegistryEmptyModule = typeof import("../src/plugins/registry-empty.js");
type DirectiveRuntimeModule =
  typeof import("../src/auto-reply/reply/directive-handling.model-runtime.js");
type HarnessRuntimePluginModule = typeof import("../src/agents/harness/runtime-plugin.js");
type OpenClawConfig = import("../src/config/types.openclaw.js").OpenClawConfig;

const repoRoot = process.env.PROOF_REPO_ROOT ?? process.cwd();
const importSource = async (relativePath: string) =>
  import(pathToFileURL(path.join(repoRoot, relativePath)).href);

const { buildPreparedModelsProviderData } = (await importSource(
  "src/auto-reply/reply/commands-models.ts",
)) as CommandsModelsModule;
const { listAppServerRuntimeModelBackendBindings } = (await importSource(
  "src/agents/app-server-runtime-bindings.ts",
)) as BindingsModule;
const { listBundledPluginMetadata } = (await importSource(
  "src/plugins/bundled-plugin-metadata.ts",
)) as BundledMetadataModule;
const { setActivePluginRegistry } = (await importSource(
  "src/plugins/runtime.ts",
)) as PluginRuntimeModule;
const { createEmptyPluginRegistry } = (await importSource(
  "src/plugins/registry-empty.ts",
)) as RegistryEmptyModule;
const { applyModelRuntimeDirective, resolveModelRuntimeDirective } = (await importSource(
  "src/auto-reply/reply/directive-handling.model-runtime.ts",
)) as DirectiveRuntimeModule;
const { ensureSelectedAgentHarnessPlugin } = (await importSource(
  "src/agents/harness/runtime-plugin.ts",
)) as HarnessRuntimePluginModule;

// A real, empty registry: no CLI backends registered, so nothing below can be
// attributed to listCliRuntimeModelBackendBindings().
setActivePluginRegistry(createEmptyPluginRegistry());

/** Mirrors the Discord picker's runtime selection: 1-based index -> runtime id. */
function selectRuntimeChoiceId(params: {
  data: Awaited<ReturnType<typeof buildPreparedModelsProviderData>>;
  provider: string;
  runtimeIndex: number;
}): string | undefined {
  const choices = params.data.runtimeChoicesByProvider?.get(params.provider);
  return choices?.[params.runtimeIndex - 1]?.id;
}

const config = {
  models: {
    providers: {
      "github-copilot": {
        baseUrl: "https://api.individual.githubcopilot.com",
        apiKey: "proof-github-copilot-key",
        models: [{ id: "claude-opus-4-6", name: "Claude Opus 4.6" }],
      },
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "proof-openai-key",
        models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
      },
      "proof-standalone": {
        baseUrl: "https://proof-standalone.example.test/v1",
        apiKey: "proof-standalone-key",
        models: [{ id: "proof-model", name: "Proof Model" }],
      },
    },
  },
  agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
} as unknown as OpenClawConfig;

const data = await buildPreparedModelsProviderData(config);

function runtimeIdsFor(provider: string): string[] {
  return (data.runtimeChoicesByProvider?.get(provider) ?? []).map((choice) => choice.id);
}

// --- Scenario 1: github-copilot gets a Copilot runtime choice (the bug). -----
const copilotChoices = data.runtimeChoicesByProvider?.get("github-copilot");
assert.ok(
  copilotChoices,
  "github-copilot has NO runtime chooser entry at all — this is the reported bug",
);
assert.ok(
  runtimeIdsFor("github-copilot").includes("copilot"),
  `github-copilot chooser is missing the copilot runtime; got ${JSON.stringify(runtimeIdsFor("github-copilot"))}`,
);
const copilotIndex = runtimeIdsFor("github-copilot").indexOf("copilot") + 1;
assert.equal(
  selectRuntimeChoiceId({ data, provider: "github-copilot", runtimeIndex: copilotIndex }),
  "copilot",
  "selecting the Copilot entry through the picker lookup did not resolve to the copilot runtime",
);
const copilotChoice = copilotChoices.find((choice) => choice.id === "copilot");
assert.equal(
  copilotChoice?.label,
  "GitHub Copilot",
  `Copilot chooser entry renders a raw id instead of a label: ${JSON.stringify(copilotChoice)}`,
);
console.log(
  `[1] github-copilot runtime choices: ${JSON.stringify(runtimeIdsFor("github-copilot"))}`,
);

// --- Scenario 2: openai still offers Codex (no regression). -----------------
assert.ok(
  runtimeIdsFor("openai").includes("codex"),
  `openai lost its Codex runtime choice; got ${JSON.stringify(runtimeIdsFor("openai"))}`,
);
console.log(`[2] openai runtime choices: ${JSON.stringify(runtimeIdsFor("openai"))}`);

// --- Scenario 3: a provider with no app-server harness stays absent. --------
assert.equal(
  data.runtimeChoicesByProvider?.get("proof-standalone"),
  undefined,
  "a provider served by no app-server harness must not gain a runtime chooser",
);
console.log("[3] proof-standalone runtime choices: absent (as expected)");

// --- Scenario 4: disabled harness owners are not advertised. ----------------
const disabledCopilotData = await buildPreparedModelsProviderData({
  ...config,
  plugins: { entries: { copilot: { enabled: false } } },
});
assert.equal(
  disabledCopilotData.runtimeChoicesByProvider?.get("github-copilot"),
  undefined,
  "disabled Copilot owner plugin must not leave an unusable runtime choice",
);
console.log("[4] disabled Copilot runtime choices: absent (as expected)");

// --- Scenario 5: every bundled app-server harness has a binding. ------------
const boundRuntimes = new Set(
  listAppServerRuntimeModelBackendBindings().map((binding) => binding.runtime),
);
const bundledHarnessIds = new Set<string>();
for (const entry of listBundledPluginMetadata({ includeChannelConfigs: false })) {
  const cliBackends = new Set(entry.manifest.cliBackends ?? []);
  for (const harnessId of entry.manifest.activation?.onAgentHarnesses ?? []) {
    if (!cliBackends.has(harnessId)) {
      bundledHarnessIds.add(harnessId);
    }
  }
}
assert.ok(bundledHarnessIds.size > 0, "read zero bundled agent harnesses — the scan is broken");
const unbound = [...bundledHarnessIds].filter((harnessId) => !boundRuntimes.has(harnessId));
assert.deepEqual(
  unbound,
  [],
  `bundled agent harness(es) ${unbound.join(", ")} ship with no model-provider binding`,
);
console.log(
  `[5] bundled app-server harnesses ${JSON.stringify([...bundledHarnessIds].toSorted())} all bound`,
);

// --- Scenario 6: the /model directive accepts what the chooser offers. ------
for (const [provider, runtime] of [
  ["github-copilot", "copilot"],
  ["openai", "codex"],
] as const) {
  const resolution = resolveModelRuntimeDirective({ rawRuntime: runtime, provider, cfg: config });
  assert.deepEqual(
    resolution,
    { kind: "set", runtime },
    `/model ${provider}/... --runtime ${runtime} was not accepted: ${JSON.stringify(resolution)}`,
  );
}
console.log("[6] directive accepts github-copilot/copilot and openai/codex");

// --- Scenario 7: a disabled harness owner is rejected, not persisted. -------
for (const [provider, runtime, pluginId] of [
  ["github-copilot", "copilot", "copilot"],
  ["openai", "codex", "codex"],
] as const) {
  const disabledConfig = {
    ...config,
    plugins: { entries: { [pluginId]: { enabled: false } } },
  } as unknown as OpenClawConfig;
  const resolution = resolveModelRuntimeDirective({
    rawRuntime: runtime,
    provider,
    cfg: disabledConfig,
  });
  assert.equal(
    resolution.kind,
    "invalid",
    `--runtime ${runtime} was accepted while plugin "${pluginId}" is disabled: ${JSON.stringify(resolution)}`,
  );
  assert.ok(
    resolution.kind === "invalid" && resolution.errorText.includes(runtime),
    `rejection text does not name the runtime: ${JSON.stringify(resolution)}`,
  );
  const entry: { agentRuntimeOverride?: string } = {};
  assert.deepEqual(
    applyModelRuntimeDirective(entry, resolution),
    { updated: false },
    "a rejected runtime directive reported a session mutation",
  );
  assert.equal(
    entry.agentRuntimeOverride,
    undefined,
    `a rejected runtime directive persisted an unusable override: ${JSON.stringify(entry)}`,
  );
  console.log(
    `[7] ${provider}/--runtime ${runtime} with "${pluginId}" disabled: ${resolution.kind}`,
  );
}

// --- Scenario 8: exemptions and incompatible runtimes are unchanged. --------
assert.deepEqual(
  resolveModelRuntimeDirective({
    rawRuntime: "openclaw",
    provider: "github-copilot",
    cfg: { ...config, plugins: { entries: { copilot: { enabled: false } } } } as OpenClawConfig,
  }),
  { kind: "set", runtime: "openclaw" },
  "the built-in openclaw runtime must not be gated on a harness owner plugin",
);
const incompatible = resolveModelRuntimeDirective({
  rawRuntime: "copilot",
  provider: "proof-standalone",
  cfg: config,
});
assert.ok(
  incompatible.kind === "invalid" &&
    incompatible.errorText.includes("is not supported for proof-standalone"),
  `an incompatible runtime must keep its unsupported message: ${JSON.stringify(incompatible)}`,
);
console.log("[8] openclaw runtime ungated; incompatible runtime keeps its unsupported message");

// --- Scenario 9: the next turn the gate protects. ---------------------------
const disabledCopilotConfig = {
  ...config,
  plugins: { entries: { copilot: { enabled: false } } },
} as unknown as OpenClawConfig;
// The registry a disabled owner plugin produces: real, and without the harness.
const registryWithoutCopilot = createEmptyPluginRegistry();
let nextTurnError: unknown;
try {
  await ensureSelectedAgentHarnessPlugin({
    provider: "github-copilot",
    modelId: "claude-opus-4-6",
    config: disabledCopilotConfig,
    // The override the PRE-FIX directive persisted for this exact selection.
    agentHarnessRuntimeOverride: "copilot",
    workspaceDir: repoRoot,
    pluginRegistry: registryWithoutCopilot,
  });
} catch (error) {
  nextTurnError = error;
}
assert.ok(
  nextTurnError instanceof Error &&
    nextTurnError.message.includes('Agent harness runtime "copilot" is unavailable'),
  `expected the next turn to fail for a persisted-but-unavailable runtime, got ${String(nextTurnError)}`,
);
console.log(
  `[9] pre-fix persisted override fails the next turn: ${(nextTurnError as Error).message.split(".")[0]}.`,
);

// With the gate, the same selection persists nothing, so the next turn runs the
// default policy instead of the unavailable harness.
const gatedEntry: { agentRuntimeOverride?: string } = {};
applyModelRuntimeDirective(
  gatedEntry,
  resolveModelRuntimeDirective({
    rawRuntime: "copilot",
    provider: "github-copilot",
    cfg: disabledCopilotConfig,
  }),
);
assert.equal(gatedEntry.agentRuntimeOverride, undefined, "gate leaked an override");
await ensureSelectedAgentHarnessPlugin({
  provider: "github-copilot",
  modelId: "claude-opus-4-6",
  config: disabledCopilotConfig,
  ...(gatedEntry.agentRuntimeOverride
    ? { agentHarnessRuntimeOverride: gatedEntry.agentRuntimeOverride }
    : {}),
  workspaceDir: repoRoot,
  pluginRegistry: registryWithoutCopilot,
});
console.log("[9] post-fix: nothing persisted, so the next turn starts without throwing");

console.log("All runtime assertions passed.");
