import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import { codexCatalogHomeId } from "../session-catalog-home-id.js";
import {
  createCodexManagedThreadStore,
  type StoredCodexManagedThread,
} from "./managed-thread-store.js";

function createStateStore() {
  const values = new Map<string, StoredCodexManagedThread>();
  const state: Pick<
    PluginStateSyncKeyedStore<StoredCodexManagedThread>,
    "entries" | "registerIfAbsent"
  > = {
    registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    entries: () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
  return { state, values };
}

describe("Codex managed thread store", () => {
  it("records one durable ownership row per home and thread", async () => {
    const { state, values } = createStateStore();
    const store = createCodexManagedThreadStore(state);
    const sourceHomeId = codexCatalogHomeId("/tmp/codex-home");

    await store.mark({ sourceHomeId, threadId: "thread-1", rolloutPath: "/rollout.jsonl" });
    await store.mark({ sourceHomeId, threadId: "thread-1", rolloutPath: "/new-path.jsonl" });

    expect(values.size).toBe(1);
    expect([...values.values()][0]).toMatchObject({
      kind: "managed-thread",
      sourceHomeId,
      threadId: "thread-1",
      rolloutPath: "/rollout.jsonl",
    });
    await expect(store.snapshot()).resolves.toEqual(
      new Map([[sourceHomeId, new Set(["thread-1"])]]),
    );
  });

  it("ignores malformed rows when building a snapshot", async () => {
    const { state, values } = createStateStore();
    values.set("malformed", {
      version: 1,
      kind: "managed-thread",
    } as unknown as StoredCodexManagedThread);

    await expect(createCodexManagedThreadStore(state).snapshot()).resolves.toEqual(new Map());
  });

  it("uses the same source identity for a symlinked configured home", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-id-")));
    try {
      const home = path.join(root, "home");
      const alias = path.join(root, "alias");
      await fs.mkdir(home);
      await fs.symlink(home, alias, process.platform === "win32" ? "junction" : "dir");

      expect(codexCatalogHomeId(alias)).toBe(codexCatalogHomeId(home));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
