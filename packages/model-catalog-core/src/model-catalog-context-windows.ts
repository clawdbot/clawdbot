import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  MODEL_CATALOG_MAX_CONTEXT_WINDOWS,
  type ModelCatalogContextWindowOption,
} from "./model-catalog-types.js";

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeModelCatalogContextWindows(
  value: unknown,
): ModelCatalogContextWindowOption[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const seen = new Set<string>();
  const contextWindows = value.slice(0, MODEL_CATALOG_MAX_CONTEXT_WINDOWS).flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const id = normalizeOptionalString(entry.id) ?? "";
    const label = normalizeOptionalString(entry.label) ?? "";
    const contextWindow = normalizePositiveInteger(entry.contextWindow);
    if (!id || !label || contextWindow === undefined || seen.has(id)) {
      return [];
    }
    seen.add(id);
    return [{ id, label, contextWindow }];
  });
  return contextWindows.length > 0
    ? contextWindows.toSorted(
        (left, right) =>
          left.contextWindow - right.contextWindow || left.id.localeCompare(right.id),
      )
    : undefined;
}

function normalizeModelCatalogContextWindowDefault(
  value: unknown,
  contextWindows: readonly ModelCatalogContextWindowOption[] | undefined,
): string | undefined {
  const contextWindowDefault = normalizeOptionalString(value);
  return contextWindowDefault &&
    contextWindows?.some((option) => option.id === contextWindowDefault)
    ? contextWindowDefault
    : undefined;
}

export function normalizeModelCatalogContextWindowSelection(value: {
  contextWindows?: unknown;
  contextWindowDefault?: unknown;
}): {
  contextWindows?: ModelCatalogContextWindowOption[];
  contextWindowDefault?: string;
} {
  const contextWindows = normalizeModelCatalogContextWindows(value.contextWindows);
  const contextWindowDefault = normalizeModelCatalogContextWindowDefault(
    value.contextWindowDefault,
    contextWindows,
  );
  // Options and default are one atomic tuple: options without a valid default
  // would advertise a capability the picker cannot render a selection for, so
  // a missing or invalid default drops the option list with it.
  return contextWindows && contextWindowDefault ? { contextWindows, contextWindowDefault } : {};
}
