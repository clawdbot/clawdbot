// Plugin compatibility registry tests cover compatibility metadata loading and validation.
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";
import { listPluginCompatRecords } from "./registry.js";

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const sourceRootsForDeprecatedCallGuard = [
  "src",
  "extensions",
  "packages",
  "test",
  "scripts",
] as const;
const deprecatedTargetParserCallPattern =
  /\.parseExplicitTarget\?\.\s*\(|parseExplicitTargetFor(?:Channel|LoadedChannel)\s*\(|resolveRouteTargetFor(?:Channel|LoadedChannel)\s*\(/u;
const deprecatedTargetParserCompatFiles = new Set([
  "src/auto-reply/reply/group-id.ts",
  "src/channels/plugins/target-parsing-loaded.ts",
  "src/channels/plugins/target-parsing.test.ts",
  "src/infra/outbound/outbound-session.ts",
  "src/infra/outbound/outbound-session.test-helpers.ts",
  "src/plugins/compat/registry.test.ts",
]);

function expectNonEmptyStringList(values: readonly string[], label: string) {
  expect(values, label).toEqual([expect.stringMatching(/\S/u), ...values.slice(1)]);
  for (const value of values) {
    expect(value, label).toMatch(/\S/u);
  }
}

function listTrackedSourceFiles(): string[] {
  return (listGitTrackedFiles({ pathspecs: sourceRootsForDeprecatedCallGuard }) ?? []).filter(
    (file) => /\.(?:ts|tsx|mts|cts)$/u.test(file),
  );
}

describe("plugin compatibility registry", () => {
  let deprecatedTargetParserOffenders: string[] = [];

  beforeAll(() => {
    deprecatedTargetParserOffenders = listTrackedSourceFiles()
      .filter((file) => !deprecatedTargetParserCompatFiles.has(file))
      .filter((file) => deprecatedTargetParserCallPattern.test(fs.readFileSync(file, "utf8")));
  });

  it("keeps every record actionable", () => {
    for (const record of listPluginCompatRecords()) {
      expect(record.introduced, record.code).toMatch(datePattern);
      expect(record.docsPath, record.code).toMatch(/^\//u);
      if (record.status === "deprecated") {
        expect(record.replacement, record.code).toMatch(/\S/u);
      }
      expectNonEmptyStringList(record.surfaces, `${record.code}: surfaces`);
      expectNonEmptyStringList(record.diagnostics, `${record.code}: diagnostics`);
      expectNonEmptyStringList(record.tests, `${record.code}: tests`);
      for (const testPath of record.tests) {
        expect(fs.existsSync(testPath), `${record.code}: ${testPath}`).toBe(true);
      }
    }
  });

  it("keeps loaded target compatibility surfaces exported during their removal windows", () => {
    const source = fs.readFileSync("src/channels/plugins/target-parsing-loaded.ts", "utf8");
    expect(source).toMatch(/export type \{ ChannelRouteParsedTarget \}/u);
    for (const symbol of [
      "ParsedChannelExplicitTarget",
      "ComparableChannelTarget",
      "parseExplicitTargetForLoadedChannel",
      "resolveRouteTargetForLoadedChannel",
      "resolveComparableTargetForLoadedChannel",
      "comparableChannelTargetsMatch",
      "comparableChannelTargetsShareRoute",
    ]) {
      expect(source).toMatch(new RegExp(`export (?:type|function) ${symbol}\\b`, "u"));
    }
  });
  it("keeps deprecated explicit target parser calls inside compatibility shims", () => {
    expect(deprecatedTargetParserOffenders).toEqual([]);
  });
});
