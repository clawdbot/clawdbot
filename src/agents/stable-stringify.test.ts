import { describe, expect, it } from "vitest";
import { stableStringify } from "./stable-stringify.js";

describe("stableStringify", () => {
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

  it("serializes cache-trace edge types deterministically", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at test";

    expect(
      stableStringify({
        bytes: new Uint8Array([1, 2, 3]),
        error,
        finite: 1,
        infinity: Infinity,
        nan: Number.NaN,
        nil: null,
        token: 123n,
        undef: undefined,
      }),
    ).toBe(
      '{"bytes":{"data":"AQID","type":"Uint8Array"},"error":{"message":"boom","name":"Error","stack":"Error: boom\\n    at test"},"finite":1,"infinity":"Infinity","nan":"NaN","nil":null,"token":"123","undef":undefined}',
    );
  });
});
