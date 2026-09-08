import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  cleanupPluginLoaderFixturesForTest,
  clearPluginLoaderCache,
  EMPTY_PLUGIN_SCHEMA,
  loadOpenClawPlugins,
  makePluginLoaderTempDir,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import {
  resolveLoadedProviderPluginsForHooks,
  resolveProviderPluginsForHooks,
  resolveProviderRuntimePluginHandle,
} from "./provider-hook-runtime.js";
import { findProviderRuntimePluginInRegistry } from "./provider-registry-selection.js";
import { resolvePluginProvidersCore } from "./providers.runtime.js";
import { setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";

function fixture(
  declaration: "setup" | "activation" | "cli",
  registersProvider = true,
  triggerProvider = "helper-provider",
) {
  const root = makePluginLoaderTempDir();
  const marker = path.join(root, "registrations.log");
  const helper = writePlugin({
    id: "helper-owner",
    dir: root,
    filename: "index.cjs",
    body: `module.exports={id:"helper-owner",register(api){
      require("node:fs").appendFileSync(${JSON.stringify(marker)},"registered");
      ${registersProvider ? 'api.registerProvider({id:"helper-provider",label:"Helper",auth:[]});' : ""}
    }};`,
  });
  const other = writePlugin({
    id: "other-owner",
    filename: "index.cjs",
    body: 'module.exports={id:"other-owner",register(api){api.registerProvider({id:"other-provider",label:"Other",auth:[]});}};',
  });
  const setupSource = path.join(root, "setup.cjs");
  writeFileSync(
    setupSource,
    'module.exports={plugin:{id:"setup-channel",meta:{id:"setup-channel",label:"Setup",selectionLabel:"Setup",docsPath:"/synthetic",blurb:"Synthetic"},capabilities:{chatTypes:["direct"]},config:{listAccountIds:()=>[],resolveAccount:()=>({})}}};',
  );
  const helperManifest = {
    id: "helper-owner",
    origin: "global" as const,
    rootDir: root,
    source: helper.file,
    setupSource,
    channels: ["setup-channel"],
    providers: [],
    configSchema: EMPTY_PLUGIN_SCHEMA,
    ...(declaration === "setup"
      ? { setup: { providers: [{ id: "helper-provider" }] } }
      : declaration === "activation"
        ? { activation: { onProviders: [triggerProvider] } }
        : { cliBackends: ["helper-cli"] }),
  };
  const otherManifest = {
    id: "other-owner",
    origin: "global" as const,
    rootDir: other.dir,
    source: other.file,
    providers: ["other-provider"],
    configSchema: EMPTY_PLUGIN_SCHEMA,
  };
  for (const manifest of [helperManifest, otherManifest]) {
    writeFileSync(path.join(manifest.rootDir, "openclaw.plugin.json"), JSON.stringify(manifest));
  }
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [helperManifest, otherManifest],
  });
  const config = {
    plugins: {
      allow: ["helper-owner", "other-owner"],
      entries: { "helper-owner": { enabled: true }, "other-owner": { enabled: true } },
    },
  };
  const query = {
    config,
    env: {},
    pluginMetadataSnapshot: snapshot,
    providerRefs: [declaration === "cli" ? "helper-cli" : "helper-provider", "other-provider"],
    onlyPluginIds: ["helper-owner", "other-owner"],
  };
  return {
    query,
    snapshot,
    helperSource: helper.file,
    otherSource: other.file,
    registrations: () => (existsSync(marker) ? readFileSync(marker, "utf8") : ""),
    load: (channelPluginLoadIntent: "setup" | "full", onlyPluginIds = query.onlyPluginIds) =>
      loadOpenClawPlugins({
        config,
        env: {},
        installRecords: {},
        onlyPluginIds,
        manifestRegistry: snapshot.manifestRegistry,
        channelPluginLoadIntent,
        activate: false,
      }),
  };
}

afterEach(clearPluginLoaderCache);
afterAll(cleanupPluginLoaderFixturesForTest);

describe("provider selection registration coverage", () => {
  it.each(["active", "request", "retained"] as const)(
    "keeps current policy separate from a mixed %s receiver projection",
    (scope) => {
      const proof = fixture("setup");
      const loaded = proof.load("full");
      const all = ["Helper", "Other"];
      expect(loaded.providers.map(({ provider }) => provider.label)).toEqual(all);
      const query = {
        ...proof.query,
        config: {
          plugins: {
            ...proof.query.config.plugins,
            entries: {
              ...proof.query.config.plugins.entries,
              "helper-owner": { enabled: false },
            },
          },
        },
      };
      const verify = () => {
        const expected = scope === "retained" ? all : ["Other"];
        expect(
          resolveLoadedProviderPluginsForHooks(query)?.map((provider) => provider.label),
        ).toEqual(expected);
        expect(resolveProviderPluginsForHooks(query).map((provider) => provider.label)).toEqual(
          expected,
        );
        expect(loaded.providers.map(({ provider }) => provider.label)).toEqual(all);
        expect(proof.registrations()).toBe("registered");
        expect(
          resolveProviderPluginsForHooks(proof.query).map((provider) => provider.label),
        ).toEqual(all);
        expect(
          resolveProviderPluginsForHooks({ ...query, providerRefs: ["other-provider"] }).map(
            (provider) => provider.label,
          ),
        ).toEqual(["Other"]);
        expect(
          resolveProviderPluginsForHooks({ ...query, providerRefs: ["helper-provider"] }).map(
            (provider) => provider.label,
          ),
        ).toEqual(scope === "retained" ? ["Helper"] : []);
        expect(
          resolvePluginProvidersCore({ ...query, registryScope: "exact" }).map(
            (provider) => provider.label,
          ),
        ).toEqual(expected);
      };
      if (scope === "retained") {
        withPluginRuntimeGenerationScope(
          { metadataSnapshot: proof.snapshot, pluginRegistry: loaded },
          verify,
        );
      } else if (scope === "request") {
        withPluginRuntimeRegistryScope(loaded, verify);
      } else {
        setActivePluginRegistry(loaded, "mixed-current-policy");
        verify();
      }
    },
  );

  it("runs an activation helper beside the declared provider without projecting it as the receiver", () => {
    const proof = fixture("activation", false, "other-provider");
    expect(
      resolveProviderPluginsForHooks({ ...proof.query, providerRefs: ["other-provider"] }).map(
        (provider) => provider.label,
      ),
    ).toEqual(["Other"]);
    expect(proof.registrations()).toBe("registered");
  });

  it.each([
    "active",
    "request",
    "retained",
    "missing helper",
    "disabled alias owner",
    "replaced alias owner",
    "retained disabled owner",
  ] as const)("resolves runtime aliases beside activation helpers in the %s registry", (scope) => {
    const proof = fixture("activation", false);
    const aliasCalls = path.join(path.dirname(proof.otherSource), "alias-calls");
    writeFileSync(
      proof.otherSource,
      `module.exports={id:"other-owner",register(api){api.registerProvider({id:"other-provider",label:"Other",auth:[],hookAliases:["helper-provider"],normalizeModelId(){require("node:fs").appendFileSync(${JSON.stringify(aliasCalls)}, "called");return "alias-current";}});}};`,
    );
    const blockedAlias = scope === "disabled alias owner" || scope === "replaced alias owner";
    const missingHelper = scope === "missing helper" || scope === "replaced alias owner";
    const loaded = proof.load("full", missingHelper ? ["other-owner"] : undefined);
    expect(proof.registrations()).toBe(missingHelper ? "" : "registered");
    const unexpectedImport = path.join(path.dirname(proof.otherSource), "replacement-imported");
    const replacementSource = path.join(path.dirname(proof.otherSource), "replacement.cjs");
    if (scope === "replaced alias owner") {
      writeFileSync(
        replacementSource,
        `require("node:fs").writeFileSync(${JSON.stringify(unexpectedImport)}, "imported");
          module.exports={id:"other-owner",register(api){api.registerProvider({id:"other-provider",label:"Replacement",auth:[],hookAliases:["helper-provider"]});}};`,
      );
    }
    const query = {
      ...proof.query,
      ...(scope === "disabled alias owner" || scope === "retained disabled owner"
        ? {
            config: {
              plugins: {
                ...proof.query.config.plugins,
                entries: {
                  ...proof.query.config.plugins.entries,
                  "other-owner": { enabled: false },
                },
              },
            },
          }
        : {}),
      ...(scope === "replaced alias owner"
        ? {
            pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
              plugins: proof.snapshot.plugins.map((plugin) =>
                plugin.id === "other-owner" ? { ...plugin, source: replacementSource } : plugin,
              ),
            }),
          }
        : {}),
      providerRefs: ["helper-provider"],
      onlyPluginIds: missingHelper ? undefined : proof.query.onlyPluginIds,
    };
    const verify = () => {
      expect(
        resolveLoadedProviderPluginsForHooks(query)?.map((provider) => provider.label),
      ).toEqual(missingHelper || blockedAlias ? undefined : ["Other"]);
      expect(proof.registrations()).toBe(missingHelper ? "" : "registered");
      expect(resolveProviderPluginsForHooks(query).map((provider) => provider.label)).toEqual(
        blockedAlias ? [] : ["Other"],
      );
      // Disabling A creates a new policy/scope key; the helper completes once in
      // that new registry, in addition to its original warm registration.
      const expectedRegistrations =
        scope === "disabled alias owner" ? "registeredregistered" : "registered";
      expect(proof.registrations()).toBe(expectedRegistrations);
      const handle = resolveProviderRuntimePluginHandle({ ...query, provider: "helper-provider" });
      expect(handle.plugin?.id).toBe(blockedAlias ? undefined : "other-provider");
      expect(
        handle.plugin?.normalizeModelId?.({ provider: "helper-provider", modelId: "legacy" }),
      ).toBe(blockedAlias ? undefined : "alias-current");
      expect(existsSync(aliasCalls) ? readFileSync(aliasCalls, "utf8") : "").toBe(
        blockedAlias ? "" : "called",
      );
      expect(proof.registrations()).toBe(expectedRegistrations);
      expect(existsSync(unexpectedImport)).toBe(false);
      expect(resolveProviderPluginsForHooks({ ...query, onlyPluginIds: ["helper-owner"] })).toEqual(
        [],
      );
    };
    if (scope === "retained" || scope === "retained disabled owner") {
      withPluginRuntimeGenerationScope(
        { metadataSnapshot: proof.snapshot, pluginRegistry: loaded },
        verify,
      );
    } else if (scope === "request") {
      withPluginRuntimeRegistryScope(loaded, verify);
    } else {
      setActivePluginRegistry(loaded, "active-alias");
      verify();
    }
  });

  it("keeps a failed declared receiver reserved for raw parser and hook lookups", () => {
    const proof = fixture("setup");
    writeFileSync(
      proof.helperSource,
      'module.exports={id:"helper-owner",register(){throw new Error("synthetic registration failure");}};',
    );
    writeFileSync(
      proof.otherSource,
      'module.exports={id:"other-owner",register(api){api.registerProvider({id:"other-provider",label:"Other",auth:[],hookAliases:["helper-provider"],normalizeModelId:()=>"wrong-owner"});}};',
    );
    const registry = proof.load("full");
    setActivePluginRegistry(registry, "failed-receiver");
    const lookup = () =>
      findProviderRuntimePluginInRegistry({ registry, provider: "helper-provider", ownerRefs: [] });
    expect(lookup() === undefined).toBe(true);
    withPluginRuntimeGenerationScope(
      { metadataSnapshot: proof.snapshot, pluginRegistry: registry },
      () => {
        expect(lookup() === undefined).toBe(true);
        expect(
          resolveProviderPluginsForHooks({ ...proof.query, providerRefs: ["helper-provider"] }),
        ).toEqual([]);
      },
    );
    expect(
      resolveProviderPluginsForHooks({ ...proof.query, providerRefs: ["helper-provider"] }),
    ).toEqual([]);
  });

  it.each(["setup", "activation"] as const)(
    "completes a provider selected through %s metadata",
    (declaration) => {
      const proof = fixture(declaration);
      const partial = proof.load("setup");
      setActivePluginRegistry(partial, "partial");
      expect(partial.providers.map((entry) => entry.provider.label)).toEqual(["Other"]);
      expect(resolveLoadedProviderPluginsForHooks(proof.query) === undefined).toBe(true);
      expect(resolveProviderPluginsForHooks(proof.query).map((provider) => provider.label)).toEqual(
        ["Helper", "Other"],
      );
      expect(proof.load("full").providers.map((entry) => entry.provider.label)).toEqual([
        "Helper",
        "Other",
      ]);
    },
  );

  it.each(["setup", "full"] as const)(
    "keeps a non-provider activation helper's %s registration pass distinct",
    (intent) => {
      const proof = fixture("activation", false);
      const registry = proof.load(intent);
      setActivePluginRegistry(registry, intent);
      const before = intent === "full" ? "registered" : "";
      expect(proof.registrations()).toBe(before);
      withPluginRuntimeGenerationScope(
        { metadataSnapshot: proof.snapshot, pluginRegistry: registry },
        () => {
          expect(
            resolveProviderPluginsForHooks(proof.query).map((provider) => provider.label),
          ).toEqual(["Other"]);
          expect(proof.registrations()).toBe(before);
        },
      );
      expect(
        resolveLoadedProviderPluginsForHooks(proof.query)?.map((provider) => provider.label),
      ).toEqual(intent === "full" ? ["Other"] : undefined);
      expect(resolveProviderPluginsForHooks(proof.query).map((provider) => provider.label)).toEqual(
        ["Other"],
      );
      expect(proof.registrations()).toBe("registered");
    },
  );

  it("does not require provider registration from a CLI-backend-only owner", () => {
    const proof = fixture("cli", false);
    setActivePluginRegistry(proof.load("setup"), "cli-only");
    expect(
      resolveLoadedProviderPluginsForHooks(proof.query)?.map((provider) => provider.label),
    ).toEqual(["Other"]);
    expect(resolveProviderPluginsForHooks(proof.query).map((provider) => provider.label)).toEqual([
      "Other",
    ]);
    expect(proof.registrations()).toBe("");
  });
});
