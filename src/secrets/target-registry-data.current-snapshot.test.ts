/** Tests target-registry data built from the current runtime snapshot. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPluginCache } from "../plugins/plugin-cache.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

const metadataMocks = vi.hoisted(() => ({
  listBundledPluginMetadata: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn<
    (params?: { config?: { plugins?: { load?: { paths?: string[] } } } }) => {
      plugins: never[];
    }
  >(() => ({ plugins: [] })),
}));

vi.mock("../plugins/bundled-plugin-metadata.js", () => ({
  listBundledPluginMetadata: metadataMocks.listBundledPluginMetadata,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: metadataMocks.resolvePluginMetadataSnapshot,
}));

function writeChannelContract(params: {
  channelId: string;
  pluginId: string;
  targetId: string;
  ownership: "channelConfigs" | "channels";
}) {
  const rootDir = makeTrackedTempDir("openclaw-target-registry-channel", tempDirs);
  fs.writeFileSync(
    path.join(rootDir, "secret-contract-api.cjs"),
    `module.exports = { secretTargetRegistryEntries: [${JSON.stringify({
      id: params.targetId,
      targetType: params.targetId,
      configFile: "openclaw.json",
      pathPattern: params.targetId,
      secretShape: "secret_input",
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true,
    })}] };`,
    "utf8",
  );
  return {
    id: params.pluginId,
    origin: "config",
    channels: params.ownership === "channels" ? [params.channelId] : [],
    channelConfigs: params.ownership === "channelConfigs" ? { [params.channelId]: {} } : {},
    rootDir,
  };
}

describe("getSecretTargetRegistry metadata reuse", () => {
  beforeEach(() => {
    vi.resetModules();
    metadataMocks.listBundledPluginMetadata.mockReset();
    metadataMocks.listBundledPluginMetadata.mockImplementation(() => {
      throw new Error("source bundled metadata must not be scanned");
    });
    metadataMocks.resolvePluginMetadataSnapshot.mockClear();
    metadataMocks.resolvePluginMetadataSnapshot.mockReturnValue({ plugins: [] });
  });

  afterEach(() => {
    resetPluginCache();
    vi.unstubAllEnvs();
    cleanupTrackedTempDirs(tempDirs);
  });

  it.each(["bundled", "config"])(
    "rejects a broken %s contract during source docs generation without changing runtime tolerance",
    async (origin) => {
      const healthy = writeChannelContract({
        channelId: "healthy",
        pluginId: "healthy",
        targetId: "channels.healthy.token",
        ownership: "channels",
      });
      const broken = writeChannelContract({
        channelId: "broken",
        pluginId: "broken",
        targetId: "channels.broken.token",
        ownership: "channels",
      });
      const missing = {
        ...broken,
        id: "missing",
        rootDir: makeTrackedTempDir("openclaw-target-registry-missing", tempDirs),
      };
      // A dependency failure can resemble the old missing-artifact message; it is not absence.
      const failure = "Unable to resolve bundled plugin public surface fixture dependency failed";
      fs.writeFileSync(
        path.join(broken.rootDir, "secret-contract-api.cjs"),
        `throw new Error(${JSON.stringify(failure)});`,
      );
      const records = [healthy, broken, missing].map((record) =>
        Object.assign({}, record, {
          origin,
          id: origin === "bundled" ? path.basename(record.rootDir) : record.id,
        }),
      );
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.dirname(healthy.rootDir));
      vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
      metadataMocks.resolvePluginMetadataSnapshot.mockReturnValue({ plugins: records } as never);
      const { getSecretTargetRegistry } = await import("./target-registry-data.js");
      const { buildSecretRefCredentialMatrix } =
        await import("./credential-matrix.test-support.js");

      const runtimeIds = getSecretTargetRegistry({ config: {}, env: {} }).map((entry) => entry.id);
      expect(runtimeIds).toContain("channels.healthy.token");
      expect(runtimeIds).toContain("gateway.auth.token");
      expect(runtimeIds).not.toContain("channels.broken.token");
      expect(() => buildSecretRefCredentialMatrix()).toThrow(failure);

      metadataMocks.resolvePluginMetadataSnapshot.mockReturnValue({
        plugins: [records[0], records[2]],
      } as never);
      const matrixIds = buildSecretRefCredentialMatrix().entries.map((entry) => entry.id);
      expect(matrixIds).toContain("channels.healthy.token");
      expect(matrixIds).toContain("gateway.auth.token");
    },
  );

  it.runIf(process.platform !== "win32")(
    "reports a rejected contract boundary during source generation after runtime cached the rejection",
    async () => {
      const record = writeChannelContract({
        channelId: "blocked",
        pluginId: "blocked",
        targetId: "channels.blocked.token",
        ownership: "channels",
      });
      const outsideDir = makeTrackedTempDir("openclaw-contract-outside", tempDirs);
      fs.linkSync(
        path.join(record.rootDir, "secret-contract-api.cjs"),
        path.join(outsideDir, "linked-contract.cjs"),
      );
      metadataMocks.resolvePluginMetadataSnapshot.mockReturnValue({ plugins: [record] } as never);
      const { getSecretTargetRegistry } = await import("./target-registry-data.js");
      expect(
        getSecretTargetRegistry({ config: {}, env: {} }).map((entry) => entry.id),
      ).not.toContain("channels.blocked.token");
      expect(() => getSecretTargetRegistry({ sourceTree: true })).toThrow(
        "Unable to open channel secret contract for blocked",
      );
    },
  );

  it("allows configless runtime targets to reuse the lifecycle workspace", async () => {
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");

    getSecretTargetRegistry();

    expect(metadataMocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith({
      allowWorkspaceScopedCurrent: true,
      env: process.env,
    });
    const calls = metadataMocks.resolvePluginMetadataSnapshot.mock.calls as unknown as Array<
      [{ allowWorkspaceScopedCurrent?: boolean }]
    >;
    for (const [call] of calls) {
      expect(call.allowWorkspaceScopedCurrent).toBe(true);
    }
  });
  it("registers secret targets for installed-origin plugins (#104320)", async () => {
    // The Exa web providers moved from bundled origin to an installed plugin
    // package; the gateway's known-target registry must keep covering them.
    metadataMocks.resolvePluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "exa",
          origin: "global",
          channels: [],
          contracts: { webSearchProviders: ["exa"] },
          configUiHints: { "webSearch.apiKey": { sensitive: true } },
          configContracts: {
            secretInputs: { paths: [{ path: "webSearch.apiKey" }] },
          },
        },
      ],
    } as never);
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");
    const { isKnownSecretTargetId } = await import("./target-registry-query.js");

    const ids = getSecretTargetRegistry().map((entry) => entry.id);

    expect(ids).toContain("plugins.entries.exa.config.webSearch.apiKey");
    expect(isKnownSecretTargetId("plugins.entries.exa.config.webSearch.apiKey")).toBe(true);
  });

  it("registers config contract targets only from the resolved snapshot", async () => {
    metadataMocks.resolvePluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "snapshot-plugin",
          origin: "config",
          channels: [],
          configContracts: {
            secretInputs: { paths: [{ path: "credentials.token" }] },
          },
        },
      ],
    } as never);
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");

    const ids = getSecretTargetRegistry().map((entry) => entry.id);

    expect(ids).toContain("plugins.entries.snapshot-plugin.config.credentials.token");
    expect(metadataMocks.listBundledPluginMetadata).not.toHaveBeenCalled();
  });

  it("preserves plugin, array, and record identity across discovery, setup, and apply", async () => {
    const rootDir = makeTrackedTempDir("openclaw-target-registry-plugin-identity", tempDirs);
    const pluginContracts = [
      { id: "foo.config.bar", secretPath: "token", refId: "DOTTED_PLUGIN_TOKEN" },
      { id: "foo", secretPath: "bar.config.token", refId: "NESTED_PLUGIN_TOKEN" },
      { id: "array-plugin", secretPath: "accounts[].token", refId: "ARRAY_PLUGIN_TOKEN" },
      { id: "record-plugin", secretPath: "accounts.*.token", refId: "RECORD_PLUGIN_TOKEN" },
      {
        id: "wildcard-array-plugin",
        secretPath: "accounts.*.token",
        refId: "WILDCARD_ARRAY_PLUGIN_TOKEN",
      },
    ];
    const plugins = pluginContracts.map(({ id, secretPath }, index) => {
      const pluginRoot = path.join(rootDir, `plugin-${index}`);
      fs.mkdirSync(pluginRoot);
      fs.writeFileSync(
        path.join(pluginRoot, "index.js"),
        `export default { id: ${JSON.stringify(id)}, register() {} };`,
      );
      const manifest = {
        id,
        configSchema: { type: "object", additionalProperties: true },
        configContracts: { secretInputs: { paths: [{ path: secretPath }] } },
      };
      fs.writeFileSync(path.join(pluginRoot, "openclaw.plugin.json"), JSON.stringify(manifest));
      return { ...manifest, origin: "config", channels: [], rootDir: pluginRoot };
    });
    metadataMocks.resolvePluginMetadataSnapshot.mockReturnValue({
      plugins,
      manifestRegistry: { plugins, diagnostics: [] },
    } as never);

    const config = {
      plugins: {
        load: { paths: plugins.map((plugin) => plugin.rootDir) },
        entries: {
          "foo.config.bar": { enabled: true, config: { token: "dotted-plaintext" } },
          foo: { enabled: true, config: { bar: { config: { token: "nested-plaintext" } } } },
          "array-plugin": { enabled: true, config: { accounts: [{ token: "array-plaintext" }] } },
          "record-plugin": {
            enabled: true,
            config: {
              accounts: {
                "0": { token: "numeric-record-plaintext" },
                "foo.bar": { token: "dotted-record-plaintext" },
              },
            },
          },
          "wildcard-array-plugin": {
            enabled: true,
            config: { accounts: [{ token: "wildcard-array-plaintext" }] },
          },
        },
      },
    };
    const expectedTargets = [
      {
        path: 'plugins.entries["foo.config.bar"].config.token',
        pathSegments: ["plugins", "entries", "foo.config.bar", "config", "token"],
      },
      {
        path: "plugins.entries.foo.config.bar.config.token",
        pathSegments: ["plugins", "entries", "foo", "config", "bar", "config", "token"],
      },
      {
        path: "plugins.entries.array-plugin.config.accounts[0].token",
        pathSegments: ["plugins", "entries", "array-plugin", "config", "accounts", "0", "token"],
      },
      {
        path: 'plugins.entries.record-plugin.config.accounts["0"].token',
        pathSegments: ["plugins", "entries", "record-plugin", "config", "accounts", "0", "token"],
      },
      {
        path: 'plugins.entries.record-plugin.config.accounts["foo.bar"].token',
        pathSegments: [
          "plugins",
          "entries",
          "record-plugin",
          "config",
          "accounts",
          "foo.bar",
          "token",
        ],
      },
      {
        path: "plugins.entries.wildcard-array-plugin.config.accounts[0].token",
        pathSegments: [
          "plugins",
          "entries",
          "wildcard-array-plugin",
          "config",
          "accounts",
          "0",
          "token",
        ],
      },
    ];
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");
    const { discoverConfigSecretTargets } = await import("./target-registry-query.js");
    const { buildConfigureCandidatesForScope, buildSecretsConfigurePlan } =
      await import("./configure-plan.js");
    const { isSecretsApplyPlan, resolveValidatedPlanTarget } = await import("./plan.js");

    expect(getSecretTargetRegistry({ config, env: {} })).toEqual(
      expect.arrayContaining(
        pluginContracts.map(({ id, secretPath }) => {
          const pluginPath = id.includes(".") ? `[${JSON.stringify(id)}]` : `.${id}`;
          const pathPattern = `plugins.entries${pluginPath}.config.${secretPath}`;
          return expect.objectContaining({
            id: pathPattern,
            pathPattern,
            pathPatternSegments: ["plugins", "entries", id, "config", ...secretPath.split(".")],
          });
        }),
      ),
    );
    expect(discoverConfigSecretTargets(config)).toEqual(
      expect.arrayContaining(expectedTargets.map((target) => expect.objectContaining(target))),
    );

    const candidates = buildConfigureCandidatesForScope({ config }).filter((candidate) =>
      candidate.path.startsWith("plugins.entries"),
    );
    expect(candidates).toEqual(
      expect.arrayContaining(expectedTargets.map((target) => expect.objectContaining(target))),
    );
    const plan = buildSecretsConfigurePlan({
      selectedTargets: new Map(
        candidates.map((candidate) => {
          const plugin = pluginContracts.find(({ id }) => candidate.pathSegments[2] === id)!;
          return [
            candidate.path,
            {
              ...candidate,
              ref: { source: "env" as const, provider: "default", id: plugin.refId },
            },
          ];
        }),
      ),
      providerChanges: { upserts: {}, deletes: [] },
    });
    expect(plan.targets).toHaveLength(expectedTargets.length);
    const arrayTarget = plan.targets.find((target) => target.pathSegments?.[2] === "array-plugin")!;
    const recordTarget = plan.targets.find(
      (target) => target.pathSegments?.[2] === "record-plugin" && target.pathSegments[5] === "0",
    )!;
    const wildcardArrayTarget = plan.targets.find(
      (target) => target.pathSegments?.[2] === "wildcard-array-plugin",
    )!;
    const dottedPluginTarget = plan.targets.find(
      (target) => target.pathSegments?.[2] === "foo.config.bar",
    )!;
    const quotedArrayPath = 'plugins.entries.array-plugin.config.accounts["0"].token';
    const legacyArrayTarget = {
      ...arrayTarget,
      path: arrayTarget.pathSegments!.join("."),
    };
    const legacyRecordTarget = {
      ...recordTarget,
      path: recordTarget.pathSegments!.join("."),
    };
    expect(resolveValidatedPlanTarget(arrayTarget)?.pathTokens[5]).toBe(0);
    expect(resolveValidatedPlanTarget(recordTarget)?.pathTokens[5]).toBe("0");
    expect(resolveValidatedPlanTarget(wildcardArrayTarget)?.pathTokens[5]).toBe(0);
    expect(Object.hasOwn(arrayTarget, "pathTokens")).toBe(false);
    expect(resolveValidatedPlanTarget({ ...arrayTarget, path: quotedArrayPath })).toBeNull();
    expect(resolveValidatedPlanTarget(legacyArrayTarget)?.pathTokens[5]).toBe(0);
    expect(resolveValidatedPlanTarget(legacyRecordTarget)?.pathTokens[5]).toBe("0");
    expect(
      resolveValidatedPlanTarget({ ...legacyArrayTarget, pathSegments: undefined })?.pathTokens[5],
    ).toBe(0);
    expect(
      resolveValidatedPlanTarget({ ...legacyRecordTarget, pathSegments: undefined })?.pathTokens[5],
    ).toBe("0");
    expect(
      resolveValidatedPlanTarget({
        ...dottedPluginTarget,
        path: dottedPluginTarget.pathSegments!.join("."),
      }),
    ).not.toBeNull();
    const forgedArrayPlan = {
      ...plan,
      generatedBy: "manual" as const,
      targets: [{ ...arrayTarget, path: quotedArrayPath }],
    };
    expect(isSecretsApplyPlan(forgedArrayPlan)).toBe(false);
    const { buildPluginSecretRefSetupPlan } = await import("./plugin-setup-plan.js");
    const setupPlan = buildPluginSecretRefSetupPlan({
      productName: "Fixture",
      providerAlias: "fixture",
      providerConfig: {
        source: "exec",
        pluginIntegration: { pluginId: "fixture", integrationId: "fixture" },
      },
      providerSecrets: [],
      configTargetSecrets: expectedTargets.map(({ path: targetPath }, index) => ({
        path: targetPath,
        secretId: `credentials/${index}`,
      })),
    });
    expect(setupPlan.targets).toEqual(
      expect.arrayContaining(expectedTargets.map((target) => expect.objectContaining(target))),
    );
    expect(isSecretsApplyPlan(plan)).toBe(true);

    const configPath = path.join(rootDir, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify(config));
    const { testing } = await import("./apply.js");
    const env = {
      OPENCLAW_STATE_DIR: rootDir,
      OPENCLAW_CONFIG_PATH: configPath,
      DOTTED_PLUGIN_TOKEN: "dotted-secret",
      NESTED_PLUGIN_TOKEN: "nested-secret",
      ARRAY_PLUGIN_TOKEN: "array-secret",
      RECORD_PLUGIN_TOKEN: "record-secret",
      WILDCARD_ARRAY_PLUGIN_TOKEN: "wildcard-array-secret",
    };
    await expect(testing.projectConfigForTest({ plan: forgedArrayPlan, env })).rejects.toThrow(
      /Invalid plan target path/,
    );
    const projected = await testing.projectConfigForTest({
      plan,
      env,
    });

    expect(projected.plugins?.entries?.["foo.config.bar"]?.config).toEqual({
      token: { source: "env", provider: "default", id: "DOTTED_PLUGIN_TOKEN" },
    });
    expect(projected.plugins?.entries?.foo?.config).toEqual({
      bar: {
        config: { token: { source: "env", provider: "default", id: "NESTED_PLUGIN_TOKEN" } },
      },
    });
    expect(projected.plugins?.entries?.["array-plugin"]?.config).toEqual({
      accounts: [{ token: { source: "env", provider: "default", id: "ARRAY_PLUGIN_TOKEN" } }],
    });
    expect(projected.plugins?.entries?.["record-plugin"]?.config).toEqual({
      accounts: {
        "0": { token: { source: "env", provider: "default", id: "RECORD_PLUGIN_TOKEN" } },
        "foo.bar": { token: { source: "env", provider: "default", id: "RECORD_PLUGIN_TOKEN" } },
      },
    });
    expect(projected.plugins?.entries?.["wildcard-array-plugin"]?.config).toEqual({
      accounts: [
        { token: { source: "env", provider: "default", id: "WILDCARD_ARRAY_PLUGIN_TOKEN" } },
      ],
    });
  });

  it("keeps official external channel secret targets without installed plugin metadata", async () => {
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");

    const ids = getSecretTargetRegistry().map((entry) => entry.id);

    expect(ids).toContain("channels.qqbot.clientSecret");
    expect(ids).toContain("channels.qqbot.accounts.*.clientSecret");
  });

  it("builds config-scoped registries independently instead of reusing the singleton", async () => {
    metadataMocks.resolvePluginMetadataSnapshot.mockImplementation(
      (params?: { config?: { plugins?: { load?: { paths?: string[] } } } }) => {
        const pluginId = params?.config?.plugins?.load?.paths?.[0] ?? "missing";
        return {
          plugins: [
            {
              id: pluginId,
              origin: "config",
              channels: [],
              configContracts: {
                secretInputs: { paths: [{ path: "credentials.token" }] },
              },
            },
          ],
        } as never;
      },
    );
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");
    const firstConfig = { plugins: { load: { paths: ["first-plugin"] }, entries: {} } };
    const secondConfig = { plugins: { load: { paths: ["second-plugin"] }, entries: {} } };

    const firstIds = getSecretTargetRegistry({ config: firstConfig, env: {} }).map(
      (entry) => entry.id,
    );
    const secondIds = getSecretTargetRegistry({ config: secondConfig, env: {} }).map(
      (entry) => entry.id,
    );

    expect(firstIds).toContain("plugins.entries.first-plugin.config.credentials.token");
    expect(firstIds).not.toContain("plugins.entries.second-plugin.config.credentials.token");
    expect(secondIds).toContain("plugins.entries.second-plugin.config.credentials.token");
    expect(secondIds).not.toContain("plugins.entries.first-plugin.config.credentials.token");
  });

  it("loads channel contracts from every supported ownership field", async () => {
    const records = [
      writeChannelContract({
        channelId: "custom",
        pluginId: "custom-primary",
        targetId: "channels.custom.primaryToken",
        ownership: "channels",
      }),
      writeChannelContract({
        channelId: "custom",
        pluginId: "custom-secondary",
        targetId: "channels.custom.secondaryToken",
        ownership: "channelConfigs",
      }),
    ];
    metadataMocks.resolvePluginMetadataSnapshot.mockReturnValue({ plugins: records } as never);
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");

    const ids = getSecretTargetRegistry({
      config: { plugins: { load: { paths: records.map((record) => record.rootDir) } } },
      env: {},
    }).map((entry) => entry.id);

    expect(ids).toEqual(
      expect.arrayContaining(["channels.custom.primaryToken", "channels.custom.secondaryToken"]),
    );
  });
});
