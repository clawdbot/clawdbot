import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import { findModelCatalogEntry, type ModelCatalogEntry } from "../agents/model-catalog.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";

export function* applySessionContextWindowPatch(params: {
  defaultModel: string;
  defaultProvider: string;
  loadModelCatalog: () => Generator<
    void,
    ModelCatalogEntry[] | undefined,
    ModelCatalogEntry[] | undefined
  >;
  next: SessionEntry;
  patch: SessionsPatchParams;
}): Generator<void, { ok: true } | { ok: false; error: string }, ModelCatalogEntry[] | undefined> {
  if ("contextWindow" in params.patch) {
    const previous = params.next.contextWindow;
    const raw = params.patch.contextWindow;
    if (raw === null) {
      delete params.next.contextWindow;
    } else if (raw !== undefined) {
      params.next.contextWindow = raw.trim();
    }
    if (previous !== params.next.contextWindow) {
      params.next.liveModelSwitchPending = true;
      delete params.next.contextTokens;
      delete params.next.contextTokensSource;
      delete params.next.contextBudgetStatus;
    }
  }
  if (!("contextWindow" in params.patch) && !("model" in params.patch)) {
    return { ok: true };
  }
  const selected = normalizeOptionalString(params.next.contextWindow);
  if (!selected) {
    delete params.next.contextWindow;
    return { ok: true };
  }
  const provider = params.next.providerOverride ?? params.defaultProvider;
  const model = params.next.modelOverride ?? params.defaultModel;
  const catalog = yield* params.loadModelCatalog();
  const catalogEntry = catalog
    ? findModelCatalogEntry(catalog, { provider, modelId: model })
    : undefined;
  if (catalogEntry?.contextWindows?.some((option) => option.id === selected)) {
    return { ok: true };
  }
  if (!("contextWindow" in params.patch)) {
    delete params.next.contextWindow;
    return { ok: true };
  }
  const allowed = catalogEntry?.contextWindows?.map((option) => option.id).join("|");
  return {
    ok: false,
    error: `contextWindow "${selected}" is not supported for ${provider}/${model}${allowed ? ` (use ${allowed})` : ""}`,
  };
}
