// Plugin compatibility registry tests cover compatibility metadata loading and validation.
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";
import { listPluginCompatRecords, type PluginCompatCode } from "./registry.js";

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
const removalDatePendingCompatCodes = new Set<PluginCompatCode>([
  "plugin-sdk-tool-plugin-public-demotion",
  "agent-harness-sdk-alias",
]);
const deprecationMarkingCodes = [
  "plugin-sdk-channel-setup-input-fields",
  "plugin-sdk-broad-runtime-barrels",
  "plugin-sdk-provider-owned-helper-shims",
  "message-presentation-legacy-bridges",
  "plugin-sdk-focused-compat-aliases",
  "agent-harness-terminal-result-aliases",
  "official-plugin-export-aliases",
  "memory-host-compatibility-aliases",
  "plugin-runtime-api-compat-aliases",
  "plugin-provider-manifest-compat-aliases",
] as const;
const deprecationMarkingSurfaceCounts: Record<(typeof deprecationMarkingCodes)[number], number> = {
  "plugin-sdk-channel-setup-input-fields": 22,
  "plugin-sdk-broad-runtime-barrels": 12,
  "plugin-sdk-provider-owned-helper-shims": 34,
  "message-presentation-legacy-bridges": 21,
  "plugin-sdk-focused-compat-aliases": 23,
  "agent-harness-terminal-result-aliases": 10,
  "official-plugin-export-aliases": 7,
  "memory-host-compatibility-aliases": 4,
  "plugin-runtime-api-compat-aliases": 27,
  "plugin-provider-manifest-compat-aliases": 9,
};
function expectNonEmptyStringList(values: readonly string[], label: string) {
  expect(values, label).toEqual([expect.stringMatching(/\S/u), ...values.slice(1)]);
  for (const value of values) {
    expect(value, label).toMatch(/\S/u);
  }
}

function listTrackedSourceFiles(): string[] {
  const files = listGitTrackedFiles({ pathspecs: sourceRootsForDeprecatedCallGuard });
  if (!files) {
    throw new Error("unable to list tracked source files for the deprecated-call guard");
  }
  return files.filter((file) => /\.(?:ts|tsx|mts|cts)$/u.test(file));
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
        if (record.removalGate !== undefined) {
          expect(record.removalGate, record.code).toBe("next-plugin-sdk-major");
          expect(record.removeAfter, record.code).toBeUndefined();
        } else if (removalDatePendingCompatCodes.has(record.code)) {
          expect(record.removeAfter, record.code).toBeUndefined();
        } else {
          expect(record.removeAfter, record.code).toMatch(datePattern);
        }
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

  it("keeps blocked public SDK removals aligned with their actual gates", () => {
    const records = new Map(listPluginCompatRecords().map((record) => [record.code, record]));
    const staleRemovalWindows = [...records.values()].filter(
      (record) =>
        record.status === "removal-pending" &&
        record.removeAfter !== undefined &&
        record.removeAfter <= "2026-07-30",
    );

    expect(staleRemovalWindows).toEqual([]);
    expect(records.get("plugin-sdk-media-understanding-public-demotion")).toMatchObject({
      status: "removal-pending",
      removeAfter: "2026-09-30",
    });
    expect(records.get("plugin-sdk-memory-host-core-public-demotion")).toMatchObject({
      status: "removal-pending",
      removeAfter: "2026-09-30",
    });
    expect(records.get("plugin-sdk-plugin-config-runtime-public-demotion")).toMatchObject({
      status: "removal-pending",
      removeAfter: "2026-12-01",
    });
    for (const code of removalDatePendingCompatCodes) {
      expect(records.get(code)).toMatchObject({ status: "deprecated" });
      expect(records.get(code)?.removeAfter).toBeUndefined();
      expect(records.get(code)?.replacement).toMatch(/retain/u);
    }
    expect(records.get("plugin-sdk-inbound-reply-dispatch-subpath")).toMatchObject({
      status: "deprecated",
      removalGate: "next-plugin-sdk-major",
      removeAfter: undefined,
    });
    expect(records.get("agent-harness-sdk-alias")?.surfaces).toEqual([
      "openclaw/plugin-sdk/agent-harness",
      "openclaw/plugin-sdk/agent-harness-runtime",
    ]);
  });

  it("tracks the deprecation-marking families through the approved window", () => {
    const records = new Map(listPluginCompatRecords().map((record) => [record.code, record]));

    expect(deprecationMarkingCodes.map((code) => records.get(code)?.code)).toEqual(
      deprecationMarkingCodes,
    );
    for (const code of deprecationMarkingCodes) {
      expect(records.get(code)).toMatchObject({
        status: "deprecated",
        deprecated: "2026-07-25",
        warningStarts: "2026-07-25",
        removeAfter: "2026-10-01",
      });
      expect(records.get(code)?.surfaces, code).toHaveLength(deprecationMarkingSurfaceCounts[code]);
    }
    expect(records.get("plugin-sdk-broad-runtime-barrels")?.surfaces).toEqual(
      expect.arrayContaining([
        "openclaw/plugin-sdk/agent-runtime",
        "openclaw/plugin-sdk/agent-runtime loadModelCatalog params.useCache",
        "openclaw/plugin-sdk/agent-runtime loadModelCatalog params.cacheOnly",
        "openclaw/plugin-sdk/agent-runtime loadModelCatalog params.metadataSnapshot",
        "openclaw/plugin-sdk/agent-runtime loadModelCatalog",
        "openclaw/plugin-sdk/cli-runtime",
        "openclaw/plugin-sdk/conversation-runtime",
        "openclaw/plugin-sdk/hook-runtime",
        "openclaw/plugin-sdk/media-runtime",
        "openclaw/plugin-sdk/media-runtime buildAgentMediaPayload",
        "openclaw/plugin-sdk/plugin-runtime",
        "openclaw/plugin-sdk/security-runtime",
      ]),
    );
    expect(records.get("deprecated-session-store-beta5-api")?.surfaces).toEqual(
      expect.arrayContaining([
        "openclaw package root loadSessionStore",
        "openclaw package root saveSessionStore",
      ]),
    );
  });

  it("tracks the context-engine legacy host-param default through its two-week window", () => {
    const record = listPluginCompatRecords().find(
      (candidate) => candidate.code === "context-engine-legacy-host-param-default",
    );

    expect(record).toMatchObject({
      status: "deprecated",
      deprecated: "2026-07-29",
      warningStarts: "2026-07-29",
      removeAfter: "2026-08-12",
    });
  });

  it("keeps deprecated explicit target parser calls inside compatibility shims", () => {
    expect(deprecatedTargetParserOffenders).toEqual([]);
  });
});
