import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginCandidateInstallOwner } from "./candidate-install-owner.js";
import type { PluginCandidate } from "./discovery.js";
import {
  collectCededChannelIdsByPlugin,
  createManifestPluginRecord,
  createPluginCandidatesFromManifestRegistry,
  validatePluginConfig,
} from "./loader-shared.js";
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
