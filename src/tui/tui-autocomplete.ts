import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import { isTerminalSafeAutocompleteValue, sanitizeRenderableLine } from "./tui-formatters.js";

const originalSafeItem = Symbol("originalSafeItem");
/** Sanitize autocomplete presentation and omit values unsafe for editor rendering. */
function sanitizeAutocompleteProvider(inner: AutocompleteProvider): AutocompleteProvider {
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

export function createTuiAutocompleteProvider(
  commands: SlashCommand[],
  basePath: string,
  fdPath?: string,
): AutocompleteProvider {
  const inner = new CombinedAutocompleteProvider(commands, basePath, fdPath);
  return sanitizeAutocompleteProvider({
    getSuggestions(lines, cursorLine, cursorCol, options) {
      const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const isAttachment = /(?:^|[\s='"])@(?:"[^"]*|[^\s='"]*)$/u.test(textBeforeCursor);
      const isNaturalCompletion = isAttachment || textBeforeCursor.startsWith("/");
      if (!options.force && !isNaturalCompletion) {
        return Promise.resolve(null);
      }
      return inner.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion: (...args) => inner.applyCompletion(...args),
    shouldTriggerFileCompletion: (...args) => inner.shouldTriggerFileCompletion(...args),
  });
}
