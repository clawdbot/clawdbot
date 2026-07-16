import type { ChannelDoctorLegacyConfigRule } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import { ReefChannelConfigSchema, normalizeReefTarget } from "./src/config-schema.js";
import { ReefPeerTrustSchema, type ReefPeerTrust } from "./src/friend-types.js";
import {
  REEF_TRUST_STORE_MAX_ENTRIES,
  REEF_TRUST_STORE_NAMESPACE,
  resolveReefTrustStoreKey,
} from "./src/trust-store.js";

const RETIRED_REEF_CONFIG_KEYS = ["friends", "dmPolicy", "allowFrom"] as const;
const REEF_CONFIG_IMPORT_NAMESPACE = "peer-state-config-imports";
const LegacyReefFriendSchema = ReefPeerTrustSchema.omit({ approvedAt: true });

type ReefPeerStateSnapshot = {
  revision: number;
  trust: ReefPeerTrust;
};

type ReefConfigImportMarker = {
  version: 1;
  importedAt: number;
};

function hasRetiredReefPolicyConfig(value: unknown): boolean {
  return isRecord(value) && ["dmPolicy", "allowFrom"].some((key) => Object.hasOwn(value, key));
}

function inspectLegacyReefFriends(cfg: OpenClawConfig) {
  const reef = cfg.channels?.reef;
  if (!isRecord(reef) || !Object.hasOwn(reef, "friends")) {
    return null;
  }
  const rawFriends = isRecord(reef.friends) ? reef.friends : null;
  const canonicalCandidate = { ...reef };
  for (const key of RETIRED_REEF_CONFIG_KEYS) {
    delete canonicalCandidate[key];
  }
  const parsedConfig = ReefChannelConfigSchema.safeParse(canonicalCandidate);
  const config = parsedConfig.success && parsedConfig.data.handle ? parsedConfig.data : null;
  const friends = new Map<string, z.infer<typeof LegacyReefFriendSchema>>();
  let rejected = rawFriends ? 0 : 1;
  for (const [peer, value] of Object.entries(rawFriends ?? {})) {
    const parsedFriend = LegacyReefFriendSchema.safeParse(value);
    if (normalizeReefTarget(peer) !== peer || !parsedFriend.success) {
      rejected++;
      continue;
    }
    friends.set(peer, parsedFriend.data);
  }
  return { config, friends, rejected, total: rawFriends ? Object.keys(rawFriends).length : 0 };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "reef"],
    message:
      'channels.reef dmPolicy/allowFrom are legacy; run "openclaw doctor --fix" to remove them. Peer trust is SQLite-backed.',
    match: hasRetiredReefPolicyConfig,
  },
];

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const reef = cfg.channels?.reef;
  if (!isRecord(reef) || !hasRetiredReefPolicyConfig(reef)) {
    return { config: cfg, changes: [] };
  }
  const next = structuredClone(cfg);
  const nextReef = next.channels?.reef;
  if (!isRecord(nextReef)) {
    return { config: cfg, changes: [] };
  }
  const changes: string[] = [];
  for (const key of ["dmPolicy", "allowFrom"] as const) {
    if (Object.hasOwn(nextReef, key)) {
      delete nextReef[key];
      changes.push(`Removed retired Reef ${key} field.`);
    }
  }
  return {
    config: next,
    changes,
  };
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "reef-config-trust-to-plugin-state",
    label: "Reef peer trust",
    async detectLegacyState({ config, context }) {
      const legacy = inspectLegacyReefFriends(config);
      const markerStore = context.openPluginStateKeyedStore<ReefConfigImportMarker>({
        namespace: REEF_CONFIG_IMPORT_NAMESPACE,
        maxEntries: REEF_TRUST_STORE_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const markedKeys = new Set((await markerStore.entries()).map((entry) => entry.key));
      const legacyConfig = legacy?.config;
      const count = legacyConfig
        ? [...legacy.friends.keys()].filter(
            (peer) => !markedKeys.has(resolveReefTrustStoreKey(legacyConfig, peer)),
          ).length
        : (legacy?.friends.size ?? 0);
      const rejected = legacy?.rejected ?? 0;
      return count > 0 || rejected > 0
        ? {
            preview: [
              `- Reef peer trust: config -> plugin state (${count} peer(s), ${rejected} invalid)`,
            ],
          }
        : null;
    },
    async migrateLegacyState({ config, context }) {
      const legacy = inspectLegacyReefFriends(config);
      if (!legacy) {
        return { changes: [], warnings: [] };
      }
      const warnings: string[] = [];
      if (legacy.rejected > 0) {
        warnings.push(
          `Skipped ${legacy.rejected} invalid Reef peer trust row(s); left legacy friends config in place`,
        );
      }
      if (!legacy.config) {
        if (legacy.total > 0) {
          warnings.push(
            "Skipped Reef peer trust migration because channels.reef needs a valid handle and canonical config; left legacy friends config in place",
          );
        }
        return { changes: [], warnings };
      }
      const reefConfig = legacy.config;
      if (legacy.friends.size === 0) {
        return { changes: [], warnings };
      }
      const store = context.openPluginStateKeyedStore<ReefPeerStateSnapshot>({
        namespace: REEF_TRUST_STORE_NAMESPACE,
        maxEntries: REEF_TRUST_STORE_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const markerStore = context.openPluginStateKeyedStore<ReefConfigImportMarker>({
        namespace: REEF_CONFIG_IMPORT_NAMESPACE,
        maxEntries: REEF_TRUST_STORE_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const existingEntries = await store.entries();
      const existingKeys = new Set(existingEntries.map((entry) => entry.key));
      const markerEntries = await markerStore.entries();
      const markedKeys = new Set(markerEntries.map((entry) => entry.key));
      const pendingKeys = [...legacy.friends.keys()]
        .map((peer) => resolveReefTrustStoreKey(reefConfig, peer))
        .filter((key) => !markedKeys.has(key));
      const missingTrust = pendingKeys.filter((key) => !existingKeys.has(key));
      const availableTrust = Math.max(0, REEF_TRUST_STORE_MAX_ENTRIES - existingEntries.length);
      const availableMarkers = Math.max(0, REEF_TRUST_STORE_MAX_ENTRIES - markerEntries.length);
      if (missingTrust.length > availableTrust || pendingKeys.length > availableMarkers) {
        warnings.push(
          `Skipped Reef peer trust migration because plugin state has room for ${availableTrust} of ${missingTrust.length} trust row(s) and ${availableMarkers} of ${pendingKeys.length} import marker(s); left legacy friends config in place`,
        );
        return { changes: [], warnings };
      }
      let imported = 0;
      let alreadyPresent = 0;
      for (const [peer, trust] of legacy.friends) {
        const key = resolveReefTrustStoreKey(reefConfig, peer);
        if (markedKeys.has(key)) {
          continue;
        }
        const inserted = await store.registerIfAbsent(key, {
          revision: 1,
          trust: { ...trust, approvedAt: 0 },
        });
        if (inserted) {
          imported++;
        } else {
          alreadyPresent++;
        }
        await markerStore.registerIfAbsent(key, { version: 1, importedAt: Date.now() });
        markedKeys.add(key);
      }
      if (imported === 0 && alreadyPresent === 0) {
        return { changes: [], warnings };
      }
      return {
        changes: [
          `Migrated Reef peer trust -> plugin state (${imported} imported, ${alreadyPresent} already present)`,
        ],
        warnings,
      };
    },
  },
];
