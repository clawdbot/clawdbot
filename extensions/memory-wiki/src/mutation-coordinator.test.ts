import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir } = createMemoryWikiTestHarness();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("withMemoryWikiVaultMutation", () => {
  it("serializes mutations for one vault and permits nested work", async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];

    const first = withMemoryWikiVaultMutation("/tmp/wiki-a", async () => {
      order.push("first:start");
      firstEntered.resolve();
      await withMemoryWikiVaultMutation("/tmp/wiki-a", async () => {
        order.push("first:nested");
      });
      await releaseFirst.promise;
      order.push("first:end");
    });
    await firstEntered.promise;

    const second = withMemoryWikiVaultMutation("/tmp/wiki-a", async () => {
      order.push("second");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first:start", "first:nested"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:nested", "first:end", "second"]);
  });

  it("allows distinct agent vaults to mutate in parallel", async () => {
    const firstEntered = deferred();
    const secondEntered = deferred();
    const releaseFirst = deferred();

    const first = withMemoryWikiVaultMutation("/tmp/wiki/support", async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;
    const second = withMemoryWikiVaultMutation("/tmp/wiki/marketing", async () => {
      secondEntered.resolve();
    });

    await secondEntered.promise;
    releaseFirst.resolve();
    await Promise.all([first, second]);
  });

  it("serializes physical aliases of one vault", async () => {
    const root = await createTempDir("memory-wiki-vault-alias-");
    const vaultPath = path.join(root, "vault");
    const aliasPath = path.join(root, "vault-alias");
    await fs.mkdir(vaultPath);
    await fs.symlink(vaultPath, aliasPath, process.platform === "win32" ? "junction" : "dir");
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let aliasEntered = false;
    let first: Promise<void> | undefined;
    let alias: Promise<void> | undefined;

    try {
      first = withMemoryWikiVaultMutation(vaultPath, async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
      });
      await firstEntered.promise;
      alias = withMemoryWikiVaultMutation(aliasPath, async () => {
        aliasEntered = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(aliasEntered).toBe(false);

      releaseFirst.resolve();
      await Promise.all([first, alias]);
      expect(aliasEntered).toBe(true);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, alias].filter((item) => item !== undefined));
    }
  });

  it("queues detached work after its inherited transaction has ended", async () => {
    const releaseDetached = deferred();
    const holderEntered = deferred();
    const releaseHolder = deferred();
    let detachedEntered = false;
    let detached!: Promise<void>;

    await withMemoryWikiVaultMutation("/tmp/wiki-detached", async () => {
      detached = (async () => {
        await releaseDetached.promise;
        await withMemoryWikiVaultMutation("/tmp/wiki-detached", async () => {
          detachedEntered = true;
        });
      })();
    });

    const holder = withMemoryWikiVaultMutation("/tmp/wiki-detached", async () => {
      holderEntered.resolve();
      await releaseHolder.promise;
    });
    await holderEntered.promise;
    releaseDetached.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(detachedEntered).toBe(false);

    releaseHolder.resolve();
    await Promise.all([holder, detached]);
    expect(detachedEntered).toBe(true);
  });
});
