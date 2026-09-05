// Memory Core tests cover manager registry behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import {
  closeAllMemoryIndexManagers,
  closeMemoryIndexManagersForAgent,
  MemoryIndexManager as RuntimeMemoryIndexManager,
} from "./manager.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory index", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { provider: providerFixture } = fixture;
  const { createConfig: createCfg, getFreshManager, requireManager, trackManager } = fixture;

  it("reuses a read-only search manager without triggering index sync", async () => {
    const cfg = createCfg({ provider: "none", vectorEnabled: false, onSearch: true });
    const writer = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    trackManager(writer);
    await writer.sync({ force: true, reason: "test-search-cache" });

    const first = requireManager(
      await getMemorySearchManager({ cfg, agentId: "main", purpose: "search" }),
    );
    trackManager(first);
    const second = requireManager(
      await getMemorySearchManager({ cfg, agentId: "main", purpose: "search" }),
    );
    expect(second).toBe(first);
    expect(requireManager(await getMemorySearchManager({ cfg, agentId: "main" }))).toBe(writer);
    expect(first).not.toBe(writer);

    const searchDb = Reflect.get(first, "db") as DatabaseSync;
    expect(searchDb.prepare("PRAGMA query_only").get()).toEqual({ query_only: 1 });
    expect(() => searchDb.exec("DELETE FROM memory_index_meta")).toThrow();
    await expect(first.sync({ force: true })).rejects.toThrow(/read-only/iu);

    Reflect.set(first, "dirty", true);
    const getSpy = vi.spyOn(RuntimeMemoryIndexManager, "get");
    try {
      await expect(first.search("zebra", { maxResults: 5, minScore: 0 })).resolves.not.toEqual([]);
      expect(getSpy).not.toHaveBeenCalledWith(expect.objectContaining({ purpose: "maintenance" }));

      await fs.writeFile(
        path.join(fixture.paths.memory, "2026-01-12.md"),
        "# Log\nAlpha memory line.\nGiraffe memory line.",
      );
      await writer.sync({ force: true, reason: "test-search-cache-refresh" });
      await expect(first.search("giraffe", { maxResults: 5, minScore: 0 })).resolves.not.toEqual(
        [],
      );
      await expect(first.search("zebra", { maxResults: 5, minScore: 0 })).resolves.toEqual([]);
    } finally {
      getSpy.mockRestore();
    }

    await closeMemoryIndexManagersForAgent({ agentId: "main" });
    const replacement = requireManager(
      await getMemorySearchManager({ cfg, agentId: "main", purpose: "search" }),
    );
    trackManager(replacement);
    expect(replacement).not.toBe(first);
  });

  it("fails closed when the read-only search schema is incomplete", async () => {
    const cfg = createCfg({ provider: "none", vectorEnabled: false });
    const writer = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    trackManager(writer);
    await writer.sync({ force: true, reason: "test-search-schema" });
    const writerDb = Reflect.get(writer, "db") as DatabaseSync;
    writerDb.exec("DROP INDEX idx_memory_index_chunks_source");
    await writer.close();

    const rejected = await getMemorySearchManager({ cfg, agentId: "main", purpose: "search" });
    expect(rejected.manager).toBeNull();
    expect(rejected.error).toMatch(/schema is incomplete.*idx_memory_index_chunks_source/iu);
  });

  it("fails closed when persisted memory index identity does not match", async () => {
    const cfg = createCfg({ provider: "none", vectorEnabled: false });
    const writer = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    trackManager(writer);
    await writer.sync({ force: true, reason: "test-search-identity" });
    const writerDb = Reflect.get(writer, "db") as DatabaseSync;
    const row = writerDb
      .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
      .get() as { value: string };
    writerDb
      .prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'")
      .run(JSON.stringify({ ...JSON.parse(row.value), scopeHash: "wrong-scope" }));
    await writer.close();

    const rejected = await getMemorySearchManager({ cfg, agentId: "main", purpose: "search" });
    expect(rejected.manager).toBeNull();
    expect(rejected.error).toMatch(/identity is mismatched|index scope changed/iu);
  });

  it("fails closed when the persisted vector clean marker requires a rebuild", async () => {
    const cfg = createCfg({ provider: "mock", vectorEnabled: true });
    const writer = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    trackManager(writer);
    await writer.sync({ force: true, reason: "test-search-vector-clean-marker" });
    const writerDb = Reflect.get(writer, "db") as DatabaseSync;
    writerDb
      .prepare(
        `INSERT INTO memory_index_meta (key, value) VALUES ('memory_vector_rebuild_v1', '1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run();
    await writer.close();

    const rejected = await getMemorySearchManager({ cfg, agentId: "main", purpose: "search" });
    expect(rejected.manager).toBeNull();
    expect(rejected.error).toMatch(/vector index is incomplete/iu);
  });

  it("waits for scoped manager close before initializing a replacement", async () => {
    let releaseProviderClose: () => void = () => {};
    providerFixture.providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const first = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    trackManager(first);
    await first.probeEmbeddingAvailability();
    const closePromise = closeMemoryIndexManagersForAgent({ agentId: "main" });
    const callsBeforeReplacement = providerFixture.providerCalls.length;
    const secondPromise = getMemorySearchManager({ cfg, agentId: "main" }).then((result) =>
      requireManager(result),
    );
    const concurrentSecondPromise = getMemorySearchManager({ cfg, agentId: "main" }).then(
      (result) => requireManager(result),
    );
    const secondProbe = secondPromise.then(async (manager) => {
      await manager.probeEmbeddingAvailability();
    });
    let secondSettled = false;
    void secondPromise.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );
    try {
      await vi.waitFor(() => {
        expect(providerFixture.providerCloseCalls).toBe(1);
      });
      await Promise.resolve();
      expect(secondSettled).toBe(false);
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeReplacement);
    } finally {
      releaseProviderClose();
      providerFixture.providerCloseGate = null;
    }
    await closePromise;
    const second = await secondPromise;
    const concurrentSecond = await concurrentSecondPromise;
    await secondProbe;
    trackManager(second);
    expect(second === first).toBe(false);
    expect(concurrentSecond).toBe(second);

    const third = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    trackManager(third);
    expect(third).toBe(second);
  });

  it("does not reuse a cached manager after direct close starts", async () => {
    let releaseProviderClose: () => void = () => {};
    providerFixture.providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const first = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    trackManager(first);
    await first.probeEmbeddingAvailability();

    const closePromise = first.close();
    const replacementPromise = getMemorySearchManager({ cfg, agentId: "main" }).then((result) =>
      requireManager(result),
    );
    let replacementSettled = false;
    void replacementPromise.then(
      () => {
        replacementSettled = true;
      },
      () => {
        replacementSettled = true;
      },
    );
    try {
      await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(1));
      await Promise.resolve();
      expect(replacementSettled).toBe(false);
    } finally {
      releaseProviderClose();
      providerFixture.providerCloseGate = null;
    }

    await closePromise;
    const replacement = await replacementPromise;
    trackManager(replacement);
    expect(replacement === first).toBe(false);
  });

  it("serializes concurrent acquisitions with different cache identities", async () => {
    const firstCfg = createCfg({
      model: "first-model",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const first = requireManager(await getMemorySearchManager({ cfg: firstCfg, agentId: "main" }));
    trackManager(first);
    await first.probeEmbeddingAvailability();
    let releaseProviderClose: () => void = () => {};
    providerFixture.providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });

    const secondPromise = getMemorySearchManager({
      cfg: createCfg({ model: "second-model" }),
      agentId: "main",
    }).then((result) => requireManager(result));
    await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(1));
    const thirdPromise = getMemorySearchManager({
      cfg: createCfg({ model: "third-model" }),
      agentId: "main",
    }).then((result) => requireManager(result));
    try {
      await Promise.resolve();
      expect(providerFixture.providerCalls).toHaveLength(1);
    } finally {
      releaseProviderClose();
      providerFixture.providerCloseGate = null;
    }

    const [second, third] = await Promise.all([secondPromise, thirdPromise]);
    trackManager(second);
    trackManager(third);
    expect(second === first).toBe(false);
    expect(third === second).toBe(false);
    expect((second as unknown as { closed: boolean }).closed).toBe(true);
    expect((third as unknown as { closed: boolean }).closed).toBe(false);
  });

  it("canonicalizes agent ids before builtin manager acquisition", async () => {
    const cfg = createCfg({ model: "canonical-model" });
    const first = await RuntimeMemoryIndexManager.get({ cfg, agentId: "Main-Agent" });
    const second = await RuntimeMemoryIndexManager.get({ cfg, agentId: "main-agent" });
    if (!first || !second) {
      throw new Error("Expected canonical memory index managers");
    }
    trackManager(first);
    trackManager(second);
    expect(second).toBe(first);
  });

  it("retires the prior builtin manager when an agent workspace changes", async () => {
    const firstCfg = createCfg({ model: "workspace-model" });
    const secondCfg = createCfg({ model: "workspace-model" });
    if (!firstCfg.agents?.defaults || !secondCfg.agents?.defaults) {
      throw new Error("Expected agent defaults");
    }
    firstCfg.agents.defaults.workspace = path.join(fixture.paths.root, "workspace-a");
    secondCfg.agents.defaults.workspace = path.join(fixture.paths.root, "workspace-b");

    const first = await RuntimeMemoryIndexManager.get({ cfg: firstCfg, agentId: "main" });
    const second = await RuntimeMemoryIndexManager.get({ cfg: secondCfg, agentId: "main" });
    if (!first || !second) {
      throw new Error("Expected workspace memory index managers");
    }
    trackManager(first);
    trackManager(second);
    expect(second === first).toBe(false);
    expect((first as unknown as { closed: boolean }).closed).toBe(true);
  });

  it("does not block another agent while one scope retires its manager", async () => {
    const firstCfg = createCfg({
      model: "first-model",
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const first = requireManager(await getMemorySearchManager({ cfg: firstCfg, agentId: "main" }));
    trackManager(first);
    await first.probeEmbeddingAvailability();
    let releaseProviderClose: () => void = () => {};
    providerFixture.providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });

    const replacementPromise = getMemorySearchManager({
      cfg: createCfg({ model: "second-model" }),
      agentId: "main",
    });
    await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(1));
    const otherAgentPromise = getMemorySearchManager({
      cfg: createCfg({ model: "other-model" }),
      agentId: "other",
    });
    let otherAgentSettled = false;
    void otherAgentPromise.then(
      () => {
        otherAgentSettled = true;
      },
      () => {
        otherAgentSettled = true;
      },
    );
    try {
      await vi.waitFor(() => expect(otherAgentSettled).toBe(true));
    } finally {
      releaseProviderClose();
      providerFixture.providerCloseGate = null;
    }

    const otherAgent = requireManager(await otherAgentPromise);
    const replacement = requireManager(await replacementPromise);
    trackManager(otherAgent);
    trackManager(replacement);
    expect((otherAgent as unknown as { closed: boolean }).closed).toBe(false);
  });

  it("global teardown waits for an admitted builtin manager replacement", async () => {
    const first = await RuntimeMemoryIndexManager.get({
      cfg: createCfg({ model: "first-model" }),
      agentId: "main",
    });
    if (!first) {
      throw new Error("Expected first memory index manager");
    }
    trackManager(first);
    await first.probeEmbeddingAvailability();
    let releaseProviderClose: () => void = () => {};
    providerFixture.providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });

    const replacementPromise = RuntimeMemoryIndexManager.get({
      cfg: createCfg({ model: "second-model" }),
      agentId: "main",
    });
    await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(1));
    const globalClosePromise = closeAllMemoryIndexManagers();
    let globalCloseSettled = false;
    void globalClosePromise.then(
      () => {
        globalCloseSettled = true;
      },
      () => {
        globalCloseSettled = true;
      },
    );
    try {
      await Promise.resolve();
      expect(globalCloseSettled).toBe(false);
    } finally {
      releaseProviderClose();
      providerFixture.providerCloseGate = null;
    }

    const replacement = await replacementPromise;
    await globalClosePromise;
    if (!replacement) {
      throw new Error("Expected replacement memory index manager");
    }
    trackManager(replacement);
    expect((replacement as unknown as { closed: boolean }).closed).toBe(true);
  });

  it("declines a maintenance manager that arrives during global teardown", async () => {
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    trackManager(manager);
    await manager.probeEmbeddingAvailability();
    let releaseProviderClose: () => void = () => {};
    providerFixture.providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });

    const globalClose = closeAllMemoryIndexManagers();
    try {
      await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(1));
      await expect(
        RuntimeMemoryIndexManager.get({ cfg, agentId: "main", purpose: "maintenance" }),
      ).resolves.toBeNull();
    } finally {
      releaseProviderClose();
      providerFixture.providerCloseGate = null;
    }
    await globalClose;
  });

  it("retains a failed scoped close owner until provider retirement succeeds", async () => {
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const first = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    trackManager(first);
    await first.probeEmbeddingAvailability();
    providerFixture.providerCloseFailuresRemaining = 2;

    await expect(closeMemoryIndexManagersForAgent({ agentId: "main" })).rejects.toThrow(
      "provider close failed",
    );
    expect(providerFixture.providerCloseCalls).toBe(2);

    let releaseProviderClose: () => void = () => {};
    providerFixture.providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });
    const callsBeforeReplacement = providerFixture.providerCalls.length;
    const replacementPromise = getMemorySearchManager({ cfg, agentId: "main" }).then((result) =>
      requireManager(result),
    );
    try {
      await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(3));
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeReplacement);
    } finally {
      releaseProviderClose();
      providerFixture.providerCloseGate = null;
    }

    const replacement = await replacementPromise;
    trackManager(replacement);
    expect(replacement === first).toBe(false);
  });

  it("retains a failed global close owner until provider retirement succeeds", async () => {
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const first = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    trackManager(first);
    await first.probeEmbeddingAvailability();
    providerFixture.providerCloseFailuresRemaining = 2;
    providerFixture.providerCloseFailure = undefined;

    let globalCloseRejected = false;
    await closeAllMemorySearchManagers().then(
      () => {},
      () => {
        globalCloseRejected = true;
      },
    );
    expect(globalCloseRejected).toBe(true);
    expect(providerFixture.providerCloseCalls).toBe(2);

    let releaseProviderClose: () => void = () => {};
    providerFixture.providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });
    const callsBeforeReplacement = providerFixture.providerCalls.length;
    const replacementPromise = getMemorySearchManager({ cfg, agentId: "main" }).then((result) =>
      requireManager(result),
    );
    let concurrentGlobalClose: Promise<void> = Promise.resolve();
    try {
      await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(3));
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeReplacement);
      concurrentGlobalClose = closeAllMemorySearchManagers();
    } finally {
      releaseProviderClose();
      providerFixture.providerCloseGate = null;
    }

    const replacement = await replacementPromise;
    await concurrentGlobalClose;
    trackManager(replacement);
    expect(replacement === first).toBe(false);
    expect((replacement as unknown as { closed: boolean }).closed).toBe(false);
  });

  it("does not reuse memory index managers across local-service hosts", async () => {
    const cfg = createCfg({});
    const firstAcquire = vi.fn(async () => undefined);
    const secondAcquire = vi.fn(async () => undefined);
    const first = requireManager(
      await getMemorySearchManager({
        cfg,
        agentId: "main",
        acquireLocalService: firstAcquire,
      }),
    );
    trackManager(first);

    const second = requireManager(
      await getMemorySearchManager({
        cfg,
        agentId: "main",
        acquireLocalService: secondAcquire,
      }),
    );
    trackManager(second);
    const secondAgain = requireManager(
      await getMemorySearchManager({
        cfg,
        agentId: "main",
        acquireLocalService: secondAcquire,
      }),
    );

    expect(Object.is(second, first)).toBe(false);
    expect(Object.is(secondAgain, second)).toBe(true);
  });

  it("retries embedding provider close before releasing the manager", async () => {
    providerFixture.providerCloseFailuresRemaining = 1;
    const cfg = createCfg({
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getFreshManager(cfg);

    await manager.probeEmbeddingAvailability();
    await manager.close();

    expect(providerFixture.providerCloseCalls).toBe(2);
  });
});
