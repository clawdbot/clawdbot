import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { sanitizeAutocompleteProvider } from "./tui-autocomplete.js";

describe("sanitizeAutocompleteProvider", () => {
  it("sanitizes display copies while applying the exact original completion", async () => {
    const original: AutocompleteItem = {
      value: "raw-value",
      label: `label\x1b]52;c;Y2xpcGJvYXJk\x07\r\nمرحبا`,
      description: "description\u009b31munsafe\u009b0m\tשלום",
    };
    const applyCompletion = vi.fn(() => ({
      lines: [original.value],
      cursorLine: 0,
      cursorCol: original.value.length,
    }));
    const inner: AutocompleteProvider = {
      getSuggestions: vi.fn(async () => ({ items: [original], prefix: "/" })),
      applyCompletion,
    };
    const provider = sanitizeAutocompleteProvider(inner);

    const suggestions = await provider.getSuggestions(["/"], 0, 1, {
      signal: new AbortController().signal,
    });
    const displayItem = suggestions?.items[0];

    expect(displayItem).toEqual({
      value: original.value,
      label: "\u2067label مرحبا\u2069",
      description: "\u2067descriptionunsafe שלום\u2069",
    });
    expect(displayItem).not.toBe(original);

    provider.applyCompletion(["/"], 0, 1, displayItem!, "/");
    expect(applyCompletion).toHaveBeenCalledWith(["/"], 0, 1, original, "/");
  });

  it("preserves long labels and delegates file-completion triggers", async () => {
    const label = "a".repeat(300);
    const inner: AutocompleteProvider = {
      triggerCharacters: ["@"],
      getSuggestions: vi.fn(async () => ({
        items: [{ value: label, label }],
        prefix: "@",
      })),
      applyCompletion: vi.fn(() => ({ lines: [label], cursorLine: 0, cursorCol: label.length })),
      shouldTriggerFileCompletion: vi.fn(() => true),
    };
    const provider = sanitizeAutocompleteProvider(inner);

    const suggestions = await provider.getSuggestions(["@"], 0, 1, {
      signal: new AbortController().signal,
    });

    expect(suggestions?.items[0]?.label).toBe(label);
    expect(provider.triggerCharacters).toEqual(["@"]);
    expect(provider.shouldTriggerFileCompletion(["@"], 0, 1)).toBe(true);
  });

  it("falls back to a visible sanitized value and omits empty descriptions", async () => {
    const original: AutocompleteItem = {
      value: "fallback\x1b[31m-value\x1b[0m",
      label: "\x1b]0;hidden\x07",
      description: "\u009b31m\u009b0m",
    };
    const unnamed: AutocompleteItem = {
      value: "\x1b]0;hidden-value\x07",
      label: "\u009b31m\u009b0m",
    };
    const inner: AutocompleteProvider = {
      getSuggestions: vi.fn(async () => ({ items: [original, unnamed], prefix: "/" })),
      applyCompletion: vi.fn(() => ({ lines: [original.value], cursorLine: 0, cursorCol: 0 })),
    };
    const provider = sanitizeAutocompleteProvider(inner);

    const suggestions = await provider.getSuggestions(["/"], 0, 1, {
      signal: new AbortController().signal,
    });

    expect(suggestions?.items[0]).toEqual({
      value: original.value,
      label: "fallback-value",
    });
    expect(suggestions?.items[1]).toEqual({
      value: unnamed.value,
      label: "(unnamed)",
    });
  });
});
