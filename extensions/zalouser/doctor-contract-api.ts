// Zalouser API module exposes the plugin public contract.
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildAgentSessionKey, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  archiveLegacyStateSource,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor";
import {
  deleteSessionEntry,
  deliveryContextFromSession,
  listSessionEntries,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveZalouserDmSessionScope } from "./src/session-scope.js";
import {
  isZaloCredentialRevocation,
  normalizeStoredZaloCredentials,
  normalizeZalouserCredentialProfile,
  resolveLegacyZalouserCredentialsDir,
  resolveLegacyZalouserCredentialsPath,
  zalouserCredentialStoreKey,
  ZALOUSER_CREDENTIALS_MAX_ENTRIES,
  ZALOUSER_CREDENTIALS_NAMESPACE,
  type ZaloCredentialStateRecord,
  type StoredZaloCredentials,
} from "./src/session-state.js";

export { normalizeCompatibilityConfig, legacyConfigRules } from "./src/doctor-contract.js";

type LegacyZalouserCredentialSource = {
  filePath: string;
  profile: string;
};

type LegacyZalouserDmEntry = {
  agentId: string;
  canonicalKey: string;
  entry: ReturnType<typeof listSessionEntries>[number]["entry"];
  legacyKeys: string[];
  storePath: string;
};

const LEGACY_ZALOUSER_DM_PREFIX = "zalouser:group:";

async function collectLegacyZalouserCredentialSources(
  env: NodeJS.ProcessEnv,
): Promise<LegacyZalouserCredentialSource[]> {
  const credentialsDir = resolveLegacyZalouserCredentialsDir(env);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(credentialsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name === "credentials.json" ||
          (entry.name.startsWith("credentials-") && entry.name.endsWith(".json"))),
    )
    .flatMap((entry) => {
      let profile = "default";
      if (entry.name !== "credentials.json") {
        try {
          profile = decodeURIComponent(entry.name.slice("credentials-".length, -".json".length));
        } catch {
          return [];
        }
      }
      const normalizedProfile = normalizeZalouserCredentialProfile(profile);
      const filePath = path.join(credentialsDir, entry.name);
      return resolveLegacyZalouserCredentialsPath(normalizedProfile, env) === filePath
        ? [{ filePath, profile: normalizedProfile }]
        : [];
    })
    .toSorted((left, right) => left.profile.localeCompare(right.profile));
}

function collectLegacyZalouserDmEntries(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  options: { readOnly?: boolean } = {},
): LegacyZalouserDmEntry[] {
  const entries = new Map<string, LegacyZalouserDmEntry>();
  const fallbackAccountId = config.channels?.zalouser?.defaultAccount?.trim() || "default";
  const agentIds = new Set([
    "main",
    ...(config.agents?.list ?? []).flatMap(({ id }) => (id?.trim() ? [id.trim()] : [])),
  ]);
  for (const agentId of agentIds) {
    const storePath = resolveStorePath(config.session?.store, { agentId, env });
    const storedEntries = listSessionEntries({
      agentId,
      storePath,
      ...(options.readOnly ? { readOnly: true } : {}),
    });
    const entryByKey = new Map(storedEntries.map(({ sessionKey, entry }) => [sessionKey, entry]));
    for (const { sessionKey, entry } of storedEntries) {
      const parsed = parseAgentSessionKey(sessionKey);
      if (entry.chatType !== "direct" || !parsed?.rest.startsWith(LEGACY_ZALOUSER_DM_PREFIX)) {
        continue;
      }
      const peerId = parsed.rest.slice(LEGACY_ZALOUSER_DM_PREFIX.length);
      if (!peerId) {
        continue;
      }
      const canonicalKey = buildAgentSessionKey({
        agentId: parsed.agentId,
        channel: "zalouser",
        accountId: deliveryContextFromSession(entry)?.accountId?.trim() || fallbackAccountId,
        peer: { kind: "direct", id: peerId },
        dmScope: resolveZalouserDmSessionScope(config),
        identityLinks: config.session?.identityLinks,
      });
      const groupKey = `${storePath}\0${canonicalKey}`;
      const canonicalEntry = entryByKey.get(canonicalKey);
      const pending = entries.get(groupKey) ?? {
        agentId,
        canonicalKey,
        // Identity links can collapse peers; preserve the freshest row, preferring canonical ties.
        entry:
          canonicalEntry && canonicalEntry.updatedAt >= entry.updatedAt ? canonicalEntry : entry,
        legacyKeys: [],
        storePath,
      };
      pending.legacyKeys.push(sessionKey);
      if (entry.updatedAt > pending.entry.updatedAt) {
        pending.entry = entry;
      }
      entries.set(groupKey, pending);
    }
  }
  return [...entries.values()];
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "zalouser-credentials-json-to-plugin-state",
    label: "Zalo Personal credentials",
    async detectLegacyState(params) {
      const sources = await collectLegacyZalouserCredentialSources(params.env);
      return sources.length > 0
        ? {
            preview: [
              `- Zalo Personal credentials: ${sources.length} ${sources.length === 1 ? "file" : "files"} -> plugin state (${ZALOUSER_CREDENTIALS_NAMESPACE})`,
            ],
          }
        : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const store = params.context.openPluginStateKeyedStore<ZaloCredentialStateRecord>({
        namespace: ZALOUSER_CREDENTIALS_NAMESPACE,
        maxEntries: ZALOUSER_CREDENTIALS_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      for (const source of await collectLegacyZalouserCredentialSources(params.env)) {
        let credentials: StoredZaloCredentials | null = null;
        try {
          const raw = JSON.parse(await fs.readFile(source.filePath, "utf8")) as unknown;
          const createdAt =
            isRecord(raw) && typeof raw.createdAt === "string" && raw.createdAt
              ? raw.createdAt
              : (await fs.stat(source.filePath)).mtime.toISOString();
          credentials = normalizeStoredZaloCredentials(
            isRecord(raw) ? { ...raw, createdAt } : raw,
            source.profile,
          );
        } catch {
          // Report the same fail-closed result as a structurally invalid file.
        }
        if (!credentials) {
          warnings.push(
            `Left invalid Zalo Personal credential legacy source in place for profile ${source.profile}`,
          );
          continue;
        }
        const key = zalouserCredentialStoreKey(source.profile);
        const stored = await store.lookup(key);
        if (isZaloCredentialRevocation(stored, source.profile)) {
          changes.push(
            `Archived revoked Zalo Personal credential legacy source for profile ${source.profile}`,
          );
          await archiveLegacyStateSource({
            filePath: source.filePath,
            label: "Zalo Personal credentials",
            changes,
            warnings,
          });
          continue;
        }
        const existing = normalizeStoredZaloCredentials(stored, source.profile);
        if (existing && JSON.stringify(existing) !== JSON.stringify(credentials)) {
          warnings.push(
            `Kept existing Zalo Personal credentials for profile ${source.profile}; left differing legacy source in place`,
          );
          continue;
        }
        if (!existing) {
          try {
            await store.registerIfAbsent(key, credentials);
          } catch (error) {
            warnings.push(
              `Failed importing Zalo Personal credentials for profile ${source.profile}: ${String(error)}; left legacy source in place`,
            );
            continue;
          }
        }
        const persisted = normalizeStoredZaloCredentials(await store.lookup(key), source.profile);
        if (!persisted || JSON.stringify(persisted) !== JSON.stringify(credentials)) {
          warnings.push(
            `Failed verifying Zalo Personal credentials for profile ${source.profile}; left legacy source in place`,
          );
          continue;
        }
        changes.push(`Migrated Zalo Personal credentials for profile ${source.profile}`);
        await archiveLegacyStateSource({
          filePath: source.filePath,
          label: "Zalo Personal credentials",
          changes,
          warnings,
        });
      }
      return { changes, warnings };
    },
  },
  {
    id: "zalouser-direct-session-keys",
    label: "Zalo Personal direct-message sessions",
    async detectLegacyState({ config, env }) {
      // A never-configured channel cannot own legacy DMs, so do not scan every agent DB at startup.
      // Removed config defers leftover-row detection until zalouser is configured again.
      if (
        config.channels?.zalouser === undefined &&
        (await collectLegacyZalouserCredentialSources(env)).length === 0
      ) {
        return null;
      }
      const pending = collectLegacyZalouserDmEntries(config, env, { readOnly: true });
      const count = pending.flatMap(({ legacyKeys }) => legacyKeys).length;
      return count > 0
        ? { preview: [`- Zalo Personal direct-message session keys: ${count} legacy row(s)`] }
        : null;
    },
    async migrateLegacyState({ config, env }) {
      const pending = collectLegacyZalouserDmEntries(config, env);
      const warnings: string[] = [];
      let migrated = 0;
      for (const entry of pending) {
        try {
          await upsertSessionEntry({
            agentId: entry.agentId,
            env,
            storePath: entry.storePath,
            sessionKey: entry.canonicalKey,
            entry: entry.entry,
          });
        } catch (error) {
          warnings.push(`Failed writing ${entry.canonicalKey}: ${String(error)}`);
          continue;
        }
        for (const legacyKey of entry.legacyKeys) {
          try {
            await deleteSessionEntry({
              agentId: entry.agentId,
              env,
              storePath: entry.storePath,
              sessionKey: legacyKey,
            });
            migrated++;
          } catch (error) {
            warnings.push(`Failed removing ${legacyKey}: ${String(error)}`);
          }
        }
      }
      return {
        changes: migrated > 0 ? [`Migrated ${migrated} Zalo Personal DM session key(s)`] : [],
        warnings,
      };
    },
  },
];
