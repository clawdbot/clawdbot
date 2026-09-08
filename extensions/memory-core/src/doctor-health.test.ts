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
>[0]["inspectEmbeddingProviderSetup"];

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
  inspectManagedLocalEmbeddingSetup?: InspectManagedLocalEmbeddingSetup,
  memoryCoreActive = true,
): HealthCheck {
  const checks = new Map<string, HealthCheck>();
  registerMemoryCoreDoctorChecks({
    registerHealthCheck(check) {
      checks.set(check.id, check);
    },
    getHealthCheck: (id) => checks.get(id),
    inspectEmbeddingProviderSetup: inspectManagedLocalEmbeddingSetup ?? (async () => undefined),
    memoryCoreActive,
  });
  const check = checks.get(MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID);
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
  it("stays opt-in outside an explicit pre-cutover selection", () => {
    expect(captureCheck()).toMatchObject({
      defaultEnabled: false,
    });
  });

  it("refreshes current host state and re-registers after a registry reset", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-setup-registration-"));
    roots.add(stateDir);
    await createSemanticIndex(stateDir);
    const checks = new Map<string, HealthCheck>();
    const registerHealthCheck = vi.fn((check: HealthCheck) => {
      if (checks.has(check.id)) {
        throw new Error(`duplicate check: ${check.id}`);
      }
      checks.set(check.id, check);
    });
    const getHealthCheck = (id: string) => checks.get(id);
    const staleInspect = vi.fn<InspectManagedLocalEmbeddingSetup>(async () => null);
    const currentInspect = vi.fn<InspectManagedLocalEmbeddingSetup>(async (params) => ({
      provider: params.provider,
      reason: "Local embeddings need the managed llama.cpp server config.",
      requirement: "managed-llama-cpp-setup",
    }));

    registerMemoryCoreDoctorChecks({
      registerHealthCheck,
      getHealthCheck,
      inspectEmbeddingProviderSetup: staleInspect,
      memoryCoreActive: false,
    });
    const check = checks.get(MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID);
    if (!check) {
      throw new Error("expected managed local embedding setup check");
    }

    registerMemoryCoreDoctorChecks({
      registerHealthCheck,
      getHealthCheck,
      inspectEmbeddingProviderSetup: currentInspect,
      memoryCoreActive: true,
    });
    expect(registerHealthCheck).toHaveBeenCalledOnce();
    await expect(check.detect(context(stateDir, "local"))).resolves.toEqual([
      expect.objectContaining({
        requirement: "managed-llama-cpp-setup",
        target: "main/local",
      }),
    ]);
    expect(staleInspect).not.toHaveBeenCalled();
    expect(currentInspect).toHaveBeenCalledOnce();

    checks.clear();
    registerMemoryCoreDoctorChecks({
      registerHealthCheck,
      getHealthCheck,
      inspectEmbeddingProviderSetup: currentInspect,
      memoryCoreActive: true,
    });
    expect(checks.get(MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID)).toBe(check);
    expect(registerHealthCheck).toHaveBeenCalledTimes(2);
  });

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

  it("passes configured local setup and ignores non-local providers", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-setup-controls-"));
    roots.add(stateDir);
    await createSemanticIndex(stateDir);
    const inspect = vi.fn<InspectManagedLocalEmbeddingSetup>(async () => null);
    const check = captureCheck(inspect);

    await expect(check.detect(context(stateDir, "local"))).resolves.toEqual([]);
    await expect(check.detect(context(stateDir, "openai"))).resolves.toEqual([]);
    expect(inspect.mock.calls.map(([params]) => params.provider)).toEqual(["local"]);
  });

  it("reports a structured blocker when the local provider plugin is unavailable", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-setup-plugin-missing-"));
    roots.add(stateDir);
    await createSemanticIndex(stateDir);
    const check = captureCheck();

    await expect(check.detect(context(stateDir, "local"))).resolves.toEqual([
      expect.objectContaining({
        checkId: MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
        target: "main/local",
        requirement: "memory-embedding-provider-plugin",
        message: expect.stringContaining("official llama.cpp provider plugin"),
        fixHint: expect.stringContaining("openclaw plugins install @openclaw/llama-cpp-provider"),
      }),
    ]);
  });

  it("normalizes selected provider IDs like Gateway startup", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-setup-normalized-"));
    roots.add(stateDir);
    await createSemanticIndex(stateDir);
    const inspect = vi.fn<InspectManagedLocalEmbeddingSetup>(async (params) => ({
      provider: params.provider,
      reason: "Local embeddings need the managed llama.cpp server config.",
      requirement: "managed-llama-cpp-setup",
    }));
    const check = captureCheck(inspect);

    await expect(check.detect(context(stateDir, " LOCAL "))).resolves.toEqual([
      expect.objectContaining({
        requirement: "managed-llama-cpp-setup",
        target: "main/local",
      }),
    ]);
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ provider: "local" }));
  });

  it("ignores stale built-in indexes when another plugin owns the memory slot", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-setup-alternate-slot-"));
    roots.add(stateDir);
    await createSemanticIndex(stateDir);
    const inspect = vi.fn<InspectManagedLocalEmbeddingSetup>(async () => ({
      provider: "local",
      reason: "Local embeddings need the managed llama.cpp server config.",
    }));
    const check = captureCheck(inspect, false);

    await expect(check.detect(context(stateDir, "local"))).resolves.toEqual([]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("does not let a retained remote SecretRef suppress selected local setup", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-setup-secret-ref-"));
    roots.add(stateDir);
    await createSemanticIndex(stateDir);
    const inspect = vi.fn<InspectManagedLocalEmbeddingSetup>(async (params) => ({
      provider: params.provider,
      reason: "Local embeddings need the managed llama.cpp server config.",
      requirement: "managed-llama-cpp-setup",
    }));
    const check = captureCheck(inspect);
    const checkContext = context(stateDir, "local");
    checkContext.cfg.memory = {
      search: {
        provider: "local",
        fallback: "none",
        remote: {
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      },
    };

    await expect(check.detect(checkContext)).resolves.toEqual([
      expect.objectContaining({
        checkId: MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
        target: "main/local",
        requirement: "managed-llama-cpp-setup",
      }),
    ]);
    expect(inspect).toHaveBeenCalledOnce();
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

  it("reads an active WAL index without changing the live SQLite family", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-setup-live-wal-"));
    roots.add(stateDir);
    const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const writer = new DatabaseSync(databasePath);
    try {
      writer.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE memory_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        PRAGMA wal_checkpoint(TRUNCATE);
      `);
      writer
        .prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)")
        .run(
          "memory_index_meta_v1",
          JSON.stringify({ model: "embeddinggemma-300m", vectorDims: 768 }),
        );
      const familyPaths = ["", "-wal", "-shm"].map((suffix) => `${databasePath}${suffix}`);
      const before = await Promise.all(familyPaths.map(async (file) => await fs.readFile(file)));
      const check = captureCheck(async (params) => ({
        provider: params.provider,
        reason: "Local embeddings need the managed llama.cpp server config.",
        requirement: "managed-llama-cpp-setup",
      }));

      await expect(check.detect(context(stateDir, "local"))).resolves.toEqual([
        expect.objectContaining({
          requirement: "managed-llama-cpp-setup",
          target: "main/local",
        }),
      ]);
      const after = await Promise.all(familyPaths.map(async (file) => await fs.readFile(file)));
      expect(after).toEqual(before);
    } finally {
      writer.close();
    }
  });

  it("returns a structured non-ready result when an agent database cannot be inspected", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-setup-unreadable-"));
    roots.add(stateDir);
    const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.writeFile(databasePath, "not a sqlite database");
    const check = captureCheck(async () => null);

    await expect(check.detect(context(stateDir, "local"))).resolves.toEqual([
      {
        checkId: MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
        severity: "error",
        source: "memory-core",
        target: "memory-core",
        requirement: "memory-index-inspection",
        message: expect.stringContaining(
          "Memory Core semantic-index readiness could not be verified",
        ),
        fixHint:
          "Keep the current Gateway running, resolve the database inspection error, then rerun this check.",
      },
    ]);
  });

  it("returns a structured non-ready result when provider setup cannot be inspected", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-setup-provider-state-"));
    roots.add(stateDir);
    await createSemanticIndex(stateDir);
    const check = captureCheck(async () => {
      throw new Error("shared plugin state did not stabilize");
    });

    await expect(check.detect(context(stateDir, "local"))).resolves.toEqual([
      {
        checkId: MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
        severity: "error",
        source: "memory-core",
        target: "memory-core",
        requirement: "memory-index-inspection",
        message: expect.stringContaining("shared plugin state did not stabilize"),
        fixHint:
          "Keep the current Gateway running, resolve the database inspection error, then rerun this check.",
      },
    ]);
  });
});
