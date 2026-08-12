// Channel schema OWNERSHIP contracts in config validation: canonical channel identity for
// authored variant spellings, and ownership planning from the defaulted config the gateway's
// auto-enable pass actually consumes.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

const mockLoadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn(
    (): PluginManifestRegistry => ({
      diagnostics: [],
      plugins: [],
    }),
  ),
);

function createPluginManifestRecord(
  overrides: Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id">,
): PluginManifestRecord {
  return {
    channels: [],
    cliBackends: [],
    hooks: [],
    manifestPath: `/tmp/${overrides.id}/openclaw.plugin.json`,
    origin: "bundled",
    providers: [],
    rootDir: `/tmp/${overrides.id}`,
    skills: [],
    source: `/tmp/${overrides.id}/index.js`,
    ...overrides,
  };
}

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: () => mockLoadPluginManifestRegistry(),
  resolveManifestContractPluginIds: () => [],
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => mockLoadPluginManifestRegistry(),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: () => ({
    manifestRegistry: mockLoadPluginManifestRegistry(),
  }),
  resolvePluginMetadataSnapshot: () => ({
    manifestRegistry: mockLoadPluginManifestRegistry(),
  }),
}));

vi.mock("../plugins/doctor-contract-registry.js", () => ({
  collectRelevantDoctorPluginIds: () => [],
}));

// #120332 round 48 (P2): an authored variant spelling of a claimed channel validates with the
// canonical schema. Schema metadata is keyed by canonical channel identity, so a raw-key lookup
// found no schema and silently accepted unsupported fields under the declared spelling.
describe("variant channel spellings validate canonically", () => {
  it("rejects unsupported keys authored under a claimed variant spelling", () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        createPluginManifestRecord({
          id: "qqbot-variant",
          origin: "global",
          channels: ["QQBot"],
          channelConfigs: {
            QQBot: {
              schema: {
                type: "object",
                properties: { mode: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        }),
      ],
    });

    const result = validateConfigObjectWithPlugins({
      channels: { QQBot: { bogusKey: true } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path.startsWith("channels.QQBot"))).toBe(true);
    }
  });
});

// ClawSweeper cycle 32 (P1): admission folds a manifest spelling and its canonical identity onto
// one channel, but validated each authored section independently. `resolveChannelConfigKey`
// serves exactly ONE section per canonical identity (the exact canonical key first, else the
// first authored record that folds), so a config carrying both spellings validated clean while
// activation silently ignored the other section's credentials or `enabled: false`.
describe("duplicate alias-equivalent channel sections are rejected", () => {
  // `clickclack` is a bundled channel id, so `normalizeChatChannelId` folds case variants onto
  // it — the same fold the activation resolver applies.
  const variantClaimant = (spelling: string, id = `${spelling.toLowerCase()}-variant`) =>
    createPluginManifestRecord({
      id,
      origin: "global",
      enabledByDefault: true,
      channels: [spelling],
      channelConfigs: { [spelling]: { schema: { type: "object" } } },
    });

  it("rejects a variant plus canonical pair and names the section activation reads", () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [variantClaimant("ClickClack")],
    });

    for (const channels of [
      { ClickClack: { token: "tok" }, clickclack: { enabled: false } },
      { clickclack: { enabled: false }, ClickClack: { token: "tok" } },
    ]) {
      const result = validateConfigObjectWithPlugins({ channels });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const duplicate = result.issues.find((issue) =>
          issue.message.includes("duplicate channel config"),
        );
        expect(duplicate?.message).toContain('"ClickClack"');
        expect(duplicate?.message).toContain('"clickclack"');
        // The exact canonical key takes priority in the resolver, whichever key came first.
        expect(duplicate?.message).toContain("activation reads only channels.clickclack");
      }
    }
  });

  it("names the first authored variant when no exact canonical section exists", () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [variantClaimant("ClickClack"), variantClaimant("CLICKCLACK")],
    });

    const result = validateConfigObjectWithPlugins({
      channels: { ClickClack: { token: "tok" }, CLICKCLACK: { enabled: false } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const duplicate = result.issues.find((issue) =>
        issue.message.includes("duplicate channel config"),
      );
      expect(duplicate?.path).toBe("channels.CLICKCLACK");
      expect(duplicate?.message).toContain("activation reads only channels.ClickClack");
    }
  });

  it("accepts a single authored variant section", () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [variantClaimant("ClickClack")],
    });

    const result = validateConfigObjectWithPlugins({
      channels: { ClickClack: { token: "tok" } },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts a single canonical section", () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [variantClaimant("ClickClack")],
    });

    const result = validateConfigObjectWithPlugins({
      channels: { clickclack: { token: "tok" } },
    });

    expect(result.ok).toBe(true);
  });

  it("ignores non-record duplicates the resolver walk skips", () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [variantClaimant("ClickClack")],
    });

    const result = validateConfigObjectWithPlugins({
      channels: { ClickClack: "oops", clickclack: { token: "tok" } },
    });

    // The string section fails its own schema; only two record-shaped sections can shadow
    // each other through the resolver, so no duplicate issue is reported.
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.message.includes("duplicate channel config")),
      ).toBe(false);
    }
  });
});

// #120332 round 48 (P1): ownership is planned from the DEFAULTED config. A `{}` channel whose
// schema default makes it meaningfully configured activates its replacement claim in the
// validated config gateway auto-enable consumes — the replacement supersedes the claimant
// serving ANOTHER channel, so that channel must be validated with the post-default owner's
// schema instead of the pre-default plan's.
describe("channel schema ownership follows the defaulted config", () => {
  it("ranks a sibling channel by the post-default owner", () => {
    const strictSchema = (property: string, extra?: Record<string, unknown>) => ({
      type: "object",
      properties: { [property]: { type: "string", ...extra } },
      additionalProperties: false,
    });
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        createPluginManifestRecord({
          id: "acme-multi",
          origin: "global",
          enabledByDefault: true,
          channels: ["acha", "bchb"],
          channelConfigs: {
            acha: { schema: strictSchema("region") },
            bchb: { schema: strictSchema("multiOpt") },
          },
        }),
        createPluginManifestRecord({
          id: "acme-alt",
          origin: "global",
          enabledByDefault: true,
          channels: ["bchb"],
          channelConfigs: { bchb: { schema: strictSchema("altOpt") } },
        }),
        createPluginManifestRecord({
          id: "acme-rep",
          origin: "global",
          enabledByDefault: true,
          channels: ["acha"],
          channelConfigs: {
            acha: {
              schema: strictSchema("region", { default: "us" }),
              preferOver: ["acme-multi"],
            },
          },
        }),
      ],
    });

    const result = validateConfigObjectWithPlugins({
      channels: { acha: {}, bchb: { multiOpt: "x" } },
    });

    // Post-defaults `acha` is configured, its replacement kills the multi-channel incumbent,
    // and `bchb`'s runtime owner is the alternative claimant whose schema rejects the
    // incumbent-only key.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path.startsWith("channels.bchb"))).toBe(true);
    }
  });
});

// #120332 round 49 (P1): landed ownership applies only to the config that produced the active
// registry. A prospective mutation selecting the replacement must validate against ITS OWN
// auto-enable plan — the old runtime owner's schema would veto the very change that replaces
// it — while re-validating the running config keeps the landed owner.
describe("landed ownership gates on the validated config", () => {
  const strictSchema = (property: string) => ({
    type: "object",
    properties: { [property]: { type: "string" } },
    additionalProperties: false,
  });
  const setupClaimants = () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        createPluginManifestRecord({
          id: "acme-inc",
          origin: "global",
          enabledByDefault: true,
          channels: ["acmech"],
          channelConfigs: { acmech: { schema: strictSchema("incOpt") } },
        }),
        createPluginManifestRecord({
          id: "acme-rep",
          origin: "global",
          enabledByDefault: true,
          channels: ["acmech"],
          contracts: { speechProviders: ["acme-speech"] },
          channelConfigs: {
            acmech: { schema: strictSchema("repOpt"), preferOver: ["acme-inc"] },
          },
        }),
      ],
    });
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.channels.push({
      pluginId: "acme-inc",
      plugin: { id: "acmech" },
    } as (typeof activeRegistry.channels)[number]);
    setActivePluginRegistry(activeRegistry, "landed-owner-validation");
  };

  it("validates a prospective replacement selection predictively", () => {
    setupClaimants();
    const runningConfig: OpenClawConfig = { channels: { acmech: { incOpt: "x" } } };
    setRuntimeConfigSnapshot(runningConfig, runningConfig);

    // The candidate differs on the activation surface: its own plan selects the replacement,
    // so the replacement-only key must validate even though the incumbent still serves.
    const result = validateConfigObjectWithPlugins({
      channels: { acmech: { repOpt: "x" } },
    });

    expect(result.ok).toBe(true);
  });

  it("keeps the landed owner when re-validating the running config", () => {
    setupClaimants();
    const runningConfig: OpenClawConfig = { channels: { acmech: { incOpt: "x" } } };
    setRuntimeConfigSnapshot(runningConfig, runningConfig);

    // Same activation surface as the published source: prediction would select the
    // replacement and reject the serving plugin's key — landed ownership keeps it valid.
    const result = validateConfigObjectWithPlugins({
      channels: { acmech: { incOpt: "x" } },
    });

    expect(result.ok).toBe(true);
  });

  // #120332 round 50 (P1): the landed-owner gate compares the probe-less candidate list, not
  // just the hashed surface. A candidate differing only in a section that creates capability
  // candidates (tts here) is a prospective mutation and must validate on its own plan.
  // #120332 round 55 (P1): config-owned env vars are activation surface. A candidate that
  // differs only in `env.vars` reloads into a different prepared environment, where an
  // env-only channel can change a cross-channel replacement plan — it must validate on its
  // own plan instead of reusing the landed owners.
  it("goes predictive when config-owned env vars change", () => {
    setupClaimants();
    const runningConfig: OpenClawConfig = { channels: { acmech: { incOpt: "x" } } };
    setRuntimeConfigSnapshot(runningConfig, runningConfig);

    const result = validateConfigObjectWithPlugins({
      channels: { acmech: { incOpt: "x" } },
      env: { vars: { ACME_NEW_CRED: "1" } },
    });

    expect(result.ok).toBe(false);
  });

  it("goes predictive when a non-surface section changes claimant planning", () => {
    setupClaimants();
    const runningConfig: OpenClawConfig = { channels: { acmech: { incOpt: "x" } } };
    setRuntimeConfigSnapshot(runningConfig, runningConfig);

    const result = validateConfigObjectWithPlugins({
      channels: { acmech: { incOpt: "x" } },
      tts: { enabled: true, provider: "acme-speech" },
    });

    // The speech selection adds a capability candidate for the replacement: the prospective
    // plan supersedes the incumbent, whose key the replacement's schema rejects.
    expect(result.ok).toBe(false);
  });
});

// #120332 round 50 (P1): default hydration and ownership planning iterate to STABILITY. One
// channel's default configures it and flips a second channel's owner; the second channel's own
// default then configures IT and flips a third channel's owner — a single rebuild froze the
// third channel on its pre-cascade schema.
describe("default-ownership iteration reaches a fixpoint", () => {
  it("ranks a third channel by the owner the cascaded defaults produce", () => {
    const schemaOf = (property: string, extra?: Record<string, unknown>) => ({
      type: "object",
      properties: { [property]: { type: "string", ...extra } },
      additionalProperties: false,
    });
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        createPluginManifestRecord({
          id: "acme-m1",
          origin: "global",
          enabledByDefault: true,
          channels: ["cha", "chb"],
          channelConfigs: { cha: { schema: schemaOf("aOpt") }, chb: { schema: schemaOf("m1Opt") } },
        }),
        createPluginManifestRecord({
          id: "acme-r1",
          origin: "global",
          enabledByDefault: true,
          channels: ["cha"],
          channelConfigs: {
            cha: { schema: schemaOf("aOpt", { default: "x" }), preferOver: ["acme-m1"] },
          },
        }),
        createPluginManifestRecord({
          id: "acme-alt2",
          origin: "global",
          enabledByDefault: true,
          channels: ["chb"],
          channelConfigs: {
            chb: { schema: schemaOf("bOpt", { default: "y" }), preferOver: ["acme-m3"] },
          },
        }),
        createPluginManifestRecord({
          id: "acme-m3",
          origin: "global",
          enabledByDefault: true,
          channels: ["chc"],
          channelConfigs: { chc: { schema: schemaOf("m3Opt") } },
        }),
        createPluginManifestRecord({
          id: "acme-alt3",
          origin: "global",
          enabledByDefault: true,
          channels: ["chc"],
          channelConfigs: { chc: { schema: schemaOf("alt3Opt") } },
        }),
      ],
    });

    const result = validateConfigObjectWithPlugins({
      channels: { cha: {}, chb: {}, chc: { m3Opt: "x" } },
    });

    // Pass 1 defaults cha (replacement owner) → replan kills m1 → chb's owner becomes alt2;
    // pass 2 defaults chb from alt2's schema → replan kills m3 → chc's runtime owner is alt3,
    // whose schema rejects the m3-only key.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path.startsWith("channels.chc"))).toBe(true);
    }
  });
});

// #120332 round 51 (P1): a hydration pass can REMOVE a default — a channel's default
// materializes it, the material plan kills a sibling channel's defaulted owner, and the
// surviving owner's schema no longer hydrates that sibling. The iteration must settle with
// schemas built from the record it accepts: the sibling is enforced by the post-kill owner's
// schema, and the de-hydrated sibling never resurrects the dead owner's defaults.
describe("default removal settles on schemas built from the accepted record", () => {
  it("enforces the post-kill owner on the channel whose default was removed", () => {
    const schemaOf = (property: string, extra?: Record<string, unknown>, required = false) => ({
      type: "object",
      properties: { [property]: { type: "string", ...extra } },
      ...(required ? { required: [property] } : {}),
      additionalProperties: false,
    });
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        // xch's incumbent, and ych's first claimant with a default: alive until xch's own
        // default materializes xch and its replacement's kill lands.
        createPluginManifestRecord({
          id: "acme-l",
          origin: "global",
          enabledByDefault: true,
          channels: ["xch", "ych"],
          channelConfigs: {
            xch: { schema: schemaOf("lOpt") },
            ych: { schema: schemaOf("yOpt", { default: "v" }) },
          },
        }),
        createPluginManifestRecord({
          id: "acme-w",
          origin: "global",
          enabledByDefault: true,
          channels: ["xch"],
          channelConfigs: {
            xch: { schema: schemaOf("wOpt", { default: "x" }), preferOver: ["acme-l"] },
          },
        }),
        createPluginManifestRecord({
          id: "acme-r",
          origin: "global",
          enabledByDefault: true,
          channels: ["ych"],
          channelConfigs: { ych: { schema: schemaOf("rOpt", undefined, true) } },
        }),
      ],
    });

    // Pass 1 defaults BOTH channels (w's replacement schema on xch, l's schema on ych); the
    // rebuilt plan kills l, so ych's default supply disappears and the channel de-hydrates.
    // The settled schemas must pair xch's surviving default with ych's post-kill owner, whose
    // required property rejects the authored empty channel.
    const result = validateConfigObjectWithPlugins({
      channels: { xch: {}, ych: {} },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path.startsWith("channels.ych"))).toBe(true);
      expect(result.issues.some((issue) => issue.path.startsWith("channels.xch"))).toBe(false);
    }
  });
});

// #120332 round 52 (P1): a bundled special setup's auto-enable decision reaches probe-less
// ownership planning. The acpx probe fires on `acp.*` config alone — no manifest fact, no
// plugins entry — and its catalog-level preference kills the incumbent only while it is live,
// so the surviving claimant's schema must govern exactly when the setup config is authored.
// Pins the end-to-end contract around the declarative setup candidates the detector now emits
// in skip mode (the red-first observable for those is the exact-plan accounting beside them).
describe("declared special setups decide probe-less ownership", () => {
  const schemaOf = (property: string) => ({
    type: "object",
    properties: { [property]: { type: "string" } },
    additionalProperties: false,
  });
  const setupClaimants = () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        createPluginManifestRecord({
          id: "acme-a",
          origin: "global",
          enabledByDefault: true,
          channels: ["xch"],
          channelConfigs: { xch: { schema: schemaOf("aOpt") } },
        }),
        // Setup-only plugin: activated by nothing but its (declaratively mirrored) probe — it
        // never claims the channel, so channel candidacy cannot enable it — and its
        // catalog-level preference kills the incumbent only while it is live.
        createPluginManifestRecord({
          id: "acpx",
          origin: "global",
          channels: [],
          channelCatalogMeta: { id: "xch", preferOver: ["acme-a"] },
          setup: {},
        }),
        createPluginManifestRecord({
          id: "acme-c",
          origin: "global",
          enabledByDefault: true,
          channels: ["xch"],
          channelConfigs: { xch: { schema: schemaOf("cOpt") } },
        }),
      ],
    });
  };

  it("accepts the surviving claimant's keys when the setup config is declared", () => {
    setupClaimants();
    const result = validateConfigObjectWithPlugins({
      channels: { xch: { cOpt: "z" } },
      acp: { enabled: true },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects the killed incumbent's keys when the setup config is declared", () => {
    setupClaimants();
    const result = validateConfigObjectWithPlugins({
      channels: { xch: { aOpt: "v" } },
      acp: { enabled: true },
    });
    expect(result.ok).toBe(false);
  });

  it("keeps the incumbent without the setup config", () => {
    setupClaimants();
    const result = validateConfigObjectWithPlugins({
      channels: { xch: { aOpt: "v" } },
    });
    expect(result.ok).toBe(true);
  });
});
