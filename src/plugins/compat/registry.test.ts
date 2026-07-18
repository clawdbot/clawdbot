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
  "src/infra/outbound/outbound-session.ts",
  "src/infra/outbound/outbound-session.test-helpers.ts",
  "src/plugins/compat/registry.test.ts",
]);
const publicSdkContractNarrowingTiers = [
  {
    name: "fully unused subpath",
    codeSuffix: "-unused-subpath",
    count: 5,
    replacement: "none needed — no known consumers; the subpath is removed without successor",
    releaseNote: /no known consumers.*removal without a successor/u,
  },
  {
    name: "bundled-only public export",
    codeSuffix: "-public-demotion",
    count: 157,
    replacement:
      "subpath becomes internal (private-local-only); no external successor — no known external consumers",
    releaseNote: /public export.*module stays available for bundled plugins.*private-local-only/u,
  },
] as const;

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
        expect(record.deprecated, record.code).toMatch(datePattern);
        expect(record.warningStarts, record.code).toMatch(datePattern);
        expect(record.removeAfter, record.code).toMatch(datePattern);
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

  it.each(publicSdkContractNarrowingTiers)(
    "keeps the $name tier on its registry-backed window",
    ({ codeSuffix, count, replacement, releaseNote }) => {
      const records = listPluginCompatRecords().filter((record) =>
        record.code.endsWith(codeSuffix),
      );

      expect(records).toHaveLength(count);
      for (const record of records) {
        expect(record).toMatchObject({
          status: "deprecated",
          owner: "sdk",
          introduced: "2026-07-15",
          deprecated: "2026-07-15",
          warningStarts: "2026-07-15",
          removeAfter: "2026-07-30",
          replacement,
          docsPath: "/plugins/sdk-migration",
        });
        expect(record.surfaces).toEqual([expect.stringMatching(/^openclaw\/plugin-sdk\//u)]);
        expect(record.releaseNote).toMatch(releaseNote);
      }
    },
  );

  it("keeps deprecated explicit target parser calls inside compatibility shims", () => {
    expect(deprecatedTargetParserOffenders).toEqual([]);
  });
});
