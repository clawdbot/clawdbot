import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { afterEach, describe, expect, it } from "vitest";
import { createVectorIndexProviderDiagnostic } from "./doctor-vector-index-provider-diagnostic.js";

const vectorIndexProviderDiagnostic = createVectorIndexProviderDiagnostic(async () => ({
  provider: "openai",
  reason: "OpenAI API key missing",
}));

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => fs.rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("memory vector index provider doctor diagnostic", () => {
  it("reports a protected semantic index when the configured provider cannot bootstrap", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-vector-doctor-"));
    roots.add(stateDir);
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await fs.mkdir(path.dirname(agentPath), { recursive: true });
    const db = new DatabaseSync(agentPath);
    db.exec("CREATE TABLE memory_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
    db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
      "memory_index_meta_v1",
      JSON.stringify({ model: "text-embedding-3-small", vectorDims: 1536 }),
    );
    db.close();
    const config = {
      memory: {},
      agents: { entries: {} },
    } satisfies OpenClawConfig;
    const params = {
      config,
      env: { OPENCLAW_STATE_DIR: stateDir },
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: {} as PluginDoctorStateMigrationContext,
    };

    const preview = await vectorIndexProviderDiagnostic.detectLegacyState(params);
    const result = await vectorIndexProviderDiagnostic.migrateLegacyState(params);

    expect(preview?.preview.join("\n")).toContain(
      "Memory index for agent main uses vector model text-embedding-3-small",
    );
    expect(preview?.preview.join("\n")).toContain("memory.search.remote.apiKey");
    expect(preview?.preview.join("\n")).toContain("memory.search.provider");
    expect(preview?.preview.join("\n")).toContain(
      "Memory sync will abort rather than overwrite this semantic index with FTS-only data",
    );
    expect(result).toEqual({
      changes: [],
      warnings: [expect.stringContaining('embedding provider "openai" cannot initialize')],
    });

    await expect(
      vectorIndexProviderDiagnostic.detectLegacyState({
        ...params,
        config: {
          ...config,
          memory: {
            search: {
              remote: {
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              },
            },
          },
        },
      }),
    ).resolves.toBeNull();
  });
});
