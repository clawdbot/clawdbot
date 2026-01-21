import { loadModelCatalog } from "../../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  modelKey,
  normalizeProviderId,
  resolveModelRefFromString,
  type ModelAliasIndex,
} from "../../agents/model-selection.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { formatInboundBodyWithSenderMeta } from "./inbound-sender-meta.js";
import { resolveModelDirectiveSelection, type ModelDirectiveSelection } from "./model-selection.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";

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

function buildSelectionFromExplicit(params: {
  raw: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
}): ModelDirectiveSelection | undefined {
  const resolved = resolveModelRefFromString({
    raw: params.raw,
    defaultProvider: params.defaultProvider,
    aliasIndex: params.aliasIndex,
  });
  if (!resolved) return undefined;
  const key = modelKey(resolved.ref.provider, resolved.ref.model);
  if (params.allowedModelKeys.size > 0 && !params.allowedModelKeys.has(key)) return undefined;
  const isDefault =
    resolved.ref.provider === params.defaultProvider && resolved.ref.model === params.defaultModel;
  return {
    provider: resolved.ref.provider,
    model: resolved.ref.model,
    isDefault,
    ...(resolved.alias ? { alias: resolved.alias } : undefined),
  };
}

function applySelectionToSession(params: {
  selection: ModelDirectiveSelection;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
}) {
  const { selection, sessionEntry, sessionStore, sessionKey, storePath } = params;
  if (!sessionEntry || !sessionStore || !sessionKey) return;
  const { updated } = applyModelOverrideToSessionEntry({
    entry: sessionEntry,
    selection,
  });
  if (!updated) return;
  sessionStore[sessionKey] = sessionEntry;
  if (storePath) {
    updateSessionStore(storePath, (store) => {
      store[sessionKey] = sessionEntry;
    }).catch(() => {
      // Ignore persistence errors; session still proceeds.
    });
  }
}

export async function applyResetModelOverride(params: {
  cfg: ClawdbotConfig;
  resetTriggered: boolean;
  bodyStripped?: string;
  sessionCtx: TemplateContext;
  ctx: MsgContext;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
}): Promise<ResetModelResult> {
  if (!params.resetTriggered) return {};
  const rawBody = params.bodyStripped?.trim();
  if (!rawBody) return {};

  const { tokens, first, second } = splitBody(rawBody);
  if (!first) return {};

  const catalog = await loadModelCatalog({ config: params.cfg });
  const allowed = buildAllowedModelSet({
    cfg: params.cfg,
    catalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });
  const allowedModelKeys = allowed.allowedKeys;
  if (allowedModelKeys.size === 0) return {};

  const providers = new Set<string>();
  for (const key of allowedModelKeys) {
    const slash = key.indexOf("/");
    if (slash <= 0) continue;
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
    if (selection) consumed = 1;
  }

  if (!selection) {
    const resolved = resolveSelection(first);
    const allowFuzzy = providers.has(normalizeProviderId(first)) || first.trim().length >= 6;
    if (allowFuzzy) {
      selection = resolved.selection;
      if (selection) consumed = 1;
    }
  }

  if (!selection) return {};

  const cleanedBody = tokens.slice(consumed).join(" ").trim();
  params.sessionCtx.BodyStripped = formatInboundBodyWithSenderMeta({
    ctx: params.ctx,
    body: cleanedBody,
  });
  params.sessionCtx.BodyForCommands = cleanedBody;

  applySelectionToSession({
    selection,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });

  return { selection, cleanedBody };
}
