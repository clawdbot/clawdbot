/** Applies model override tokens embedded in reset/new command text. */
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import {
  createModelManifestPluginContext,
  type ModelSelectionNormalizationContext,
  resolveModelRefFromString,
} from "../../agents/model-selection-shared.js";
import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { SessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import {
  adoptPersistedSessionSnapshot,
  SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS,
  sessionModelOverrideChangesApplied,
} from "../../config/sessions/session-snapshot-merge.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { applyModelOverrideWithAuthProfileCompatibility } from "../../sessions/auth-profile-preservation.js";
import { ModelSelectionLockedError } from "../../sessions/model-overrides.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { isKnownModelSelectionProvider } from "./model-runtime-normalization.js";
import {
  resolveModelDirectiveSelection,
  type ModelAliasIndex,
  type ModelDirectiveSelection,
} from "./model-selection-directive.js";
import type { ReplySessionEntryHandle } from "./session-entry-handle.js";

/** Result of applying a reset-message model override. */
type ResetModelResult = {
  selection?: ModelDirectiveSelection;
  cleanedBody?: string;
};

async function loadResetModelCatalog(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<ModelCatalogEntry[]> {
  const { loadPreparedModelCatalog } = await import("../../agents/prepared-model-catalog.js");
  return loadPreparedModelCatalog({
    config: params.cfg,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    readOnly: true,
  });
}

async function applySelectionToSession(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  defaultProvider: string;
  selection: ModelDirectiveSelection;
  sessionEntry?: SessionEntry;
  sessionEntryHandle?: ReplySessionEntryHandle;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
}): Promise<boolean> {
  const { selection, sessionEntryHandle, sessionStore, sessionKey, storePath } = params;
  const sessionEntry = sessionEntryHandle?.getCurrent() ?? params.sessionEntry;
  if (!sessionEntry || !sessionKey) {
    return true;
  }
  const initialSessionEntry = { ...sessionEntry };
  const nextSessionEntry = { ...sessionEntry };
  applyModelOverrideWithAuthProfileCompatibility({
    cfg: params.cfg,
    agentDir: params.agentDir,
    entry: nextSessionEntry,
    currentProvider:
      sessionEntry.providerOverride?.trim() ||
      sessionEntry.modelProvider?.trim() ||
      params.defaultProvider,
    selection,
  });
  let appliedEntry = nextSessionEntry;
  let selectionApplied = true;
  if (storePath) {
    const { persistReplySessionEntry } = await import("./session-entry-persistence.js");
    const persistence = await persistReplySessionEntry({
      storePath,
      sessionKey,
      initialEntry: initialSessionEntry,
      entry: nextSessionEntry,
      touchedFields: SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS,
      requireModelSelectionUnlocked: true,
    });
    if (persistence.status === "lifecycle-invalidated") {
      throw new SessionWorkStartInvalidatedError(persistence.error);
    }
    if (persistence.status === "model-selection-locked") {
      throw new ModelSelectionLockedError();
    }
    const persistedEntry = persistence.entry;
    appliedEntry = persistedEntry;
    selectionApplied = sessionModelOverrideChangesApplied({
      initial: initialSessionEntry,
      next: nextSessionEntry,
      current: persistedEntry,
    });
  }
  adoptPersistedSessionSnapshot(sessionEntry, appliedEntry);
  if (sessionEntryHandle) {
    sessionEntryHandle.replaceCurrent(sessionEntry);
  } else if (sessionStore) {
    sessionStore[sessionKey] = sessionEntry;
  }
  return selectionApplied;
}

/** Applies a valid reset model override to session state and returns the cleaned body. */
export async function applyResetModelOverride(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  manifestPluginContext?: ModelSelectionNormalizationContext["manifestPluginContext"];
  resetTriggered: boolean;
  bodyStripped?: string;
  sessionCtx: TemplateContext;
  ctx: MsgContext;
  sessionEntry?: SessionEntry;
  sessionEntryHandle?: ReplySessionEntryHandle;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  modelCatalog?: ModelCatalogEntry[];
}): Promise<ResetModelResult> {
  if (!params.resetTriggered) {
    return {};
  }
  const rawBody = normalizeOptionalString(params.bodyStripped);
  if (!rawBody) {
    return {};
  }

  const tokens = rawBody.split(/\s+/).filter(Boolean);
  const [first, second] = tokens;
  if (!first) {
    return {};
  }

  const manifestPluginContext =
    params.manifestPluginContext ?? createModelManifestPluginContext(params);
  const normalization = { ...manifestPluginContext.getContext(), manifestPluginContext };
  const catalog =
    params.modelCatalog ??
    (await loadResetModelCatalog({
      cfg: params.cfg,
      agentId: params.agentId,
      agentDir: params.agentDir,
      workspaceDir: normalization.workspaceDir,
    }));
  const modelPolicy = createModelVisibilityPolicy({
    ...normalization,
    preparedDefaultModel: { provider: params.defaultProvider, model: params.defaultModel },
    cfg: params.cfg,
    catalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    agentId: params.agentId,
  });
  const allowedModelKeys = modelPolicy.allowedKeys;
  const providers = new Set([...allowedModelKeys].map((key) => key.split("/", 1)[0]));
  const resolveSelection = (raw: string, explicitRef = false) => {
    const parsed = resolveModelRefFromString({
      ...normalization,
      cfg: params.cfg,
      agentId: params.agentId,
      raw,
      defaultProvider: params.defaultProvider,
      aliasIndex: params.aliasIndex,
    });
    if (!parsed) {
      return undefined;
    }
    const exact =
      explicitRef ||
      parsed.alias ||
      allowedModelKeys.has(buildModelCatalogRef(parsed.ref.provider, parsed.ref.model));
    if (
      (exact && !modelPolicy.allows(parsed.ref)) ||
      (!exact && !providers.has(normalizeProviderId(raw)) && raw.length < 6)
    ) {
      return undefined;
    }
    const resolved = resolveModelDirectiveSelection({
      ...normalization,
      resolvedModel: parsed,
      raw,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
      aliasIndex: params.aliasIndex,
      allowedModelKeys,
      modelPolicy,
      cfg: params.cfg,
      agentId: params.agentId,
    }).selection;
    // Bare text needs a finite hint match; explicit refs and configured aliases
    // use policy independently of inventory. Neither can invent a provider.
    return resolved &&
      (exact || allowedModelKeys.has(buildModelCatalogRef(resolved.provider, resolved.model))) &&
      isKnownModelSelectionProvider({
        cfg: params.cfg,
        catalog,
        provider: resolved.provider,
        manifestPluginContext,
      })
      ? resolved
      : undefined;
  };

  let selection: ModelDirectiveSelection | undefined;
  let consumed = 0;

  if (providers.has(normalizeProviderId(first)) && second) {
    // Inventory disambiguates `provider model prompt` from `provider prompt`.
    // Uncataloged model ids remain explicit through provider/model syntax.
    const composite = `${normalizeProviderId(first)}/${second}`;
    selection = resolveSelection(composite);
    if (selection) {
      consumed = 2;
    }
  }

  if (!selection) {
    selection = resolveSelection(first, first.includes("/"));
    if (selection) {
      consumed = 1;
    }
  }

  if (!selection) {
    return {};
  }

  const cleanedBody = tokens.slice(consumed).join(" ").trim();
  params.sessionCtx.commandText = cleanedBody;
  params.sessionCtx.agentText = cleanedBody;
  params.sessionCtx.BodyStripped = cleanedBody;
  params.sessionCtx.BodyForCommands = cleanedBody;

  const selectionApplied = await applySelectionToSession({
    cfg: params.cfg,
    agentDir:
      params.agentDir ??
      resolveAgentDir(params.cfg, params.agentId ?? resolveDefaultAgentId(params.cfg)),
    defaultProvider: params.defaultProvider,
    selection,
    sessionEntry: params.sessionEntry,
    sessionEntryHandle: params.sessionEntryHandle,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });

  return { selection: selectionApplied ? selection : undefined, cleanedBody };
}
