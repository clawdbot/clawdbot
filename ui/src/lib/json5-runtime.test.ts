// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseJson5Text, warmJson5 } from "./json5-runtime.ts";

const COMMENTED = '// comment\n{\n  "a": 1, // trailing\n}\n';

describe("json5 runtime boundary", () => {
  it("parses strict JSON on the fast path", () => {
    expect(parseJson5Text('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses JSON5 text once the module is warmed", async () => {
    await warmJson5();
    expect(parseJson5Text(COMMENTED)).toEqual({ a: 1 });
  });
});
