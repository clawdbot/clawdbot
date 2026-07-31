import fs from "node:fs/promises";
import path from "node:path";
import type { ChannelDoctorLegacyConfigRule } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  archiveLegacyStateSource,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import {
  parseReefRelayUrl,
  ReefChannelConfigSchema,
  normalizeReefTarget,
} from "./src/config-schema.js";
import { reefAuditStateMigration, reefRuntimeStateMigration } from "./src/doctor-durable-state.js";
import {
  legacyReefFileExists,
  REEF_DURABLE_LEGACY_FILENAMES,
  resolveLegacyReefStateDir,
} from "./src/doctor-state-paths.js";
import { ReefPeerTrustSchema, type ReefPeerTrust } from "./src/friend-types.js";
import {
  REEF_DURABLE_MIGRATION_KEY,
  REEF_DURABLE_MIGRATION_MAX_ENTRIES,
  REEF_DURABLE_MIGRATION_NAMESPACE,
  REEF_KEYS_KEY,
  REEF_KEYS_MAX_ENTRIES,
  REEF_KEYS_MIGRATION_KEY,
  REEF_KEYS_MIGRATION_MAX_ENTRIES,
  REEF_KEYS_MIGRATION_NAMESPACE,
  REEF_KEYS_NAMESPACE,
  REEF_REGISTRATION_IDENTITY_KEY,
  REEF_REGISTRATION_MAX_ENTRIES,
  REEF_REGISTRATION_NAMESPACE,
  REEF_REGISTRATION_SESSION_KEY,
  parseReefIdentityBinding,
  parseReefKeys,
  parseReefSetupSession,
  type ReefIdentityMigrationRecord,
  type ReefDurableMigrationRecord,
  type ReefIdentityBinding,
  type ReefSetupSession,
} from "./src/state.js";
import {
  REEF_TRUST_STORE_MAX_ENTRIES,
  REEF_TRUST_STORE_NAMESPACE,
  resolveReefTrustStoreKey,
} from "./src/trust-store.js";
import type { ReefKeys } from "./src/types.js";

const RETIRED_REEF_CONFIG_KEYS = ["friends", "dmPolicy", "allowFrom"] as const;
const REEF_CONFIG_IMPORT_NAMESPACE = "peer-state-config-imports";
const LegacyReefFriendSchema = ReefPeerTrustSchema.omit({ approvedAt: true });
const ReefIdentityConfigSchema = ReefChannelConfigSchema.pick({
  handle: true,
  relayUrl: true,
});

type ReefPeerStateSnapshot = {
  revision: number;
  trust: ReefPeerTrust;
};

type ReefConfigImportMarker = {
  version: 1;
  importedAt: number;
};

type ReefLegacyRegistrationSource =
  | {
      filename: "identity.json";
      key: typeof REEF_REGISTRATION_IDENTITY_KEY;
      parse: typeof parseReefIdentityBinding;
      label: string;
    }
  | {
      filename: "setup-session.json";
      key: typeof REEF_REGISTRATION_SESSION_KEY;
      parse: typeof parseReefSetupSession;
      label: string;
    };

const REEF_LEGACY_REGISTRATION_SOURCES: ReefLegacyRegistrationSource[] = [
  {
    filename: "identity.json",
    key: REEF_REGISTRATION_IDENTITY_KEY,
    parse: parseReefIdentityBinding,
    label: "Reef identity binding",
  },
  {
    filename: "setup-session.json",
    key: REEF_REGISTRATION_SESSION_KEY,
    parse: parseReefSetupSession,
    label: "Reef setup session",
  },
];

type ConfiguredReefIdentityBinding =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; binding: ReefIdentityBinding };

function configuredReefIdentityBinding(cfg: OpenClawConfig): ConfiguredReefIdentityBinding {
  const reef = cfg.channels?.reef;
  if (!isRecord(reef) || !Object.hasOwn(reef, "handle") || reef.handle === undefined) {
    return { status: "absent" };
  }
  const parsed = ReefIdentityConfigSchema.safeParse({
    handle: reef.handle,
    relayUrl: reef.relayUrl,
  });
  if (!parsed.success || !parsed.data.handle) {
    return { status: "invalid" };
  }
  return {
    status: "valid",
    binding: {
      handle: parsed.data.handle,
      relayUrl: parseReefRelayUrl(parsed.data.relayUrl),
    },
  };
}

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
    id: "reef-keys-json-to-plugin-state",
    label: "Reef identity keys",
    async detectLegacyState(params) {
      const stateDir = resolveLegacyReefStateDir(params);
      const filePath = path.join(stateDir, "keys.json");
      const migrationStore = params.context.openPluginStateKeyedStore<ReefIdentityMigrationRecord>({
        namespace: REEF_KEYS_MIGRATION_NAMESPACE,
        maxEntries: REEF_KEYS_MIGRATION_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const durableMigrationStore =
        params.context.openPluginStateKeyedStore<ReefDurableMigrationRecord>({
          namespace: REEF_DURABLE_MIGRATION_NAMESPACE,
          maxEntries: REEF_DURABLE_MIGRATION_MAX_ENTRIES,
          overflowPolicy: "reject-new",
        });
      const sourceExists = await legacyReefFileExists(filePath);
      const pending = await migrationStore.lookup(REEF_KEYS_MIGRATION_KEY);
      const durableSourceExists = (
        await Promise.all(
          REEF_DURABLE_LEGACY_FILENAMES.map((filename) =>
            legacyReefFileExists(path.join(stateDir, filename)),
          ),
        )
      ).some(Boolean);
      const durablePending = await durableMigrationStore.lookup(REEF_DURABLE_MIGRATION_KEY);
      return sourceExists || pending || durableSourceExists || durablePending
        ? {
            preview: [
              sourceExists
                ? "- Reef identity keys -> plugin state (identity)"
                : pending
                  ? "- Verify Reef identity-key migration marker"
                  : "- Prepare Reef durable state migration barrier",
            ],
          }
        : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const stateDir = resolveLegacyReefStateDir(params);
      const filePath = path.join(stateDir, "keys.json");
      const migrationStore = params.context.openPluginStateKeyedStore<ReefIdentityMigrationRecord>({
        namespace: REEF_KEYS_MIGRATION_NAMESPACE,
        maxEntries: REEF_KEYS_MIGRATION_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const store = params.context.openPluginStateKeyedStore<ReefKeys>({
        namespace: REEF_KEYS_NAMESPACE,
        maxEntries: REEF_KEYS_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const durableMigrationStore =
        params.context.openPluginStateKeyedStore<ReefDurableMigrationRecord>({
          namespace: REEF_DURABLE_MIGRATION_NAMESPACE,
          maxEntries: REEF_DURABLE_MIGRATION_MAX_ENTRIES,
          overflowPolicy: "reject-new",
        });
      const durableSourceExists = (
        await Promise.all(
          REEF_DURABLE_LEGACY_FILENAMES.map((filename) =>
            legacyReefFileExists(path.join(stateDir, filename)),
          ),
        )
      ).some(Boolean);
      const durablePending = await durableMigrationStore.lookup(REEF_DURABLE_MIGRATION_KEY);
      if (durableSourceExists || durablePending) {
        await durableMigrationStore.register(REEF_DURABLE_MIGRATION_KEY, { pending: true });
      }
      if (!(await legacyReefFileExists(filePath))) {
        const pending = await migrationStore.lookup(REEF_KEYS_MIGRATION_KEY);
        if (!pending) {
          return { changes, warnings };
        }
        try {
          parseReefKeys(await store.lookup(REEF_KEYS_KEY));
          if (!pending?.identityBindingRequired) {
            await migrationStore.delete(REEF_KEYS_MIGRATION_KEY);
            changes.push("Verified Reef identity keys; cleared completed migration marker");
          }
        } catch {
          warnings.push(
            "Reef identity key migration is incomplete and keys.json is missing; left migration blocker in place",
          );
        }
        return { changes, warnings };
      }
      const existingMarker = await migrationStore.lookup(REEF_KEYS_MIGRATION_KEY);
      const configuredBinding = configuredReefIdentityBinding(params.config);
      const identityBindingRequired =
        existingMarker?.identityBindingRequired ||
        (await legacyReefFileExists(
          path.join(resolveLegacyReefStateDir(params), "identity.json"),
        )) ||
        configuredBinding.status !== "absent";
      await migrationStore.register(REEF_KEYS_MIGRATION_KEY, {
        pending: true,
        identityBindingRequired,
      });
      let keys: ReefKeys;
      try {
        keys = parseReefKeys(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { changes, warnings };
        }
        warnings.push(
          `Failed importing Reef identity keys: ${String(error)}; left source in place`,
        );
        return { changes, warnings };
      }
      const existing = await store.lookup(REEF_KEYS_KEY);
      if (existing && JSON.stringify(existing) !== JSON.stringify(keys)) {
        warnings.push("Kept existing Reef identity keys; left differing legacy source in place");
        return { changes, warnings };
      }
      if (!existing) {
        try {
          await store.registerIfAbsent(REEF_KEYS_KEY, keys);
        } catch (error) {
          warnings.push(
            `Failed importing Reef identity keys: ${String(error)}; left source in place`,
          );
          return { changes, warnings };
        }
      }
      const persisted = await store.lookup(REEF_KEYS_KEY);
      try {
        if (JSON.stringify(parseReefKeys(persisted)) !== JSON.stringify(keys)) {
          throw new Error("persisted value differs");
        }
      } catch (error) {
        warnings.push(
          `Failed verifying Reef identity keys after import: ${String(error)}; left source in place`,
        );
        return { changes, warnings };
      }
      changes.push("Migrated Reef identity keys -> plugin state");
      const warningCount = warnings.length;
      await archiveLegacyStateSource({
        filePath,
        label: "Reef identity keys",
        changes,
        warnings,
      });
      if (warnings.length === warningCount && !identityBindingRequired) {
        await migrationStore.delete(REEF_KEYS_MIGRATION_KEY);
      }
      return { changes, warnings };
    },
  },
  {
    id: "reef-registration-json-to-plugin-state",
    label: "Reef registration state",
    async detectLegacyState(params) {
      const stateDir = resolveLegacyReefStateDir(params);
      const migrationStore = params.context.openPluginStateKeyedStore<ReefIdentityMigrationRecord>({
        namespace: REEF_KEYS_MIGRATION_NAMESPACE,
        maxEntries: REEF_KEYS_MIGRATION_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const files = (
        await Promise.all(
          REEF_LEGACY_REGISTRATION_SOURCES.map(async (source) => ({
            source,
            exists: await legacyReefFileExists(path.join(stateDir, source.filename)),
          })),
        )
      ).filter((entry) => entry.exists);
      const pending = await migrationStore.lookup(REEF_KEYS_MIGRATION_KEY);
      const configuredBinding = configuredReefIdentityBinding(params.config);
      const configuredBindingNeedsImport =
        configuredBinding.status !== "absent" &&
        (await legacyReefFileExists(path.join(stateDir, "keys.json")));
      return files.length > 0 || pending?.identityBindingRequired || configuredBindingNeedsImport
        ? {
            preview: [
              files.length > 0
                ? `- Reef registration state -> plugin state (${files.map((entry) => entry.source.filename).join(", ")})`
                : configuredBindingNeedsImport
                  ? "- Reef configured identity binding -> plugin state"
                  : "- Verify Reef identity binding migration marker",
            ],
          }
        : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const stateDir = resolveLegacyReefStateDir(params);
      const store = params.context.openPluginStateKeyedStore<
        ReefIdentityBinding | ReefSetupSession
      >({
        namespace: REEF_REGISTRATION_NAMESPACE,
        maxEntries: REEF_REGISTRATION_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const migrationStore = params.context.openPluginStateKeyedStore<ReefIdentityMigrationRecord>({
        namespace: REEF_KEYS_MIGRATION_NAMESPACE,
        maxEntries: REEF_KEYS_MIGRATION_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const durableMigrationStore =
        params.context.openPluginStateKeyedStore<ReefDurableMigrationRecord>({
          namespace: REEF_DURABLE_MIGRATION_NAMESPACE,
          maxEntries: REEF_DURABLE_MIGRATION_MAX_ENTRIES,
          overflowPolicy: "reject-new",
        });
      const hasRegistrationSource = (
        await Promise.all(
          REEF_LEGACY_REGISTRATION_SOURCES.map((source) =>
            legacyReefFileExists(path.join(stateDir, source.filename)),
          ),
        )
      ).some(Boolean);
      if (
        hasRegistrationSource ||
        (await migrationStore.lookup(REEF_KEYS_MIGRATION_KEY)) ||
        (await durableMigrationStore.lookup(REEF_DURABLE_MIGRATION_KEY))
      ) {
        await durableMigrationStore.register(REEF_DURABLE_MIGRATION_KEY, { pending: true });
      }
      for (const source of REEF_LEGACY_REGISTRATION_SOURCES) {
        const filePath = path.join(stateDir, source.filename);
        if (!(await legacyReefFileExists(filePath))) {
          continue;
        }
        let legacy: ReefIdentityBinding | ReefSetupSession | undefined;
        try {
          legacy = source.parse(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
        } catch {
          // The structural validation below owns the fail-closed warning.
        }
        if (!legacy) {
          warnings.push(`Failed importing ${source.label}: invalid JSON; left source in place`);
          continue;
        }
        const existing = await store.lookup(source.key);
        const normalizedExisting = source.parse(existing);
        if (normalizedExisting && JSON.stringify(normalizedExisting) !== JSON.stringify(legacy)) {
          warnings.push(`Kept existing ${source.label}; left differing legacy source in place`);
          continue;
        }
        if (!normalizedExisting) {
          try {
            await store.registerIfAbsent(source.key, legacy);
          } catch (error) {
            warnings.push(
              `Failed importing ${source.label}: ${String(error)}; left source in place`,
            );
            continue;
          }
        }
        const persisted = source.parse(await store.lookup(source.key));
        if (!persisted || JSON.stringify(persisted) !== JSON.stringify(legacy)) {
          warnings.push(`Failed verifying ${source.label}; left source in place`);
          continue;
        }
        changes.push(`Migrated ${source.label} -> plugin state`);
        await archiveLegacyStateSource({
          filePath,
          label: source.label,
          changes,
          warnings,
        });
      }
      const configuredBindingResult = configuredReefIdentityBinding(params.config);
      const configuredBinding =
        configuredBindingResult.status === "valid" ? configuredBindingResult.binding : undefined;
      if (configuredBinding) {
        const existing = parseReefIdentityBinding(
          await store.lookup(REEF_REGISTRATION_IDENTITY_KEY),
        );
        if (existing && JSON.stringify(existing) !== JSON.stringify(configuredBinding)) {
          warnings.push("Kept existing Reef identity binding; configured handle or relay differs");
        } else if (!existing) {
          try {
            await store.registerIfAbsent(REEF_REGISTRATION_IDENTITY_KEY, configuredBinding);
            const persisted = parseReefIdentityBinding(
              await store.lookup(REEF_REGISTRATION_IDENTITY_KEY),
            );
            if (JSON.stringify(persisted) !== JSON.stringify(configuredBinding)) {
              throw new Error("persisted value differs");
            }
            changes.push("Migrated Reef identity binding from config -> plugin state");
          } catch (error) {
            warnings.push(`Failed importing Reef identity binding from config: ${String(error)}`);
          }
        }
      }
      const pending = await migrationStore.lookup(REEF_KEYS_MIGRATION_KEY);
      if (pending?.identityBindingRequired) {
        const keysPath = path.join(stateDir, "keys.json");
        const identityPath = path.join(stateDir, "identity.json");
        try {
          parseReefKeys(
            await params.context
              .openPluginStateKeyedStore<ReefKeys>({
                namespace: REEF_KEYS_NAMESPACE,
                maxEntries: REEF_KEYS_MAX_ENTRIES,
                overflowPolicy: "reject-new",
              })
              .lookup(REEF_KEYS_KEY),
          );
          const binding = parseReefIdentityBinding(
            await store.lookup(REEF_REGISTRATION_IDENTITY_KEY),
          );
          if (!binding) {
            throw new Error("canonical identity binding is missing");
          }
          if (configuredBindingResult.status === "invalid") {
            throw new Error("configured handle or relay is invalid");
          }
          if (configuredBinding && JSON.stringify(binding) !== JSON.stringify(configuredBinding)) {
            throw new Error("configured handle or relay differs from canonical identity binding");
          }
          if (
            (await legacyReefFileExists(keysPath)) ||
            (await legacyReefFileExists(identityPath))
          ) {
            throw new Error("legacy identity sources remain");
          }
          await migrationStore.delete(REEF_KEYS_MIGRATION_KEY);
          changes.push("Verified Reef identity keys and binding; cleared migration marker");
        } catch (error) {
          warnings.push(
            `Reef identity migration is incomplete: ${String(error)}; left migration blocker in place`,
          );
        }
      }
      return { changes, warnings };
    },
  },
  reefAuditStateMigration,
  reefRuntimeStateMigration,
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
