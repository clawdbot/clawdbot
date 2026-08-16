import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { isTerminalSafeAutocompleteValue, sanitizeRenderableLine } from "./tui-formatters.js";

const originalSafeItem = Symbol("originalSafeItem");
/** Sanitize autocomplete presentation and omit values unsafe for editor rendering. */
export function sanitizeAutocompleteProvider(inner: AutocompleteProvider): AutocompleteProvider {
  return {
    triggerCharacters: inner.triggerCharacters,
    async getSuggestions(...args) {
      const suggestions = await inner.getSuggestions(...args);
      if (!suggestions) {
        return null;
      }
      const safeItems = suggestions.items.filter((item) =>
        isTerminalSafeAutocompleteValue(item.value),
      );
      if (safeItems.length === 0) {
        return null;
      }
      return {
        ...suggestions,
        items: Array.from(safeItems, (item) => {
          const { description: rawDescription, ...displayFields } = item;
          const label =
            sanitizeRenderableLine(item.label) || sanitizeRenderableLine(item.value) || "(unnamed)";
          const description =
            rawDescription === undefined ? undefined : sanitizeRenderableLine(rawDescription);
          const displayItem = {
            ...displayFields,
            label,
            ...(description ? { description } : {}),
          };
          return Object.defineProperty(displayItem, originalSafeItem, { value: item });
        }),
      };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return inner.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        (Reflect.get(item, originalSafeItem) as AutocompleteItem | undefined) ?? item,
        prefix,
      );
    },
    shouldTriggerFileCompletion: inner.shouldTriggerFileCompletion
      ? (...args) => inner.shouldTriggerFileCompletion!(...args)
      : undefined,
  };
}
