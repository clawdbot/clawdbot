/** Doctor-owned migration of plaintext model-catalog credentials into agent SQLite. */
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds, resolveAgentDir, resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
  mergeAuthProfileStores,
} from "../agents/auth-profiles/persisted.js";
import { removeRuntimeExternalProfileReferences } from "../agents/auth-profiles/runtime-external-profile-references.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { resolveProviderConfigSecretInput } from "../agents/model-auth-provider-config.js";
import { parseModelCatalogJson } from "../agents/model-catalog-json.js";
import {
  isGeneratedPluginModelCatalog,
  loadPersistedPluginModelCatalogsReadOnly,
} from "../agents/plugin-model-catalog.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { listAgentModelsJsonPaths } from "../secrets/storage-scan.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type PlaintextCredential = { key: string; provider: string };
type AgentCatalogs = {
  agentDir: string;
  localStore: AuthProfileStore;
  providers: Record<string, unknown>[];
};

function emptyStore(): AuthProfileStore {
  return { version: AUTH_STORE_VERSION, profiles: {} };
}

function credentialMatches(
  credential: AuthProfileCredential | undefined,
  { provider, key }: PlaintextCredential,
): boolean {
  if (normalizeProviderId(credential?.provider ?? "") !== normalizeProviderId(provider)) {
    return false;
  }
  return (
    (credential?.type === "api_key" && credential.key === key) ||
    (credential?.type === "token" && credential.token === key)
  );
}

function matchesProviderEnvRefMarker(
  cfg: OpenClawConfig,
  provider: string,
  value: string,
): boolean {
  const ref = resolveProviderConfigSecretInput(cfg, provider).ref;
  if (ref?.source !== "env") {
    return false;
  }
  // Generated env markers are provider-scoped. Treating every uppercase value
  // as a marker would discard valid literal credentials.
  const id = ref.id.trim();
  const candidate = value.trim();
  return candidate === id || candidate === `$${id}` || candidate === `\${${id}}`;
}

function findProviderSecretRefProfiles(store: AuthProfileStore, cfg: OpenClawConfig) {
  return Object.entries(store.profiles).filter(
    ([, credential]) =>
      credential.type === "api_key" &&
      credential.key &&
      matchesProviderEnvRefMarker(cfg, credential.provider, credential.key),
  );
}

function collectCredentials(
  providers: unknown,
  store: AuthProfileStore,
  blockedStores: readonly AuthProfileStore[] = [],
  cfg?: OpenClawConfig,
): PlaintextCredential[] {
  if (!isRecord(providers)) {
    return [];
  }
  return Object.entries(providers).flatMap(([provider, entry]) => {
    if (!isRecord(entry) || typeof entry.apiKey !== "string") {
      return [];
    }
    const key = entry.apiKey;
    const credential = { provider, key };
    if (
      !key.trim() ||
      // An authored SecretRef owns this provider; generated catalog copies are never fallbacks.
      (cfg && resolveProviderConfigSecretInput(cfg, provider).ref) ||
      isNonSecretApiKeyMarker(key) ||
      store.profiles[key] !== undefined ||
      findMatchingProfileId(store, credential, blockedStores) !== undefined
    ) {
      return [];
    }
    return [credential];
  });
}

function uniqueCredentials(credentials: readonly PlaintextCredential[]): PlaintextCredential[] {
  return [
    ...new Map(
      credentials.map((credential) => [
        `${normalizeProviderId(credential.provider)}\0${credential.key}`,
        credential,
      ]),
    ).values(),
  ];
}

function findMatchingProfileId(
  store: AuthProfileStore,
  credential: PlaintextCredential,
  blockedStores: readonly AuthProfileStore[],
): string | undefined {
  return Object.entries(store.profiles).find(
    ([profileId, stored]) =>
      credentialMatches(stored, credential) &&
      blockedStores.every(
        (blocked) =>
          blocked.profiles[profileId] === undefined ||
          credentialMatches(blocked.profiles[profileId], credential),
      ),
  )?.[0];
}

function allocateProfileId(
  store: AuthProfileStore,
  credential: PlaintextCredential,
  blockedStores: readonly AuthProfileStore[],
): string {
  const provider = normalizeProviderId(credential.provider);
  for (let suffix = 1; ; suffix += 1) {
    const profileId =
      suffix === 1
        ? `${provider}:default`
        : `${provider}:models-json${suffix === 2 ? "" : `-${suffix}`}`;
    if (
      (!store.profiles[profileId] || credentialMatches(store.profiles[profileId], credential)) &&
      blockedStores.every(
        (blocked) =>
          !blocked.profiles[profileId] ||
          credentialMatches(blocked.profiles[profileId], credential),
      )
    ) {
      return profileId;
    }
  }
}

async function persistCredentials(params: {
  agentDir?: string;
  blockedStores?: readonly AuthProfileStore[];
  credentials: readonly PlaintextCredential[];
  inheritedStore?: AuthProfileStore;
  invalidProfiles: ReadonlyArray<[string, AuthProfileCredential]>;
  stateDir: string;
}): Promise<{ migrated: number; removed: number }> {
  const credentials = uniqueCredentials(params.credentials);
  const { invalidProfiles } = params;
  if (credentials.length === 0 && invalidProfiles.length === 0) {
    return { migrated: 0, removed: 0 };
  }
  const blockedStores = params.blockedStores ?? [];
  const profileIds = new Map<string, PlaintextCredential>();
  let added = 0;
  let removedProfiles: [string, AuthProfileCredential][] = [];
  const updated = await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    stateDir: params.stateDir,
    saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
    updater: (localStore) => {
      // Confirmation can pause while another writer replaces a marker. Only remove
      // the exact credential observed before prompting, including its references.
      removedProfiles = invalidProfiles.filter(([profileId, credential]) =>
        isDeepStrictEqual(localStore.profiles[profileId], credential),
      );
      if (removedProfiles.length > 0) {
        Object.assign(
          localStore,
          removeRuntimeExternalProfileReferences({
            store: localStore,
            profileIds: new Set(removedProfiles.map(([profileId]) => profileId)),
          }),
        );
      }
      const effectiveStore = params.inheritedStore
        ? mergeAuthProfileStores(params.inheritedStore, localStore)
        : localStore;
      for (const credential of credentials) {
        const profileId =
          findMatchingProfileId(effectiveStore, credential, blockedStores) ??
          allocateProfileId(effectiveStore, credential, blockedStores);
        profileIds.set(profileId, credential);
        if (credentialMatches(effectiveStore.profiles[profileId], credential)) {
          continue;
        }
        localStore.profiles[profileId] = {
          type: "api_key",
          provider: normalizeProviderId(credential.provider),
          key: credential.key,
        };
        effectiveStore.profiles[profileId] = localStore.profiles[profileId];
        added += 1;
      }
      return added > 0 || removedProfiles.length > 0;
    },
  });
  if (!updated) {
    throw new Error("auth profile store could not be updated");
  }
  const persisted = params.agentDir
    ? loadPersistedAuthProfileStore(params.agentDir)
    : loadPersistedSharedAuthProfileStore({
        ...process.env,
        OPENCLAW_STATE_DIR: params.stateDir,
      });
  const effectivePersisted = params.inheritedStore
    ? mergeAuthProfileStores(params.inheritedStore, persisted ?? emptyStore())
    : persisted;
  for (const [profileId, credential] of removedProfiles) {
    if (isDeepStrictEqual(persisted?.profiles[profileId], credential)) {
      throw new Error(`credential cleanup verification failed for profile "${profileId}"`);
    }
  }
  for (const [profileId, credential] of profileIds) {
    if (!credentialMatches(effectivePersisted?.profiles[profileId], credential)) {
      throw new Error(`credential verification failed for provider "${credential.provider}"`);
    }
  }
  return { migrated: added, removed: removedProfiles.length };
}

function collectAgentCatalogs(agentDir: string, warnings: string[]): AgentCatalogs {
  const localStore = loadPersistedAuthProfileStore(agentDir) ?? emptyStore();
  const providers: Record<string, unknown>[] = [];
  const rootPath = path.join(agentDir, "models.json");
  try {
    const root = parseModelCatalogJson(fs.readFileSync(rootPath, "utf8"));
    if (isRecord(root) && isRecord(root.providers)) {
      providers.push(root.providers);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(
        `Could not read model catalog ${shortenHomePath(rootPath)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    for (const catalog of loadPersistedPluginModelCatalogsReadOnly(agentDir)) {
      try {
        const parsed = JSON.parse(catalog.contents) as unknown;
        if (
          isGeneratedPluginModelCatalog(parsed) &&
          isRecord(parsed) &&
          isRecord(parsed.providers)
        ) {
          providers.push(parsed.providers);
        }
      } catch {
        warnings.push(`Could not parse generated model catalog for plugin ${catalog.pluginId}.`);
      }
    }
  } catch (error) {
    warnings.push(
      `Could not read generated model catalogs for ${shortenHomePath(agentDir)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { agentDir, localStore, providers };
}

/** Copies and verifies catalog credentials before the runtime retires plaintext catalog auth. */
export async function maybeMigrateModelCatalogCredentials(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  prompter: DoctorPrompter;
  runtime: RuntimeEnv;
}): Promise<{ detected: number; migrated: number; removed: number; warnings: string[] }> {
  const warnings: string[] = [];
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const mainAgentDir = resolveSharedMainAuthAgentDir(env);
  const discoveredAgentDirs = listAgentModelsJsonPaths(params.cfg, stateDir, env).map(
    (modelsPath) => path.dirname(modelsPath),
  );
  const agentIds = listAgentIds(params.cfg);
  const configuredAgentDirs =
    agentIds.length > 0
      ? agentIds.map((agentId) => resolveAgentDir(params.cfg, agentId, env))
      : [resolveDefaultAgentDir(params.cfg, env)];
  const agentDirs = [...new Set([mainAgentDir, ...configuredAgentDirs, ...discoveredAgentDirs])];
  const mainStore = loadPersistedSharedAuthProfileStore(env) ?? emptyStore();
  const catalogs = agentDirs.map((agentDir) => collectAgentCatalogs(agentDir, warnings));
  const effectiveStores = catalogs.map(({ localStore }) =>
    mergeAuthProfileStores(mainStore, localStore),
  );
  const childStores = catalogs
    .filter((catalog) => catalog.agentDir !== mainAgentDir)
    .map((catalog) => catalog.localStore);
  const configCredentials = collectCredentials(
    params.cfg.models?.providers,
    mainStore,
    childStores,
    params.cfg,
  );
  const catalogCredentials = catalogs.map((catalog, index) =>
    uniqueCredentials(
      catalog.providers.flatMap((providers) =>
        collectCredentials(providers, effectiveStores[index] ?? mainStore, [], params.cfg),
      ),
    ),
  );
  const invalidMainProfiles = findProviderSecretRefProfiles(mainStore, params.cfg);
  const invalidCatalogProfiles = catalogs.map((catalog) =>
    catalog.agentDir === mainAgentDir
      ? []
      : findProviderSecretRefProfiles(catalog.localStore, params.cfg),
  );
  const detected =
    configCredentials.length + catalogCredentials.reduce((sum, entries) => sum + entries.length, 0);
  const removable =
    invalidMainProfiles.length +
    invalidCatalogProfiles.reduce((sum, profiles) => sum + profiles.length, 0);

  for (const warning of warnings) {
    params.runtime.error(warning);
  }
  if (detected === 0 && removable === 0) {
    return { detected, migrated: 0, removed: 0, warnings };
  }

  if (detected > 0) {
    note(
      `Found ${detected} plaintext model credential${detected === 1 ? "" : "s"}. Run openclaw doctor --fix to copy and verify them in agent SQLite before plaintext catalog authentication is retired.`,
      "Model catalog credentials",
    );
  }
  if (removable > 0) {
    note(
      `Found ${removable} stored unresolved model credential marker${removable === 1 ? "" : "s"}. Run openclaw doctor --fix to remove them from agent SQLite.`,
      "Model catalog credentials",
    );
  }
  const shouldRepair =
    params.prompter.shouldRepair ||
    (await params.prompter.confirmAutoFix({
      message: "Repair model credentials in agent SQLite now?",
      initialValue: true,
    }));
  if (!shouldRepair) {
    return { detected, migrated: 0, removed: 0, warnings };
  }

  let migrated = 0;
  let removed = 0;
  try {
    const result = await persistCredentials({
      blockedStores: childStores,
      credentials: configCredentials,
      invalidProfiles: invalidMainProfiles,
      stateDir,
    });
    migrated += result.migrated;
    removed += result.removed;
  } catch (error) {
    const warning = `Could not migrate configured model credentials: ${error instanceof Error ? error.message : String(error)}`;
    warnings.push(warning);
    params.runtime.error(warning);
  }

  const migratedMainStore = loadPersistedSharedAuthProfileStore(env) ?? mainStore;
  for (const [index, catalog] of catalogs.entries()) {
    try {
      const result = await persistCredentials({
        ...(catalog.agentDir === mainAgentDir ? {} : { agentDir: catalog.agentDir }),
        credentials: catalogCredentials[index] ?? [],
        invalidProfiles: invalidCatalogProfiles[index] ?? [],
        ...(catalog.agentDir === mainAgentDir ? {} : { inheritedStore: migratedMainStore }),
        stateDir,
      });
      migrated += result.migrated;
      removed += result.removed;
    } catch (error) {
      const warning = `Could not migrate model credentials for ${shortenHomePath(catalog.agentDir)}: ${error instanceof Error ? error.message : String(error)}`;
      warnings.push(warning);
      params.runtime.error(warning);
    }
  }

  if (migrated > 0) {
    note(
      `Copied and verified ${migrated} model credential${migrated === 1 ? "" : "s"} in agent SQLite. Existing catalog values remain active until the runtime migration lands.`,
      "Doctor changes",
    );
  }
  if (removed > 0) {
    note(
      `Removed ${removed} unresolved model credential marker${removed === 1 ? "" : "s"} from agent SQLite.`,
      "Doctor changes",
    );
  }
  return { detected, migrated, removed, warnings };
}
