// Memory Wiki compiled cache tests cover compile, prepare, query, restart, and owner cleanup.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { OpenBlobStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginBlobStoreForTests,
  resetPluginBlobStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import {
  activateMemoryWikiCompiledCacheOwner,
  configureMemoryWikiCompiledCacheStore,
  createMemoryWikiCompiledCachePublicationId,
  createMemoryWikiCompiledCacheStore,
  deactivateMemoryWikiCompiledCacheOwnersExcept,
  loadMemoryWikiCompiledCache,
  reconcileMemoryWikiCompiledCacheOwner,
  resolveMemoryWikiCompiledCacheGeneration,
  resolveMemoryWikiCompiledCacheOwnerId,
  writeMemoryWikiCompiledCache,
  type MemoryWikiCompiledCacheSnapshot,
} from "./compiled-cache.js";
import { resolveMemoryWikiAgentConfig, resolveMemoryWikiConfig } from "./config.js";
import {
  appendMemoryWikiLog,
  loadMemoryWikiValidatedVaultIdentity,
  loadMemoryWikiVaultIdentity,
  resolveMemoryWikiVaultSourceGeneration,
} from "./log.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createWikiPromptSectionPreparer } from "./prompt-section.js";
import { getMemoryWikiPage } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { initializeMemoryWikiVault } from "./vault.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();
let blobStateDir = "";
let blobStoreEnv: NodeJS.ProcessEnv = {};

function createCacheStore() {
  return createMemoryWikiCompiledCacheStore(<T>(options: OpenBlobStoreOptions) =>
    createPluginBlobStoreForTests<T>("memory-wiki", options, blobStoreEnv),
  );
}

async function createPersistentVault(
  options?: Parameters<typeof createVault>[0],
): Promise<Awaited<ReturnType<typeof createVault>>> {
  const vault = await createVault(options);
  // The shared unit harness installs its in-memory cache store. These lifecycle
  // tests deliberately switch back to the SQLite-backed plugin Blob test store.
  configureMemoryWikiCompiledCacheStore(createCacheStore());
  return vault;
}

async function activateVault(config: ReturnType<typeof resolveMemoryWikiConfig>): Promise<void> {
  const identity = await loadMemoryWikiValidatedVaultIdentity(config.vault.path);
  if (!identity.vaultGeneration) {
    throw new Error(`Expected vault generation for ${config.vault.path}`);
  }
  activateMemoryWikiCompiledCacheOwner(
    config,
    identity.vaultGeneration,
    identity.compiledCachePublicationId,
  );
  await reconcileMemoryWikiCompiledCacheOwner(config, () =>
    loadMemoryWikiValidatedVaultIdentity(config.vault.path),
  );
}

function snapshot(text: string): MemoryWikiCompiledCacheSnapshot {
  return {
    digest: {
      claimCount: 1,
      contradictionCount: 0,
      pages: [
        {
          title: "Snapshot",
          kind: "entity",
          path: "entities/snapshot.md",
          aliases: [],
          sourceIds: [],
          questions: [],
          contradictions: [],
          bestUsedFor: [],
          notEnoughFor: [],
          relationshipCount: 0,
          topRelationships: [],
          claimCount: 1,
          topClaims: [{ text, status: "supported", freshnessLevel: "fresh" }],
        },
      ],
    },
    claims: [
      {
        pageTitle: "Snapshot",
        pageKind: "entity",
        pagePath: "entities/snapshot.md",
        text,
      },
    ],
  };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function publishSnapshot(
  config: ReturnType<typeof resolveMemoryWikiConfig>,
  value: MemoryWikiCompiledCacheSnapshot,
): Promise<string> {
  const generation = resolveMemoryWikiCompiledCacheGeneration(value);
  const publicationId = createMemoryWikiCompiledCachePublicationId();
  const reservationId = createMemoryWikiCompiledCachePublicationId();
  const parentPublicationId = (await loadMemoryWikiVaultIdentity(config.vault.path))
    .compiledCachePublicationId;
  await appendMemoryWikiLog(config.vault.path, {
    type: "compile",
    timestamp: "2026-07-17T00:00:00.000Z",
    details: { compiledCacheReservationId: reservationId },
  });
  const sourceGeneration = await resolveMemoryWikiVaultSourceGeneration(config.vault.path);
  await appendMemoryWikiLog(config.vault.path, {
    type: "compile",
    timestamp: "2026-07-17T00:00:00.000Z",
    details: {
      compiledCachePublicationId: publicationId,
      compiledCacheParentPublicationId: parentPublicationId,
      compiledCacheReservationId: reservationId,
      compiledCacheSourceGeneration: sourceGeneration,
    },
  });
  await writeMemoryWikiCompiledCache(
    config,
    value,
    generation,
    publicationId,
    parentPublicationId,
    async () => {},
    async () => {},
    () => loadMemoryWikiValidatedVaultIdentity(config.vault.path),
  );
  return publicationId;
}

async function preparePrompt(config: ReturnType<typeof resolveMemoryWikiConfig>): Promise<string> {
  return (
    await createWikiPromptSectionPreparer({ config, resolveConfig: () => config })({
      availableTools: new Set(),
    })
  ).join("\n");
}

describe("Memory Wiki compiled cache lifecycle", () => {
  beforeEach(async () => {
    resetPluginBlobStoreForTests();
    configureMemoryWikiCompiledCacheStore(undefined);
    blobStateDir = await createTempDir("memory-wiki-compiled-cache-state-");
    blobStoreEnv = { ...process.env, OPENCLAW_STATE_DIR: blobStateDir };
    configureMemoryWikiCompiledCacheStore(createCacheStore());
  });

  afterEach(async () => {
    configureMemoryWikiCompiledCacheStore(undefined);
    resetPluginBlobStoreForTests();
    blobStateDir = "";
    blobStoreEnv = {};
  });

  it("round-trips compile through async preparation and claim query after restart", async () => {
    const { rootDir, config } = await createPersistentVault({
      initialize: true,
      config: { context: { includeCompiledDigestPrompt: true } },
    });
    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alpha",
          title: "Alpha",
          claims: [
            {
              id: "claim.alpha.db",
              text: "Alpha uses PostgreSQL for production writes.",
              status: "supported",
              confidence: 0.91,
              evidence: [{ sourceId: "source.alpha", lines: "1-2" }],
            },
          ],
        },
        body: "# Alpha\n\nDatabase notes.\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    await expect(preparePrompt(config)).resolves.toContain(
      "Alpha uses PostgreSQL for production writes.",
    );
    await expect(getMemoryWikiPage({ config, lookup: "claim.alpha.db" })).resolves.toMatchObject({
      path: "entities/alpha.md",
      title: "Alpha",
    });

    configureMemoryWikiCompiledCacheStore(undefined);
    configureMemoryWikiCompiledCacheStore(createCacheStore());
    await activateVault(config);

    await expect(preparePrompt(config)).resolves.toContain(
      "Alpha uses PostgreSQL for production writes.",
    );
  });

  it("ignores legacy files and rebuilds only on compile", async () => {
    const { rootDir, config } = await createPersistentVault({
      initialize: true,
      config: { context: { includeCompiledDigestPrompt: true } },
    });
    const legacyPath = path.join(rootDir, ".openclaw-wiki", "cache", "agent-digest.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, JSON.stringify({ claimCount: 1, pages: [] }), "utf8");
    await fs.writeFile(
      path.join(rootDir, "entities", "fresh.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.fresh",
          title: "Fresh",
          claims: [{ text: "Fresh cache content.", status: "supported" }],
        },
        body: "# Fresh\n",
      }),
      "utf8",
    );

    await expect(preparePrompt(config)).resolves.not.toContain("Fresh cache content.");
    await compileMemoryWikiVault(config);

    await expect(preparePrompt(config)).resolves.toContain("Fresh cache content.");
    await expect(fs.readFile(legacyPath, "utf8")).resolves.toContain("claimCount");
  });

  it("persists snapshots beyond the keyed-state value limit", async () => {
    const { config } = await createPersistentVault({ initialize: true });
    const text = Array.from({ length: 4096 }, (_, index) =>
      createHash("sha256").update(String(index)).digest("hex"),
    ).join("");
    expect(gzipSync(text).byteLength).toBeGreaterThan(65_536);
    await publishSnapshot(config, snapshot(text));

    configureMemoryWikiCompiledCacheStore(undefined);
    configureMemoryWikiCompiledCacheStore(createCacheStore());
    await activateVault(config);

    expect((await loadMemoryWikiCompiledCache(config))?.claims[0]?.text).toBe(text);
  });

  it("loads an externally compiled generation after lifecycle refresh without polling", async () => {
    const { config } = await createPersistentVault({
      initialize: true,
      config: { context: { includeCompiledDigestPrompt: true } },
    });
    await publishSnapshot(config, snapshot("before"));
    await expect(preparePrompt(config)).resolves.toContain("before");

    const nextSnapshot = snapshot("after");
    const nextGeneration = resolveMemoryWikiCompiledCacheGeneration(nextSnapshot);
    const nextPublicationId = createMemoryWikiCompiledCachePublicationId();
    const nextReservationId = createMemoryWikiCompiledCachePublicationId();
    const parentPublicationId = (await loadMemoryWikiVaultIdentity(config.vault.path))
      .compiledCachePublicationId;
    await appendMemoryWikiLog(config.vault.path, {
      type: "compile",
      timestamp: "2026-07-17T00:01:00.000Z",
      details: { compiledCacheReservationId: nextReservationId },
    });
    const sourceGeneration = await resolveMemoryWikiVaultSourceGeneration(config.vault.path);
    await appendMemoryWikiLog(config.vault.path, {
      type: "compile",
      timestamp: "2026-07-17T00:01:00.000Z",
      details: {
        compiledCachePublicationId: nextPublicationId,
        compiledCacheParentPublicationId: parentPublicationId,
        compiledCacheReservationId: nextReservationId,
        compiledCacheSourceGeneration: sourceGeneration,
      },
    });
    await createCacheStore().write(config, nextSnapshot, nextGeneration, nextPublicationId);

    await expect(preparePrompt(config)).resolves.not.toContain("after");
    await activateVault(config);
    await expect(preparePrompt(config)).resolves.toContain("after");
  });

  it("defers a publication that completes during lifecycle reconciliation", async () => {
    const { config } = await createPersistentVault({ initialize: true });
    await publishSnapshot(config, snapshot("before"));
    const nextSnapshot = snapshot("during reconciliation");
    const nextGeneration = resolveMemoryWikiCompiledCacheGeneration(nextSnapshot);
    const nextPublicationId = createMemoryWikiCompiledCachePublicationId();
    const nextReservationId = createMemoryWikiCompiledCachePublicationId();
    const parentPublicationId = (await loadMemoryWikiVaultIdentity(config.vault.path))
      .compiledCachePublicationId;
    await appendMemoryWikiLog(config.vault.path, {
      type: "compile",
      timestamp: "2026-07-17T00:01:00.000Z",
      details: { compiledCacheReservationId: nextReservationId },
    });
    const sourceGeneration = await resolveMemoryWikiVaultSourceGeneration(config.vault.path);
    const externalStore = createCacheStore();
    let publishDuringLookup = true;
    const reconcilingStore = createMemoryWikiCompiledCacheStore(
      <T>(options: OpenBlobStoreOptions) => {
        const blobStore = createPluginBlobStoreForTests<T>("memory-wiki", options, blobStoreEnv);
        return {
          ...blobStore,
          async lookup(key) {
            const entry = await blobStore.lookup(key);
            if (publishDuringLookup) {
              publishDuringLookup = false;
              await appendMemoryWikiLog(config.vault.path, {
                type: "compile",
                timestamp: "2026-07-17T00:01:00.000Z",
                details: {
                  compiledCachePublicationId: nextPublicationId,
                  compiledCacheParentPublicationId: parentPublicationId,
                  compiledCacheReservationId: nextReservationId,
                  compiledCacheSourceGeneration: sourceGeneration,
                },
              });
              await externalStore.write(config, nextSnapshot, nextGeneration, nextPublicationId);
            }
            return entry;
          },
        };
      },
    );
    configureMemoryWikiCompiledCacheStore(reconcilingStore);

    await activateVault(config);

    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
    await activateVault(config);
    expect((await loadMemoryWikiCompiledCache(config))?.claims[0]?.text).toBe(
      "during reconciliation",
    );
  });

  it("reads the stable owner row directly without enumerating stale metadata", async () => {
    const { config } = await createPersistentVault({ initialize: true });
    const reader = createMemoryWikiCompiledCacheStore(<T>(options: OpenBlobStoreOptions) => {
      const store = createPluginBlobStoreForTests<T>("memory-wiki", options, blobStoreEnv);
      return {
        ...store,
        async entries() {
          throw new Error("read must not enumerate owner rows");
        },
      };
    });
    configureMemoryWikiCompiledCacheStore(reader);
    await publishSnapshot(config, snapshot("authoritative"));

    expect((await loadMemoryWikiCompiledCache(config))?.claims[0]?.text).toBe("authoritative");
  });

  it("preserves vault identity across atomic edits to user-managed scaffold files", async () => {
    const { rootDir, config } = await createPersistentVault({ initialize: true });
    await publishSnapshot(config, snapshot("still current"));
    const replacement = path.join(rootDir, "WIKI.md.replacement");
    await fs.writeFile(replacement, "# Edited wiki\n", "utf8");
    await fs.rename(replacement, path.join(rootDir, "WIKI.md"));

    expect((await loadMemoryWikiCompiledCache(config))?.claims[0]?.text).toBe("still current");
  });

  it("rejects claims newer than a restored vault after lifecycle refresh", async () => {
    const { rootDir, config } = await createPersistentVault({ initialize: true });
    await publishSnapshot(config, snapshot("backup"));
    const logPath = path.join(rootDir, ".openclaw-wiki", "log.jsonl");
    const backupLog = await fs.readFile(logPath, "utf8");
    const newerSnapshot = snapshot("Private post-backup claim.");
    const preRestorePublicationId = await publishSnapshot(config, newerSnapshot);
    await fs.writeFile(logPath, backupLog, "utf8");

    configureMemoryWikiCompiledCacheStore(undefined);
    configureMemoryWikiCompiledCacheStore(createCacheStore());
    await activateVault(config);

    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();

    const delayedSnapshot = snapshot("Private delayed pre-restore claim.");
    await createCacheStore().write(
      config,
      delayedSnapshot,
      resolveMemoryWikiCompiledCacheGeneration(delayedSnapshot),
      createMemoryWikiCompiledCachePublicationId(),
    );
    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();

    const republishedId = createMemoryWikiCompiledCachePublicationId();
    const staleReservationId = createMemoryWikiCompiledCachePublicationId();
    const newerGeneration = resolveMemoryWikiCompiledCacheGeneration(newerSnapshot);
    const sourceGeneration = await resolveMemoryWikiVaultSourceGeneration(config.vault.path);
    await appendMemoryWikiLog(config.vault.path, {
      type: "compile",
      timestamp: "2026-07-17T00:02:00.000Z",
      details: {
        compiledCachePublicationId: republishedId,
        compiledCacheParentPublicationId: preRestorePublicationId,
        compiledCacheReservationId: staleReservationId,
        compiledCacheSourceGeneration: sourceGeneration,
      },
    });
    await expect(
      writeMemoryWikiCompiledCache(
        config,
        newerSnapshot,
        newerGeneration,
        republishedId,
        preRestorePublicationId,
        async () => {},
        async () => {},
        () => loadMemoryWikiValidatedVaultIdentity(config.vault.path),
      ),
    ).rejects.toThrow("vault changed");

    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
    await activateVault(config);
    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
  });

  it("rejects a reserved publication when its identical parent was restored", async () => {
    const { rootDir, config } = await createPersistentVault({ initialize: true });
    await publishSnapshot(config, snapshot("backup"));
    const logPath = path.join(rootDir, ".openclaw-wiki", "log.jsonl");
    const backupLog = await fs.readFile(logPath, "utf8");
    const parentPublicationId = (await loadMemoryWikiVaultIdentity(rootDir))
      .compiledCachePublicationId;
    const reservedPublicationId = createMemoryWikiCompiledCachePublicationId();
    const reservationId = createMemoryWikiCompiledCachePublicationId();
    await appendMemoryWikiLog(rootDir, {
      type: "compile",
      timestamp: "2026-07-17T00:03:00.000Z",
      details: {
        compiledCacheReservationId: reservationId,
        compiledCacheParentPublicationId: parentPublicationId,
      },
    });
    const compiledAfterBackup = snapshot("Private content scanned after backup.");
    await fs.writeFile(logPath, backupLog, "utf8");
    const sourceGeneration = await resolveMemoryWikiVaultSourceGeneration(rootDir);

    await expect(
      writeMemoryWikiCompiledCache(
        config,
        compiledAfterBackup,
        resolveMemoryWikiCompiledCacheGeneration(compiledAfterBackup),
        reservedPublicationId,
        parentPublicationId,
        async () => {},
        async () => {
          await appendMemoryWikiLog(rootDir, {
            type: "compile",
            timestamp: "2026-07-17T00:03:01.000Z",
            details: {
              compiledCachePublicationId: reservedPublicationId,
              compiledCacheParentPublicationId: parentPublicationId,
              compiledCacheReservationId: reservationId,
              compiledCacheSourceGeneration: sourceGeneration,
            },
          });
        },
        () => loadMemoryWikiValidatedVaultIdentity(rootDir),
      ),
    ).rejects.toThrow("vault changed");
    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
    await activateVault(config);
    expect((await loadMemoryWikiCompiledCache(config))?.claims[0]?.text).toBe("backup");
  });

  it("keeps a committed publication when an older writer is rejected", async () => {
    const { config } = await createPersistentVault({ initialize: true });
    const parentPublicationId = await publishSnapshot(config, snapshot("parent"));
    const stalePublicationId = createMemoryWikiCompiledCachePublicationId();
    const staleReservationId = createMemoryWikiCompiledCachePublicationId();
    await appendMemoryWikiLog(config.vault.path, {
      type: "compile",
      timestamp: "2026-07-17T00:03:30.000Z",
      details: { compiledCacheReservationId: staleReservationId },
    });
    const staleSnapshot = snapshot("stale candidate");
    const sourceGeneration = await resolveMemoryWikiVaultSourceGeneration(config.vault.path);
    const callbackEntered = createDeferred();
    const releaseCallback = createDeferred();
    const staleWrite = writeMemoryWikiCompiledCache(
      config,
      staleSnapshot,
      resolveMemoryWikiCompiledCacheGeneration(staleSnapshot),
      stalePublicationId,
      parentPublicationId,
      async () => {},
      async () => {
        callbackEntered.resolve();
        await releaseCallback.promise;
        await appendMemoryWikiLog(config.vault.path, {
          type: "compile",
          timestamp: "2026-07-17T00:04:00.000Z",
          details: {
            compiledCachePublicationId: stalePublicationId,
            compiledCacheParentPublicationId: parentPublicationId,
            compiledCacheReservationId: staleReservationId,
            compiledCacheSourceGeneration: sourceGeneration,
          },
        });
      },
      () => loadMemoryWikiValidatedVaultIdentity(config.vault.path),
    );
    await callbackEntered.promise;
    await publishSnapshot(config, snapshot("accepted successor"));
    releaseCallback.resolve();

    await expect(staleWrite).rejects.toThrow("vault changed");
    expect((await loadMemoryWikiCompiledCache(config))?.claims[0]?.text).toBe("accepted successor");
  });

  it("loads a prepared snapshot without prompt-path file I/O", async () => {
    const { config } = await createPersistentVault({
      initialize: true,
      config: { context: { includeCompiledDigestPrompt: true } },
    });
    await publishSnapshot(config, snapshot("prepared"));
    const stat = vi.spyOn(fs, "stat");
    const readFile = vi.spyOn(fs, "readFile");

    await expect(preparePrompt(config)).resolves.toContain("prepared");
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("treats transient SQLite read failures as a recoverable cache miss", async () => {
    const { config } = await createPersistentVault({ initialize: true });
    const errors: unknown[] = [];
    let failNextRead = false;
    const store = createMemoryWikiCompiledCacheStore(
      <T>(options: OpenBlobStoreOptions) => {
        const blobStore = createPluginBlobStoreForTests<T>("memory-wiki", options, blobStoreEnv);
        return {
          ...blobStore,
          async lookup(key) {
            if (failNextRead) {
              failNextRead = false;
              throw new Error("transient SQLite failure");
            }
            return await blobStore.lookup(key);
          },
        };
      },
      { onReadError: (error) => errors.push(error) },
    );
    configureMemoryWikiCompiledCacheStore(store);
    await publishSnapshot(config, snapshot("recoverable"));
    failNextRead = true;

    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
    expect(errors).toHaveLength(1);
    expect((await loadMemoryWikiCompiledCache(config))?.claims[0]?.text).toBe("recoverable");
  });

  it("keeps a restored owner closed when lifecycle reconciliation fails", async () => {
    const { rootDir, config } = await createPersistentVault({ initialize: true });
    await publishSnapshot(config, snapshot("backup"));
    const logPath = path.join(rootDir, ".openclaw-wiki", "log.jsonl");
    const backupLog = await fs.readFile(logPath, "utf8");
    await publishSnapshot(config, snapshot("Private newer claim."));
    await fs.writeFile(logPath, backupLog, "utf8");

    const errors: unknown[] = [];
    let failNextRead = true;
    const store = createMemoryWikiCompiledCacheStore(
      <T>(options: OpenBlobStoreOptions) => {
        const blobStore = createPluginBlobStoreForTests<T>("memory-wiki", options, blobStoreEnv);
        return {
          ...blobStore,
          async lookup(key) {
            if (failNextRead) {
              failNextRead = false;
              throw new Error("transient reconciliation failure");
            }
            return await blobStore.lookup(key);
          },
        };
      },
      { onReadError: (error) => errors.push(error) },
    );
    configureMemoryWikiCompiledCacheStore(undefined);
    configureMemoryWikiCompiledCacheStore(store);
    await expect(activateVault(config)).rejects.toThrow("transient reconciliation failure");

    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
    expect(errors).toHaveLength(1);
  });

  it("rejects a predecessor snapshot when a vault path is reused", async () => {
    const { rootDir, config } = await createPersistentVault({
      initialize: true,
      config: { context: { includeCompiledDigestPrompt: true } },
    });
    await publishSnapshot(config, snapshot("Private predecessor content."));
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.mkdir(path.join(rootDir, ".openclaw-wiki"), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(rootDir, "WIKI.md"), "# Replacement\n", "utf8"),
      fs.writeFile(
        path.join(rootDir, ".openclaw-wiki", "log.jsonl"),
        `${JSON.stringify({
          type: "vault-generation",
          timestamp: "2026-07-17T00:00:00.000Z",
          details: { vaultGeneration: "replacement-generation" },
        })}\n`,
        "utf8",
      ),
    ]);
    await initializeMemoryWikiVault(config);

    await expect(preparePrompt(config)).resolves.not.toContain("Private predecessor content.");
    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
  });

  it("atomically replaces one stable owner row when the configured vault moves", async () => {
    const { config: firstConfig } = await createPersistentVault({ initialize: true });
    const { config: secondConfig } = await createPersistentVault({ initialize: true });
    const store = createCacheStore();
    configureMemoryWikiCompiledCacheStore(store);

    await activateVault(firstConfig);
    await publishSnapshot(firstConfig, snapshot("first"));
    await activateVault(secondConfig);
    await publishSnapshot(secondConfig, snapshot("second"));

    await expect(loadMemoryWikiCompiledCache(firstConfig)).resolves.toBeNull();
    expect((await loadMemoryWikiCompiledCache(secondConfig))?.claims[0]?.text).toBe("second");
  });

  it("deletes cache rows when their agent owner is removed", async () => {
    const rootDir = path.join((await createPersistentVault()).rootDir, "agents");
    const appConfig = {
      agents: { list: [{ id: "support", default: true }, { id: "marketing" }] },
    };
    const baseConfig = resolveMemoryWikiConfig({ vault: { scope: "agent", path: rootDir } });
    const support = resolveMemoryWikiAgentConfig({
      config: baseConfig,
      appConfig,
      agentId: "support",
    });
    const marketing = resolveMemoryWikiAgentConfig({
      config: baseConfig,
      appConfig,
      agentId: "marketing",
    });
    for (const config of [support, marketing]) {
      await initializeMemoryWikiVault(config);
      await publishSnapshot(config, snapshot(config.agentId ?? "unknown"));
    }
    const store = createCacheStore();
    configureMemoryWikiCompiledCacheStore(store);

    const activeOwners = new Set([resolveMemoryWikiCompiledCacheOwnerId(support)]);
    deactivateMemoryWikiCompiledCacheOwnersExcept(activeOwners);
    await store.deleteOwnersExcept(activeOwners);

    await expect(loadMemoryWikiCompiledCache(marketing)).resolves.toBeNull();
    await expect(loadMemoryWikiCompiledCache(support)).resolves.not.toBeNull();
  });
});
