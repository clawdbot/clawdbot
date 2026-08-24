import { describe, expect, it } from "vitest";
import { resolveConfigEnvVars } from "../config/env-substitution.js";
import {
  createConfigResolutionFacts,
  getAuthoredConfigSecretRef,
  getConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validatePluginId } from "../plugins/install-paths.js";
import { assertSecretOwnerAvailable } from "./runtime-degraded-state.js";
import { runtimePluginManifestSecretOwnerId } from "./runtime-plugin-manifest-secret-owner.js";
import { listProviderAuthDegradedOwners } from "./runtime-provider-auth-scope.js";
import {
  activateSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  refreshActiveProviderAuthRuntimeSnapshot,
} from "./runtime.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const LOCAL_OWNER_ID = "shared-owner";

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

type ManifestOwnerKind = "capability" | "provider";
type PluginOwnerFixture = readonly [
  pluginId: string,
  token: ReturnType<typeof envRef>,
  ownerId?: string,
];

function preparePluginOwnerSnapshot(
  ownerKind: ManifestOwnerKind,
  plugins: readonly PluginOwnerFixture[],
  env: NodeJS.ProcessEnv,
  options?: {
    coreConfig?: Record<string, unknown>;
    path?: "service.token" | "apiKey";
    pendingFacts?: ReadonlyMap<string, string>;
  },
) {
  const secretPath = options?.path ?? "service.token";
  const config = asConfig({
    agents: { list: [{ id: "main", default: true }] },
    ...options?.coreConfig,
    plugins: {
      entries: Object.fromEntries(
        plugins.map(([pluginId, token]) => [
          pluginId,
          {
            enabled: true,
            config: secretPath === "apiKey" ? { apiKey: token } : { service: { token } },
          },
        ]),
      ),
    },
  });
  if (options?.pendingFacts) {
    setConfigResolutionFacts(config, createConfigResolutionFacts([], options.pendingFacts));
  }
  return prepareSecretsRuntimeSnapshot({
    config,
    env,
    includeAuthStoreRefs: false,
    allowUnavailableSecretOwners: true,
    loadablePluginOrigins: new Map(plugins.map(([pluginId]) => [pluginId, "config" as const])),
    manifestRegistry: {
      plugins: plugins.map(
        ([pluginId, , ownerId = LOCAL_OWNER_ID]) =>
          ({
            id: pluginId,
            origin: "config" as const,
            configContracts: {
              secretInputs: {
                paths: [{ path: secretPath, ownerKind, ownerId }],
              },
            },
          }) as never,
      ),
    },
  });
}

function runtimeOwnerKind(ownerKind: ManifestOwnerKind) {
  return ownerKind === "capability" ? ("plugin-capability" as const) : ("plugin-provider" as const);
}

function activateSnapshot(snapshot: Awaited<ReturnType<typeof preparePluginOwnerSnapshot>>): void {
  activateSecretsRuntimeSnapshot(snapshot);
}

describe("manifest-declared plugin secret owners", () => {
  it.each([
    ["alpha:beta", "gamma", "alpha%3Abeta:gamma"],
    ["alpha", "beta:gamma", "alpha:beta%3Agamma"],
    ["alpha%3Abeta", "gamma", "alpha%253Abeta:gamma"],
    ["alpha", "beta%3Agamma", "alpha:beta%253Agamma"],
    ["@scope/plugin", "feature:%/value", "%40scope%2Fplugin:feature%3A%25%2Fvalue"],
    ["plugin-\ud800", "owner", "plugin-%uD800:owner"],
    ["plugin", "owner-\ud800", "plugin:owner-%uD800"],
    ["plugin-\udc00", "owner", "plugin-%uDC00:owner"],
    ["plugin", "owner-\udc00", "plugin:owner-%uDC00"],
    ["plugin-\ud83d\ude00", "owner", "plugin-%uD83D%uDE00:owner"],
    ["plugin", "owner-%uD800", "plugin:owner-%25uD800"],
    ["plugin", "owner-%uDC00", "plugin:owner-%25uDC00"],
    ["plugin", "owner-\\uD800", "plugin:owner-%5CuD800"],
    ["plugin-%uD800", "owner", "plugin-%25uD800:owner"],
  ])("injectively encodes valid plugin %s and local owner %s", (pluginId, ownerId, expected) => {
    expect(validatePluginId(pluginId)).toBeNull();
    expect(runtimePluginManifestSecretOwnerId(pluginId, ownerId)).toBe(expected);
  });

  it.each(["capability", "provider"] as const)(
    "isolates only the failed plugin when local %s owner IDs collide",
    async (ownerKind) => {
      const coldOwnerId = runtimePluginManifestSecretOwnerId("cold-plugin", LOCAL_OWNER_ID);
      const healthyOwnerId = runtimePluginManifestSecretOwnerId("healthy-plugin", LOCAL_OWNER_ID);
      const missingRef = envRef("COLD_PLUGIN_TOKEN");
      const snapshot = await preparePluginOwnerSnapshot(
        ownerKind,
        [
          ["cold-plugin", missingRef],
          ["healthy-plugin", envRef("HEALTHY_PLUGIN_TOKEN")],
        ],
        { HEALTHY_PLUGIN_TOKEN: "healthy-plugin-secret" },
      );

      expect(snapshot.config.plugins?.entries?.["cold-plugin"]?.config).toEqual({
        service: { token: missingRef },
      });
      expect(snapshot.config.plugins?.entries?.["healthy-plugin"]?.config).toEqual({
        service: { token: "healthy-plugin-secret" },
      });
      expect(snapshot.secretOwners).toMatchObject([
        { ownerKind: runtimeOwnerKind(ownerKind), ownerId: coldOwnerId },
        { ownerKind: runtimeOwnerKind(ownerKind), ownerId: healthyOwnerId },
      ]);
      expect(snapshot.degradedOwners).toMatchObject([
        {
          ownerKind: runtimeOwnerKind(ownerKind),
          ownerId: coldOwnerId,
          degradationState: "cold",
          paths: ["plugins.entries.cold-plugin.config.service.token"],
        },
      ]);

      activateSnapshot(snapshot);
      expect(() => assertSecretOwnerAvailable(runtimeOwnerKind(ownerKind), coldOwnerId)).toThrow(
        "configured but unavailable",
      );
      expect(() =>
        assertSecretOwnerAvailable(runtimeOwnerKind(ownerKind), healthyOwnerId),
      ).not.toThrow();
    },
  );

  it.each(["capability", "provider"] as const)(
    "treats a renamed plugin's unavailable %s owner as cold",
    async (ownerKind) => {
      const token = envRef("RENAMED_PLUGIN_TOKEN");
      activateSnapshot(
        await preparePluginOwnerSnapshot(ownerKind, [["original-plugin", token]], {
          RENAMED_PLUGIN_TOKEN: "last-known-good",
        }),
      );

      const renamed = await preparePluginOwnerSnapshot(ownerKind, [["renamed-plugin", token]], {});
      expect(renamed.config.plugins?.entries?.["renamed-plugin"]?.config).toEqual({
        service: { token },
      });
      expect(renamed.degradedOwners).toMatchObject([
        {
          ownerKind: runtimeOwnerKind(ownerKind),
          ownerId: runtimePluginManifestSecretOwnerId("renamed-plugin", LOCAL_OWNER_ID),
          degradationState: "cold",
        },
      ]);
    },
  );

  it.each(["capability", "provider"] as const)(
    "does not merge alternate delimiter splits across %s plugins",
    async (ownerKind) => {
      const coldRef = envRef("ALTERNATE_SPLIT_COLD");
      const snapshot = await preparePluginOwnerSnapshot(
        ownerKind,
        [
          ["alpha:beta", coldRef, "gamma"],
          ["alpha", envRef("ALTERNATE_SPLIT_HEALTHY"), "beta:gamma"],
        ],
        { ALTERNATE_SPLIT_HEALTHY: "healthy-alternate-split-secret" },
      );

      expect(snapshot.secretOwners).toMatchObject([
        { ownerKind: runtimeOwnerKind(ownerKind), ownerId: "alpha%3Abeta:gamma" },
        { ownerKind: runtimeOwnerKind(ownerKind), ownerId: "alpha:beta%3Agamma" },
      ]);
      expect(snapshot.degradedOwners).toMatchObject([
        {
          ownerKind: runtimeOwnerKind(ownerKind),
          ownerId: "alpha%3Abeta:gamma",
          paths: ['plugins.entries["alpha:beta"].config.service.token'],
        },
      ]);
      expect(snapshot.config.plugins?.entries?.alpha?.config).toEqual({
        service: { token: "healthy-alternate-split-secret" },
      });
      expect(snapshot.config.plugins?.entries?.["alpha:beta"]?.config).toEqual({
        service: { token: coldRef },
      });
    },
  );

  it.each(["capability", "provider"] as const)(
    "never transfers a stale %s credential across alternate plugin identity splits",
    async (ownerKind) => {
      const token = envRef("ALTERNATE_SPLIT_SHARED");
      activateSnapshot(
        await preparePluginOwnerSnapshot(ownerKind, [["alpha:beta", token, "gamma"]], {
          ALTERNATE_SPLIT_SHARED: "old-plugin-secret",
        }),
      );

      const replacement = await preparePluginOwnerSnapshot(
        ownerKind,
        [["alpha", token, "beta:gamma"]],
        {},
      );

      expect(replacement.degradedOwners).toMatchObject([
        {
          ownerKind: runtimeOwnerKind(ownerKind),
          ownerId: "alpha:beta%3Agamma",
          degradationState: "cold",
        },
      ]);
      expect(replacement.config.plugins?.entries?.alpha?.config).toEqual({
        service: { token },
      });
    },
  );

  it("never transfers a stale route credential across dotted plugin and config-path splits", async () => {
    const token = envRef("DOTTED_ROUTE_SHARED_TOKEN");
    const prepareRouteSnapshot = (pluginId: string, routePath: string, env: NodeJS.ProcessEnv) =>
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          agents: { list: [{ id: "main", default: true }] },
          plugins: {
            entries: {
              [pluginId]: {
                enabled: true,
                config: routePath === "token" ? { token } : { bar: { config: { token } } },
              },
            },
          },
        }),
        env,
        includeAuthStoreRefs: false,
        allowUnavailableSecretOwners: true,
        loadablePluginOrigins: new Map([[pluginId, "config"]]),
        manifestRegistry: {
          plugins: [
            {
              id: pluginId,
              origin: "config",
              configContracts: {
                secretInputs: {
                  paths: [{ path: routePath, ownerKind: "route", ownerContractFields: ["token"] }],
                },
              },
            } as never,
          ],
        },
      });
    const healthy = await prepareRouteSnapshot("foo", "bar.config.token", {
      DOTTED_ROUTE_SHARED_TOKEN: "victim-route-secret",
    });
    activateSecretsRuntimeSnapshot(healthy);

    const replacement = await prepareRouteSnapshot("foo.config.bar", "token", {});

    expect(healthy.secretOwners).toMatchObject([
      { ownerKind: "plugin-route", ownerId: "foo:bar.config.token" },
    ]);
    expect(replacement.secretOwners).toMatchObject([
      { ownerKind: "plugin-route", ownerId: "foo.config.bar:token" },
    ]);
    expect(replacement.degradedOwners).toMatchObject([
      {
        ownerKind: "plugin-route",
        ownerId: "foo.config.bar:token",
        degradationState: "cold",
        paths: ['plugins.entries["foo.config.bar"].config.token'],
      },
    ]);
    expect(replacement.config.plugins?.entries?.["foo.config.bar"]?.config).toEqual({ token });
    activateSnapshot(replacement);
    expect(() => assertSecretOwnerAvailable("route", "foo.config.bar:token")).not.toThrow();
    expect(() => assertSecretOwnerAvailable("plugin-route", "foo.config.bar:token")).toThrow(
      "configured but unavailable",
    );
  });

  it("materializes each plugin's authored env credential despite dotted identity/path aliases", async () => {
    const pluginIds = ["foo.config.bar", "foo"] as const;
    const env = { ATTACKER: "attacker-only-secret", VICTIM: "victim-only-secret" };
    const pendingRefs = new Map<string, string>();
    const config = asConfig(
      resolveConfigEnvVars(
        {
          agents: { list: [{ id: "main", default: true }] },
          plugins: {
            entries: {
              "foo.config.bar": { enabled: true, config: { token: "$ATTACKER" } },
              foo: {
                enabled: true,
                config: { bar: { config: { token: "$VICTIM" } } },
              },
            },
          },
        },
        env,
        { onPendingEnvSecretRef: (refId, configPath) => pendingRefs.set(configPath, refId) },
      ),
    );
    setConfigResolutionFacts(config, createConfigResolutionFacts([], pendingRefs));

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env,
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: new Map(pluginIds.map((pluginId) => [pluginId, "config" as const])),
      manifestRegistry: {
        plugins: pluginIds.map(
          (pluginId) =>
            ({
              id: pluginId,
              origin: "config",
              configContracts: {
                secretInputs: {
                  paths: [
                    {
                      path: pluginId === "foo" ? "bar.config.token" : "token",
                      ownerKind: "capability",
                      ownerId: pluginId === "foo" ? "victim" : "attacker",
                    },
                  ],
                },
              },
            }) as never,
        ),
      },
    });

    expect(pendingRefs).toEqual(
      new Map([
        ['plugins.entries["foo.config.bar"].config.token', "ATTACKER"],
        ["plugins.entries.foo.config.bar.config.token", "VICTIM"],
      ]),
    );
    expect(snapshot.secretOwners).toMatchObject([
      { ownerKind: "plugin-capability", ownerId: "foo.config.bar:attacker" },
      { ownerKind: "plugin-capability", ownerId: "foo:victim" },
    ]);
    expect(snapshot.config.plugins?.entries?.["foo.config.bar"]?.config).toEqual({
      token: "attacker-only-secret",
    });
    expect(snapshot.config.plugins?.entries?.foo?.config).toEqual({
      bar: { config: { token: "victim-only-secret" } },
    });
    expect(snapshot.degradedOwners).toEqual([]);
  });

  it.each([
    ["capability", "provider"],
    ["provider", "capability"],
  ] as const)("treats an owner-kind change from %s to %s as cold", async (before, after) => {
    const token = envRef("SEMANTIC_OWNER_TOKEN");
    activateSnapshot(
      await preparePluginOwnerSnapshot(before, [["semantic-plugin", token]], {
        SEMANTIC_OWNER_TOKEN: "last-known-good",
      }),
    );

    const replacement = await preparePluginOwnerSnapshot(after, [["semantic-plugin", token]], {});

    expect(replacement.degradedOwners).toMatchObject([
      {
        ownerKind: runtimeOwnerKind(after),
        ownerId: "semantic-plugin:shared-owner",
        degradationState: "cold",
      },
    ]);
    expect(replacement.config.plugins?.entries?.["semantic-plugin"]?.config).toEqual({
      service: { token },
    });
  });

  it.each([
    {
      label: "skill capability",
      ownerKind: "capability" as const,
      pluginId: "skill",
      localOwnerId: "trusted-skill",
      coreOwnerId: "skill:trusted-skill",
      coreConfig: (apiKey: unknown) => ({ skills: { entries: { "trusted-skill": { apiKey } } } }),
      coreSecret: (config: OpenClawConfig) => config.skills?.entries?.["trusted-skill"]?.apiKey,
    },
    {
      label: "configured model provider",
      ownerKind: "provider" as const,
      pluginId: "alpha",
      localOwnerId: "beta",
      coreOwnerId: "alpha:beta",
      coreConfig: (apiKey: unknown) => ({ models: { providers: { "alpha:beta": { apiKey } } } }),
      coreSecret: (config: OpenClawConfig) => config.models?.providers?.["alpha:beta"]?.apiKey,
    },
  ])("cannot withhold or impersonate a healthy core $label owner", async (scenario) => {
    const pluginRef = envRef("PLUGIN_MISSING_TOKEN");
    const snapshot = await preparePluginOwnerSnapshot(
      scenario.ownerKind,
      [[scenario.pluginId, pluginRef, scenario.localOwnerId]],
      { HEALTHY_CORE_TOKEN: "healthy-core-secret" },
      {
        path: "apiKey",
        coreConfig: scenario.coreConfig(envRef("HEALTHY_CORE_TOKEN")),
      },
    );

    expect(scenario.coreSecret(snapshot.config)).toBe("healthy-core-secret");
    expect(snapshot.secretOwners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerKind: scenario.ownerKind,
          ownerId: scenario.coreOwnerId,
        }),
        expect.objectContaining({
          ownerKind: runtimeOwnerKind(scenario.ownerKind),
          ownerId: scenario.coreOwnerId,
        }),
      ]),
    );
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: runtimeOwnerKind(scenario.ownerKind),
        ownerId: scenario.coreOwnerId,
        degradationState: "cold",
      },
    ]);

    activateSnapshot(snapshot);
    expect(() =>
      assertSecretOwnerAvailable(scenario.ownerKind, scenario.coreOwnerId),
    ).not.toThrow();
    expect(() =>
      assertSecretOwnerAvailable(runtimeOwnerKind(scenario.ownerKind), scenario.coreOwnerId),
    ).toThrow("configured but unavailable");
  });

  it.each([
    {
      label: "skill capability",
      ownerKind: "capability" as const,
      pluginId: "skill",
      localOwnerId: "trusted-skill",
      coreConfig: (apiKey: unknown) => ({ skills: { entries: { "trusted-skill": { apiKey } } } }),
    },
    {
      label: "configured model provider",
      ownerKind: "provider" as const,
      pluginId: "alpha",
      localOwnerId: "beta",
      coreConfig: (apiKey: unknown) => ({ models: { providers: { "alpha:beta": { apiKey } } } }),
    },
  ])("never copies a stale core $label credential into plugin config", async (scenario) => {
    const token = envRef("SHARED_CORE_TOKEN");
    activateSecretsRuntimeSnapshot(
      await prepareSecretsRuntimeSnapshot({
        config: asConfig({
          agents: { list: [{ id: "main", default: true }] },
          ...scenario.coreConfig(token),
        }),
        env: { SHARED_CORE_TOKEN: "core-only-secret" },
        includeAuthStoreRefs: false,
        allowUnavailableSecretOwners: true,
        loadablePluginOrigins: new Map(),
      }),
    );

    const replacement = await preparePluginOwnerSnapshot(
      scenario.ownerKind,
      [[scenario.pluginId, token, scenario.localOwnerId]],
      {},
      { path: "apiKey" },
    );

    expect(replacement.degradedOwners).toMatchObject([
      {
        ownerKind: runtimeOwnerKind(scenario.ownerKind),
        ownerId: `${scenario.pluginId}:${scenario.localOwnerId}`,
        degradationState: "cold",
      },
    ]);
    expect(replacement.config.plugins?.entries?.[scenario.pluginId]?.config).toEqual({
      apiKey: token,
    });
  });

  it.each([
    ["skill", "trusted-skill"],
    ["talk", "speech"],
    ["talk", "realtime"],
    ["web-search", "brave"],
    ["web-fetch", "firecrawl"],
  ])("keeps plugin %s:%s outside the core capability owner domain", async (pluginId, localId) => {
    const snapshot = await preparePluginOwnerSnapshot(
      "capability",
      [[pluginId, envRef("CORE_NAMESPACE_PROBE"), localId]],
      {},
    );
    const ownerId = `${pluginId}:${localId}`;

    expect(snapshot.secretOwners).toMatchObject([{ ownerKind: "plugin-capability", ownerId }]);
    activateSnapshot(snapshot);
    expect(() => assertSecretOwnerAvailable("capability", ownerId)).not.toThrow();
    expect(() => assertSecretOwnerAvailable("plugin-capability", ownerId)).toThrow(
      "configured but unavailable",
    );
  });

  it("retains healthy and cold plugin-provider owners and resolution facts across model auth refresh", async () => {
    const coldPath = "plugins.entries.cold-plugin.config.service.token";
    const healthyPath = "plugins.entries.healthy-plugin.config.service.token";
    const coldRef = envRef("COLD_PLUGIN_PROVIDER_TOKEN");
    const healthyRef = envRef("HEALTHY_PLUGIN_PROVIDER_TOKEN");
    const coldOwnerId = runtimePluginManifestSecretOwnerId("cold-plugin", LOCAL_OWNER_ID);
    const healthyOwnerId = runtimePluginManifestSecretOwnerId("healthy-plugin", LOCAL_OWNER_ID);
    const initial = await preparePluginOwnerSnapshot(
      "provider",
      [
        ["cold-plugin", coldRef],
        ["healthy-plugin", healthyRef],
      ],
      { HEALTHY_PLUGIN_PROVIDER_TOKEN: "healthy-plugin-provider-secret" },
      {
        pendingFacts: new Map([
          [coldPath, coldRef.id],
          [healthyPath, healthyRef.id],
        ]),
      },
    );
    activateSnapshot(initial);

    expect(getAuthoredConfigSecretRef(initial.config, coldPath)).toEqual(coldRef);
    expect(getAuthoredConfigSecretRef(initial.config, healthyPath)).toBeNull();
    await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);

    const refreshed = getActiveSecretsRuntimeSnapshot();
    expect(refreshed?.config.plugins?.entries?.["cold-plugin"]?.config).toEqual({
      service: { token: coldRef },
    });
    expect(refreshed?.config.plugins?.entries?.["healthy-plugin"]?.config).toEqual({
      service: { token: "healthy-plugin-provider-secret" },
    });
    expect(refreshed?.secretOwners).toMatchObject([
      { ownerKind: "plugin-provider", ownerId: coldOwnerId },
      { ownerKind: "plugin-provider", ownerId: healthyOwnerId },
    ]);
    expect(refreshed?.degradedOwners).toMatchObject([
      {
        ownerKind: "plugin-provider",
        ownerId: coldOwnerId,
        degradationState: "cold",
        paths: [coldPath],
      },
    ]);
    expect(() => assertSecretOwnerAvailable("plugin-provider", coldOwnerId)).toThrow(
      "configured but unavailable",
    );
    expect(() => assertSecretOwnerAvailable("plugin-provider", healthyOwnerId)).not.toThrow();
    expect(getConfigResolutionFacts(refreshed?.config)).not.toBeNull();
    expect(getAuthoredConfigSecretRef(refreshed?.config, coldPath)).toEqual(coldRef);
    expect(getAuthoredConfigSecretRef(refreshed?.config, healthyPath)).toBeNull();
    expect(refreshed && listProviderAuthDegradedOwners(refreshed)).toEqual([]);
  });
});
