import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { sanitizeRenderableLine } from "./tui-formatters.js";

/** Sanitize autocomplete presentation while preserving exact completion values. */
export function sanitizeAutocompleteProvider(inner: AutocompleteProvider): AutocompleteProvider {
  const originals = new WeakMap<AutocompleteItem, AutocompleteItem>();
  return {
    triggerCharacters: inner.triggerCharacters,
    async getSuggestions(...args) {
      const suggestions = await inner.getSuggestions(...args);
      if (!suggestions) {
        return null;
      }
      return {
        ...suggestions,
        items: Array.from(suggestions.items, (item) => {
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
          originals.set(displayItem, item);
          return displayItem;
        }),
      };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return inner.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        originals.get(item) ?? item,
        prefix,
      );
    },
    shouldTriggerFileCompletion: inner.shouldTriggerFileCompletion
      ? (...args) => inner.shouldTriggerFileCompletion!(...args)
      : undefined,
  };
}
