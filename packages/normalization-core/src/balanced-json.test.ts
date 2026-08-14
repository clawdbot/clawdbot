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

  it("still recovers a later valid object after an unterminated leading quote", () => {
    // A lone, never-closed quote in arbitrary prose must not be treated as
    // opening a skippable span: doing so would swallow the rest of the text
    // (including the real JSON) instead of just the malformed prose.
    const raw = 'banner "unterminated then {"a":1}';

    const fragment = extractBalancedJsonPrefix(raw);

    expect(fragment?.json).toBe('{"a":1}');
  });

  it("returns null when an unterminated quote leaves no delimiter behind", () => {
    const fragment = extractBalancedJsonPrefix('banner "unterminated with no json at all');

    expect(fragment).toBeNull();
  });

  it("does not resurrect a delimiter from an earlier, already-closed quoted span", () => {
    // The unterminated-quote fallback must only rescan from its own unclosed
    // span onward; rescanning from index 0 would pick `{not}` back up out of
    // the first, already-completed quoted span instead of the real object.
    const raw = '"first {not}" then "unterminated {"ok":true}';

    const fragment = extractBalancedJsonPrefix(raw);

    expect(fragment?.json).toBe('{"ok":true}');
  });

  it("does not fall back into an earlier closed span when the unmatched span has no JSON either", () => {
    // The trailing unterminated span has no delimiter at all, so the fallback
    // must not retry the earlier, already-closed "first {not}" span just
    // because it happens to contain a brace - `{not}` isn't valid JSON and
    // must stay skipped rather than being returned as a false recovery.
    const raw = '"first {not}" then "unterminated no JSON';

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
