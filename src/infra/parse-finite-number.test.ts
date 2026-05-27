import { describe, expect, it } from "vitest";
import {
  parseFiniteNumber,
  parseStrictFiniteNumber,
  parseStrictInteger,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "./parse-finite-number.js";

function expectParserCases<T>(
  parse: (value: unknown) => T | undefined,
  cases: Array<{ value: unknown; expected: T | undefined }>,
) {
  for (const { value, expected } of cases) {
    expect(parse(value)).toBe(expected);
  }
}

describe("parseFiniteNumber", () => {
  it("parses finite values and rejects invalid inputs", () => {
    expectParserCases(parseFiniteNumber, [
      { value: 42, expected: 42 },
      { value: "3.14", expected: 3.14 },
      { value: " 3.14ms", expected: 3.14 },
      { value: "+7", expected: 7 },
      { value: "1e3", expected: 1000 },
      { value: Number.NaN, expected: undefined },
      { value: Number.POSITIVE_INFINITY, expected: undefined },
      { value: "not-a-number", expected: undefined },
      { value: " ", expected: undefined },
      { value: "", expected: undefined },
      { value: null, expected: undefined },
    ]);
  });
});

describe("parseStrictInteger", () => {
  it("parses strict integers and rejects non-integers", () => {
    expectParserCases(parseStrictInteger, [
      { value: "42", expected: 42 },
      { value: " -7 ", expected: -7 },
      { value: 12, expected: 12 },
      { value: "+9", expected: 9 },
      { value: "42ms", expected: undefined },
      { value: "0abc", expected: undefined },
      { value: "1.5", expected: undefined },
      { value: "1e3", expected: undefined },
      { value: " ", expected: undefined },
      { value: Number.MAX_SAFE_INTEGER + 1, expected: undefined },
    ]);
  });
});

describe("parseStrictFiniteNumber", () => {
  it("parses full finite numbers and rejects partial tokens", () => {
    expectParserCases(parseStrictFiniteNumber, [
      { value: "42", expected: 42 },
      { value: "3.14", expected: 3.14 },
      { value: ".5", expected: 0.5 },
      { value: "1e3", expected: 1000 },
      { value: "3.14ms", expected: undefined },
      { value: "0abc", expected: undefined },
      { value: "0x10", expected: undefined },
      { value: " ", expected: undefined },
      { value: Number.POSITIVE_INFINITY, expected: undefined },
    ]);
  });
});

describe("parseStrictPositiveInteger", () => {
  it("enforces positive integers", () => {
    expectParserCases(parseStrictPositiveInteger, [
      { value: "9", expected: 9 },
      { value: "0", expected: undefined },
      { value: "-1", expected: undefined },
    ]);
  });
});

describe("parseStrictNonNegativeInteger", () => {
  it("allows zero and positive integers only", () => {
    expectParserCases(parseStrictNonNegativeInteger, [
      { value: "0", expected: 0 },
      { value: "9", expected: 9 },
      { value: "-1", expected: undefined },
    ]);
  });
});
