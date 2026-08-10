import { describe, expect, it } from "vitest";
import {
  auditCoercionHelperDeclarations,
  findBannedCoercionHelperDeclarations,
  isGovernedCoercionHelperPath,
  type CoercionHelperCarveOut,
  type CoercionHelperDeclaration,
} from "../../scripts/check-coercion-helper-declarations.mts";

describe("coercion helper declaration AST guard", () => {
  it("finds nested, exported, async, and callable-variable declarations", () => {
    const source = [
      "export async function readString() {}",
      "if (true) {",
      "  function asRecord() {}",
      "}",
      "const isRecord = (value: unknown) => Boolean(value);",
      "let toError = function (value: unknown) { return value; };",
      "var optionalString = async (value: unknown) => value;",
      "const readString = (((value: unknown) => String(value)) satisfies ((value: unknown) => string));",
      "function readNumber(record: Record<string, unknown>, key: string) { return record[key]; }",
      "const timestampMs = (value: unknown) => Number(value);",
      "function readBoolean() {}",
      "function readOptionalString() {}",
      "function normalizeString() {}",
      "const asString = (value: unknown) => String(value);",
      "function asObject() {}",
      "const readOptionalString = normalizeOptionalString;",
      "const optionalString = helpers.readStringValue;",
      "const asObject = helpers.asOptionalRecord;",
    ].join("\n");

    expect(findBannedCoercionHelperDeclarations(source, "src/example.ts")).toEqual([
      { file: "src/example.ts", kind: "function", line: 1, name: "readString" },
      { file: "src/example.ts", kind: "function", line: 3, name: "asRecord" },
      { file: "src/example.ts", kind: "variable", line: 5, name: "isRecord" },
      { file: "src/example.ts", kind: "variable", line: 6, name: "toError" },
      { file: "src/example.ts", kind: "variable", line: 7, name: "optionalString" },
      { file: "src/example.ts", kind: "variable", line: 8, name: "readString" },
      { file: "src/example.ts", kind: "function", line: 9, name: "readNumber" },
      { file: "src/example.ts", kind: "variable", line: 10, name: "timestampMs" },
      { file: "src/example.ts", kind: "function", line: 11, name: "readBoolean" },
      { file: "src/example.ts", kind: "function", line: 12, name: "readOptionalString" },
      { file: "src/example.ts", kind: "function", line: 13, name: "normalizeString" },
      { file: "src/example.ts", kind: "variable", line: 14, name: "asString" },
      { file: "src/example.ts", kind: "function", line: 15, name: "asObject" },
      { file: "src/example.ts", kind: "variable", line: 16, name: "readOptionalString" },
      { file: "src/example.ts", kind: "variable", line: 17, name: "optionalString" },
      { file: "src/example.ts", kind: "variable", line: 18, name: "asObject" },
    ]);
  });

  it("ignores imports, aliases, methods, properties, callbacks, and inert text", () => {
    const source = [
      'import { isRecord, readString as importedReadString } from "./helpers.js";',
      "const alias = isRecord;",
      "const { asRecord } = helpers;",
      "class Example { isRecord() {} readString = () => true; }",
      "const object = { optionalString() {}, toError: () => new Error() };",
      "values.map(function readString(value) { return value; });",
      "const aliasWithInternalName = function isRecord(value) { return value; };",
      "const asRecord = raw as Record<string, unknown>;",
      "const optionalString = value as string;",
      "// function asRecord() {}",
      'const fixture = "function toError() {}";',
    ].join("\n");

    expect(findBannedCoercionHelperDeclarations(source, "src/example.ts")).toEqual([]);
  });

  it("checks exact counts and rejects excess, stale, or malformed carve-outs", () => {
    const declarations: CoercionHelperDeclaration[] = [
      { file: "src/allowed.ts", kind: "function", line: 2, name: "isRecord" },
      { file: "src/allowed.ts", kind: "variable", line: 8, name: "isRecord" },
      { file: "src/new.ts", kind: "function", line: 4, name: "readString" },
    ];
    const carveOuts: CoercionHelperCarveOut[] = [
      {
        file: "src/allowed.ts",
        name: "isRecord",
        count: 1,
        reason: "Dependency-free protocol boundary.",
      },
      {
        file: "src/removed.ts",
        name: "toError",
        count: 1,
        reason: "Hostile object trap semantics.",
      },
      { file: "src/blank.ts", name: "asRecord", count: 0, reason: "" },
    ];

    expect(auditCoercionHelperDeclarations(declarations, carveOuts)).toEqual({
      excessDeclarations: [
        { file: "src/allowed.ts", kind: "variable", line: 8, name: "isRecord" },
        { file: "src/new.ts", kind: "function", line: 4, name: "readString" },
      ],
      invalidCarveOuts: [
        "src/blank.ts [asRecord] must have a positive count",
        "src/blank.ts [asRecord] needs a non-empty reason",
      ],
      staleCarveOuts: [
        {
          file: "src/removed.ts",
          name: "toError",
          count: 1,
          reason: "Hostile object trap semantics.",
          actualCount: 0,
          lines: [],
        },
      ],
    });
  });

  it("excludes declarations, fixtures, generated sources, and browser bundles", () => {
    expect(isGovernedCoercionHelperPath("src/runtime.ts")).toBe(true);
    expect(isGovernedCoercionHelperPath("extensions/demo/runtime.jsx")).toBe(true);
    expect(isGovernedCoercionHelperPath("src/runtime.d.ts")).toBe(false);
    expect(isGovernedCoercionHelperPath("scripts/runtime.d.mts")).toBe(false);
    expect(isGovernedCoercionHelperPath("test/fixtures/example.ts")).toBe(false);
    expect(isGovernedCoercionHelperPath("extensions/demo/dist/index.js")).toBe(false);
    expect(isGovernedCoercionHelperPath("src/example.test-fixtures.ts")).toBe(false);
    expect(isGovernedCoercionHelperPath("src/schema.generated.ts")).toBe(false);
    expect(isGovernedCoercionHelperPath("ui/src/vendor.bundle.js")).toBe(false);
    expect(
      isGovernedCoercionHelperPath(
        "extensions/browser/chrome-extension/modules/copilot-runtime.js",
      ),
    ).toBe(false);
  });
});
