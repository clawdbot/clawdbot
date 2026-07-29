import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ingestMemoryWikiSource } from "./ingest.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();

describe("ingestMemoryWikiSource human notes", () => {
  it("preserves user notes when the same source is re-ingested", async () => {
    const rootDir = await createTempDir("memory-wiki-reingest-");
    const inputPath = path.join(rootDir, "roadmap.txt");
    const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });

    await fs.writeFile(inputPath, "v1 content\n", "utf8");
    await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    const pagePath = path.join(config.vault.path, "sources", "roadmap.md");
    const userNote = "KEY INSIGHT: covers $1 of the Q2 roadmap";
    const edited = (await fs.readFile(pagePath, "utf8")).replace(
      "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
      `<!-- openclaw:human:start -->\n${userNote}\n<!-- openclaw:human:end -->`,
    );
    await fs.writeFile(pagePath, edited, "utf8");

    await fs.writeFile(inputPath, "v2 content updated\n", "utf8");
    await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 6, 12, 0, 0),
    });

    const after = await fs.readFile(pagePath, "utf8");
    expect(after).toContain("v2 content updated");
    expect(after).toContain(userNote);
  });

  it("preserves notes without corrupting source content that contains human markers", async () => {
    const rootDir = await createTempDir("memory-wiki-markers-");
    const inputPath = path.join(rootDir, "notes.txt");
    const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });

    await fs.writeFile(inputPath, "first body\n", "utf8");
    await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    const pagePath = path.join(config.vault.path, "sources", "notes.md");
    const userNote = "MY PRIVATE NOTE";
    const edited = (await fs.readFile(pagePath, "utf8")).replace(
      "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
      `<!-- openclaw:human:start -->\n${userNote}\n<!-- openclaw:human:end -->`,
    );
    await fs.writeFile(pagePath, edited, "utf8");

    const sourceWithMarkers = [
      "second body",
      "<!-- openclaw:human:start -->",
      "INJECTED FROM SOURCE",
      "<!-- openclaw:human:end -->",
      "",
    ].join("\n");
    await fs.writeFile(inputPath, sourceWithMarkers, "utf8");
    await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 6, 12, 0, 0),
    });

    const after = await fs.readFile(pagePath, "utf8");
    const notesBlock = after.slice(after.indexOf("## Notes"));
    expect(after).toContain("INJECTED FROM SOURCE");
    expect(notesBlock).toContain(userNote);
    expect(notesBlock).not.toContain("INJECTED FROM SOURCE");
  });

  it("preserves CRLF notes without copying marker comments from existing source content", async () => {
    const rootDir = await createTempDir("memory-wiki-crlf-markers-");
    const inputPath = path.join(rootDir, "windows-notes.txt");
    const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });

    const sourceWithMarkers = [
      "first body",
      "<!-- openclaw:human:start -->",
      "OLD SOURCE MARKER PAYLOAD",
      "<!-- openclaw:human:end -->",
      "",
    ].join("\n");
    await fs.writeFile(inputPath, sourceWithMarkers, "utf8");
    await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    const pagePath = path.join(config.vault.path, "sources", "windows-notes.md");
    const userNote = "CRLF USER NOTE";
    const edited = (await fs.readFile(pagePath, "utf8")).replace(
      "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
      `<!-- openclaw:human:start -->\n${userNote}\n<!-- openclaw:human:end -->`,
    );
    await fs.writeFile(pagePath, edited.replace(/\n/g, "\r\n"), "utf8");

    await fs.writeFile(inputPath, "second body without marker comments\n", "utf8");
    await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 6, 12, 0, 0),
    });

    const after = await fs.readFile(pagePath, "utf8");
    const notesBlock = after.slice(after.indexOf("## Notes"));
    expect(after).toContain("second body without marker comments");
    expect(notesBlock).toContain(userNote);
    expect(notesBlock).not.toContain("OLD SOURCE MARKER PAYLOAD");
  });

  it("preserves the whole note when the note text itself contains a marker comment", async () => {
    const rootDir = await createTempDir("memory-wiki-innermarker-");
    const inputPath = path.join(rootDir, "diary.txt");
    const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });

    await fs.writeFile(inputPath, "first body\n", "utf8");
    await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    const pagePath = path.join(config.vault.path, "sources", "diary.md");
    const noteWithMarker = [
      "EARLY NOTE before any quoted marker",
      "<!-- openclaw:human:start -->",
      "LATE NOTE after a pasted marker",
    ].join("\n");
    const edited = (await fs.readFile(pagePath, "utf8")).replace(
      "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
      `<!-- openclaw:human:start -->\n${noteWithMarker}\n<!-- openclaw:human:end -->`,
    );
    await fs.writeFile(pagePath, edited, "utf8");

    await fs.writeFile(inputPath, "second body\n", "utf8");
    await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 6, 12, 0, 0),
    });

    const after = await fs.readFile(pagePath, "utf8");
    expect(after).toContain("second body");
    expect(after).toContain("EARLY NOTE before any quoted marker");
    expect(after).toContain("LATE NOTE after a pasted marker");
  });

  it("preserves the note when the note text contains a Markdown heading", async () => {
    const rootDir = await createTempDir("memory-wiki-heading-");
    const inputPath = path.join(rootDir, "log.txt");
    const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });

    await fs.writeFile(inputPath, "first body\n", "utf8");
    await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    const pagePath = path.join(config.vault.path, "sources", "log.md");
    const noteWithHeading = ["NOTE TOP", "## Notes", "NOTE BOTTOM under a pasted heading"].join(
      "\n",
    );
    const edited = (await fs.readFile(pagePath, "utf8")).replace(
      "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
      `<!-- openclaw:human:start -->\n${noteWithHeading}\n<!-- openclaw:human:end -->`,
    );
    await fs.writeFile(pagePath, edited, "utf8");

    await fs.writeFile(inputPath, "second body\n", "utf8");
    await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 6, 12, 0, 0),
    });

    const after = await fs.readFile(pagePath, "utf8");
    expect(after).toContain("second body");
    expect(after).toContain("NOTE TOP");
    expect(after).toContain("NOTE BOTTOM under a pasted heading");
  });
});
