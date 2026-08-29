/**
 * Telegram inline button utilities for model selection.
 *
 * Callback data patterns (max 64 bytes for Telegram):
 * - mdl_prov              - show providers list
 * - mdl_list_{prov}_{pg}  - show models for provider (page N, 1-indexed)
 * - mdl_sel_{provider/id} - select model (standard)
 * - mdl_sel/{model}       - select model (compact fallback when standard is >64 bytes)
 * - mdl1~m:{sha256}       - select an opaque provider/model ref
 * - mdl1~p:{sha256}:{pg}  - show models for an opaque provider ref
 * - mdl_back              - back to providers list
 */
import { createHash } from "node:crypto";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { fitsTelegramCallbackData } from "./approval-callback-data.js";

export type ButtonRow = Array<{ text: string; callback_data: string }>;

export type ParsedModelCallback =
  | { type: "providers" }
  | { type: "list"; provider: string; page: number }
  | { type: "list-ref"; digest: string; page: number }
  | { type: "select"; provider?: string; model: string }
  | { type: "select-ref"; digest: string }
  | { type: "back" };

export type ProviderInfo = {
  id: string;
  count: number;
};

export type ResolveModelSelectionResult =
  | { kind: "resolved"; provider: string; model: string }
  | { kind: "ambiguous"; model: string; matchingProviders: string[] };

export type ModelsKeyboardParams = {
  provider: string;
  models: readonly string[];
  currentModel?: string;
  currentPage: number;
  totalPages: number;
  pageSize?: number;
  /** Optional map from provider/model to display name. When provided, the
   *  display name is shown on the button instead of the raw model ID. */
  modelNames?: ReadonlyMap<string, string>;
};

const MODELS_PAGE_SIZE = 8;
const MODEL_BUTTON_LABEL_MAX_LENGTH = 38;
const LEGACY_PROVIDER_PATTERN = /^[a-z0-9_.-]+$/i;
const CALLBACK_PREFIX = {
  providers: "mdl_prov",
  back: "mdl_back",
  list: "mdl_list_",
  selectStandard: "mdl_sel_",
  selectCompact: "mdl_sel/",
  opaqueModel: "mdl1~m:",
  opaqueProvider: "mdl1~p:",
} as const;

function hashOpaqueCallback(domain: "model" | "provider", ...values: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([`openclaw.telegram.${domain}-callback.v1`, ...values]))
    .digest("base64url");
}

/**
 * Parse a model callback_data string into a structured object.
 * Returns null if the data doesn't match a known pattern.
 */
export function parseModelCallbackData(data: string): ParsedModelCallback | null {
  const trimmed = data.trim();
  const opaqueModelMatch = trimmed.match(/^mdl1~m:([A-Za-z0-9_-]{43})$/);
  if (opaqueModelMatch?.[1]) {
    return { type: "select-ref", digest: opaqueModelMatch[1] };
  }
  const opaqueProviderMatch = trimmed.match(/^mdl1~p:([A-Za-z0-9_-]{43}):(\d+)$/);
  if (opaqueProviderMatch?.[1]) {
    const page = parseStrictPositiveInteger(opaqueProviderMatch[2]);
    if (page !== undefined && fitsTelegramCallbackData(trimmed)) {
      return { type: "list-ref", digest: opaqueProviderMatch[1], page };
    }
  }
  if (trimmed === CALLBACK_PREFIX.providers || trimmed === CALLBACK_PREFIX.back) {
    return { type: trimmed === CALLBACK_PREFIX.providers ? "providers" : "back" };
  }

  // mdl_list_{provider}_{page}
  const listMatch = trimmed.match(/^mdl_list_([a-z0-9_.-]+)_(\d+)$/i);
  if (listMatch) {
    const [, provider, pageStr] = listMatch;
    const page = parseStrictPositiveInteger(pageStr);
    if (provider && page !== undefined) {
      return { type: "list", provider, page };
    }
  }

  // mdl_sel/{model} (compact fallback)
  const compactModel = trimmed.match(/^mdl_sel\/(.+)$/)?.[1];
  if (compactModel) {
    return { type: "select", model: compactModel };
  }

  // mdl_sel_{provider/model}
  const [, provider, model] = trimmed.match(/^mdl_sel_([^/]+)\/(.+)$/) ?? [];
  return provider && model ? { type: "select", provider, model } : null;
}

export function buildModelSelectionCallbackData(params: {
  provider: string;
  model: string;
}): string {
  const fullCallbackData = `${CALLBACK_PREFIX.selectStandard}${params.provider}/${params.model}`;
  if (LEGACY_PROVIDER_PATTERN.test(params.provider) && fitsTelegramCallbackData(fullCallbackData)) {
    return fullCallbackData;
  }
  const compactCallbackData = `${CALLBACK_PREFIX.selectCompact}${params.model}`;
  if (
    LEGACY_PROVIDER_PATTERN.test(params.provider) &&
    fitsTelegramCallbackData(`${CALLBACK_PREFIX.list}${params.provider}_1`) &&
    fitsTelegramCallbackData(compactCallbackData)
  ) {
    return compactCallbackData;
  }
  return `${CALLBACK_PREFIX.opaqueModel}${hashOpaqueCallback("model", params.provider, params.model)}`;
}

function buildProviderListCallbackData(provider: string, page: number): string {
  const callbackData = `${CALLBACK_PREFIX.list}${provider}_${page}`;
  return LEGACY_PROVIDER_PATTERN.test(provider) && fitsTelegramCallbackData(callbackData)
    ? callbackData
    : `${CALLBACK_PREFIX.opaqueProvider}${hashOpaqueCallback("provider", provider)}:${page}`;
}

export function resolveModelSelection(params: {
  callback: Extract<ParsedModelCallback, { type: "select" | "select-ref" }>;
  providers: readonly string[];
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
}): ResolveModelSelectionResult {
  const callback = params.callback;
  if (callback.type === "select" && callback.provider) {
    return {
      kind: "resolved",
      provider: callback.provider,
      model: callback.model,
    };
  }
  const matches = params.providers.flatMap((provider) => {
    const models = params.byProvider.get(provider);
    if (callback.type === "select") {
      return models?.has(callback.model) ? [{ provider, model: callback.model }] : [];
    }
    return [...(models ?? [])]
      .filter((model) => hashOpaqueCallback("model", provider, model) === callback.digest)
      .map((model) => ({ provider, model }));
  });
  const [match] = matches;
  return matches.length === 1 && match
    ? { kind: "resolved", ...match }
    : {
        kind: "ambiguous",
        model: callback.type === "select" ? callback.model : callback.digest,
        matchingProviders: matches.map(({ provider }) => provider),
      };
}

export function resolveModelListCallback(params: {
  callback: Extract<ParsedModelCallback, { type: "list" | "list-ref" }>;
  providers: readonly string[];
}): { provider: string; page: number } | undefined {
  const { callback } = params;
  if (callback.type === "list") {
    return { provider: callback.provider, page: callback.page };
  }
  const matches = params.providers.filter(
    (provider) => hashOpaqueCallback("provider", provider) === callback.digest,
  );
  const [provider] = matches;
  return matches.length === 1 && provider !== undefined
    ? { provider, page: callback.page }
    : undefined;
}

function isCurrentModelSelection(params: {
  currentModel?: string;
  provider: string;
  model: string;
}): boolean {
  const currentModel = params.currentModel?.trim();
  if (!currentModel) {
    return false;
  }
  return currentModel.includes("/")
    ? currentModel === `${params.provider}/${params.model}`
    : currentModel === params.model;
}

/**
 * Build provider selection keyboard with 2 providers per row.
 */
export function buildProviderKeyboard(providers: ProviderInfo[]): ButtonRow[] {
  const rows: ButtonRow[] = [];
  for (const [index, provider] of providers.entries()) {
    (rows[Math.floor(index / 2)] ??= []).push({
      text: `${provider.id} (${provider.count})`,
      callback_data: buildProviderListCallbackData(provider.id, 1),
    });
  }
  return rows;
}

/**
 * Build model list keyboard with pagination and back button.
 */
export function buildModelsKeyboard(params: ModelsKeyboardParams): ButtonRow[] {
  const { provider, models, currentModel, currentPage, totalPages, modelNames } = params;
  const pageSize = params.pageSize ?? MODELS_PAGE_SIZE;

  if (models.length === 0) {
    return [[{ text: "<< Back", callback_data: CALLBACK_PREFIX.back }]];
  }

  const rows: ButtonRow[] = [];

  // Calculate page slice
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, models.length);
  const pageModels = models.slice(startIndex, endIndex);

  for (const model of pageModels) {
    const callbackData = buildModelSelectionCallbackData({ provider, model });
    const isCurrentModel = isCurrentModelSelection({ currentModel, provider, model });
    const fallbackLabel = model.includes("/") ? `${provider}/${model}` : model;
    const displayLabel = modelNames?.get(`${provider}/${model}`) ?? fallbackLabel;
    const displayText = truncateModelLabel(displayLabel, MODEL_BUTTON_LABEL_MAX_LENGTH);
    const text = isCurrentModel ? `${displayText} ✓` : displayText;

    rows.push([
      {
        text,
        callback_data: callbackData,
      },
    ]);
  }

  // Pagination row
  if (totalPages > 1) {
    const paginationRow: ButtonRow = [];

    if (currentPage > 1) {
      paginationRow.push({
        text: "◀ Prev",
        callback_data: buildProviderListCallbackData(provider, currentPage - 1),
      });
    }

    paginationRow.push({
      text: `${currentPage}/${totalPages}`,
      callback_data: buildProviderListCallbackData(provider, currentPage), // noop
    });

    if (currentPage < totalPages) {
      paginationRow.push({
        text: "Next ▶",
        callback_data: buildProviderListCallbackData(provider, currentPage + 1),
      });
    }

    rows.push(paginationRow);
  }

  // Back button
  rows.push([{ text: "<< Back", callback_data: CALLBACK_PREFIX.back }]);

  return rows;
}

/**
 * Build "Browse providers" button for /model summary.
 */
export function buildBrowseProvidersButton(): ButtonRow[] {
  return [[{ text: "Browse providers", callback_data: CALLBACK_PREFIX.providers }]];
}

/**
 * Truncate a model label for display, preserving its end if too long.
 */
function truncateModelLabel(modelLabel: string, maxLen: number): string {
  if (modelLabel.length <= maxLen) {
    return modelLabel;
  }
  return `…${sliceUtf16Safe(modelLabel, -(maxLen - 1))}`;
}

/**
 * Get page size for model list pagination.
 */
export function getModelsPageSize(): number {
  return MODELS_PAGE_SIZE;
}

/**
 * Calculate total pages for a model list.
 */
export function calculateTotalPages(totalModels: number, pageSize?: number): number {
  const size = pageSize ?? MODELS_PAGE_SIZE;
  return size > 0 ? Math.ceil(totalModels / size) : 1;
}
