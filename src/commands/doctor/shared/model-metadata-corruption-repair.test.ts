import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ConfigAuditRecord } from "../../../config/io.audit.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { repairGeneratedModelMetadataCorruption } from "./model-metadata-corruption-repair.js";

const configPath = path.resolve("/tmp/openclaw-model-metadata-corruption.json");

function corruptedConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          models: [
            {
              id: "gpt-5.6-sol",
              name: "gpt-5.6-sol",
              contextWindow: 272_000,
              contextTokens: 272_000,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 8192,
              api: "openai-chatgpt-responses",
            },
          ],
        },
      },
    },
  };
}

function writeRecord(
  overrides: Partial<Extract<ConfigAuditRecord, { event: "config.write" }>> = {},
): ConfigAuditRecord {
  return {
    ts: "2026-08-28T00:00:00.000Z",
    source: "config-io",
    event: "config.write",
    result: "rename",
    configPath,
    pid: 1,
    ppid: 0,
    cwd: "/tmp",
    argv: ["openclaw", "update", "finalize", "--yes", "--channel", "dev"],
    execArgv: [],
    watchMode: false,
    watchSession: null,
    watchCommand: null,
    existsBefore: true,
    previousHash: "before",
    nextHash: "current",
    previousBytes: 100,
    nextBytes: 200,
    previousDev: null,
    nextDev: null,
    previousIno: null,
    nextIno: null,
    previousMode: null,
    nextMode: null,
    previousNlink: null,
    nextNlink: null,
    previousUid: null,
    nextUid: null,
    previousGid: null,
    nextGid: null,
    changedPathCount: 96,
    changedPaths: [
      "models.providers.openai.models[0].reasoning",
      "models.providers.openai.models[0].input",
      "models.providers.openai.models[0].cost",
      "models.providers.openai.models[0].maxTokens",
      "…+92 more",
    ],
    hasMetaBefore: true,
    hasMetaAfter: true,
    gatewayModeBefore: "local",
    gatewayModeAfter: "local",
    suspicious: [],
    ...overrides,
  };
}

describe("repairGeneratedModelMetadataCorruption", () => {
  it("removes only the audit-proven generic fallback quartet", () => {
    const config = corruptedConfig();
    const result = repairGeneratedModelMetadataCorruption({
      config,
      authoredRoot: structuredClone(config),
      configPath,
      currentHash: "current",
      auditRecords: [writeRecord()],
    });

    const model = result.config.models?.providers?.openai?.models[0];
    expect(model).toMatchObject({
      id: "gpt-5.6-sol",
      name: "gpt-5.6-sol",
      api: "openai-chatgpt-responses",
      contextWindow: 272_000,
      contextTokens: 272_000,
    });
    for (const field of ["reasoning", "input", "cost", "maxTokens"]) {
      expect(model).not.toHaveProperty(field);
    }
    expect(result.changes).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it.each([
    { name: "no audit", auditRecords: [] },
    { name: "different final hash", auditRecords: [writeRecord({ nextHash: "older" })] },
    { name: "failed write", auditRecords: [writeRecord({ result: "failed", nextHash: null })] },
    {
      name: "different config path",
      auditRecords: [writeRecord({ configPath: `${configPath}.x` })],
    },
    {
      name: "no candidate metadata paths",
      auditRecords: [writeRecord({ changedPathCount: 1, changedPaths: ["update.channel"] })],
    },
    {
      name: "only unrelated model metadata paths",
      auditRecords: [
        writeRecord({
          changedPaths: [
            "models.providers.anthropic.models[0].reasoning",
            "models.providers.anthropic.models[0].input",
            "models.providers.ollama.models[0].cost",
            "models.providers.ollama.models[0].maxTokens",
            "…+92 more",
          ],
        }),
      ],
    },
  ])("warns without changing an exact fingerprint with $name", ({ auditRecords }) => {
    const config = corruptedConfig();
    const result = repairGeneratedModelMetadataCorruption({
      config,
      authoredRoot: structuredClone(config),
      configPath,
      currentHash: "current",
      auditRecords,
    });

    expect(result.config).toEqual(config);
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("left unchanged");
  });

  it("does not diagnose a partial fallback tuple as historical corruption", () => {
    const config = corruptedConfig();
    const model = config.models?.providers?.openai?.models[0];
    if (!model) {
      throw new Error("missing model fixture");
    }
    Reflect.deleteProperty(model, "cost");
    const result = repairGeneratedModelMetadataCorruption({
      config,
      authoredRoot: structuredClone(config),
      configPath,
      currentHash: "current",
      auditRecords: [writeRecord()],
    });

    expect(result).toEqual({ config, changes: [], warnings: [] });
  });

  it("does not diagnose a custom model absent from the shipped catalog", () => {
    const config = corruptedConfig();
    const model = config.models?.providers?.openai?.models[0];
    if (!model) {
      throw new Error("missing model fixture");
    }
    model.id = "custom-sol";
    const result = repairGeneratedModelMetadataCorruption({
      config,
      authoredRoot: structuredClone(config),
      configPath,
      currentHash: "current",
      auditRecords: [writeRecord()],
    });

    expect(result).toEqual({ config, changes: [], warnings: [] });
  });

  it("preserves an audit-matched override on a custom route", () => {
    const config = corruptedConfig();
    const provider = config.models?.providers?.openai;
    if (!provider) {
      throw new Error("missing provider fixture");
    }
    provider.api = "openai-responses";
    provider.baseUrl = "https://proxy.example.test/v1";
    const result = repairGeneratedModelMetadataCorruption({
      config,
      authoredRoot: structuredClone(config),
      configPath,
      currentHash: "current",
      auditRecords: [writeRecord()],
    });

    expect(result.config).toEqual(config);
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("configured API route is not owned");
  });

  it("does not rewrite metadata that is not directly authored in the root config", () => {
    const config = corruptedConfig();
    const result = repairGeneratedModelMetadataCorruption({
      config,
      authoredRoot: { models: { $include: "models.json" } },
      configPath,
      currentHash: "current",
      auditRecords: [writeRecord()],
    });

    expect(result.config).toEqual(config);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});
