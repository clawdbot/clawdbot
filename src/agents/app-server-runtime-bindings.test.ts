// Guards that every bundled app-server agent harness has a runtime-chooser binding.
import { describe, expect, it } from "vitest";
import { listBundledPluginMetadata } from "../plugins/bundled-plugin-metadata.js";
import { listAppServerRuntimeModelBackendBindings } from "./app-server-runtime-bindings.js";

/**
 * Harness ids declared by bundled extensions that are NOT CLI backends. CLI
 * backends declare `modelProvider` on their registration and are covered by
 * `listCliRuntimeModelBackendBindings()`; everything else is an app-server
 * harness whose provider pairing only exists in
 * `listAppServerRuntimeModelBackendBindings()`.
 */
function listBundledAppServerHarnessIds(): readonly string[] {
  const harnessIds = new Set<string>();
  for (const entry of listBundledPluginMetadata({ includeChannelConfigs: false })) {
    const cliBackends = new Set(entry.manifest.cliBackends ?? []);
    for (const harnessId of entry.manifest.activation?.onAgentHarnesses ?? []) {
      if (!cliBackends.has(harnessId)) {
        harnessIds.add(harnessId);
      }
    }
  }
  return [...harnessIds].toSorted((left, right) => left.localeCompare(right));
}

describe("listAppServerRuntimeModelBackendBindings", () => {
  it("binds every bundled app-server harness to a model provider", () => {
    const harnessIds = listBundledAppServerHarnessIds();
    // A vacuous pass would hide the very regression this test exists to catch.
    expect(harnessIds.length).toBeGreaterThan(0);

    const boundRuntimes = new Set(
      listAppServerRuntimeModelBackendBindings().map((binding) => binding.runtime),
    );
    const unbound = harnessIds.filter((harnessId) => !boundRuntimes.has(harnessId));
    expect(
      unbound,
      `bundled agent harness(es) ${unbound.join(", ")} have no model-provider binding, so /models offers no runtime chooser for the provider(s) they serve. Add a row to APP_SERVER_RUNTIME_MODEL_BACKEND_BINDINGS in src/agents/app-server-runtime-bindings.ts.`,
    ).toEqual([]);
  });

  it("covers the codex and copilot harnesses shipped today", () => {
    expect(listBundledAppServerHarnessIds()).toEqual(expect.arrayContaining(["codex", "copilot"]));
    expect(listAppServerRuntimeModelBackendBindings()).toEqual(
      expect.arrayContaining([
        { provider: "openai", runtime: "codex" },
        { provider: "github-copilot", runtime: "copilot" },
      ]),
    );
  });

  it("declares each runtime once so the chooser cannot list duplicates", () => {
    const runtimes = listAppServerRuntimeModelBackendBindings().map((binding) => binding.runtime);
    expect(runtimes).toEqual([...new Set(runtimes)]);
  });
});
