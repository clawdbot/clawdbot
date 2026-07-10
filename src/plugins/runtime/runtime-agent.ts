// Runtime agent helpers resolve agent-scoped directories and config for plugin execution.
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import {
  buildConfiguredModelCatalog,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import {
  concretizeAgentRuntime,
  resolveEffectiveAgentRuntime,
} from "../../agents/thinking-runtime.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import { normalizeThinkLevel, resolveThinkingProfile } from "../../auto-reply/thinking.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionWorkStartError } from "../../config/sessions/lifecycle.js";
import { resolveSessionFilePath, resolveStorePath } from "../../config/sessions/paths.js";
import {
  listSessionEntries as listAccessorSessionEntries,
  loadSessionEntry,
  patchSessionEntry as patchAccessorSessionEntry,
  replaceSessionEntry,
  type SessionAccessScope,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { normalizeResolvedMaintenanceConfigInput } from "../../config/sessions/store-maintenance.js";
import {
  loadSessionStore,
  saveSessionStore,
  updateSessionStore,
  type ResolvedSessionMaintenanceConfigInput,
} from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { createLazyRuntimeMethod, createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { defineCachedValue } from "./runtime-cache.js";
import type { PluginRuntime } from "./types.js";

type RuntimeSessionStoreReadParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  hydrateSkillPromptRefs?: boolean;
  sessionKey: string;
  readConsistency?: "latest";
  storePath?: string;
};

type RuntimeSessionStoreListParams = Partial<Omit<RuntimeSessionStoreReadParams, "sessionKey">>;

type RuntimeSessionStoreEntrySummary = {
  sessionKey: string;
  entry: SessionEntry;
};

type RuntimeSessionStoreEntryUpdateParams = {
  storePath: string;
  sessionKey: string;
  update: (
    entry: SessionEntry,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
  requireWriteSuccess?: boolean;
};

type RuntimeSessionStoreEntryPatchParams = RuntimeSessionStoreReadParams & {
  fallbackEntry?: SessionEntry;
  maintenanceConfig?: ResolvedSessionMaintenanceConfigInput;
  preserveActivity?: boolean;
  replaceEntry?: boolean;
  update: (
    entry: SessionEntry,
    context: { existingEntry?: SessionEntry },
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
};

type RuntimeUpsertSessionEntryParams = RuntimeSessionStoreReadParams & {
  entry: SessionEntry;
};

const loadEmbeddedAgentRuntime = createLazyRuntimeModule(
  () => import("./runtime-embedded-agent.runtime.js"),
);

function resolveRuntimeThinkingCatalog(
  params: Parameters<PluginRuntime["agent"]["resolveThinkingPolicy"]>[0],
) {
  if (params.catalog) {
    return params.catalog;
  }
  const configuredCatalog = buildConfiguredModelCatalog({ cfg: getRuntimeConfig() });
  return configuredCatalog.length > 0 ? configuredCatalog : undefined;
}

function toSessionAccessScope(params: RuntimeSessionStoreReadParams): SessionAccessScope {
  // Keep plugin runtime parameters aligned with the public SDK wrapper while
  // avoiding direct exposure of internal accessor-only options.
  return {
    sessionKey: params.sessionKey,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.hydrateSkillPromptRefs !== undefined
      ? { hydrateSkillPromptRefs: params.hydrateSkillPromptRefs }
      : {}),
    ...(params.readConsistency !== undefined ? { readConsistency: params.readConsistency } : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
  };
}

function getSessionEntry(params: RuntimeSessionStoreReadParams): SessionEntry | undefined {
  return loadSessionEntry(toSessionAccessScope(params));
}

function listSessionEntries(
  params: RuntimeSessionStoreListParams = {},
): RuntimeSessionStoreEntrySummary[] {
  return listAccessorSessionEntries({
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.hydrateSkillPromptRefs !== undefined
      ? { hydrateSkillPromptRefs: params.hydrateSkillPromptRefs }
      : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
  });
}

async function patchSessionEntry(
  params: RuntimeSessionStoreEntryPatchParams,
): Promise<SessionEntry | null> {
  return await patchAccessorSessionEntry(toSessionAccessScope(params), params.update, {
    fallbackEntry: params.fallbackEntry,
    maintenanceConfig:
      params.maintenanceConfig !== undefined
        ? normalizeResolvedMaintenanceConfigInput(params.maintenanceConfig)
        : undefined,
    preserveActivity: params.preserveActivity,
    replaceEntry: params.replaceEntry,
  });
}

async function updateSessionStoreEntry(
  params: RuntimeSessionStoreEntryUpdateParams,
): Promise<SessionEntry | null> {
  // Maintainer note: keep the legacy object-parameter API here, but route
  // mutations through the session accessor boundary.
  return await updateSessionEntry(
    {
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    params.update,
    {
      skipMaintenance: params.skipMaintenance,
      takeCacheOwnership: params.takeCacheOwnership,
      requireWriteSuccess: params.requireWriteSuccess,
    },
  );
}

async function upsertSessionEntry(params: RuntimeUpsertSessionEntryParams): Promise<void> {
  // Maintainer note: this compatibility helper has full-entry replacement
  // semantics, so removed fields must not survive as merge leftovers.
  await replaceSessionEntry(toSessionAccessScope(params), params.entry);
}

async function runWithSessionWorkAdmission<T>(
  params: { storePath: string; sessionKey: string; signal?: AbortSignal },
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const initialEntry = getSessionEntry({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    readConsistency: "latest",
  });
  const lifecycleAbortController = new AbortController();
  const admission = await beginSessionWorkAdmission({
    scope: params.storePath,
    identities: [params.sessionKey, initialEntry?.sessionId],
    signal: params.signal,
    onInterrupt: () =>
      lifecycleAbortController.abort(
        new Error("Agent work interrupted by a session lifecycle change."),
      ),
    assertAllowed: () => {
      const currentEntry = getSessionEntry({
        storePath: params.storePath,
        sessionKey: params.sessionKey,
        readConsistency: "latest",
      });
      const changed = initialEntry
        ? !currentEntry || currentEntry.sessionId !== initialEntry.sessionId
        : Boolean(currentEntry);
      if (changed) {
        throw new Error(`Session "${params.sessionKey}" changed while starting work. Retry.`);
      }
      const archivedSessionError = resolveSessionWorkStartError(params.sessionKey, currentEntry);
      if (archivedSessionError) {
        throw new Error(archivedSessionError);
      }
    },
  });

  try {
    const signal = params.signal
      ? AbortSignal.any([params.signal, lifecycleAbortController.signal])
      : lifecycleAbortController.signal;
    return await admission.run(async () => await run(signal));
  } finally {
    admission.release();
  }
}

/** Creates the plugin runtime agent facade with lazy embedded-agent/session helpers. */
export function createRuntimeAgent(): PluginRuntime["agent"] {
  const agentRuntime = {
    defaults: {
      model: DEFAULT_MODEL,
      provider: DEFAULT_PROVIDER,
    },
    resolveAgentDir,
    resolveAgentWorkspaceDir,
    resolveAgentIdentity,
    resolveThinkingDefault,
    normalizeThinkingLevel: normalizeThinkLevel,
    resolveThinkingPolicy: (params) => {
      const cfg = getRuntimeConfig();
      const effectiveRuntime = params.agentRuntime
        ? concretizeAgentRuntime(params.agentRuntime)
        : params.provider && params.model
          ? resolveEffectiveAgentRuntime({
              cfg,
              provider: params.provider,
              modelId: params.model,
            })
          : undefined;
      const profile = resolveThinkingProfile({
        ...params,
        agentRuntime: effectiveRuntime,
        catalog: resolveRuntimeThinkingCatalog(params),
      });
      const policy: Omit<
        ReturnType<PluginRuntime["agent"]["resolveThinkingPolicy"]>,
        "defaultLevel"
      > = {
        levels: profile.levels.map(({ id, label }) => ({ id, label })),
      };
      return profile.defaultLevel ? { ...policy, defaultLevel: profile.defaultLevel } : policy;
    },
    resolveAgentTimeoutMs,
    ensureAgentWorkspace,
  } satisfies Omit<PluginRuntime["agent"], "runEmbeddedAgent" | "runEmbeddedPiAgent" | "session"> &
    Partial<Pick<PluginRuntime["agent"], "runEmbeddedAgent" | "runEmbeddedPiAgent" | "session">>;

  defineCachedValue(agentRuntime, "runEmbeddedAgent", () =>
    createLazyRuntimeMethod(loadEmbeddedAgentRuntime, (runtime) => runtime.runEmbeddedAgent),
  );
  defineCachedValue(
    agentRuntime,
    "runEmbeddedPiAgent",
    () => (agentRuntime as PluginRuntime["agent"]).runEmbeddedAgent,
  );
  defineCachedValue(agentRuntime, "session", () => ({
    resolveStorePath,
    getSessionEntry,
    listSessionEntries,
    patchSessionEntry,
    upsertSessionEntry,
    runWithWorkAdmission: runWithSessionWorkAdmission,
    loadSessionStore,
    saveSessionStore,
    updateSessionStore,
    updateSessionStoreEntry,
    resolveSessionFilePath,
  }));

  return agentRuntime as PluginRuntime["agent"];
}
