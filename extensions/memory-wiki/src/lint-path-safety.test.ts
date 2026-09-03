// Memory Wiki tests cover bounded, abortable direct lint path checks.
import fs from "node:fs/promises";
import path from "node:path";
import { root as createFsSafeRoot } from "openclaw/plugin-sdk/file-access-runtime";
import { describe, expect, it, vi } from "vitest";
import { lintMemoryWikiVault } from "./lint.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

vi.mock("openclaw/plugin-sdk/file-access-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/file-access-runtime")>();
  return {
    ...actual,
    root: vi.fn(actual.root),
  };
});

const { createVault } = createMemoryWikiTestHarness();
const FALLBACK_PATH_CHECK_BUDGET = 512;

describe("lintMemoryWikiVault direct path safety", () => {
  it("stops fallback path checks on abort without publishing a lint report", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-vault-wide-abort-",
      config: {
        vault: { renderMode: "obsidian" },
      },
    });
    await Promise.all(
      ["sources", "people"].map((dir) => fs.mkdir(path.join(rootDir, dir), { recursive: true })),
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "references.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.references",
          title: "References",
        },
        body: "# References\n\n[[people/ada-lovelace]]\n[[people/grace-hopper]]\n",
      }),
      "utf8",
    );
    await fs.writeFile(path.join(rootDir, "people", "ada-lovelace.md"), "# Ada Lovelace\n", "utf8");

    const rootMock = vi.mocked(createFsSafeRoot);
    const createRoot = rootMock.getMockImplementation();
    if (!createRoot) {
      throw new Error("file-access root mock has no implementation");
    }
    const abortController = new AbortController();
    let openCalls = 0;
    rootMock.mockImplementationOnce(async (requestedRoot, defaults) => {
      const safeRoot = await createRoot(requestedRoot, defaults);
      const open = safeRoot.open.bind(safeRoot);
      vi.spyOn(safeRoot, "open").mockImplementation(async (...args) => {
        openCalls += 1;
        const opened = await open(...args);
        abortController.abort();
        return opened;
      });
      return safeRoot;
    });

    await expect(lintMemoryWikiVault(config, { signal: abortController.signal })).rejects.toThrow();
    expect(openCalls).toBe(1);
    await expect(fs.stat(path.join(rootDir, "reports", "lint.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails clearly when unique fallback path checks exhaust their budget", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-vault-wide-budget-",
      config: {
        vault: { renderMode: "obsidian" },
      },
    });
    await fs.mkdir(path.join(rootDir, "sources"), { recursive: true });
    const links = Array.from(
      { length: FALLBACK_PATH_CHECK_BUDGET + 1 },
      (_, index) => `[[archive/missing-${index}]]`,
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "references.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.references",
          title: "References",
        },
        body: ["# References", "", ...links].join("\n"),
      }),
      "utf8",
    );

    await expect(lintMemoryWikiVault(config)).rejects.toThrow(
      `Memory Wiki lint fallback path check budget exceeded (${FALLBACK_PATH_CHECK_BUDGET} unique targets)`,
    );
    await expect(fs.stat(path.join(rootDir, "reports", "lint.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not spend the fallback path budget on rejected targets", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-vault-wide-rejected-budget-",
      config: {
        vault: { renderMode: "obsidian" },
      },
    });
    await Promise.all(
      ["sources", "people"].map((dir) => fs.mkdir(path.join(rootDir, dir), { recursive: true })),
    );
    const rejectedLinks = Array.from(
      { length: FALLBACK_PATH_CHECK_BUDGET + 1 },
      (_, index) => `[[.GiT/private-${index}]]`,
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "references.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.references",
          title: "References",
        },
        body: ["# References", "", ...rejectedLinks, "[[people/ada-lovelace]]"].join("\n"),
      }),
      "utf8",
    );
    await fs.writeFile(path.join(rootDir, "people", "ada-lovelace.md"), "# Ada Lovelace\n", "utf8");

    const result = await lintMemoryWikiVault(config);

    expect(result.issues.filter((issue) => issue.code === "broken-wikilink")).toHaveLength(
      rejectedLinks.length,
    );
  });

  it("keeps direct fallback path spelling exact on case-insensitive filesystems", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-vault-wide-exact-case-",
      config: {
        vault: { renderMode: "obsidian" },
      },
    });
    await Promise.all(
      ["sources", "people"].map((dir) => fs.mkdir(path.join(rootDir, dir), { recursive: true })),
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "references.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.references",
          title: "References",
        },
        body: "# References\n\n[[people/Ada-Lovelace]]\n",
      }),
      "utf8",
    );
    await fs.writeFile(path.join(rootDir, "people", "ada-lovelace.md"), "# Ada Lovelace\n", "utf8");

    const rootMock = vi.mocked(createFsSafeRoot);
    const createRoot = rootMock.getMockImplementation();
    if (!createRoot) {
      throw new Error("file-access root mock has no implementation");
    }
    let openCalls = 0;
    rootMock.mockImplementationOnce(async (requestedRoot, defaults) => {
      const safeRoot = await createRoot(requestedRoot, defaults);
      const open = safeRoot.open.bind(safeRoot);
      vi.spyOn(safeRoot, "open").mockImplementation(async (relativePath, options) => {
        openCalls += 1;
        return await open(relativePath.replace("Ada-Lovelace", "ada-lovelace"), options);
      });
      return safeRoot;
    });

    const result = await lintMemoryWikiVault(config);

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "broken-wikilink",
          message: "Broken wikilink target `people/Ada-Lovelace`.",
        }),
      ]),
    );
    expect(openCalls).toBe(1);
  });

  it("resolves a target in a large directory without enumerating its siblings", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-vault-wide-large-directory-",
      config: {
        vault: { renderMode: "obsidian" },
      },
    });
    await Promise.all(
      ["sources", "people"].map((dir) => fs.mkdir(path.join(rootDir, dir), { recursive: true })),
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "references.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.references",
          title: "References",
        },
        body: "# References\n\n[[people/ada-lovelace]]\n",
      }),
      "utf8",
    );
    await Promise.all([
      fs.writeFile(path.join(rootDir, "people", "ada-lovelace.md"), "# Ada Lovelace\n", "utf8"),
      ...Array.from({ length: 2_048 }, (_, index) =>
        fs.writeFile(
          path.join(rootDir, "people", `unrelated-${index}.md`),
          "# Unrelated\n",
          "utf8",
        ),
      ),
    ]);

    const rootMock = vi.mocked(createFsSafeRoot);
    const createRoot = rootMock.getMockImplementation();
    if (!createRoot) {
      throw new Error("file-access root mock has no implementation");
    }
    let listCalls = 0;
    rootMock.mockImplementationOnce(async (requestedRoot, defaults) => {
      const safeRoot = await createRoot(requestedRoot, defaults);
      const list = safeRoot.list.bind(safeRoot);
      vi.spyOn(safeRoot, "list").mockImplementation(async (...args) => {
        listCalls += 1;
        return await list(...args);
      });
      return safeRoot;
    });

    const result = await lintMemoryWikiVault(config);

    expect(result.issues.filter((issue) => issue.code === "broken-wikilink")).toEqual([]);
    expect(listCalls).toBe(0);
  });

  it("propagates path-identity races instead of publishing a broken-link warning", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-vault-wide-path-race-",
      config: {
        vault: { renderMode: "obsidian" },
      },
    });
    await Promise.all(
      ["sources", "people"].map((dir) => fs.mkdir(path.join(rootDir, dir), { recursive: true })),
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "references.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.references",
          title: "References",
        },
        body: "# References\n\n[[people/ada-lovelace]]\n",
      }),
      "utf8",
    );
    await fs.writeFile(path.join(rootDir, "people", "ada-lovelace.md"), "# Ada Lovelace\n", "utf8");

    const rootMock = vi.mocked(createFsSafeRoot);
    const createRoot = rootMock.getMockImplementation();
    if (!createRoot) {
      throw new Error("file-access root mock has no implementation");
    }
    rootMock.mockImplementationOnce(async (requestedRoot, defaults) => {
      const safeRoot = await createRoot(requestedRoot, defaults);
      vi.spyOn(safeRoot, "open").mockRejectedValue(
        Object.assign(new Error("path changed during open"), { code: "path-mismatch" }),
      );
      return safeRoot;
    });

    await expect(lintMemoryWikiVault(config)).rejects.toMatchObject({ code: "path-mismatch" });
    await expect(fs.stat(path.join(rootDir, "reports", "lint.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
