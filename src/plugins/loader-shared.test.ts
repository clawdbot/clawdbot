import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolvePluginCandidateInstallOwner } from "./candidate-install-owner.js";
import { getPluginCliCommandDescriptors } from "./cli-root-descriptors.js";
import type { PluginCandidate } from "./discovery.js";
import {
  collectCededChannelIdsByPlugin,
  createManifestPluginRecord,
  createPluginCandidatesFromManifestRegistry,
  validatePluginConfig,
} from "./loader-shared.js";
import { loadOpenClawPluginCliRegistry, loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "./loader.test-fixtures.js";
import { recordPluginManifestInstallOwner } from "./manifest-install-owner.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";

const emptyObjectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

function withSchemaKeyword(key: "if" | "then" | "else", value: unknown) {
  return { [key]: value };
}

const manifestRecord = {
  id: "example",
  channels: [],
  providers: [],
  cliBackends: [],
  skills: [],
  hooks: [],
  origin: "global",
  rootDir: "/plugins/example",
  source: "/plugins/example/index.js",
  manifestPath: "/plugins/example/openclaw.plugin.json",
} satisfies PluginManifestRecord;

function createRecordWithBuildVersion(openclawVersion: unknown) {
  const candidate = {
    idHint: "example",
    source: manifestRecord.source,
    rootDir: manifestRecord.rootDir,
    origin: manifestRecord.origin,
    packageManifest: {
      build: { openclawVersion },
    } as unknown as NonNullable<PluginCandidate["packageManifest"]>,
  } satisfies PluginCandidate;

  return createManifestPluginRecord({
    candidate,
    manifestRecord,
    enabled: true,
    activationState: {
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
    },
  });
}

describe("createManifestPluginRecord", () => {
  it("ignores malformed package build version metadata", () => {
    expect(createRecordWithBuildVersion(" 2026.7.2 ").builtWithOpenClawVersion).toBe("2026.7.2");
    expect(createRecordWithBuildVersion(42).builtWithOpenClawVersion).toBeUndefined();
  });
});

describe("createPluginCandidatesFromManifestRegistry", () => {
  it("preserves runtime child identity and package ownership", () => {
    const childRecord = recordPluginManifestInstallOwner(
      { ...manifestRecord, id: "example/child" },
      "example",
    );

    const candidate = createPluginCandidatesFromManifestRegistry({
      plugins: [childRecord],
      diagnostics: [],
    })[0];
    expect(candidate).toMatchObject({
      idHint: "example/child",
      effectivePluginId: "example/child",
    });
    expect(resolvePluginCandidateInstallOwner(candidate!)).toBe("example");
  });
});

describe("collectCededChannelIdsByPlugin", () => {
  function ringClaimant(id: string, preferOver?: string[]): PluginManifestRecord {
    return {
      ...manifestRecord,
      id,
      rootDir: `/plugins/${id}`,
      source: `/plugins/${id}/index.js`,
      manifestPath: `/plugins/${id}/openclaw.plugin.json`,
      channels: ["zzalpha"],
      channelConfigs: {
        zzalpha: {
          schema: { type: "object" },
          ...(preferOver ? { preferOver } : {}),
        },
      },
    };
  }

  function cededFor(plugins: PluginManifestRecord[]) {
    const config = { channels: { zzalpha: { token: "alpha" } } } as unknown as OpenClawConfig;
    return collectCededChannelIdsByPlugin({
      registry: { plugins, diagnostics: [] } as unknown as PluginManifestRegistry,
      config,
      sourceConfig: config,
      env: {},
      onlyPluginIdSet: null,
      dreamingSidecar: null,
    });
  }

  // Commit 6e5113c6742's invariant: members of a preferOver cycle settle nothing — no member
  // displaces another, all members register, and the first registrant keeps the channel. The cede
  // rule hands the channel to the winner and cedes every other active claimant, so a ring member
  // suppressed with the winner must be exempt: ceding it would displace a claimant the stand-off
  // says nobody displaces. The outside claimant's edge into the ring is what puts the channel in
  // the displaced set at all — a pure ring displaces nobody and the loop never reaches it.
  it("exempts a ring member suppressed with the winner from the cede", () => {
    const { cededChannelIdsByPlugin, cededChannelOwners } = cededFor([
      ringClaimant("zz-ring-a", ["zz-ring-b"]),
      ringClaimant("zz-ring-b", ["zz-ring-c"]),
      ringClaimant("zz-ring-c", ["zz-ring-a"]),
      ringClaimant("zz-outside", ["zz-ring-a"]),
    ]);

    // The outside edge displaces only zz-ring-a; the survivors settle on the first registrant.
    expect(cededChannelOwners.get("zzalpha")).toBe("zz-ring-b");
    expect(cededChannelIdsByPlugin.get("zz-ring-a")).toEqual(["zzalpha"]);
    // Not the winner, but suppressed with it: zz-ring-c keeps registering so the facade's
    // first-registrant rule — not a cede — settles the surviving ring.
    expect(cededChannelIdsByPlugin.has("zz-ring-c")).toBe(false);
    // An active claimant outside the suppressed component cedes to the winner.
    expect(cededChannelIdsByPlugin.get("zz-outside")).toEqual(["zzalpha"]);
  });

  // The P1 shape (comment 3840887960): two independent declarations leave two active,
  // undisplaced claimants, and ceding only the displaced ids let registration order pick between
  // them while schema ownership named its one winner. Every active non-winner cedes.
  it("cedes the second independent declarer, not only the displaced ids", () => {
    const { cededChannelIdsByPlugin, cededChannelOwners } = cededFor([
      ringClaimant("zz-pair-a", ["zz-pair-b"]),
      ringClaimant("zz-pair-b"),
      ringClaimant("zz-pair-c", ["zz-pair-d"]),
      ringClaimant("zz-pair-d"),
    ]);

    expect(cededChannelOwners.get("zzalpha")).toBe("zz-pair-a");
    expect(cededChannelIdsByPlugin.get("zz-pair-b")).toEqual(["zzalpha"]);
    expect(cededChannelIdsByPlugin.get("zz-pair-c")).toEqual(["zzalpha"]);
    expect(cededChannelIdsByPlugin.get("zz-pair-d")).toEqual(["zzalpha"]);
    expect(cededChannelIdsByPlugin.has("zz-pair-a")).toBe(false);
  });
});

describe("validatePluginConfig source values", () => {
  it("does not accept a null source through the empty-schema fast path", () => {
    expect(
      validatePluginConfig({ schema: emptyObjectSchema, sourceValue: null, value: {} }).ok,
    ).toBe(false);
  });
  it("keeps the resolved runtime value when source validation needs no defaults", () => {
    const schema = {
      type: "object",
      properties: { credential: { type: "object", required: ["id"] } },
      required: ["credential"],
    };
    const value = { credential: "resolved-fixture-key" };
    const result = validatePluginConfig({
      schema,
      sourceValue: { credential: { id: "KEY" } },
      value,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(value);
    }
  });

  it("validates secret input source refs while preserving resolved values and defaults", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        credential: {
          type: "object",
          required: ["source", "provider", "id"],
          properties: {
            source: { const: "store" },
            provider: { type: "string" },
            id: { type: "string" },
          },
        },
        retries: { type: "integer", default: 2 },
      },
    };
    const sourceValue = { credential: { source: "store", provider: "default", id: "KEY" } };
    const value = { credential: "resolved-fixture-key" };
    expect(validatePluginConfig({ schema, sourceValue, value })).toEqual({
      ok: true,
      value: { ...value, retries: 2 },
    });
    expect(validatePluginConfig({ schema, value })).toMatchObject({ ok: false });
    expect(value).toEqual({ credential: "resolved-fixture-key" });
  });
});

describe("validatePluginConfig empty schema classification", () => {
  it("validates pattern properties instead of requiring empty config", () => {
    const schema = {
      ...emptyObjectSchema,
      patternProperties: { "^S_": { type: "string" } },
    };

    expect(validatePluginConfig({ schema, value: { S_SETTING: "configured" } })).toEqual({
      ok: true,
      value: { S_SETTING: "configured" },
    });
    expect(validatePluginConfig({ schema, value: { S_SETTING: 42 } })).toMatchObject({
      ok: false,
    });
  });

  it("validates dependent schemas instead of using the empty-config shortcut", () => {
    const result = validatePluginConfig({
      schema: {
        ...emptyObjectSchema,
        dependentSchemas: { mode: { required: ["token"] } },
      },
      value: { mode: true },
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error.join(" ")).not.toContain("config must be empty");
    }
  });

  it.each([
    {
      branch: "then",
      schema: {
        ...withSchemaKeyword("if", true),
        ...withSchemaKeyword("then", { minProperties: 1 }),
      },
    },
    {
      branch: "else",
      schema: {
        ...withSchemaKeyword("if", false),
        ...withSchemaKeyword("else", { minProperties: 1 }),
      },
    },
  ])("applies an active $branch conditional", ({ schema }) => {
    expect(
      validatePluginConfig({ schema: { ...emptyObjectSchema, ...schema }, value: {} }),
    ).toMatchObject({ ok: false });
  });

  it.each([
    withSchemaKeyword("if", true),
    withSchemaKeyword("then", { minProperties: 1 }),
    withSchemaKeyword("else", { minProperties: 1 }),
  ])("keeps standalone conditional keywords on the empty-config path: %o", (keyword) => {
    expect(
      validatePluginConfig({
        schema: { ...emptyObjectSchema, ...keyword },
        value: { unexpected: true },
      }),
    ).toEqual({ ok: false, error: ["<root>: config must be empty"] });
  });
});

afterAll(cleanupPluginLoaderFixturesForTest);

describe.each(["runtime", "cli", "descriptors"] as const)(
  "%s source-config boundary",
  (surface) => {
    it.each(["paired", "mixed-case", "candidate", "undeclared", "invalid-source"] as const)(
      "validates the exact source only for declared secretInputs (%s)",
      async (scenario) => {
        await withOpenClawTestState(
          { label: "plugin-source-validation", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
          async (state) => {
            const id = "source-fixture";
            const configId = scenario === "mixed-case" ? "Source-Fixture" : id;
            const descriptor = {
              name: "source-fixture",
              description: "Fixture command",
              hasSubcommands: false,
            };
            const configSchema = {
              type: "object",
              properties: {
                credential: {
                  type: "object",
                  properties: {
                    source: { const: "store" },
                    provider: { type: "string" },
                    id: { type: "string" },
                  },
                  required: ["source", "provider", "id"],
                },
                retries: { type: "integer", default: 2 },
                description: { type: "string" },
              },
              if: { properties: { credential: { properties: { id: { const: "KEY" } } } } },
              // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema branch data, not a promise method.
              then: { properties: { description: { default: "Fixture command" } } },
              else: { properties: { description: { default: "Alternate command" } } },
              required: ["credential"],
              additionalProperties: false,
            };
            const marker = state.statePath("fixture/imported");
            const entry = await state.writeText(
              "fixture/index.cjs",
              `
require("node:fs").writeFileSync(${JSON.stringify(marker)}, "imported");
module.exports = { id: "source-fixture", register(api) {
  if (api.pluginConfig.credential !== "resolved-fixture-key" || api.pluginConfig.retries !== 2) {
    throw new Error("paired runtime config was not hydrated");
  }
  api.registerCli(() => {}, { descriptors: [{ ...${JSON.stringify(descriptor)}, description: api.pluginConfig.description }] });
} };`,
            );
            await state.writeJson("fixture/openclaw.plugin.json", {
              id,
              configSchema,
              cliCommands: [descriptor],
              ...(scenario === "undeclared"
                ? {}
                : {
                    configContracts: {
                      secretInputs: { paths: [{ path: "credential", expected: "string" }] },
                    },
                  }),
            });
            const runtime: OpenClawConfig = {
              plugins: {
                allow: [id],
                load: { paths: [entry] },
                entries: {
                  [configId]: { enabled: true, config: { credential: "resolved-fixture-key" } },
                },
              },
            };
            const source: OpenClawConfig = {
              ...runtime,
              plugins: {
                ...runtime.plugins,
                entries: {
                  [configId]: {
                    enabled: true,
                    config: {
                      credential:
                        scenario === "invalid-source"
                          ? "invalid-plaintext-fixture"
                          : { source: "store", provider: "default", id: "KEY" },
                    },
                  },
                },
              },
            };
            const before = structuredClone({ runtime, source });
            setRuntimeConfigSnapshot(runtime, source);
            const config = scenario === "candidate" ? structuredClone(runtime) : runtime;
            const accepted = scenario === "paired" || scenario === "mixed-case";
            try {
              if (surface === "descriptors") {
                expect(await getPluginCliCommandDescriptors(config, state.env)).toEqual(
                  accepted ? [descriptor] : [],
                );
                expect(fs.existsSync(marker)).toBe(false);
              } else {
                const messages: string[] = [];
                const options = {
                  config,
                  env: state.env,
                  activate: false,
                  logger: {
                    info() {},
                    warn() {},
                    error(message: string) {
                      messages.push(message);
                    },
                  },
                };
                const registry =
                  surface === "runtime"
                    ? loadOpenClawPlugins(options)
                    : await loadOpenClawPluginCliRegistry(options);
                expect(registry.plugins.find((plugin) => plugin.id === id)?.status).toBe(
                  accepted ? "loaded" : "error",
                );
                expect(
                  registry.cliRegistrars.flatMap((registrar) => registrar.descriptors),
                ).toEqual(accepted ? [descriptor] : []);
                expect(fs.existsSync(marker)).toBe(accepted);
                if (surface === "runtime" && scenario === "paired") {
                  const candidate = structuredClone(runtime);
                  const unpaired = loadOpenClawPlugins({ ...options, config: candidate });
                  expect
                    .soft(unpaired.plugins.find((plugin) => plugin.id === id)?.status)
                    .toBe("error");
                  // Identity failures must not expand the registries' lazy runtime properties.
                  expect.soft(unpaired === registry).toBe(false);
                  expect(
                    loadOpenClawPlugins({
                      ...options,
                      config: candidate,
                      activationSourceConfig: structuredClone(source),
                    }) === registry,
                  ).toBe(true);

                  const alternateSource: OpenClawConfig = {
                    ...source,
                    plugins: {
                      ...source.plugins,
                      entries: {
                        [id]: {
                          enabled: true,
                          config: {
                            credential: { source: "store", provider: "default", id: "OTHER" },
                          },
                        },
                      },
                    },
                  };
                  const alternateOptions = {
                    ...options,
                    config: candidate,
                    activationSourceConfig: alternateSource,
                  };
                  const alternate = loadOpenClawPlugins(alternateOptions);
                  expect.soft(alternate === registry).toBe(false);
                  expect
                    .soft(alternate.cliRegistrars.flatMap((registrar) => registrar.descriptors))
                    .toEqual([{ ...descriptor, description: "Alternate command" }]);
                  expect(
                    loadOpenClawPlugins({
                      ...alternateOptions,
                      activationSourceConfig: structuredClone(alternateSource),
                    }) === alternate,
                  ).toBe(true);

                  setRuntimeConfigSnapshot(candidate, structuredClone(source));
                  expect(loadOpenClawPlugins({ ...options, config: candidate }) === registry).toBe(
                    true,
                  );
                }
                expect(
                  JSON.stringify({ messages, diagnostics: registry.diagnostics }),
                ).not.toContain("resolved-fixture-key");
                expect(
                  JSON.stringify({ messages, diagnostics: registry.diagnostics }),
                ).not.toContain("invalid-plaintext-fixture");
              }
              expect({ runtime, source }).toEqual(before);
            } finally {
              resetPluginLoaderTestStateForTest();
            }
          },
        );
      },
    );
  },
);
