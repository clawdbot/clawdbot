// Memory Wiki tests cover source page shared plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMarkdownFence, renderWikiMarkdown } from "./markdown.js";
import { writeImportedSourcePage } from "./source-page-shared.js";

const { fsRootMock } = vi.hoisted(() => ({ fsRootMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  return {
    ...actual,
    root: (...args: Parameters<typeof actual.root>) => {
      fsRootMock(args[0]);
      return actual.root(...args);
    },
  };
});

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

describe("writeImportedSourcePage", () => {
  let suiteRoot: string;

  beforeEach(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-source-page-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    fsRootMock.mockClear();
    await fs.rm(suiteRoot, { recursive: true, force: true });
  });

  it("falls back when the source mtime is outside the Date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    const sourcePath = path.join(suiteRoot, "source.txt");
    await fs.writeFile(sourcePath, "source body", "utf8");
    const state: Parameters<typeof writeImportedSourcePage>[0]["state"] = {
      entries: {},
      version: 1,
    };

    const result = await writeImportedSourcePage({
      vaultRoot: suiteRoot,
      syncKey: "unsafe:source",
      sourcePath,
      sourceUpdatedAtMs: 8_700_000_000_000_000,
      sourceSize: 11,
      renderFingerprint: "fingerprint",
      pagePath: "pages/source.md",
      group: "unsafe-local",
      state,
      buildRendered: (raw, updatedAt) => `updatedAt: ${updatedAt}\n${raw}`,
    });

    await expect(fs.readFile(path.join(suiteRoot, "pages/source.md"), "utf8")).resolves.toBe(
      "updatedAt: 2026-05-01T12:00:00.000Z\nsource body",
    );
    expect(result).toEqual({ pagePath: "pages/source.md", changed: true, created: true });
    expect(state.entries["unsafe:source"]?.sourceUpdatedAtMs).toBe(8_700_000_000_000_000);
  });

  it("skips 1,914 unchanged pages before opening the guarded vault", async () => {
    const sourcePath = path.join(suiteRoot, "unchanged-source.md");
    const pagePath = "sources/unchanged.md";
    const pageAbsolutePath = path.join(suiteRoot, pagePath);
    await fs.mkdir(path.dirname(pageAbsolutePath), { recursive: true });
    await fs.writeFile(pageAbsolutePath, "already imported", "utf8");
    const entry = {
      group: "bridge" as const,
      pagePath,
      sourcePath,
      sourceUpdatedAtMs: 123,
      sourceSize: 456,
      renderFingerprint: "unchanged",
    };
    const syncKeys = Array.from({ length: 1_914 }, (_, index) => `bridge:${index}`);
    const state: Parameters<typeof writeImportedSourcePage>[0]["state"] = {
      version: 1,
      entries: Object.fromEntries(syncKeys.map((syncKey) => [syncKey, { ...entry }])),
    };
    const buildRendered = vi.fn();
    fsRootMock.mockClear();

    const results = await Promise.all(
      syncKeys.map((syncKey) =>
        writeImportedSourcePage({
          vaultRoot: suiteRoot,
          syncKey,
          sourcePath,
          sourceUpdatedAtMs: entry.sourceUpdatedAtMs,
          sourceSize: entry.sourceSize,
          renderFingerprint: entry.renderFingerprint,
          pagePath,
          group: "bridge",
          state,
          buildRendered,
        }),
      ),
    );

    expect(fsRootMock).not.toHaveBeenCalled();
    expect(buildRendered).not.toHaveBeenCalled();
    expect(results).toHaveLength(1_914);
    expect(results.every((result) => !result.changed && !result.created)).toBe(true);
  });

  it("recreates an unchanged source entry when its page is missing", async () => {
    const sourcePath = path.join(suiteRoot, "missing-page-source.md");
    const pagePath = "sources/missing.md";
    await fs.writeFile(sourcePath, "restored body", "utf8");
    const state: Parameters<typeof writeImportedSourcePage>[0]["state"] = {
      version: 1,
      entries: {
        missing: {
          group: "bridge",
          pagePath,
          sourcePath,
          sourceUpdatedAtMs: 123,
          sourceSize: 13,
          renderFingerprint: "missing",
        },
      },
    };
    fsRootMock.mockClear();

    const result = await writeImportedSourcePage({
      vaultRoot: suiteRoot,
      syncKey: "missing",
      sourcePath,
      sourceUpdatedAtMs: 123,
      sourceSize: 13,
      renderFingerprint: "missing",
      pagePath,
      group: "bridge",
      state,
      buildRendered: (raw) => raw,
    });

    expect(result).toEqual({ pagePath, changed: true, created: true });
    expect(fsRootMock).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(path.join(suiteRoot, pagePath), "utf8")).resolves.toBe(
      "restored body",
    );
  });

  it("preserves the human Notes block when an imported source page is updated", async () => {
    const sourcePath = path.join(suiteRoot, "imported.txt");
    const pagePath = "sources/imported.md";
    const state: Parameters<typeof writeImportedSourcePage>[0]["state"] = {
      entries: {},
      version: 1,
    };

    await fs.writeFile(sourcePath, "first body", "utf8");
    await writeImportedSourcePage({
      vaultRoot: suiteRoot,
      syncKey: "bridge:imported",
      sourcePath,
      sourceUpdatedAtMs: Date.UTC(2026, 4, 1),
      sourceSize: 10,
      renderFingerprint: "fp-1",
      pagePath,
      group: "bridge",
      state,
      buildRendered: buildSourcePage,
    });

    const absPage = path.join(suiteRoot, pagePath);
    const userNote = "IMPORTED PAGE NOTE";
    const edited = (await fs.readFile(absPage, "utf8")).replace(
      "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
      `<!-- openclaw:human:start -->\n${userNote}\n<!-- openclaw:human:end -->`,
    );
    await fs.writeFile(absPage, edited, "utf8");

    await fs.writeFile(sourcePath, "second body changed", "utf8");
    const result = await writeImportedSourcePage({
      vaultRoot: suiteRoot,
      syncKey: "bridge:imported",
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
    expect(result.changed).toBe(true);
    expect(after).toContain("second body changed");
    expect(after).toContain(userNote);
  });

  it("preserves CRLF human notes without copying marker comments from existing imported content", async () => {
    const sourcePath = path.join(suiteRoot, "imported-crlf.txt");
    const pagePath = "sources/imported-crlf.md";
    const state: Parameters<typeof writeImportedSourcePage>[0]["state"] = {
      entries: {},
      version: 1,
    };

    const sourceWithMarkers = [
      "first imported body",
      "<!-- openclaw:human:start -->",
      "OLD IMPORTED SOURCE MARKER PAYLOAD",
      "<!-- openclaw:human:end -->",
      "",
    ].join("\n");
    await fs.writeFile(sourcePath, sourceWithMarkers, "utf8");
    await writeImportedSourcePage({
      vaultRoot: suiteRoot,
      syncKey: "bridge:imported-crlf",
      sourcePath,
      sourceUpdatedAtMs: Date.UTC(2026, 4, 1),
      sourceSize: sourceWithMarkers.length,
      renderFingerprint: "fp-1",
      pagePath,
      group: "bridge",
      state,
      buildRendered: buildSourcePage,
    });

    const absPage = path.join(suiteRoot, pagePath);
    const userNote = "CRLF IMPORTED PAGE NOTE";
    const edited = (await fs.readFile(absPage, "utf8")).replace(
      "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
      `<!-- openclaw:human:start -->\n${userNote}\n<!-- openclaw:human:end -->`,
    );
    await fs.writeFile(absPage, edited.replace(/\n/g, "\r\n"), "utf8");

    await fs.writeFile(sourcePath, "second imported body without marker comments", "utf8");
    const result = await writeImportedSourcePage({
      vaultRoot: suiteRoot,
      syncKey: "bridge:imported-crlf",
      sourcePath,
      sourceUpdatedAtMs: Date.UTC(2026, 4, 2),
      sourceSize: 44,
      renderFingerprint: "fp-2",
      pagePath,
      group: "bridge",
      state,
      buildRendered: buildSourcePage,
    });

    const after = await fs.readFile(absPage, "utf8");
    const notesBlock = after.slice(after.indexOf("## Notes"));
    expect(result.changed).toBe(true);
    expect(after).toContain("second imported body without marker comments");
    expect(notesBlock).toContain(userNote);
    expect(notesBlock).not.toContain("OLD IMPORTED SOURCE MARKER PAYLOAD");
  });
});
