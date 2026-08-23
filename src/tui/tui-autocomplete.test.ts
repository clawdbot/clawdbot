import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { sanitizeAutocompleteProvider } from "./tui-autocomplete.js";

describe("sanitizeAutocompleteProvider", () => {
  it("omits unsafe values while sanitizing safe display copies", async () => {
    const safe: AutocompleteItem = {
      value: "safe-value",
      label: `label\x1b]52;c;Y2xpcGJvYXJk\x07\r\nمرحبا`,
      description: "description\u009b31munsafe\u009b0m\tשלום",
    };
    const unsafe: AutocompleteItem = { value: "raw\x1b[31m-value", label: "unsafe" };
    const applyCompletion = vi.fn(() => ({
      lines: [safe.value],
      cursorLine: 0,
      cursorCol: safe.value.length,
    }));
    const inner: AutocompleteProvider = {
      getSuggestions: vi.fn(async () => ({ items: [unsafe, safe], prefix: "/" })),
      applyCompletion,
    };
    const provider = sanitizeAutocompleteProvider(inner);

    const suggestions = await provider.getSuggestions(["/"], 0, 1, {
      signal: new AbortController().signal,
    });
    const displayItem = suggestions?.items[0];

    expect(displayItem).toEqual({
      value: safe.value,
      label: "\u2067label مرحبا\u2069",
      description: "\u2067descriptionunsafe שלום\u2069",
    });
    expect(suggestions?.items).toHaveLength(1);

    provider.applyCompletion(["/"], 0, 1, displayItem!, "/");
    expect(applyCompletion).toHaveBeenCalledWith(["/"], 0, 1, safe, "/");
  });

  it("preserves exact safe RTL paths and delegates file-completion triggers", async () => {
    const value = "/tmp/مرحبا-東京/";
    const original = { value, label: value };
    const applyCompletion = vi.fn(() => ({
      lines: [value],
      cursorLine: 0,
      cursorCol: value.length,
    }));
    const inner: AutocompleteProvider = {
      triggerCharacters: ["@"],
      getSuggestions: vi.fn(async () => ({
        items: [original],
        prefix: "@",
      })),
      applyCompletion,
      shouldTriggerFileCompletion: vi.fn(() => true),
    };
    const provider = sanitizeAutocompleteProvider(inner);

    const suggestions = await provider.getSuggestions(["@"], 0, 1, {
      signal: new AbortController().signal,
    });

    expect(suggestions?.items[0]).toEqual({
      value,
      label: `\u2067${value}\u2069`,
    });
    provider.applyCompletion(["@"], 0, 1, suggestions!.items[0]!, "@");
    expect(applyCompletion).toHaveBeenCalledWith(["@"], 0, 1, original, "@");
    expect(provider.triggerCharacters).toEqual(["@"]);
    expect(provider.shouldTriggerFileCompletion?.(["@"], 0, 1)).toBe(true);
  });

  it("returns null when every completion value is unsafe", async () => {
    const inner: AutocompleteProvider = {
      getSuggestions: vi.fn(async () => ({
        items: [{ value: "bad\tvalue", label: "bad" }],
        prefix: "/",
      })),
      applyCompletion: vi.fn(() => ({ lines: [], cursorLine: 0, cursorCol: 0 })),
    };
    const provider = sanitizeAutocompleteProvider(inner);

    await expect(
      provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal }),
    ).resolves.toBeNull();
  });

  it("falls back to a visible sanitized value and omits empty descriptions", async () => {
    const original: AutocompleteItem = {
      value: "fallback-value",
      label: "\x1b]0;hidden\x07",
      description: "\u009b31m\u009b0m",
    };
    const inner: AutocompleteProvider = {
      getSuggestions: vi.fn(async () => ({ items: [original], prefix: "/" })),
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
  });
});
