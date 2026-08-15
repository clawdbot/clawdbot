import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HealthCheck, HealthCheckContext } from "openclaw/plugin-sdk/health";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
  registerMemoryCoreDoctorChecks,
} from "./doctor-health.js";

type InspectManagedLocalEmbeddingSetup = Parameters<
  typeof registerMemoryCoreDoctorChecks
>[0]["inspectManagedLocalEmbeddingSetup"];

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => fs.rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function createSemanticIndex(stateDir: string, model = "embeddinggemma-300m") {
  const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE memory_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
  db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
    "memory_index_meta_v1",
    JSON.stringify({ model, vectorDims: 768 }),
  );
  db.close();
  return databasePath;
}

function captureCheck(
  inspectManagedLocalEmbeddingSetup: InspectManagedLocalEmbeddingSetup,
): HealthCheck {
  const checks: HealthCheck[] = [];
  registerMemoryCoreDoctorChecks({
    registerHealthCheck(check) {
      checks.push(check);
    },
    inspectManagedLocalEmbeddingSetup,
  });
  const check = checks[0];
  if (!check) {
    throw new Error("expected managed local embedding setup check");
  }
  return check;
}

function context(stateDir: string, provider: string): HealthCheckContext {
  return {
    mode: "lint",
    runtime: {} as HealthCheckContext["runtime"],
    cfg: {
      memory: {
        search: {
          provider,
          fallback: "none",
        },
      },
    },
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  };
}

describe("managed local embedding setup health check", () => {
  it("reports a structured blocker without mutating config or the semantic index", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-setup-blocked-"));
    roots.add(stateDir);
    const databasePath = await createSemanticIndex(stateDir);
    const checkContext = context(stateDir, "local");
    const configBefore = JSON.stringify(checkContext.cfg);
    const databaseBefore = await fs.readFile(databasePath);
    const check = captureCheck(async (params) => ({
      provider: params.provider,
      reason: "Local embeddings need the managed llama.cpp server config.",
      requirement: "managed-llama-cpp-setup",
      fixHint:
        "Run `openclaw models --agent main auth login --provider llama-cpp --method local` in an interactive terminal, then rerun this check.",
    }));

    await expect(check.detect(checkContext)).resolves.toEqual([
      {
        checkId: MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
        severity: "error",
        source: "memory-core",
        path: "memory.search.provider",
        target: "main/local",
        requirement: "managed-llama-cpp-setup",
        message: expect.stringContaining(
          'embedding provider "local" cannot initialize (Local embeddings need',
        ),
        fixHint:
          "Run `openclaw models --agent main auth login --provider llama-cpp --method local` in an interactive terminal, then rerun this check.",
      },
    ]);
    expect(JSON.stringify(checkContext.cfg)).toBe(configBefore);
    await expect(fs.readFile(databasePath)).resolves.toEqual(databaseBefore);
  });

  it("passes configured and non-local providers through the same scoped contract", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-setup-controls-"));
    roots.add(stateDir);
    await createSemanticIndex(stateDir);
    const inspect = vi.fn<InspectManagedLocalEmbeddingSetup>(async () => null);
    const check = captureCheck(inspect);

    await expect(check.detect(context(stateDir, "local"))).resolves.toEqual([]);
    await expect(check.detect(context(stateDir, "openai"))).resolves.toEqual([]);
    expect(inspect.mock.calls.map(([params]) => params.provider)).toEqual(["local", "openai"]);
  });

  it.each(["missing", "fts-only"] as const)(
    "does not inspect a provider for a %s vector index",
    async (indexMode) => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-setup-negative-"));
      roots.add(stateDir);
      if (indexMode === "fts-only") {
        await createSemanticIndex(stateDir, "fts-only");
      }
      const inspect = vi.fn<InspectManagedLocalEmbeddingSetup>(async () => null);
      const check = captureCheck(inspect);

      await expect(check.detect(context(stateDir, "local"))).resolves.toEqual([]);
      expect(inspect).not.toHaveBeenCalled();
    },
  );
});
