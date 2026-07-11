/** Applies model override tokens embedded in reset/new command text. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import {
  buildAllowedModelSetWithFallbacks,
  isModelKeyAllowedBySet,
} from "../../agents/model-selection-shared.js";
import { resolveAgentModelFallbackValues } from "../../config/model-input.js";
import type { SessionEntry } from "../../config/sessions.js";
import { SessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import {
  adoptPersistedSessionSnapshot,
  SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS,
  sessionModelOverrideChangesApplied,
} from "../../config/sessions/session-snapshot-merge.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import {
  modelKey,
  resolveModelDirectiveSelection,
  resolveModelRefFromDirectiveString,
  type ModelAliasIndex,
  type ModelDirectiveSelection,
} from "./model-selection-directive.js";
import type { ReplySessionEntryHandle } from "./session-entry-handle.js";

/** Result of applying a reset-message model override. */
type ResetModelResult = {
  selection?: ModelDirectiveSelection;
  cleanedBody?: string;
};

function splitBody(body: string) {
  const tokens = body.split(/\s+/).filter(Boolean);
  return {
    tokens,
    first: tokens[0],
    second: tokens[1],
    rest: tokens.slice(2),
  };
}

async function loadResetModelCatalog(cfg: OpenClawConfig): Promise<ModelCatalogEntry[]> {
  const { loadModelCatalog } = await import("../../agents/model-catalog.js");
  return loadModelCatalog({ config: cfg });
}

async function resolveResetFallbackModels(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Promise<string[]> {
  if (params.agentId) {
    const { resolveAgentModelFallbacksOverride } = await import("../../agents/agent-scope.js");
    const override = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
    if (override !== undefined) {
      return override;
    }
  }
  return resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
}

async function buildResetAllowedModelKeys(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
  defaultModel?: string;
  fallbackModels: readonly string[];
}): Promise<Set<string>> {
  const rawAllowlist = Object.keys(params.cfg.agents?.defaults?.models ?? {});
  if (rawAllowlist.length > 0 || params.cfg.models?.providers) {
    return buildAllowedModelSetWithFallbacks(params).allowedKeys;
  }

  const allowedKeys = new Set<string>();
  for (const entry of params.catalog) {
    allowedKeys.add(modelKey(entry.provider, entry.id));
  }
  const defaultModel = params.defaultModel?.trim();
  if (defaultModel) {
    allowedKeys.add(modelKey(normalizeProviderId(params.defaultProvider), defaultModel));
  }
  return allowedKeys;
}

function buildSelectionFromExplicit(params: {
  raw: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
}): ModelDirectiveSelection | undefined {
  const resolved = resolveModelRefFromDirectiveString({
    raw: params.raw,
    defaultProvider: params.defaultProvider,
    aliasIndex: params.aliasIndex,
  });
  if (!resolved) {
    return undefined;
  }
  const key = modelKey(resolved.ref.provider, resolved.ref.model);
  if (params.allowedModelKeys.size > 0 && !isModelKeyAllowedBySet(params.allowedModelKeys, key)) {
    return undefined;
  }
  const isDefault =
    resolved.ref.provider === params.defaultProvider && resolved.ref.model === params.defaultModel;
  return {
    provider: resolved.ref.provider,
    model: resolved.ref.model,
    isDefault,
    ...(resolved.alias ? { alias: resolved.alias } : undefined),
  };
}

async function applySelectionToSession(params: {
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
  applyModelOverrideToSessionEntry({
    entry: nextSessionEntry,
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
    });
    if (persistence.status === "lifecycle-invalidated") {
      throw new SessionWorkStartInvalidatedError(persistence.error);
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

/** Applies a model override embedded in a reset command body. */
/** Applies a valid reset model override to session state and returns the cleaned body. */
export async function applyResetModelOverride(params: {
  cfg: OpenClawConfig;
  agentId?: string;
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

  const { tokens, first, second } = splitBody(rawBody);
  if (!first) {
    return {};
  }

  const catalog = params.modelCatalog ?? (await loadResetModelCatalog(params.cfg));
  const allowedModelKeys = await buildResetAllowedModelKeys({
    cfg: params.cfg,
    catalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    fallbackModels: await resolveResetFallbackModels({
      cfg: params.cfg,
      agentId: params.agentId,
    }),
  });
  if (allowedModelKeys.size === 0) {
    return {};
  }

  const providers = new Set<string>();
  for (const key of allowedModelKeys) {
    const slash = key.indexOf("/");
    if (slash <= 0) {
      continue;
    }
    providers.add(normalizeProviderId(key.slice(0, slash)));
  }

  const resolveSelection = (raw: string) =>
    resolveModelDirectiveSelection({
      raw,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
      aliasIndex: params.aliasIndex,
      allowedModelKeys,
    });

  let selection: ModelDirectiveSelection | undefined;
  let consumed = 0;

  if (providers.has(normalizeProviderId(first)) && second) {
    // Support reset bodies like `openai gpt-5.6-sol rest of prompt`.
    const composite = `${normalizeProviderId(first)}/${second}`;
    const resolved = resolveSelection(composite);
    if (resolved.selection) {
      selection = resolved.selection;
      consumed = 2;
    }
  }

  if (!selection) {
    selection = buildSelectionFromExplicit({
      raw: first,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
      aliasIndex: params.aliasIndex,
      allowedModelKeys,
    });
    if (selection) {
      consumed = 1;
    }
  }

  if (!selection) {
    const resolved = resolveSelection(first);
    const allowFuzzy = providers.has(normalizeProviderId(first)) || first.trim().length >= 6;
    if (allowFuzzy) {
      selection = resolved.selection;
      if (selection) {
        consumed = 1;
      }
    }
  }

  if (!selection) {
    return {};
  }

  const cleanedBody = tokens.slice(consumed).join(" ").trim();
  params.sessionCtx.BodyStripped = cleanedBody;
  params.sessionCtx.BodyForCommands = cleanedBody;

  const selectionApplied = await applySelectionToSession({
    selection,
    sessionEntry: params.sessionEntry,
    sessionEntryHandle: params.sessionEntryHandle,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });

  return { selection: selectionApplied ? selection : undefined, cleanedBody };
}
