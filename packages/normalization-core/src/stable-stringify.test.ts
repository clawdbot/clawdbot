/**
 * Regression coverage for deterministic unknown-value stringification.
 * Verifies sorted keys, repeated references, cycles, binary data, and errors.
 */
import { describe, expect, it } from "vitest";
import { stableStringify } from "./stable-stringify.js";

const sanitizeSurrogates = (text: string) =>
  text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

describe("stableStringify", () => {
  it.each([
    ['{"z":1,"a":2}', '{"a":2,"z":1}'],
    [
      '{"items":[3,null,{"z":false,"a":1.5}],"enabled":true}',
      '{"enabled":true,"items":[3,null,{"a":1.5,"z":false}]}',
    ],
    ['["text",0,-2.5,null,false]', '["text",0,-2.5,null,false]'],
  ])("preserves deterministic bytes for parsed JSON %#", (json, expected) => {
    expect(stableStringify(JSON.parse(json))).toBe(expected);
  });

  it("sorts object keys recursively", () => {
    expect(stableStringify({ b: { d: 4, c: 3 }, a: 1 })).toBe('{"a":1,"b":{"c":3,"d":4}}');
  });

  it("marks true circular references without collapsing repeated references", () => {
    const shared = { value: 1 };
    const root: Record<string, unknown> = { first: shared, second: shared };
    root.self = root;

    expect(stableStringify(root)).toBe(
      '{"first":{"value":1},"second":{"value":1},"self":"[Circular]"}',
    );
  });

  it("handles circular arrays without treating later siblings as circular", () => {
    const shared = { value: "same" };
    const items: unknown[] = [shared, shared];
    items.push(items);

    expect(stableStringify(items)).toBe('[{"value":"same"},{"value":"same"},"[Circular]"]');
  });

  it("opts into string normalization without changing the lossless default", () => {
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xdc00);
    const value = {
      [`key${high}`]: "name",
      high: `left${high}right`,
      low: `left${low}right`,
      valid: "emoji 🙈 ok",
    };

    expect(stableStringify(value)).toContain("\\ud83d");
    expect(stableStringify(value, sanitizeSurrogates)).toBe(
      '{"high":"leftright","key":"name","low":"leftright","valid":"emoji 🙈 ok"}',
    );
  });

  it("sorts normalized keys before serializing them", () => {
    const high = String.fromCharCode(0xd83d);
    const malformed = { ba: 2, [`b${high}`]: 1 };
    const normalized = { ba: 2, b: 1 };

    expect(stableStringify(malformed, sanitizeSurrogates)).toBe(
      stableStringify(normalized, sanitizeSurrogates),
    );
    expect(stableStringify(malformed, sanitizeSurrogates)).toBe('{"b":1,"ba":2}');
  });

  it("serializes Date instances to ISO 8601 strings and handles Invalid Date", () => {
    const validDate = new Date("2026-01-01T00:00:00.000Z");
    const invalidDate = new Date(Number.NaN);
    expect(stableStringify(validDate)).toBe('"2026-01-01T00:00:00.000Z"');
    expect(stableStringify(invalidDate)).toBe("null");
    expect(stableStringify({ date: validDate })).toBe('{"date":"2026-01-01T00:00:00.000Z"}');
    expect(stableStringify({ date: invalidDate })).toBe('{"date":null}');
  });

  it("serializes RegExp, Set, and Map collections deterministically", () => {
    expect(stableStringify(/abc/gi)).toBe('"/abc/gi"');

    const set1 = new Set([3, 1, 2]);
    const set2 = new Set([1, 2, 3]);
    expect(stableStringify(set1)).toBe("[1,2,3]");
    expect(stableStringify(set1)).toBe(stableStringify(set2));

    const map = new Map<unknown, unknown>([
      [1, "number-one"],
      ["1", "string-one"],
      ["z", 2],
      ["a", 1],
    ]);
    expect(stableStringify(map)).toBe('[["1","string-one"],["a",1],["z",2],[1,"number-one"]]');
  });

  it("serializes cache-trace edge types deterministically", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at test";

    expect(
      stableStringify({
        bytes: new Uint8Array([1, 2, 3]),
        date: new Date("2026-01-01T00:00:00.000Z"),
        error,
        finite: 1,
        infinity: Infinity,
        nan: Number.NaN,
        nil: null,
        token: 123n,
        undef: undefined,
      }),
    ).toBe(
      '{"bytes":{"data":"AQID","type":"Uint8Array"},"date":"2026-01-01T00:00:00.000Z","error":{"message":"boom","name":"Error","stack":"Error: boom\\n    at test"},"finite":1,"infinity":"Infinity","nan":"NaN","nil":null,"token":"123","undef":undefined}',
    );
  });
});
