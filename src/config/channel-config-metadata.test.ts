// Verifies channel config schema ownership across plugin origins and replacement declarations.
import { describe, expect, it } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { collectChannelSchemaMetadataWithOwnership } from "./channel-config-metadata.js";
import {
  createChannelPlugin,
  REPLACED_ACME,
  REPLACEMENT_ACME,
  validateAcmeChatKeys,
} from "./channel-config-metadata.test-helpers.js";
import type { OpenClawConfig } from "./types.js";

function selectSlackSchemaOwner(plugins: PluginManifestRecord[], config?: OpenClawConfig) {
  const registry: PluginManifestRegistry = { diagnostics: [], plugins };
  const entry = collectChannelSchemaMetadataWithOwnership(registry, config).find(
    (channel) => channel.id === "slack",
  );
  return {
    schemaPluginId: entry?.schemaPluginId,
    label: entry?.label,
    description: entry?.description,
    configUiHints: entry?.configUiHints,
    properties: Object.keys(
      (entry?.configSchema as { properties?: object } | undefined)?.properties ?? {},
    ),
  };
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  const orders: T[][] = [];
  for (const [index, item] of items.entries()) {
    for (const rest of permutations([...items.slice(0, index), ...items.slice(index + 1)])) {
      rest.unshift(item);
      orders.push(rest);
    }
  }
  return orders;
}

// Mirrors #92884: a replacement Slack plugin installed alongside the plugin it supersedes,
// adding a plugin-owned channels.slack.threadGuard block behind preferOver.
const REPLACED_SLACK = createChannelPlugin({ id: "openclaw-slack", origin: "global" });
const REPLACEMENT_SLACK = createChannelPlugin({
  id: "acme-slack-thread-guard",
  origin: "global",
  extraProperty: "threadGuard",
  preferOver: ["openclaw-slack"],
});
// The same incumbent with the mixed-case id its manifest author chose, against the lowercase
// policy key REPLACEMENT_SLACK declares in `preferOver`.
const MIXED_CASE_REPLACED_SLACK = createChannelPlugin({ id: "OpenClaw-Slack", origin: "global" });
// A same-origin claimant unrelated to the replacement contract.
const UNRELATED_SLACK = createChannelPlugin({
  id: "zeta-slack-extras",
  origin: "global",
  extraProperty: "zetaOnly",
});
const CLOSER_ORIGIN_SLACK = createChannelPlugin({
  id: "operator-slack",
  origin: "config",
  extraProperty: "operatorOnly",
});
// A closer declaration that only names and labels the channel. Current main lets a closer entry
// block a farther one only when it supplies a schema or UI hints, so this claim must keep its
// label without taking the schema that validates the channel's keys.
const CLOSER_LABEL_ONLY_SLACK = createChannelPlugin({
  id: "operator-slack-labels",
  origin: "config",
  omitSchema: true,
  label: "Operator Slack",
});
const TRAVERSAL_ORDERS = [
  ["replacement first", [REPLACEMENT_SLACK, REPLACED_SLACK]],
  ["replacement last", [REPLACED_SLACK, REPLACEMENT_SLACK]],
] as const;

function pluginEntryConfig(pluginId: string, entry: Record<string, unknown>): OpenClawConfig {
  return { plugins: { entries: { [pluginId]: entry } } } as OpenClawConfig;
}

function pluginEnabledConfig(pluginId: string, enabled: boolean): OpenClawConfig {
  return pluginEntryConfig(pluginId, { enabled });
}

// Every entry shape the shared material plugin-entry policy counts as an explicit operator
// selection. `apiKey` is not a canonical `plugins.entries` key, so it proves the collector reads
// that policy instead of re-deriving a `config`-only subset of it.
const MATERIAL_PLUGIN_ENTRIES = [
  ["config", { config: {} }],
  ["apiKey", { apiKey: "op://slack/token" }],
] as const;

// Every `plugins.entries` form auto-enable's replacement policy honors as an explicit selection.
const EXPLICIT_PLUGIN_ENTRIES = [
  ["enabled", { enabled: true }],
  ...MATERIAL_PLUGIN_ENTRIES,
] as const;
const CANONICAL_EXPLICIT_PLUGIN_ENTRIES = EXPLICIT_PLUGIN_ENTRIES.filter(
  ([entryKey]) => entryKey !== "apiKey",
);

function bothSlackPluginsSelected(entry: Record<string, unknown>): OpenClawConfig {
  return {
    plugins: {
      entries: { "openclaw-slack": entry, "acme-slack-thread-guard": entry },
    },
  } as OpenClawConfig;
}

// A bundled successor superseding the bundled channel plugin: the only shape where two claims
// reach the explicit tier at equal origin, since `channels.<id>.enabled` marks a bundled plugin
// explicit for the activation resolver but not for auto-enable's replacement policy.
const BUNDLED_SLACK = createChannelPlugin({ id: "slack", origin: "bundled" });
const BUNDLED_REPLACEMENT_SLACK = createChannelPlugin({
  id: "openclaw-slack-thread-guard",
  origin: "bundled",
  extraProperty: "threadGuard",
  preferOver: ["slack"],
  enabledByDefault: true,
});

// A workspace plugin stays disabled by default until auto-enable writes its entry, so its claim
// only looks inactive while the config is still the pre-auto-enable one validation reads.
const WORKSPACE_REPLACEMENT_SLACK = createChannelPlugin({
  id: "acme-slack-thread-guard",
  origin: "workspace",
  extraProperty: "threadGuard",
  preferOver: ["slack"],
});

// The same disabled-by-default workspace plugin without a replacement declaration, beside the
// already-active bundled plugin it shadows.
const WORKSPACE_ONLY_SLACK = createChannelPlugin({
  id: "acme-workspace-slack",
  origin: "workspace",
  extraProperty: "workspaceOnly",
});
const DEFAULT_ENABLED_BUNDLED_SLACK = createChannelPlugin({
  id: "slack",
  origin: "bundled",
  extraProperty: "bundledOnly",
  enabledByDefault: true,
});

// A replacement pair where both sides ship disabled-by-default (workspace origin), so neither
// claim is live on the pre-auto-enable config once the operator forbids the replacement.
const WORKSPACE_PAIR_REPLACEMENT_SLACK = createChannelPlugin({
  id: "acme-slack-thread-guard",
  origin: "workspace",
  extraProperty: "threadGuard",
  preferOver: ["acme-workspace-slack"],
});

// The mixed-case incumbent installed from the operator's config load path: the closest origin,
// active by default, against the farther global replacement that supersedes it.
const CONFIG_ORIGIN_MIXED_CASE_SLACK = createChannelPlugin({
  id: "OpenClaw-Slack",
  origin: "config",
});

// A catalog-merged channelConfigs entry for a channel the manifest `channels` list never claims:
// auto-enable can never select this plugin for the channel, whatever its origin.
const CATALOG_ONLY_CLOSER_SLACK = createChannelPlugin({
  id: "operator-slack-catalog",
  origin: "config",
  extraProperty: "catalogOnly",
  claimChannels: ["slack-catalog-extras"],
});

// A catalog-merged claim carrying preferOver and UI hints but no schema. Hints may merge, but a
// claim that validates nothing must never take validation ownership from one that supplies a schema.
const HINTS_ONLY_REPLACEMENT_SLACK = createChannelPlugin({
  id: "acme-slack-hints",
  origin: "global",
  omitSchema: true,
  preferOver: ["openclaw-slack"],
  uiHints: { mode: { label: "Mode" } },
});

// The same equal-origin replacement pair, with the presentation each side declares for the channel.
const LABELED_REPLACEMENT_SLACK = createChannelPlugin({
  id: "acme-slack-thread-guard",
  origin: "global",
  extraProperty: "threadGuard",
  preferOver: ["openclaw-slack"],
  label: "Modern Slack",
  description: "Modern replacement channel",
});
const LABELED_REPLACED_SLACK = createChannelPlugin({
  id: "openclaw-slack",
  origin: "global",
  label: "Legacy Slack",
  description: "Legacy incumbent channel",
});

describe("collectChannelSchemaMetadataWithOwnership", () => {
  for (const [order, plugins] of TRAVERSAL_ORDERS) {
    it(`keeps the preferOver replacement schema at equal origin (${order})`, () => {
      expect(selectSlackSchemaOwner([...plugins])).toEqual({
        schemaPluginId: "acme-slack-thread-guard",
        // heartbeatVisibility is the core-owned property merged into installed channel schemas.
        properties: ["mode", "threadGuard", "heartbeatVisibility"],
      });
    });

    it(`drops a disabled replacement's preferOver claim at equal origin (${order})`, () => {
      expect(
        selectSlackSchemaOwner([...plugins], pluginEnabledConfig("acme-slack-thread-guard", false))
          .schemaPluginId,
      ).toBe("openclaw-slack");
    });

    it(`keeps the enabled replacement when the plugin it supersedes is disabled (${order})`, () => {
      expect(
        selectSlackSchemaOwner([...plugins], pluginEnabledConfig("openclaw-slack", false))
          .schemaPluginId,
      ).toBe("acme-slack-thread-guard");
    });

    // #120332 rounds 37/40: an explicitly kept superseded plugin is PRESERVED — the manifest
    // contract keeps explicit operator selections registering first-wins with duplicate
    // diagnostics (only IMPLICIT supersessions are suppressed at registration) — so validation
    // mirrors whichever registrant the runtime actually serves.
    it(`follows the first-loaded claimant when an explicitly kept plugin stays co-active (${order})`, () => {
      expect(
        selectSlackSchemaOwner([...plugins], pluginEnabledConfig("openclaw-slack", true))
          .schemaPluginId,
      ).toBe(plugins[0]?.id);
    });

    for (const [entryKey, entry] of MATERIAL_PLUGIN_ENTRIES) {
      it(`follows the first-loaded claimant beside a plugin kept through entries.${entryKey} (${order})`, () => {
        expect(
          selectSlackSchemaOwner([...plugins], pluginEntryConfig("openclaw-slack", entry))
            .schemaPluginId,
        ).toBe(plugins[0]?.id);
      });
    }

    // Selecting both plugins keeps both active with duplicate channel diagnostics — explicit
    // selections are never suppressed — so ownership follows the runtime's first-wins winner.
    for (const [entryKey, entry] of EXPLICIT_PLUGIN_ENTRIES) {
      it(`keeps first-registrant ownership when both plugins are selected through entries.${entryKey} (${order})`, () => {
        expect(
          selectSlackSchemaOwner([...plugins], bothSlackPluginsSelected(entry)).schemaPluginId,
        ).toBe(plugins[0]?.id);
      });
    }

    it(`keeps first-registrant ownership when both plugins are allowlisted (${order})`, () => {
      expect(
        selectSlackSchemaOwner([...plugins], {
          plugins: { allow: ["openclaw-slack", "acme-slack-thread-guard"] },
        } as OpenClawConfig).schemaPluginId,
      ).toBe(plugins[0]?.id);
    });
  }

  // `channels.<id>.enabled` is not an explicit plugin selection for auto-enable's replacement
  // policy, so it still disables the superseded bundled plugin and the replacement serves the
  // channel. The collector must not read a broader explicit set and hand the schema back.
  for (const [order, plugins] of [
    ["replacement first", [BUNDLED_REPLACEMENT_SLACK, BUNDLED_SLACK]],
    ["replacement last", [BUNDLED_SLACK, BUNDLED_REPLACEMENT_SLACK]],
  ] as const) {
    it(`lets a replacement supersede a bundled plugin enabled only by channel config (${order})`, () => {
      expect(
        selectSlackSchemaOwner([...plugins], {
          channels: { slack: { enabled: true } },
        } as OpenClawConfig).schemaPluginId,
      ).toBe("openclaw-slack-thread-guard");
    });
  }

  // Auto-enable enables every claimant of a configured channel, so a replacement that is only
  // disabled-by-default is one the runtime is about to activate while it disables the incumbent.
  // Ranking it out on pre-auto-enable activation applies the incumbent schema to a channel the
  // replacement will serve, and validation then rejects the replacement's own keys before startup.
  for (const [order, plugins] of [
    ["replacement first", [WORKSPACE_REPLACEMENT_SLACK, BUNDLED_SLACK]],
    ["replacement last", [BUNDLED_SLACK, WORKSPACE_REPLACEMENT_SLACK]],
  ] as const) {
    it(`keeps a replacement auto-enable activates over an active bundled plugin (${order})`, () => {
      expect(
        selectSlackSchemaOwner([...plugins], {
          channels: { slack: { enabled: true, botToken: "xoxb-test" } },
        } as OpenClawConfig).schemaPluginId,
      ).toBe("acme-slack-thread-guard");
    });
  }

  // Without a declared replacement auto-enable's candidate list collapses to the first claimant in
  // discovery order, which reaches workspace plugins before bundled ones. Ranking that claimant out
  // for being disabled-by-default applies the bundled schema to a channel the runtime hands to the
  // workspace plugin, so ownership must follow the same selection in either discovery order.
  for (const [order, plugins, owner] of [
    [
      "workspace discovered first",
      [WORKSPACE_ONLY_SLACK, DEFAULT_ENABLED_BUNDLED_SLACK],
      "acme-workspace-slack",
    ],
    ["bundled discovered first", [DEFAULT_ENABLED_BUNDLED_SLACK, WORKSPACE_ONLY_SLACK], "slack"],
  ] as const) {
    it(`follows auto-enable's first-claimant selection with no declared replacement (${order})`, () => {
      expect(
        selectSlackSchemaOwner([...plugins], {
          channels: { slack: { botToken: "xoxb-test" } },
        } as OpenClawConfig).schemaPluginId,
      ).toBe(owner);
    });
  }

  for (const [order, plugins] of [
    ["closer origin first", [CLOSER_ORIGIN_SLACK, REPLACEMENT_SLACK]],
    ["closer origin last", [REPLACEMENT_SLACK, CLOSER_ORIGIN_SLACK]],
  ] as const) {
    it(`hands a disabled closer-origin owner's schema to an active farther origin (${order})`, () => {
      expect(
        selectSlackSchemaOwner([...plugins], pluginEnabledConfig("operator-slack", false))
          .schemaPluginId,
      ).toBe("acme-slack-thread-guard");
    });
  }

  for (const claimants of permutations([REPLACEMENT_SLACK, REPLACED_SLACK, UNRELATED_SLACK])) {
    it(`resolves ownership across all claimants (${claimants.map((plugin) => plugin.id).join(" > ")})`, () => {
      expect(selectSlackSchemaOwner(claimants).schemaPluginId).toBe("acme-slack-thread-guard");
    });
  }

  it("lets a closer origin override a preferOver replacement", () => {
    const owner = selectSlackSchemaOwner([
      REPLACEMENT_SLACK,
      createChannelPlugin({
        id: "workspace-slack",
        origin: "workspace",
        extraProperty: "workspaceOnly",
      }),
    ]);

    expect(owner.schemaPluginId).toBe("workspace-slack");
  });

  for (const [order, plugins] of [
    ["metadata-only first", [CLOSER_LABEL_ONLY_SLACK, REPLACED_SLACK]],
    ["metadata-only last", [REPLACED_SLACK, CLOSER_LABEL_ONLY_SLACK]],
  ] as const) {
    it(`keeps a farther schema behind a closer metadata-only declaration (${order})`, () => {
      const owner = selectSlackSchemaOwner([...plugins]);

      expect(owner.schemaPluginId).toBe("openclaw-slack");
      expect(owner.label).toBe("Operator Slack");
    });
  }

  // Pins the collector to the shared preferOver comparison auto-enable now reads, so the two
  // cannot drift back apart and leave validation and the running channel on different schemas.
  for (const [order, plugins] of [
    ["replacement first", [REPLACEMENT_SLACK, MIXED_CASE_REPLACED_SLACK]],
    ["replacement last", [MIXED_CASE_REPLACED_SLACK, REPLACEMENT_SLACK]],
  ] as const) {
    it(`applies preferOver to a manifest id that differs only in case (${order})`, () => {
      expect(selectSlackSchemaOwner([...plugins]).schemaPluginId).toBe("acme-slack-thread-guard");
    });

    // Config normalization keys plugin policy by the lowercase id, so an operator selects that
    // mixed-case incumbent through the normalized key. Explicit selection must compare through it
    // too: the case-folded preferOver comparison above now reaches this incumbent, so an
    // exact-match read ranks it out and applies the replacement's schema to a channel auto-enable
    // leaves with the incumbent.
    for (const [selection, config] of [
      ["allow", { plugins: { allow: ["openclaw-slack"] } } as OpenClawConfig],
      ["entries", pluginEntryConfig("openclaw-slack", { config: {} })],
    ] as const) {
      it(`keeps a mixed-case incumbent selected through the normalized ${selection} key (${order})`, () => {
        // Rounds 37/40: explicit selections stay registered first-wins, so the first-loaded
        // claimant owns per registry order.
        expect(selectSlackSchemaOwner([...plugins], config).schemaPluginId).toBe(plugins[0]?.id);
      });
    }
  }

  // Ownership is decided across every claim before metadata is written, so a claim that lost it can
  // still be traversed afterwards. Current main moves label and schema together, so the surfaced
  // presentation must keep describing the plugin whose schema validates the channel; an equal-origin
  // loser may only fill what the owner leaves empty.
  for (const [order, plugins] of [
    ["loser last", [LABELED_REPLACEMENT_SLACK, LABELED_REPLACED_SLACK]],
    ["loser first", [LABELED_REPLACED_SLACK, LABELED_REPLACEMENT_SLACK]],
  ] as const) {
    it(`keeps the schema owner's presentation against an equal-origin losing claim (${order})`, () => {
      expect(selectSlackSchemaOwner([...plugins])).toMatchObject({
        schemaPluginId: "acme-slack-thread-guard",
        label: "Modern Slack",
        description: "Modern replacement channel",
      });
    });
  }

  // A closer-origin losing claim still replaces the owner's presentation, the precedence current
  // main applies when that claim also takes the whole entry — in either traversal order, so the
  // surfaced label and hints never depend on which side the registry lists first.
  const HINTED_LABELED_REPLACEMENT_SLACK = createChannelPlugin({
    id: "acme-slack-thread-guard",
    origin: "global",
    extraProperty: "threadGuard",
    preferOver: ["openclaw-slack"],
    label: "Modern Slack",
    uiHints: { mode: { label: "Owner Mode" } },
  });
  // #120332 round 47 (P2): the closer claim also hints the OWNER'S sensitive key — the per-key
  // merge must combine properties within the conflicting key, not replace the owner's object,
  // or the label strips `sensitive: true` and Control UI raw-config diffs render the credential.
  const CLOSER_HINTS_ONLY_SLACK = createChannelPlugin({
    id: "operator-slack-labels",
    origin: "config",
    omitSchema: true,
    label: "Operator Slack",
    uiHints: { mode: { label: "Operator Mode" }, botToken: { label: "Operator Token" } },
  });
  for (const [order, plugins] of [
    ["closer claim first", [CLOSER_HINTS_ONLY_SLACK, HINTED_LABELED_REPLACEMENT_SLACK]],
    ["closer claim last", [HINTED_LABELED_REPLACEMENT_SLACK, CLOSER_HINTS_ONLY_SLACK]],
  ] as const) {
    it(`lets a closer-origin losing claim override the schema owner's presentation (${order})`, () => {
      expect(selectSlackSchemaOwner([...plugins])).toMatchObject({
        schemaPluginId: "acme-slack-thread-guard",
        label: "Operator Slack",
        configUiHints: { mode: { label: "Operator Mode" } },
      });
    });
  }

  // #120332 round 44 (P2): a closer losing claim's hints merge per key — they must not strip
  // the schema owner's `sensitive` hints, or Control UI raw-config diffs render the credential.
  const SENSITIVE_HINTED_OWNER_SLACK = createChannelPlugin({
    id: "acme-slack-thread-guard",
    origin: "global",
    extraProperty: "threadGuard",
    preferOver: ["openclaw-slack"],
    uiHints: { mode: { label: "Owner Mode" }, botToken: { sensitive: true } },
  });
  for (const [order, plugins] of [
    ["closer claim first", [CLOSER_HINTS_ONLY_SLACK, SENSITIVE_HINTED_OWNER_SLACK]],
    ["closer claim last", [SENSITIVE_HINTED_OWNER_SLACK, CLOSER_HINTS_ONLY_SLACK]],
  ] as const) {
    it(`keeps the owner's sensitive hints beneath a closer losing claim's hints (${order})`, () => {
      const owner = selectSlackSchemaOwner([...plugins]);
      expect(owner.configUiHints).toMatchObject({
        mode: { label: "Operator Mode" },
        botToken: { label: "Operator Token", sensitive: true },
      });
    });
  }

  // #120332 round 48 (P1): hint precedence is tracked per KEY, and the owner's `sensitive: true`
  // is authoritative regardless of rank. With one map-wide rank, a closest claim's unrelated
  // hint held the whole map, so a farther claim's `sensitive: false` filled the owner's key and
  // the owner's later `sensitive: true` could never replace it — Control UI raw-config diffs
  // would render the credential.
  const FALSE_HINT_SLACK = createChannelPlugin({
    id: "openclaw-slack-false-hint",
    origin: "global",
    omitSchema: true,
    uiHints: { botToken: { sensitive: false } },
  });
  for (const [order, plugins] of [
    ["owner last", [CLOSER_HINTS_ONLY_SLACK, FALSE_HINT_SLACK, SENSITIVE_HINTED_OWNER_SLACK]],
    ["owner first", [SENSITIVE_HINTED_OWNER_SLACK, CLOSER_HINTS_ONLY_SLACK, FALSE_HINT_SLACK]],
  ] as const) {
    it(`keeps the owner's sensitive flag over a farther claim's false on the same key (${order})`, () => {
      const owner = selectSlackSchemaOwner([...plugins]);
      expect(owner.configUiHints).toMatchObject({
        botToken: { label: "Operator Token", sensitive: true },
      });
    });
  }

  // #120332 round 51 (P1): the owner's `sensitive: true` also survives a STRICTLY CLOSER claim
  // that writes `sensitive: false` on the same key AFTER the owner was traversed. The owner-time
  // guard protects only the owner's own write; the key must stay redacted independent of
  // traversal and presentation precedence, or Control UI raw-config diffs render the credential.
  const CLOSER_FALSE_HINT_SLACK = createChannelPlugin({
    id: "operator-slack-false-hint",
    origin: "config",
    omitSchema: true,
    uiHints: { botToken: { label: "Operator Token", sensitive: false } },
  });
  for (const [order, plugins] of [
    ["owner first", [SENSITIVE_HINTED_OWNER_SLACK, CLOSER_FALSE_HINT_SLACK]],
    ["owner last", [CLOSER_FALSE_HINT_SLACK, SENSITIVE_HINTED_OWNER_SLACK]],
  ] as const) {
    it(`keeps the owner's sensitive flag under a closer claim's false on the same key (${order})`, () => {
      const owner = selectSlackSchemaOwner([...plugins]);
      expect(owner.configUiHints).toMatchObject({
        botToken: { label: "Operator Token", sensitive: true },
      });
    });
  }

  it("lets an equal-origin losing claim fill presentation the schema owner leaves empty", () => {
    expect(selectSlackSchemaOwner([REPLACEMENT_SLACK, LABELED_REPLACED_SLACK])).toMatchObject({
      schemaPluginId: "acme-slack-thread-guard",
      label: "Legacy Slack",
      description: "Legacy incumbent channel",
    });
  });

  // #120332 round 21 (P2): a claim's channel-specific presentation outranks its own generic root
  // catalog value. The root loop writes first at the same rank, so without same-claim awareness
  // the claim's explicit `channelConfigs.<id>` label could never replace its own root fallback.
  const SPECIFIC_OVER_ROOT_SLACK = {
    ...createChannelPlugin({
      id: "operator-slack-specific",
      origin: "config",
      omitSchema: true,
      label: "Specific Label",
    }),
    channelCatalogMeta: { id: "slack", label: "Generic Root" },
  };
  it("prefers a claim's channel-specific label over its own root catalog label", () => {
    expect(selectSlackSchemaOwner([REPLACEMENT_SLACK, SPECIFIC_OVER_ROOT_SLACK])).toMatchObject({
      schemaPluginId: "acme-slack-thread-guard",
      label: "Specific Label",
    });
  });

  // #120332 round 19 (P2): the owner tie-break belongs only to the selected schema owner, in the
  // root-catalog loop too. Equal-origin claimants labeling a channel only through
  // `channelCatalogMeta` must surface the owner's text in either traversal order — a losing
  // record traversed after the owner must not overwrite it and present its own text beside the
  // owner's fields.
  const ROOT_LABELED_OWNER = {
    ...createChannelPlugin({ id: "openclaw-slack-root-owner", origin: "global" }),
    channelCatalogMeta: { id: "slack", label: "Owner Root", blurb: "Owner root blurb" },
  };
  const ROOT_LABELED_LOSER = {
    ...createChannelPlugin({ id: "acme-slack-root-loser", origin: "global", omitSchema: true }),
    channelCatalogMeta: { id: "slack", label: "Loser Root", blurb: "Loser root blurb" },
  };
  for (const [order, plugins] of [
    ["loser last", [ROOT_LABELED_OWNER, ROOT_LABELED_LOSER]],
    ["loser first", [ROOT_LABELED_LOSER, ROOT_LABELED_OWNER]],
  ] as const) {
    it(`keeps root catalog presentation tied to the schema owner (${order})`, () => {
      expect(selectSlackSchemaOwner([...plugins])).toMatchObject({
        schemaPluginId: "openclaw-slack-root-owner",
        label: "Owner Root",
        description: "Owner root blurb",
      });
    });
  }

  // #120332 round 18 (P2): presentation precedence is per field. A sparse closer losing claim
  // that supplies only a label must not take the whole record's rank and starve fields it never
  // supplied — a farther loser's description and UI hints survive in every traversal order.
  const OWNER_LABELED_SLACK = createChannelPlugin({
    id: "openclaw-slack-owner",
    origin: "global",
    label: "Owner Slack",
  });
  const SPARSE_CLOSER_LABEL_SLACK = createChannelPlugin({
    id: "operator-slack-label-only",
    origin: "config",
    omitSchema: true,
    label: "Operator Slack",
  });
  const FARTHER_FIELDS_SLACK = createChannelPlugin({
    id: "workspace-slack-details",
    origin: "workspace",
    omitSchema: true,
    description: "Workspace-authored details",
    uiHints: { mode: { label: "Workspace Mode" } },
  });
  for (const plugins of permutations([
    OWNER_LABELED_SLACK,
    SPARSE_CLOSER_LABEL_SLACK,
    FARTHER_FIELDS_SLACK,
  ])) {
    const order = plugins.map((plugin) => plugin.origin).join(", ");
    it(`keeps per-field precedence for sparse losing claims (${order})`, () => {
      expect(selectSlackSchemaOwner([...plugins])).toMatchObject({
        schemaPluginId: "openclaw-slack-owner",
        label: "Operator Slack",
        description: "Workspace-authored details",
        configUiHints: { mode: { label: "Workspace Mode" } },
      });
    });
  }

  // #120332 round 14 (P2): the channel record must keep the closest origin that filled its
  // presentation, or a third, farther losing claim passes the origin guard and relabels the
  // channel over the closer claim's presentation. Catalog-merged claims (no `channels` listing)
  // are the exposed shape: only the loser branch stamps their rank.
  const CATALOG_CONFIG_HINTS_SLACK = createChannelPlugin({
    id: "operator-slack-catalog-labels",
    origin: "config",
    omitSchema: true,
    label: "Operator Slack",
    uiHints: { mode: { label: "Operator Mode" } },
    claimChannels: ["slack-catalog-extras"],
  });
  const CATALOG_WORKSPACE_HINTS_SLACK = createChannelPlugin({
    id: "workspace-slack-catalog-labels",
    origin: "workspace",
    omitSchema: true,
    label: "Workspace Slack",
    uiHints: { mode: { label: "Workspace Mode" } },
    claimChannels: ["slack-catalog-extras"],
  });
  for (const [order, plugins] of [
    [
      "config loser before workspace loser",
      [HINTED_LABELED_REPLACEMENT_SLACK, CATALOG_CONFIG_HINTS_SLACK, CATALOG_WORKSPACE_HINTS_SLACK],
    ],
    [
      "workspace loser before config loser",
      [HINTED_LABELED_REPLACEMENT_SLACK, CATALOG_WORKSPACE_HINTS_SLACK, CATALOG_CONFIG_HINTS_SLACK],
    ],
  ] as const) {
    it(`keeps the closest losing claim's presentation across later farther losers (${order})`, () => {
      expect(selectSlackSchemaOwner([...plugins])).toMatchObject({
        schemaPluginId: "acme-slack-thread-guard",
        label: "Operator Slack",
        configUiHints: { mode: { label: "Operator Mode" } },
      });
    });
  }

  // Auto-enable filters forbidden candidates before honoring their preferOver claims, so a dead
  // claim from a disabled replacement must not decide ownership when neither side is active yet.
  for (const [order, plugins] of [
    ["replacement first", [WORKSPACE_PAIR_REPLACEMENT_SLACK, WORKSPACE_ONLY_SLACK]],
    ["replacement last", [WORKSPACE_ONLY_SLACK, WORKSPACE_PAIR_REPLACEMENT_SLACK]],
  ] as const) {
    it(`keeps the incumbent auto-enable activates when the disabled replacement's claim is dead (${order})`, () => {
      expect(
        selectSlackSchemaOwner([...plugins], pluginEnabledConfig("acme-slack-thread-guard", false))
          .schemaPluginId,
      ).toBe("acme-workspace-slack");
    });
  }

  // Auto-enable has no origin tier: it disables the implicitly selected incumbent for the declared
  // replacement wherever each side was installed from, so a closer origin must not keep a schema
  // the runtime is about to stop serving.
  for (const [order, plugins] of [
    ["incumbent first", [CONFIG_ORIGIN_MIXED_CASE_SLACK, REPLACEMENT_SLACK]],
    ["incumbent last", [REPLACEMENT_SLACK, CONFIG_ORIGIN_MIXED_CASE_SLACK]],
  ] as const) {
    it(`follows auto-enable's replacement of a closer-origin incumbent (${order})`, () => {
      expect(selectSlackSchemaOwner([...plugins], {} as OpenClawConfig).schemaPluginId).toBe(
        "acme-slack-thread-guard",
      );
    });
  }

  // Auto-enable builds channel candidates from manifest `channels` claims only, so a catalog-merged
  // channelConfigs entry for an unclaimed channel can never serve it and must not own its schema.
  for (const [order, plugins] of [
    ["catalog entry first", [CATALOG_ONLY_CLOSER_SLACK, WORKSPACE_ONLY_SLACK]],
    ["catalog entry last", [WORKSPACE_ONLY_SLACK, CATALOG_ONLY_CLOSER_SLACK]],
  ] as const) {
    it(`keeps the claimant's schema over a catalog-only channelConfigs entry (${order})`, () => {
      expect(selectSlackSchemaOwner([...plugins], {} as OpenClawConfig).schemaPluginId).toBe(
        "acme-workspace-slack",
      );
    });
  }

  // Validation ownership requires an actual schema: a hints-only claim may merge its UI hints but
  // must not displace the schema that validates the channel's keys.
  for (const [order, plugins] of [
    ["hints claim first", [HINTS_ONLY_REPLACEMENT_SLACK, REPLACED_SLACK]],
    ["hints claim last", [REPLACED_SLACK, HINTS_ONLY_REPLACEMENT_SLACK]],
  ] as const) {
    it(`denies schema ownership to a schemaless hints claim while merging its hints (${order})`, () => {
      const owner = selectSlackSchemaOwner([...plugins], {} as OpenClawConfig);

      expect(owner.schemaPluginId).toBe("openclaw-slack");
      expect(owner.configUiHints).toEqual({ mode: { label: "Mode" } });
    });
  }

  it("keeps registry order deciding equal-origin plugins that declare no replacement", () => {
    const owner = selectSlackSchemaOwner([
      createChannelPlugin({
        id: "acme-slack-thread-guard",
        origin: "global",
        extraProperty: "threadGuard",
      }),
      REPLACED_SLACK,
    ]);

    expect(owner.schemaPluginId).toBe("openclaw-slack");
  });

  // A catalog-merged label-only claim on a channel its own `channels` list never declares: when it
  // is traversed before any claimant that does, no channel record exists yet, and dropping the claim
  // makes the surfaced label depend on registry order.
  const CATALOG_LABEL_ONLY_GLOBAL_SLACK = createChannelPlugin({
    id: "acme-slack-catalog-labels",
    origin: "global",
    omitSchema: true,
    label: "Catalog Slack",
    description: "Catalog-labeled channel",
    uiHints: { mode: { label: "Mode" } },
    claimChannels: ["slack-catalog-extras"],
  });
  for (const [order, plugins] of [
    ["catalog claim first", [CATALOG_LABEL_ONLY_GLOBAL_SLACK, REPLACEMENT_SLACK]],
    ["catalog claim last", [REPLACEMENT_SLACK, CATALOG_LABEL_ONLY_GLOBAL_SLACK]],
  ] as const) {
    it(`fills presentation from a catalog-only claim with no prior channel record (${order})`, () => {
      expect(selectSlackSchemaOwner([...plugins])).toMatchObject({
        schemaPluginId: "acme-slack-thread-guard",
        label: "Catalog Slack",
        description: "Catalog-labeled channel",
        configUiHints: { mode: { label: "Mode" } },
      });
    });
  }
});

const CLOSER_ORIGIN_ACME = createChannelPlugin({
  id: "operator-acmechat",
  origin: "config",
  channelId: "acmechat",
  extraProperty: "operatorOnly",
});
const CLOSER_LABEL_ONLY_ACME = createChannelPlugin({
  id: "operator-acmechat-labels",
  origin: "config",
  channelId: "acmechat",
  omitSchema: true,
  label: "Operator Acme Chat",
});

// An already-active bundled incumbent plus the workspace replacement auto-enable activates for the
// configured channel while it disables that incumbent.
const ACTIVE_BUNDLED_ACME = createChannelPlugin({
  id: "acmechat-bundled",
  origin: "bundled",
  channelId: "acmechat",
  extraProperty: "legacyOption",
  enabledByDefault: true,
});
const WORKSPACE_REPLACEMENT_ACME = createChannelPlugin({
  id: "acme-chat-thread-guard",
  origin: "workspace",
  channelId: "acmechat",
  extraProperty: "threadGuard",
  preferOver: ["acmechat-bundled"],
});
// The same workspace plugin without a replacement declaration: auto-enable still activates it as
// the channel's first claimant, so validation must accept the keys only its schema declares.
const WORKSPACE_ONLY_ACME = createChannelPlugin({
  id: "acme-workspace-chat",
  origin: "workspace",
  channelId: "acmechat",
  extraProperty: "workspaceOnly",
});

// The forbidden-replacement pair: both sides disabled by default, the replacement forbidden by the
// operator, so auto-enable enables the incumbent while the replacement's claim is dead.
const WORKSPACE_PAIR_REPLACEMENT_ACME = createChannelPlugin({
  id: "acme-chat-thread-guard",
  origin: "workspace",
  channelId: "acmechat",
  extraProperty: "threadGuard",
  preferOver: ["acme-workspace-chat"],
});

// A closer-origin mixed-case incumbent auto-enable disables for the farther global replacement.
const CONFIG_MIXED_CASE_REPLACED_ACME = createChannelPlugin({
  id: "OpenClaw-AcmeChat",
  origin: "config",
  channelId: "acmechat",
  extraProperty: "legacyOption",
});

// A catalog-merged channelConfigs entry whose plugin never claims the channel in its manifest.
const CATALOG_ONLY_CLOSER_ACME = createChannelPlugin({
  id: "operator-acmechat-catalog",
  origin: "config",
  channelId: "acmechat",
  extraProperty: "catalogOnly",
  claimChannels: ["acmechat-extras"],
});

// A catalog-merged claim with preferOver and UI hints but no schema.
const HINTS_ONLY_REPLACEMENT_ACME = createChannelPlugin({
  id: "acme-acmechat-hints",
  origin: "global",
  channelId: "acmechat",
  omitSchema: true,
  preferOver: ["openclaw-acmechat"],
  uiHints: { legacyOption: { label: "Legacy" } },
});

describe("config validate channel schema ownership", () => {
  for (const [order, plugins] of [
    ["replacement first", [REPLACEMENT_ACME, REPLACED_ACME]],
    ["replacement last", [REPLACED_ACME, REPLACEMENT_ACME]],
  ] as const) {
    it(`accepts the superseded plugin's channel keys while the replacement is disabled (${order})`, () => {
      expect(
        validateAcmeChatKeys({
          plugins: [...plugins],
          // legacyOption exists only in the superseded plugin's channel schema.
          channel: { legacyOption: {} },
          entries: { "acme-chat-thread-guard": { enabled: false } },
        }),
      ).toEqual([]);
    });

    // Rounds 37/40: the kept plugin and the replacement are co-active — explicit selections
    // are never suppressed — so validation applies the FIRST-loaded claimant's schema, the one
    // the runtime's first-wins registration actually serves.
    it(`validates an explicitly kept superseded plugin's keys by load order (${order})`, () => {
      const issues = validateAcmeChatKeys({
        plugins: [...plugins],
        channel: { legacyOption: {} },
        entries: { "openclaw-acmechat": { enabled: true } },
      });
      if (plugins[0]?.id === "openclaw-acmechat") {
        expect(issues).toEqual([]);
      } else {
        expect(issues).not.toEqual([]);
      }
    });

    it(`validates a materially kept superseded plugin's keys by load order (${order})`, () => {
      const issues = validateAcmeChatKeys({
        plugins: [...plugins],
        channel: { legacyOption: {} },
        entries: { "openclaw-acmechat": { config: { workspace: "T123" } } },
      });
      if (plugins[0]?.id === "openclaw-acmechat") {
        expect(issues).toEqual([]);
      } else {
        expect(issues).not.toEqual([]);
      }
    });
  }

  // Selecting both plugins keeps both active — explicit selections are never suppressed — and
  // validation follows the FIRST-loaded claimant's schema, the runtime's first-wins registrant.
  for (const [order, plugins, acceptedKey] of [
    ["replacement first", [REPLACEMENT_ACME, REPLACED_ACME], "threadGuard"],
    ["replacement last", [REPLACED_ACME, REPLACEMENT_ACME], "legacyOption"],
  ] as const) {
    // `apiKey` is not a canonical `plugins.entries` key, so it stays in the collector-level table.
    for (const [entryKey, entry] of CANONICAL_EXPLICIT_PLUGIN_ENTRIES) {
      it(`keeps first-registrant validation when both plugins are selected through entries.${entryKey} (${order})`, () => {
        expect(
          validateAcmeChatKeys({
            plugins: [...plugins],
            channel: { [acceptedKey]: {} },
            entries: { "openclaw-acmechat": entry, "acme-chat-thread-guard": entry },
          }),
        ).toEqual([]);
      });
    }
  }

  // Validation runs before auto-enable, so the replacement's `plugins.entries` record does not
  // exist yet. Ranking it out for that keeps the incumbent schema and rejects the replacement's
  // own keys, blocking the very startup transition auto-enable performs.
  it("accepts the channel keys of a replacement auto-enable activates over an active bundled plugin", () => {
    expect(
      validateAcmeChatKeys({
        plugins: [ACTIVE_BUNDLED_ACME, WORKSPACE_REPLACEMENT_ACME],
        // threadGuard exists only in the replacement's channel schema.
        channel: { threadGuard: {} },
        entries: {},
      }),
    ).toEqual([]);
  });

  // Auto-enable enables the first claimant of a configured channel when no claim declares a
  // replacement, and discovery reaches workspace plugins before bundled ones. Ranking that claimant
  // out for being disabled-by-default rejects its own channel keys before startup enables it.
  it("accepts the channel keys of the first claimant auto-enable activates with no declared replacement", () => {
    expect(
      validateAcmeChatKeys({
        plugins: [WORKSPACE_ONLY_ACME, ACTIVE_BUNDLED_ACME],
        // workspaceOnly exists only in the workspace plugin's channel schema.
        channel: { workspaceOnly: {} },
        entries: {},
      }),
    ).toEqual([]);
  });

  // Catalog metadata merges into an installed plugin's record without the manifest loader's
  // schema normalization, so a closer claim can name a channel without supplying its schema.
  for (const [order, plugins] of [
    ["metadata-only first", [CLOSER_LABEL_ONLY_ACME, REPLACED_ACME]],
    ["metadata-only last", [REPLACED_ACME, CLOSER_LABEL_ONLY_ACME]],
  ] as const) {
    it(`applies the farther plugin's channel schema behind a closer metadata-only declaration (${order})`, () => {
      // legacyOption exists only in the farther plugin's channel schema.
      expect(
        validateAcmeChatKeys({ plugins: [...plugins], channel: { legacyOption: {} }, entries: {} }),
      ).toEqual([]);
      // A metadata-only owner would register no schema at all, so prove the farther one is in
      // force rather than the channel silently accepting every key.
      expect(
        validateAcmeChatKeys({
          plugins: [...plugins],
          channel: { unsupportedField: true },
          entries: {},
        }),
      ).toContainEqual(
        expect.objectContaining({
          path: "channels.acmechat",
          message:
            'invalid config for plugin openclaw-acmechat: must not have additional properties: "unsupportedField"',
        }),
      );
    });
  }

  // Auto-enable filters forbidden candidates then enables the incumbent, so validation must accept
  // the incumbent's keys instead of holding the channel to the forbidden replacement's schema.
  for (const [policy, policyParams] of [
    ["entries-disabled", { entries: { "acme-chat-thread-guard": { enabled: false } } }],
    ["deny", { entries: {}, deny: ["acme-chat-thread-guard"] }],
  ] as const) {
    it(`accepts the incumbent's channel keys when the replacement is forbidden (${policy})`, () => {
      expect(
        validateAcmeChatKeys({
          plugins: [WORKSPACE_PAIR_REPLACEMENT_ACME, WORKSPACE_ONLY_ACME],
          // workspaceOnly exists only in the incumbent's channel schema.
          channel: { workspaceOnly: {} },
          ...policyParams,
        }),
      ).toEqual([]);
    });
  }

  // Auto-enable has no origin tier: it disables the closer-origin incumbent for the declared
  // replacement, so validation must accept the replacement's own channel keys.
  it("accepts the replacement's channel keys when auto-enable supersedes a closer-origin incumbent", () => {
    expect(
      validateAcmeChatKeys({
        plugins: [CONFIG_MIXED_CASE_REPLACED_ACME, REPLACEMENT_ACME],
        // threadGuard exists only in the replacement's channel schema.
        channel: { threadGuard: {} },
        entries: {},
      }),
    ).toEqual([]);
  });

  // Auto-enable builds channel candidates from manifest `channels` claims only, so a catalog-only
  // channelConfigs entry can never serve the channel and must not validate it.
  it("validates with the claimant's schema, not a catalog-only channelConfigs entry", () => {
    expect(
      validateAcmeChatKeys({
        plugins: [CATALOG_ONLY_CLOSER_ACME, WORKSPACE_ONLY_ACME],
        // workspaceOnly exists only in the claimant's channel schema.
        channel: { workspaceOnly: {} },
        entries: {},
      }),
    ).toEqual([]);
    expect(
      validateAcmeChatKeys({
        plugins: [CATALOG_ONLY_CLOSER_ACME, WORKSPACE_ONLY_ACME],
        // catalogOnly exists only in the catalog-only entry's schema, which is not in force.
        channel: { catalogOnly: {} },
        entries: {},
      }),
    ).toContainEqual(
      expect.objectContaining({
        path: "channels.acmechat",
        message:
          'invalid config for plugin acme-workspace-chat: must not have additional properties: "catalogOnly"',
      }),
    );
  });

  // Validation ownership requires an actual schema: a hints-only claim taking the channel must not
  // leave validation accepting every key.
  it("keeps schema validation when a schemaless hints claim takes the channel", () => {
    expect(
      validateAcmeChatKeys({
        plugins: [REPLACED_ACME, HINTS_ONLY_REPLACEMENT_ACME],
        channel: { legacyOption: {} },
        entries: {},
      }),
    ).toEqual([]);
    expect(
      validateAcmeChatKeys({
        plugins: [REPLACED_ACME, HINTS_ONLY_REPLACEMENT_ACME],
        channel: { unsupportedField: true },
        entries: {},
      }),
    ).toContainEqual(
      expect.objectContaining({
        path: "channels.acmechat",
        message:
          'invalid config for plugin openclaw-acmechat: must not have additional properties: "unsupportedField"',
      }),
    );
  });

  it("accepts an active farther-origin plugin's channel keys while the closer origin is disabled", () => {
    expect(
      validateAcmeChatKeys({
        plugins: [CLOSER_ORIGIN_ACME, REPLACEMENT_ACME],
        // threadGuard exists only in the active replacement's channel schema.
        channel: { threadGuard: {} },
        entries: { "operator-acmechat": { enabled: false } },
      }),
    ).toEqual([]);
  });
});
