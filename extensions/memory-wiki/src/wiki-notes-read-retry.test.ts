import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { FsSafeError } from "openclaw/plugin-sdk/security-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMemoryWikiMutation } from "./apply.js";
import { importChatGptConversations } from "./chatgpt-import.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { renderMarkdownFence, renderWikiMarkdown } from "./markdown.js";
import { writeImportedSourcePage } from "./source-page-shared.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const securityRuntimeMock = vi.hoisted(() => ({
  failReadTextOnceFor: undefined as string | undefined,
  failReadTextAlwaysFor: undefined as string | undefined,
  readTextOnceError: new Error("transient existing-page read failure"),
  readTextError: new Error("persistent existing-page read failure"),
  readTextFailureInjected: false,
}));

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  return {
    ...actual,
    root: async (...args: Parameters<typeof actual.root>) => {
      const vault = await actual.root(...args);
      return new Proxy(vault, {
        get(target, prop, receiver) {
          if (prop !== "readText") {
            return Reflect.get(target, prop, receiver);
          }
          return async (relativePath: string) => {
            if (securityRuntimeMock.failReadTextAlwaysFor === relativePath) {
              securityRuntimeMock.readTextFailureInjected = true;
              throw securityRuntimeMock.readTextError;
            }
            if (
              securityRuntimeMock.failReadTextOnceFor === relativePath &&
              !securityRuntimeMock.readTextFailureInjected
            ) {
              securityRuntimeMock.readTextFailureInjected = true;
              throw securityRuntimeMock.readTextOnceError;
            }
            return target.readText(relativePath);
          };
        },
      });
    },
  };
});

const { createTempDir, createVault } = createMemoryWikiTestHarness();

function buildSourcePage(raw: string, updatedAt: string): string {
  return renderWikiMarkdown({
    frontmatter: {
      pageType: "source",
      id: "source.imported",
      title: "imported",
      sourceType: "memory-unsafe-local",
      status: "active",
      updatedAt,
    },
    body: [
      "# imported",
      "",
      "## Content",
      renderMarkdownFence(raw, "text"),
      "",
      "## Notes",
      "<!-- openclaw:human:start -->",
      "<!-- openclaw:human:end -->",
      "",
    ].join("\n"),
  });
}

async function createChatGptImportFixture(prefix: string) {
  const { rootDir, config } = await createVault({ prefix });
  const exportDir = path.join(rootDir, "chatgpt-export");
  await fs.mkdir(exportDir, { recursive: true });
  await fs.writeFile(
    path.join(exportDir, "conversations.json"),
    `${JSON.stringify([
      {
        conversation_id: "12345678-1234-1234-1234-1234567890ab",
        title: "Travel preference check",
        create_time: 1_712_363_200,
        update_time: 1_712_366_800,
        current_node: "assistant-1",
        mapping: {
          root: {},
          "user-1": {
            parent: "root",
            message: {
              author: { role: "user" },
              content: { parts: ["I prefer aisle seats."] },
            },
          },
          "assistant-1": {
            parent: "user-1",
            message: {
              author: { role: "assistant" },
              content: { parts: ["Noted."] },
            },
          },
        },
      },
    ])}\n`,
    "utf8",
  );
  await importChatGptConversations({
    config,
    exportPath: exportDir,
    nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
  });
  const sourceFiles = (await fs.readdir(path.join(rootDir, "sources"))).filter(
    (entry) => entry !== "index.md",
  );
  expect(sourceFiles).toHaveLength(1);
  return {
    config,
    exportDir,
    pagePath: path.join(
      rootDir,
      "sources",
      expectDefined(sourceFiles[0], "imported Memory Wiki source file"),
    ),
  };
}

describe("memory-wiki existing-page read retry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    securityRuntimeMock.failReadTextOnceFor = undefined;
    securityRuntimeMock.failReadTextAlwaysFor = undefined;
    securityRuntimeMock.readTextOnceError = new Error("transient existing-page read failure");
    securityRuntimeMock.readTextError = new Error("persistent existing-page read failure");
    securityRuntimeMock.readTextFailureInjected = false;
  });

  it("preserves ingest notes after a transient existing-page read failure", async () => {
    const rootDir = await createTempDir("memory-wiki-reingest-read-retry-");
    const inputPath = path.join(rootDir, "roadmap.txt");
    const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });

    await fs.writeFile(inputPath, "v1 content\n", "utf8");
    await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    const pagePath = path.join(config.vault.path, "sources", "roadmap.md");
    const userNote = "KEY INSIGHT: covers the Q2 roadmap";
    const edited = (await fs.readFile(pagePath, "utf8")).replace(
      "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
      `<!-- openclaw:human:start -->\n${userNote}\n<!-- openclaw:human:end -->`,
    );
    await fs.writeFile(pagePath, edited, "utf8");

    await fs.writeFile(inputPath, "v2 content updated\n", "utf8");
    const originalReadFile = fs.readFile.bind(fs);
    let injectedFailure = false;
    vi.spyOn(fs, "readFile").mockImplementation(
      async (...args: Parameters<typeof fs.readFile>): ReturnType<typeof fs.readFile> => {
        if (!injectedFailure && args[0] === pagePath && args[1] === "utf8") {
          injectedFailure = true;
          throw new Error("transient existing-page read failure");
        }
        return originalReadFile(...args);
      },
    );

    await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 6, 12, 0, 0),
    });

    const after = await originalReadFile(pagePath, "utf8");
    expect(injectedFailure).toBe(true);
    expect(after).toContain("v2 content updated");
    expect(after).toContain(userNote);
  });

  it("preserves imported notes after a transient existing-page read failure", async () => {
    const suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-source-page-"));
    const sourcePath = path.join(suiteRoot, "imported-retry.txt");
    const pagePath = "sources/imported-retry.md";
    const absPage = path.join(suiteRoot, pagePath);
    const state: Parameters<typeof writeImportedSourcePage>[0]["state"] = {
      entries: {},
      version: 1,
    };

    try {
      await fs.writeFile(sourcePath, "first body", "utf8");
      await writeImportedSourcePage({
        vaultRoot: suiteRoot,
        syncKey: "bridge:imported-retry",
        sourcePath,
        sourceUpdatedAtMs: Date.UTC(2026, 4, 1),
        sourceSize: 10,
        renderFingerprint: "fp-1",
        pagePath,
        group: "bridge",
        state,
        buildRendered: buildSourcePage,
      });

      const userNote = "IMPORTED PAGE NOTE FROM HUMAN";
      const edited = (await fs.readFile(absPage, "utf8")).replace(
        "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
        `<!-- openclaw:human:start -->\n${userNote}\n<!-- openclaw:human:end -->`,
      );
      await fs.writeFile(absPage, edited, "utf8");

      securityRuntimeMock.failReadTextOnceFor = pagePath;

      await fs.writeFile(sourcePath, "second body changed", "utf8");
      const result = await writeImportedSourcePage({
        vaultRoot: suiteRoot,
        syncKey: "bridge:imported-retry",
        sourcePath,
        sourceUpdatedAtMs: Date.UTC(2026, 4, 2),
        sourceSize: 19,
        renderFingerprint: "fp-2",
        pagePath,
        group: "bridge",
        state,
        buildRendered: buildSourcePage,
      });

      const after = await fs.readFile(absPage, "utf8");
      expect(securityRuntimeMock.readTextFailureInjected).toBe(true);
      expect(result.changed).toBe(true);
      expect(after).toContain("second body changed");
      expect(after).toContain(userNote);
    } finally {
      await fs.rm(suiteRoot, { recursive: true, force: true });
    }
  });

  it("leaves imported source pages unchanged after a persistent existing-page read failure", async () => {
    const suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-source-page-"));
    const sourcePath = path.join(suiteRoot, "imported-persistent.txt");
    const pagePath = "sources/imported-persistent.md";
    const absPage = path.join(suiteRoot, pagePath);
    const state: Parameters<typeof writeImportedSourcePage>[0]["state"] = {
      entries: {},
      version: 1,
    };

    try {
      await fs.writeFile(sourcePath, "first body", "utf8");
      await writeImportedSourcePage({
        vaultRoot: suiteRoot,
        syncKey: "bridge:imported-persistent",
        sourcePath,
        sourceUpdatedAtMs: Date.UTC(2026, 4, 1),
        sourceSize: 10,
        renderFingerprint: "fp-1",
        pagePath,
        group: "bridge",
        state,
        buildRendered: buildSourcePage,
      });
      const before = await fs.readFile(absPage, "utf8");

      securityRuntimeMock.failReadTextAlwaysFor = pagePath;

      await fs.writeFile(sourcePath, "second body changed", "utf8");
      await expect(
        writeImportedSourcePage({
          vaultRoot: suiteRoot,
          syncKey: "bridge:imported-persistent",
          sourcePath,
          sourceUpdatedAtMs: Date.UTC(2026, 4, 2),
          sourceSize: 19,
          renderFingerprint: "fp-2",
          pagePath,
          group: "bridge",
          state,
          buildRendered: buildSourcePage,
        }),
      ).rejects.toThrow("persistent existing-page read failure");

      expect(securityRuntimeMock.readTextFailureInjected).toBe(true);
      await expect(fs.readFile(absPage, "utf8")).resolves.toBe(before);
    } finally {
      await fs.rm(suiteRoot, { recursive: true, force: true });
    }
  });

  it("updates ingested source pages when the existing page stays missing across retry", async () => {
    const rootDir = await createTempDir("memory-wiki-reingest-persistent-read-");
    const inputPath = path.join(rootDir, "roadmap.txt");
    const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });

    await fs.writeFile(inputPath, "v1 content\n", "utf8");
    await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    const pagePath = path.join(config.vault.path, "sources", "roadmap.md");
    await fs.writeFile(inputPath, "v2 content updated\n", "utf8");
    const originalReadFile = fs.readFile.bind(fs);
    let remainingExistingPageReadFailures = 2;
    vi.spyOn(fs, "readFile").mockImplementation(
      async (...args: Parameters<typeof fs.readFile>): ReturnType<typeof fs.readFile> => {
        if (remainingExistingPageReadFailures > 0 && args[0] === pagePath && args[1] === "utf8") {
          remainingExistingPageReadFailures -= 1;
          throw Object.assign(new Error("page disappeared"), { code: "ENOENT" });
        }
        return originalReadFile(...args);
      },
    );

    const result = await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 6, 12, 0, 0),
    });

    expect(result.created).toBe(false);
    expect(remainingExistingPageReadFailures).toBe(0);
    await expect(originalReadFile(pagePath, "utf8")).resolves.toContain("v2 content updated");
  });

  it("leaves ingested source pages unchanged after a persistent existing-page read failure", async () => {
    const rootDir = await createTempDir("memory-wiki-reingest-persistent-read-");
    const inputPath = path.join(rootDir, "roadmap.txt");
    const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });

    await fs.writeFile(inputPath, "v1 content\n", "utf8");
    await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    const pagePath = path.join(config.vault.path, "sources", "roadmap.md");
    const before = await fs.readFile(pagePath, "utf8");
    await fs.writeFile(inputPath, "v2 content updated\n", "utf8");
    const originalReadFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(
      async (...args: Parameters<typeof fs.readFile>): ReturnType<typeof fs.readFile> => {
        if (args[0] === pagePath && args[1] === "utf8") {
          throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
        }
        return originalReadFile(...args);
      },
    );

    await expect(
      ingestMemoryWikiSource({
        config,
        inputPath,
        nowMs: Date.UTC(2026, 3, 6, 12, 0, 0),
      }),
    ).rejects.toMatchObject({ code: "EBUSY" });

    await expect(originalReadFile(pagePath, "utf8")).resolves.toBe(before);
  });

  it("preserves synthesis notes and frontmatter after a transient existing-page read failure", async () => {
    const { rootDir, config } = await createVault({ prefix: "memory-wiki-apply-read-retry-" });

    await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Release Plan",
        body: "Initial summary v1.",
        sourceIds: ["source.alpha"],
      },
    });

    const pagePath = path.join(rootDir, "syntheses", "release-plan.md");
    const userNote = "Ship gate: legal sign-off required before GA.";
    let edited = (await fs.readFile(pagePath, "utf8")).replace(
      "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
      `<!-- openclaw:human:start -->\n${userNote}\n<!-- openclaw:human:end -->`,
    );
    edited = edited.replace(/^---\n/, "---\nprivacyTier: sensitive\n");
    await fs.writeFile(pagePath, edited, "utf8");

    securityRuntimeMock.failReadTextOnceFor = "syntheses/release-plan.md";
    securityRuntimeMock.readTextOnceError = new FsSafeError(
      "not-found",
      "page temporarily missing",
    );

    await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Release Plan",
        body: "Updated summary v2.",
        sourceIds: ["source.alpha"],
      },
    });

    const after = await fs.readFile(pagePath, "utf8");
    expect(securityRuntimeMock.readTextFailureInjected).toBe(true);
    expect(after).toContain("Updated summary v2.");
    expect(after).toContain(userNote);
    expect(after).toContain("privacyTier: sensitive");
  });

  it("does not treat a path-alias policy failure as a missing synthesis page", async () => {
    const { rootDir, config } = await createVault({ prefix: "memory-wiki-apply-path-alias-" });

    await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Release Plan",
        body: "Initial summary.",
        sourceIds: ["source.alpha"],
      },
    });

    const pagePath = path.join(rootDir, "syntheses", "release-plan.md");
    const before = await fs.readFile(pagePath, "utf8");
    securityRuntimeMock.failReadTextAlwaysFor = "syntheses/release-plan.md";
    securityRuntimeMock.readTextError = new FsSafeError(
      "path-alias",
      "page resolved outside the vault root",
    );

    await expect(
      applyMemoryWikiMutation({
        config,
        mutation: {
          op: "create_synthesis",
          title: "Release Plan",
          body: "Replacement summary.",
          sourceIds: ["source.alpha"],
        },
      }),
    ).rejects.toMatchObject({ code: "path-alias" });

    expect(securityRuntimeMock.readTextFailureInjected).toBe(true);
    await expect(fs.readFile(pagePath, "utf8")).resolves.toBe(before);
  });

  it("preserves chatgpt conversation notes after a transient existing-page read failure", async () => {
    const { config, exportDir, pagePath } = await createChatGptImportFixture(
      "memory-wiki-chatgpt-read-retry-",
    );
    const userNote = "HUMAN NOTE: verified against the airline booking.";
    const edited = (await fs.readFile(pagePath, "utf8")).replace(
      "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
      `<!-- openclaw:human:start -->\n${userNote}\n<!-- openclaw:human:end -->`,
    );
    await fs.writeFile(pagePath, edited, "utf8");

    const originalReadFile = fs.readFile.bind(fs);
    let injectedFailure = false;
    vi.spyOn(fs, "readFile").mockImplementation(
      async (...args: Parameters<typeof fs.readFile>): ReturnType<typeof fs.readFile> => {
        if (!injectedFailure && args[0] === pagePath && args[1] === "utf8") {
          injectedFailure = true;
          throw Object.assign(new Error("page temporarily missing"), { code: "ENOENT" });
        }
        return originalReadFile(...args);
      },
    );

    const second = await importChatGptConversations({
      config,
      exportPath: exportDir,
      nowMs: Date.UTC(2026, 3, 6, 12, 0, 0),
    });

    const after = await originalReadFile(pagePath, "utf8");
    expect(injectedFailure).toBe(true);
    expect(second.createdCount).toBe(0);
    expect(after).toContain(userNote);
  });

  it("preserves chatgpt conversation notes containing replacement-pattern dollar sequences", async () => {
    const { config, exportDir, pagePath } = await createChatGptImportFixture(
      "memory-wiki-chatgpt-dollar-notes-",
    );
    const userNote = "Energy identity $$E=mc^2$$ and match $& and prefix $` and suffix $' end.";
    const noteBlock = [
      "<!-- openclaw:human:start -->",
      userNote,
      "<!-- openclaw:human:end -->",
    ].join("\n");
    const edited = (await fs.readFile(pagePath, "utf8")).replace(
      "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
      () => noteBlock,
    );
    await fs.writeFile(pagePath, edited, "utf8");

    const second = await importChatGptConversations({
      config,
      exportPath: exportDir,
      nowMs: Date.UTC(2026, 3, 6, 12, 0, 0),
    });

    const after = await fs.readFile(pagePath, "utf8");
    expect(second.createdCount).toBe(0);
    expect(second.updatedCount).toBe(0);
    expect(second.skippedCount).toBe(1);
    expect(after).toContain(userNote);
  });

  it("leaves a ChatGPT page unchanged after a persistent existing-page read failure", async () => {
    const { config, exportDir, pagePath } = await createChatGptImportFixture(
      "memory-wiki-chatgpt-persistent-read-",
    );
    const before = await fs.readFile(pagePath, "utf8");
    const originalReadFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(
      async (...args: Parameters<typeof fs.readFile>): ReturnType<typeof fs.readFile> => {
        if (args[0] === pagePath && args[1] === "utf8") {
          throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
        }
        return originalReadFile(...args);
      },
    );

    await expect(
      importChatGptConversations({
        config,
        exportPath: exportDir,
        nowMs: Date.UTC(2026, 3, 6, 12, 0, 0),
      }),
    ).rejects.toMatchObject({ code: "EBUSY" });

    await expect(originalReadFile(pagePath, "utf8")).resolves.toBe(before);
  });
});
