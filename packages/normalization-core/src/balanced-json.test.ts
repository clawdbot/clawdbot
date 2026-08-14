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
});

describe("extractBalancedJsonFragments", () => {
  it("skips openers inside quoted prose across multiple fragments", () => {
    const raw = '"a{1}" first {"x":1} between "b[2]" second [3,4]';

    const fragments = extractBalancedJsonFragments(raw);

    expect(fragments.map((fragment) => fragment.json)).toEqual(['{"x":1}', "[3,4]"]);
  });
});
