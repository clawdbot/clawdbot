// Plugin compatibility registry tests cover compatibility metadata loading and validation.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { listPluginCompatRecords, type PluginCompatCode } from "./registry.js";

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const removalDatePendingCompatCodes = new Set<PluginCompatCode>([
  "plugin-sdk-tool-plugin-public-demotion",
  "agent-harness-sdk-alias",
  "plugin-sdk-shipped-channel-setup-exports",
]);
const retiredPluginSdkSubpathCodes = [
  "plugin-sdk-channel-streaming-subpath",
  "plugin-sdk-text-runtime-subpath",
  "plugin-sdk-channel-secret-runtime-subpath",
  "plugin-sdk-agent-config-primitives-subpath",
  "plugin-sdk-matrix-subpath",
  "plugin-sdk-channel-logging-subpath",
  "plugin-sdk-group-access-subpath",
  "plugin-sdk-zod-subpath",
] as const satisfies readonly PluginCompatCode[];
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
  "plugin-sdk-provider-owned-helper-shims": 31,
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

describe("plugin compatibility registry", () => {
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
        record.removeAfter <= "2026-09-02",
    );

    expect(staleRemovalWindows).toEqual([]);
    for (const code of [
      "plugin-sdk-config-runtime-subpath",
      "plugin-sdk-channel-reply-pipeline-subpath",
      "plugin-sdk-infra-runtime-subpath",
      "plugin-sdk-channel-lifecycle-subpath",
      "plugin-sdk-channel-message-subpath",
    ] as const satisfies readonly PluginCompatCode[]) {
      const record = records.get(code);
      expect(record).toMatchObject({
        status: "removal-pending",
        deprecated: "2026-07-06",
        warningStarts: "2026-07-06",
        removeAfter: "2026-10-01",
        docsPath: "/plugins/sdk-migration",
      });
      expect(record?.replacement).toMatch(
        /retain until supported external plugin migration is verified/u,
      );
    }

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

  it("keeps retired Plugin SDK subpaths as migration tombstones", () => {
    const records = new Map(listPluginCompatRecords().map((record) => [record.code, record]));

    for (const code of retiredPluginSdkSubpathCodes) {
      expect(records.get(code)).toMatchObject({
        status: "removed",
        releaseNote: expect.stringMatching(/\S/u),
      });
      expect(records.get(code)?.removeAfter, code).toBeUndefined();
    }
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

  it("keeps the removed context-engine host-param default as a migration tombstone", () => {
    const record = listPluginCompatRecords().find(
      (candidate) => candidate.code === "context-engine-legacy-host-param-default",
    );

    expect(record).toMatchObject({
      status: "removed",
      replacement:
        "`ContextEngineInfo.acceptedHostParams` for restricted projection; omitted declarations receive full host params",
    });
    expect(record?.removeAfter).toBeUndefined();
  });

  it("keeps the removed deactivate hook alias as a migration tombstone", () => {
    const record = listPluginCompatRecords().find(
      (candidate) => candidate.code === "legacy-deactivate-hook-alias",
    );

    expect(record).toMatchObject({
      status: "removed",
      replacement: "`gateway_stop` hook",
    });
    expect(record?.removeAfter).toBeUndefined();
  });

  it("keeps the removed subagent spawning hook as a migration tombstone", () => {
    const record = listPluginCompatRecords().find(
      (candidate) => candidate.code === "legacy-subagent-spawning-hook",
    );

    expect(record).toMatchObject({
      status: "removed",
      replacement:
        "`subagent_spawned` for post-launch observation; core session-binding adapters for thread routing",
    });
    expect(record?.removeAfter).toBeUndefined();
  });

  it("keeps the removed embedded Pi aliases as a migration tombstone", () => {
    const record = listPluginCompatRecords().find(
      (candidate) => candidate.code === "embedded-pi-agent-sdk-aliases",
    );

    expect(record).toMatchObject({
      status: "removed",
      replacement: "`runEmbeddedAgent` and `EmbeddedAgent*` SDK/runtime names",
    });
    expect(record?.removeAfter).toBeUndefined();
  });

  it("keeps shipped channel setup exports until published packages migrate", () => {
    const record = listPluginCompatRecords().find(
      (candidate) => candidate.code === "plugin-sdk-shipped-channel-setup-exports",
    );

    expect(record).toMatchObject({
      status: "deprecated",
      replacement:
        "retain until supported published packages migrate to plugin-owned config schemas plus generic `openclaw/plugin-sdk/channel-config-schema` and `openclaw/plugin-sdk/setup-runtime` primitives",
    });
    expect(record?.removeAfter).toBeUndefined();
  });

  it("keeps the removed memory embedding registrar as a migration tombstone", () => {
    const record = listPluginCompatRecords().find(
      (candidate) => candidate.code === "deprecated-memory-embedding-provider-api",
    );

    expect(record).toMatchObject({
      status: "removed",
      replacement: "`api.registerEmbeddingProvider(...)` and `contracts.embeddingProviders`",
    });
    expect(record?.removeAfter).toBeUndefined();
  });

  it("keeps removed WhatsApp inbound aliases as migration tombstones", () => {
    const records = new Map(listPluginCompatRecords().map((record) => [record.code, record]));

    for (const code of [
      "whatsapp-web-inbound-flat-message-aliases",
      "whatsapp-web-inbound-admission-top-level-fields",
    ] as const) {
      expect(records.get(code)).toMatchObject({
        status: "removed",
        releaseNote: expect.stringMatching(/\S/u),
      });
      expect(records.get(code)?.removeAfter).toBeUndefined();
    }
  });

  it("keeps removed channel target compatibility as migration tombstones", () => {
    const records = new Map(listPluginCompatRecords().map((record) => [record.code, record]));

    for (const code of [
      "channel-explicit-target-parser",
      "channel-messaging-targets-subpath",
    ] as const) {
      expect(records.get(code)).toMatchObject({
        status: "removed",
        releaseNote: expect.stringMatching(/\S/u),
      });
      expect(records.get(code)?.removeAfter).toBeUndefined();
    }
  });
});
