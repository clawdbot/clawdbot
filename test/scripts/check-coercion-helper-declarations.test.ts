import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditCanonicalCoercionExports,
  auditCoercionHelperDeclarations,
  findBannedCoercionHelperDeclarations,
  findExportedCallableNames,
  isGovernedCoercionHelperPath,
  runCoercionHelperDeclarationGuard,
  type CoercionHelperCarveOut,
  type CoercionHelperDeclaration,
} from "../../scripts/check-coercion-helper-declarations.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("coercion helper declaration AST guard", () => {
  it("finds functions, callable variables, methods, fields, and object properties", () => {
    const source = [
      "export async function readString() {}",
      "const isRecord = (value: unknown) => Boolean(value);",
      "const readOptionalString = normalizeOptionalString;",
      "const optionalString = helpers.readStringValue;",
      "const timestampMs = (((value: unknown) => Number(value)) satisfies ((value: unknown) => number));",
      "class Example {",
      "  readNumber() {}",
      "  asRecord = function () { return {}; };",
      "}",
      "const object = {",
      "  readBoolean: () => true,",
      "};",
      "function normalizeAgentId() {}",
      "const isValidAgentId = () => true;",
    ].join("\n");

    expect(findBannedCoercionHelperDeclarations(source, "src/example.ts")).toEqual([
      { file: "src/example.ts", kind: "function", line: 1, name: "readString" },
      { file: "src/example.ts", kind: "variable", line: 2, name: "isRecord" },
      { file: "src/example.ts", kind: "variable", line: 3, name: "readOptionalString" },
      { file: "src/example.ts", kind: "variable", line: 4, name: "optionalString" },
      { file: "src/example.ts", kind: "variable", line: 5, name: "timestampMs" },
      { file: "src/example.ts", kind: "method", line: 7, name: "readNumber" },
      { file: "src/example.ts", kind: "field", line: 8, name: "asRecord" },
      { file: "src/example.ts", kind: "property", line: 11, name: "readBoolean" },
      { file: "src/example.ts", kind: "function", line: 13, name: "normalizeAgentId" },
      { file: "src/example.ts", kind: "variable", line: 14, name: "isValidAgentId" },
    ]);
  });

  it("ignores imports, non-callable properties, shorthand aliases, callback names, and inert text", () => {
    const source = [
      'import { isRecord, readString as importedReadString } from "./helpers.js";',
      "const alias = isRecord;",
      "const { asRecord } = helpers;",
      "const object = { isRecord, readString: 42, toError: importedToError };",
      "const shorthand = { optionalString };",
      "values.map(function readString(value) { return value; });",
      "const aliasWithInternalName = function isRecord(value) { return value; };",
      "const asRecord = raw as Record<string, unknown>;",
      "const optionalString = value as string;",
      "// function asRecord() {}",
      'const fixture = "function toError() {}";',
    ].join("\n");

    expect(findBannedCoercionHelperDeclarations(source, "src/example.ts")).toEqual([]);
  });

  it("allows one exact declaration and reports duplicate, unowned, and stale entries", () => {
    const declarations: CoercionHelperDeclaration[] = [
      { file: "src/allowed.ts", kind: "function", line: 2, name: "isRecord" },
      { file: "src/allowed.ts", kind: "function", line: 3, name: "isRecord" },
      { file: "src/new.ts", kind: "function", line: 4, name: "readString" },
    ];
    const carveOuts: CoercionHelperCarveOut[] = [
      {
        file: "src/allowed.ts",
        name: "isRecord",
        kind: "function",
        reason: "Dependency-free protocol boundary.",
      },
      {
        file: "src/removed.ts",
        name: "toError",
        kind: "function",
        reason: "Hostile object trap semantics.",
      },
    ];

    expect(auditCoercionHelperDeclarations(declarations, carveOuts)).toEqual({
      excessDeclarations: [
        { file: "src/allowed.ts", kind: "function", line: 3, name: "isRecord" },
        { file: "src/new.ts", kind: "function", line: 4, name: "readString" },
      ],
      invalidCarveOuts: [],
      staleCarveOuts: [
        {
          file: "src/removed.ts",
          name: "toError",
          kind: "function",
          reason: "Hostile object trap semantics.",
        },
      ],
    });
  });

  it.each(["method", "field", "property"] as const)(
    "treats %s drift as both excess and stale function ownership",
    (kind) => {
      const declaration: CoercionHelperDeclaration = {
        file: "src/owner.ts",
        kind,
        line: 3,
        name: "isRecord",
      };
      const carveOut: CoercionHelperCarveOut = {
        file: "src/owner.ts",
        name: "isRecord",
        kind: "function",
        reason: "Exact function owner.",
      };

      expect(auditCoercionHelperDeclarations([declaration], [carveOut])).toEqual({
        excessDeclarations: [declaration],
        invalidCarveOuts: [],
        staleCarveOuts: [carveOut],
      });
    },
  );

  it("rejects duplicate, non-banned, and malformed carve-outs", () => {
    const valid: CoercionHelperCarveOut = {
      file: "src/owner.ts",
      name: "isRecord",
      kind: "function",
      reason: "Exact function owner.",
    };
    const invalid = [
      valid,
      valid,
      {
        ...valid,
        file: "src/not-banned.ts",
        name: "domainParser",
      } as unknown as CoercionHelperCarveOut,
      { ...valid, file: "src/blank.ts", reason: "" },
      {
        ...valid,
        file: "src/kind.ts",
        kind: "getter",
      } as unknown as CoercionHelperCarveOut,
    ];

    expect(auditCoercionHelperDeclarations([], invalid).invalidCarveOuts).toEqual([
      "src/owner.ts [isRecord] is listed more than once",
      "src/not-banned.ts [domainParser] is not a banned helper name",
      "src/blank.ts [isRecord] needs a non-empty reason",
      "src/kind.ts [isRecord] has invalid kind getter",
    ]);
  });

  it("excludes structural fixtures and generated sources without hiding authored fixture-named files", () => {
    expect(isGovernedCoercionHelperPath("src/runtime.ts")).toBe(true);
    expect(isGovernedCoercionHelperPath("extensions/demo/runtime.jsx")).toBe(true);
    expect(isGovernedCoercionHelperPath("src/runtime.d.ts")).toBe(false);
    expect(isGovernedCoercionHelperPath("scripts/runtime.d.mts")).toBe(false);
    expect(isGovernedCoercionHelperPath("test/fixtures/example.ts")).toBe(false);
    expect(isGovernedCoercionHelperPath("extensions/demo/dist/index.js")).toBe(false);
    expect(isGovernedCoercionHelperPath("src/example.test-fixtures.ts")).toBe(true);
    expect(isGovernedCoercionHelperPath("extensions/demo/runtime-tool-fixture.ts")).toBe(true);
    expect(isGovernedCoercionHelperPath("src/schema.generated.ts")).toBe(false);
    expect(isGovernedCoercionHelperPath("ui/src/vendor.bundle.js")).toBe(false);
    expect(
      isGovernedCoercionHelperPath(
        "extensions/browser/chrome-extension/modules/copilot-runtime.js",
      ),
    ).toBe(true);
    expect(isGovernedCoercionHelperPath("root.config.ts")).toBe(true);
    expect(isGovernedCoercionHelperPath(".github/actions/example/index.ts")).toBe(true);
  });

  it("finds directly exported callable declarations and export aliases", () => {
    const source = [
      "export function canonical() {}",
      "function local() {}",
      "export { local as alias };",
      "export const VALUE = 1;",
    ].join("\n");

    expect(findExportedCallableNames(source, "src/owner.ts")).toEqual(["alias", "canonical"]);
  });

  it("reports unclassified exports and stale, duplicate, or blank deferred entries", () => {
    const kept = { file: "src/owner.ts", name: "kept", status: "enforced" } as const;
    const deferredKept = {
      file: "src/owner.ts",
      name: "format",
      status: "deferred",
      reason: "Meaningful public collision.",
    } as const;
    const removed = {
      file: "src/owner.ts",
      name: "removed",
      status: "deferred",
      reason: "Removed owner.",
    } as const;
    const blank = {
      file: "src/other.ts",
      name: "unknown",
      status: "deferred",
      reason: "",
    } as const;
    const audit = auditCanonicalCoercionExports(
      new Map([["src/owner.ts", ["kept", "format", "newHelper"]]]),
      [kept, deferredKept, kept, removed, blank],
    );

    expect(audit.invalidClassifications).toEqual([
      "src/owner.ts [kept] is classified more than once",
      "src/other.ts [unknown] needs a non-empty deferred reason",
    ]);
    expect(audit.unclassifiedExports).toEqual([{ file: "src/owner.ts", name: "newHelper" }]);
    expect(audit.staleClassifications).toEqual([removed, blank]);
  });

  it("scans a temporary repository and reports sorted, owner-specific diagnostics", () => {
    const repoRoot = tempDirs.make("coercion-helper-guard-");
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "extensions", "demo"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "src", "z.ts"), "class Owner { readString() {} }\n");
    fs.writeFileSync(
      path.join(repoRoot, "extensions", "demo", "a.ts"),
      "const asRecord = () => ({});\n",
    );
    fs.writeFileSync(
      path.join(repoRoot, "config", "root.ts"),
      "class Config { normalizeOptionalString() {} }\n",
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(
      runCoercionHelperDeclarationGuard({
        carveOuts: [
          {
            file: "src/z.ts",
            name: "readString",
            kind: "function",
            reason: "Exact function owner.",
          },
        ],
        repoRoot,
        io: {
          stdout: { write: (value) => stdout.push(value) },
          stderr: { write: (value) => stderr.push(value) },
        },
      }),
    ).toBe(1);

    expect(stdout).toEqual([]);
    const output = stderr.join("");
    expect(output.indexOf("config/root.ts:1")).toBeLessThan(
      output.indexOf("extensions/demo/a.ts:1"),
    );
    expect(output.indexOf("extensions/demo/a.ts:1")).toBeLessThan(output.indexOf("src/z.ts:1"));
    expect(output).toContain("Banned local coercion-helper declarations:");
    expect(output).toContain("readString (method declaration)");
    expect(output).toContain("Stale coercion-helper carve-outs:");
    expect(output).toContain(
      "src/z.ts [readString] has no function declaration; remove the carve-out",
    );
    expect(output).toContain(
      "Core/package/UI/workspace-script code: use the matching @openclaw/normalization-core export or module.",
    );
    expect(output).toContain(
      "Bundled plugin production code: use the matching openclaw/plugin-sdk runtime; number-runtime is bundled/private-local, not a third-party typed contract.",
    );
    expect(output).toContain("Dependency-free, copied, generated, or serialized code");
  });

  it("scans only tracked files when the repository has a Git index", () => {
    const repoRoot = tempDirs.make("coercion-helper-tracked-guard-");
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "src", "tracked.ts"), "function readString() {}\n");
    fs.writeFileSync(path.join(repoRoot, "src", "untracked.ts"), "function readNumber() {}\n");
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["add", "src/tracked.ts"], { cwd: repoRoot });
    const stderr: string[] = [];

    expect(
      runCoercionHelperDeclarationGuard({
        carveOuts: [],
        repoRoot,
        io: {
          stdout: { write: () => undefined },
          stderr: { write: (value) => stderr.push(value) },
        },
      }),
    ).toBe(1);

    const output = stderr.join("");
    expect(output).toContain("src/tracked.ts:1 readString");
    expect(output).not.toContain("src/untracked.ts");
    expect(output).not.toContain("readNumber");
  });
});
