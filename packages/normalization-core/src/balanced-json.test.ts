import { describe, expect, it } from "vitest";
import { extractBalancedJsonFragments, extractBalancedJsonPrefix } from "./balanced-json.js";

describe("extractBalancedJsonPrefix", () => {
  it("skips an opener inside quoted prose", () => {
    const raw = 'prefix "notjson{here}" middle {"a":[1,{"b":"c"}]} suffix';

    const fragment = extractBalancedJsonPrefix(raw);

    expect(fragment?.json).toBe('{"a":[1,{"b":"c"}]}');
  });

  it("skips a bracket inside quoted prose", () => {
    const raw = 'prose "array[looking]" then [1,2,3] tail';

    const fragment = extractBalancedJsonPrefix(raw);

    expect(fragment?.json).toBe("[1,2,3]");
  });

  it("keeps skipping prose through an escaped quote, so its brace isn't the start", () => {
    // The quoted prose contains an escaped quote (`\"`) that must not close
    // the string early, so the `{no}` inside it stays part of the prose.
    const raw = 'say "go \\"deep{no}\\" here" then {"ok":true}';

    const fragment = extractBalancedJsonPrefix(raw);

    expect(fragment?.json).toBe('{"ok":true}');
  });

  it("still extracts a real JSON value with no leading prose", () => {
    const fragment = extractBalancedJsonPrefix('{"a":1}');

    expect(fragment?.json).toBe('{"a":1}');
  });

  it("returns null when no balanced value follows any quoted prose", () => {
    const fragment = extractBalancedJsonPrefix('prefix "notjson{here}" tail');

    expect(fragment).toBeNull();
  });

  it("recovers a value found inside the unmatched quote's own span", () => {
    // A quote still open at end-of-input was never confirmed as prose, so a
    // literal scan of that span alone may still recover a real value.
    const raw = 'banner "unterminated [1,2,3]';

    const fragment = extractBalancedJsonPrefix(raw);

    expect(fragment?.json).toBe("[1,2,3]");
  });

  it("returns null when an unterminated quote leaves no delimiter behind", () => {
    const fragment = extractBalancedJsonPrefix('banner "unterminated with no json at all');

    expect(fragment).toBeNull();
  });

  it("never re-enters a completed quoted span, even when nothing else is recoverable", () => {
    // Quote-safe contract: once a quoted span validly closes, its contents
    // are prose. When a later unterminated quote makes the rest of the text
    // ambiguous, the extractor returns no fragment instead of resurrecting
    // the `{not}` delimiter out of the completed first span.
    const raw = '"first {not}" then "unterminated no JSON';

    const fragment = extractBalancedJsonPrefix(raw);

    expect(fragment).toBeNull();
  });

  it("never extracts parseable JSON that lives inside a completed quoted span", () => {
    // The quoted text happens to contain valid JSON, but it was quoted as
    // prose and must stay skipped - parseability is not proof it was a real
    // value rather than quoted text.
    const raw = '"{\\"stale\\":true}" then "unterminated no JSON';

    const fragment = extractBalancedJsonPrefix(raw);

    expect(fragment).toBeNull();
  });

  it("prefers no fragment over quote-blind recovery once spans have closed", () => {
    // Here the toggle scan pairs the stray quote with the real JSON's own
    // opening quote, so the object can only be recovered by re-entering a
    // completed span. The quote-safe contract chooses null over guessing.
    const raw = 'banner "unterminated then {"a":1}';

    const fragment = extractBalancedJsonPrefix(raw);

    expect(fragment).toBeNull();
  });
});

describe("extractBalancedJsonFragments", () => {
  it("skips openers inside quoted prose across multiple fragments", () => {
    const raw = '"a{1}" first {"x":1} between "b[2]" second [3,4]';

    const fragments = extractBalancedJsonFragments(raw);

    expect(fragments.map((fragment) => fragment.json)).toEqual(['{"x":1}', "[3,4]"]);
  });
});
