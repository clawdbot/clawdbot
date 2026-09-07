import { describe, expect, it } from "vitest";
import { extractBalancedJsonFragments, extractBalancedJsonPrefix } from "./balanced-json.js";

describe("balanced JSON extraction", () => {
  it.each([
    ['prefix "notjson{here}" middle {"a":[1,{"b":"c"}]} suffix', '{"a":[1,{"b":"c"}]}'],
    ['prefix "array[here]" then [1,{"b":"c"}]', '[1,{"b":"c"}]'],
    ['banner "use { to begin JSON" actual {"ok":true}', '{"ok":true}'],
    [String.raw`banner "example {\"error\":true}" actual {"ok":true}`, '{"ok":true}'],
  ])("skips quoted prose when requested: %s", (raw, json) => {
    const startIndex = raw.indexOf(json);

    expect(extractBalancedJsonPrefix(raw, { skipQuotedOpeners: true })).toEqual({
      json,
      startIndex,
      endIndex: startIndex + json.length - 1,
    });
  });

  it.each([
    'banner "unterminated prose {"ok":true}',
    '"first {not}" then "unterminated no JSON',
    'banner "{example}"',
  ])("does not invent recovery across ambiguous prose quotes: %s", (raw) => {
    expect(extractBalancedJsonPrefix(raw, { skipQuotedOpeners: true })).toBeNull();
  });

  it("retains object-only selection and offsets across quoted spans", () => {
    const raw = '"{fake}" [0] {"first":1} "use { here" {"second":2}';

    expect(extractBalancedJsonFragments(raw, { openers: ["{"], skipQuotedOpeners: true })).toEqual(
      ['{"first":1}', '{"second":2}'].map((json) => ({
        json,
        startIndex: raw.indexOf(json),
        endIndex: raw.indexOf(json) + json.length - 1,
      })),
    );
  });

  it.each([
    ['prefix "notjson[1]" middle {"a":1}', "[1]"],
    ['prefix {"token": } suffix', '{"token": }'],
    ['banner "unterminated prose {"ok":true}', '{"ok":true}'],
  ])("preserves delimiter-first extraction by default: %s", (raw, json) => {
    const expected = {
      json,
      startIndex: raw.indexOf(json),
      endIndex: raw.indexOf(json) + json.length - 1,
    };

    expect(extractBalancedJsonPrefix(raw)).toEqual(expected);
    expect(extractBalancedJsonPrefix(raw, { skipQuotedOpeners: false })).toEqual(expected);
  });
});
