import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as wikiWalk from "./bounded-walk.js";
import { compileMemoryWikiVault } from "./compile.js";
import { renderWikiMarkdown } from "./markdown.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
});

async function createReadVault(relativePath = "sources/alpha.md") {
  const vault = await createVault({
    initialize: true,
    config: { search: { backend: "local", corpus: "wiki" } },
  });
  const targetPath = path.join(vault.rootDir, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(
    targetPath,
    renderWikiMarkdown({
      frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha" },
      body: "# Alpha\n\nreadable line\n",
    }),
  );
  return { ...vault, targetPath, relativePath };
}

describe("wiki query page reads", () => {
  it.each([
    ["sources/alpha.md", "sources/alpha.md"],
    ["  sources\\nested\\alpha.md  ", "sources/nested/alpha.md"],
  ])("reads %s without enumerating unrelated pages", async (lookup, relativePath) => {
    const { rootDir, config } = await createReadVault(relativePath);
    await fs.writeFile(path.join(rootDir, "sources", "unrelated.md"), "---\ninvalid: [\n---\n");
    const readdir = vi.spyOn(fs, "readdir");

    await expect(
      getMemoryWikiPage({ config, lookup, fromLine: 4, lineCount: 1 }),
    ).resolves.toMatchObject({ path: relativePath, content: "readable line", truncated: true });
    expect(readdir).not.toHaveBeenCalled();
  });

  it.each(["large", "hardlinked"] as const)(
    "keeps exact, basename and ID reads equivalent for a %s page",
    async (kind) => {
      const { rootDir, config, targetPath, relativePath } = await createReadVault();
      if (kind === "large") {
        await fs.appendFile(targetPath, ("x".repeat(1023) + "\n").repeat(16 * 1024));
      } else {
        await fs.link(targetPath, path.join(rootDir, "_attachments", "alpha-link.md"));
      }

      for (const lookup of [relativePath, "alpha", "source.alpha"]) {
        await expect(
          getMemoryWikiPage({ config, lookup, fromLine: 4, lineCount: 1 }),
        ).resolves.toMatchObject({ path: relativePath, content: "readable line" });
      }
    },
  );

  it("preserves compiled claim precedence over a matching canonical page path", async () => {
    const { rootDir, config, relativePath } = await createReadVault();
    await fs.writeFile(
      path.join(rootDir, "entities", "claim-owner.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.claim-owner",
          title: "Claim owner",
          claims: [{ id: relativePath, text: "A path-shaped claim ID.", status: "supported" }],
        },
        body: "# Claim owner\n\nClaim evidence.\n",
      }),
    );
    await compileMemoryWikiVault(config);

    await expect(getMemoryWikiPage({ config, lookup: relativePath })).resolves.toMatchObject({
      path: "entities/claim-owner.md",
      id: "entity.claim-owner",
    });
  });

  it.each(["deleted", "directory"] as const)(
    "skips a compiled candidate replaced by %s state",
    async (kind) => {
      const { rootDir, config, relativePath } = await createReadVault();
      const stalePath = path.join(rootDir, "entities", "stale.md");
      await fs.writeFile(
        stalePath,
        renderWikiMarkdown({
          frontmatter: {
            pageType: "entity",
            title: "Alpha stale",
            claims: [{ id: "claim.stale", text: "Alpha evidence.", status: "supported" }],
          },
          body: "# Alpha stale\n",
        }),
      );
      await compileMemoryWikiVault(config);
      await fs.unlink(stalePath);
      if (kind === "directory") {
        await fs.mkdir(stalePath);
      }

      const results = await searchMemoryWiki({ config, query: "Alpha" });
      expect(results.some((page) => page.path === relativePath)).toBe(true);
      expect(results.some((page) => page.path === "entities/stale.md")).toBe(false);
      await expect(getMemoryWikiPage({ config, lookup: "claim.stale" })).resolves.toBeNull();
    },
  );

  it.each(["absent", "invalid", "directory"] as const)(
    "retains ID fallback when the canonical candidate is %s",
    async (kind) => {
      const { rootDir, config, targetPath, relativePath } = await createReadVault();
      await fs.unlink(targetPath);
      if (kind === "invalid") {
        await fs.writeFile(targetPath, "---\npageType: [\n---\n");
      } else if (kind === "directory") {
        await fs.mkdir(targetPath);
      }
      await fs.writeFile(
        path.join(rootDir, "sources", "fallback.md"),
        renderWikiMarkdown({
          frontmatter: { pageType: "source", id: relativePath, title: "Fallback" },
          body: "# Fallback\n",
        }),
      );

      await expect(getMemoryWikiPage({ config, lookup: relativePath })).resolves.toMatchObject({
        path: "sources/fallback.md",
      });
    },
  );

  it.each([
    { owners: ["main"], visible: true },
    { owners: ["secondary"], visible: false },
    { owners: [], visible: false },
  ])("keeps exact bridge-page visibility for $owners", async ({ owners, visible }) => {
    const { config, targetPath, relativePath } = await createReadVault();
    await fs.writeFile(
      targetPath,
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.alpha",
          title: "Alpha",
          sourceType: "memory-bridge",
          bridgeAgentIds: owners,
        },
        body: "# Alpha\n",
      }),
    );
    const result = await getMemoryWikiPage({
      config,
      lookup: relativePath,
      appConfig: { agents: { list: [{ id: "main", default: true }, { id: "secondary" }] } },
      agentId: "main",
      sandboxed: true,
    });
    if (visible) {
      expect(result?.path).toBe(relativePath);
    } else {
      expect(result).toBeNull();
    }
  });

  it.each(["exact", "basename", "search"] as const)(
    "rejects a page swapped outside the vault during %s reads",
    async (route) => {
      const { rootDir, config, targetPath, relativePath } = await createReadVault();
      const outside = await createReadVault();
      const canonicalTarget = await fs.realpath(targetPath);
      await fs.writeFile(
        outside.targetPath,
        (await fs.readFile(outside.targetPath, "utf8")).replace(
          "readable line",
          "outside-vault marker",
        ),
      );
      let swapped = false;
      const swap = async () => {
        if (swapped) {
          return;
        }
        swapped = true;
        await fs.unlink(targetPath);
        await fs.symlink(outside.targetPath, targetPath);
      };
      if (route === "exact") {
        __setFsSafeTestHooksForTest({
          beforeOpen: async (filePath) => {
            if (path.resolve(filePath) === canonicalTarget) {
              await swap();
            }
          },
        });
      } else {
        const walk = wikiWalk.walkMemoryWikiDirectory;
        vi.spyOn(wikiWalk, "walkMemoryWikiDirectory").mockImplementation(async (...args) => {
          const entries = await walk(...args);
          if (args[0] === rootDir && entries.some((entry) => entry.relativePath === relativePath)) {
            await swap();
          }
          return entries;
        });
      }
      const readdir = vi.spyOn(fs, "readdir");
      const read =
        route === "search"
          ? searchMemoryWiki({ config, query: "Alpha" })
          : getMemoryWikiPage({ config, lookup: route === "exact" ? relativePath : "alpha" });

      await expect(read).rejects.toMatchObject({
        name: "FsSafeError",
        code: expect.stringMatching(/symlink|path-mismatch/u),
      });
      expect(swapped).toBe(true);
      if (route === "exact") {
        expect(readdir).not.toHaveBeenCalled();
      }
    },
  );
});
