import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  buildAgentModelCatalogCacheKey,
  readCachedAgentModelCatalog,
  readCachedAgentModelCatalogSnapshot,
  writeCachedAgentModelCatalog,
} from "./model-catalog-state-cache.js";

let envSnapshot: ReturnType<typeof captureEnv>;
let stateDir: string;

function configuredModel(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"] as Array<"text">,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

describe("model catalog state cache", () => {
  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    stateDir = mkdtempSync(join(tmpdir(), "openclaw-model-catalog-state-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("writes and reads agent catalog rows from shared state", () => {
    const entries = [{ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" }];

    writeCachedAgentModelCatalog({
      agentDir: "/agent/main",
      catalogKey: "catalog-key",
      entries,
      nowMs: 1_000,
    });

    expect(
      readCachedAgentModelCatalog({
        agentDir: "/agent/main",
        catalogKey: "catalog-key",
        nowMs: 1_000,
      }),
    ).toEqual(entries);
  });

  it("round-trips physical route variants atomically", () => {
    const entries = [{ provider: "openai", id: "gpt-5.4-nano", name: "Platform" }];
    const routeVariants = [
      { ...entries[0], api: "openai-responses" },
      { ...entries[0], name: "ChatGPT", api: "openai-chatgpt-responses" },
    ];
    writeCachedAgentModelCatalog({
      agentDir: "/agent/main",
      catalogKey: "variant-key",
      entries,
      routeVariants,
      nowMs: 1_000,
    });

    expect(
      readCachedAgentModelCatalogSnapshot({
        agentDir: "/agent/main",
        catalogKey: "variant-key",
        nowMs: 1_000,
      }),
    ).toEqual({ entries, routeVariants });
  });

  it("treats legacy entry-only cache rows as a provenance miss", () => {
    writeCachedAgentModelCatalog({
      agentDir: "/agent/main",
      catalogKey: "legacy-key",
      entries: [{ provider: "openai", id: "gpt-5.4-nano", name: "Collapsed" }],
      nowMs: 1_000,
    });

    expect(
      readCachedAgentModelCatalogSnapshot({
        agentDir: "/agent/main",
        catalogKey: "legacy-key",
        nowMs: 1_000,
      }),
    ).toBeUndefined();
  });

  it("rejects stale or mismatched agent catalog rows", () => {
    writeCachedAgentModelCatalog({
      agentDir: "/agent/main",
      catalogKey: "catalog-key",
      entries: [{ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" }],
      nowMs: 1_000,
    });

    expect(
      readCachedAgentModelCatalog({
        agentDir: "/agent/other",
        catalogKey: "catalog-key",
        nowMs: 1_000,
      }),
    ).toBeUndefined();
    expect(
      readCachedAgentModelCatalog({
        agentDir: "/agent/main",
        catalogKey: "catalog-key",
        nowMs: 31 * 60 * 1_000,
      }),
    ).toBeUndefined();
  });

  it("prunes expired agent catalog rows on write", () => {
    const expiredEntries = [{ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" }];
    writeCachedAgentModelCatalog({
      agentDir: "/agent/main",
      catalogKey: "expired-key",
      entries: expiredEntries,
      nowMs: 1_000,
    });

    writeCachedAgentModelCatalog({
      agentDir: "/agent/main",
      catalogKey: "fresh-key",
      entries: [{ provider: "openai", id: "gpt-5.6", name: "GPT-5.6" }],
      nowMs: 31 * 60 * 1_000,
    });

    expect(
      readCachedAgentModelCatalog({
        agentDir: "/agent/main",
        catalogKey: "expired-key",
        nowMs: 1_000,
      }),
    ).toBeUndefined();
    expect(
      readCachedAgentModelCatalog({
        agentDir: "/agent/main",
        catalogKey: "fresh-key",
        nowMs: 31 * 60 * 1_000,
      }),
    ).toEqual([{ provider: "openai", id: "gpt-5.6", name: "GPT-5.6" }]);
  });

  it("builds stable keys that change with relevant catalog inputs", () => {
    const base = buildAgentModelCatalogCacheKey({
      agentDir: "/agent/main",
      workspaceDir: "/workspace",
      config: {
        models: {
          providers: {
            openai: { baseUrl: "https://api.openai.com/v1", models: [configuredModel("gpt-5.5")] },
          },
        },
      },
      metadataSnapshot: {
        policyHash: "policy",
        configFingerprint: "config",
        index: { policyHash: "policy", plugins: [] },
        plugins: [],
      } as never,
    });
    const same = buildAgentModelCatalogCacheKey({
      agentDir: "/agent/main",
      workspaceDir: "/workspace",
      config: {
        models: {
          providers: {
            openai: { baseUrl: "https://api.openai.com/v1", models: [configuredModel("gpt-5.5")] },
          },
        },
      },
      metadataSnapshot: {
        policyHash: "policy",
        configFingerprint: "config",
        index: { policyHash: "policy", plugins: [] },
        plugins: [],
      } as never,
    });
    const changed = buildAgentModelCatalogCacheKey({
      agentDir: "/agent/main",
      workspaceDir: "/workspace",
      config: {
        models: {
          providers: {
            openai: { baseUrl: "https://api.openai.com/v1", models: [configuredModel("gpt-5.6")] },
          },
        },
      },
      metadataSnapshot: {
        policyHash: "policy",
        configFingerprint: "config",
        index: { policyHash: "policy", plugins: [] },
        plugins: [],
      } as never,
    });

    expect(base).toBe(same);
    expect(base).not.toBe(changed);
  });
});
