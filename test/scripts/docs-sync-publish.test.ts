import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderDocsHeadingMap } from "../../scripts/docs-list.js";
import {
  composeDocsConfig,
  parseArgs,
  reportOrphanLocaleDocs,
  writePublishedDocsMap,
} from "../../scripts/docs-sync-publish.mjs";

function collectPages(entry: unknown, pages: string[] = []): string[] {
  if (typeof entry === "string") {
    pages.push(entry);
    return pages;
  }
  if (Array.isArray(entry)) {
    for (const item of entry) {
      collectPages(item, pages);
    }
    return pages;
  }
  if (!entry || typeof entry !== "object") {
    return pages;
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.page === "string") {
    pages.push(record.page);
  }
  collectPages(record.pages, pages);
  collectPages(record.groups, pages);
  collectPages(record.tabs, pages);
  return pages;
}

describe("docs-sync-publish", () => {
  it("materializes the public docs map only in the publish tree", () => {
    const targetDocsDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docs-map-publish-"));
    try {
      const outputPath = writePublishedDocsMap(targetDocsDir);
      expect(fs.readFileSync(outputPath, "utf8")).toBe(
        renderDocsHeadingMap(path.resolve(import.meta.dirname, "../../docs")),
      );
    } finally {
      fs.rmSync(targetDocsDir, { recursive: true, force: true });
    }
  });

  it("parses docs sync provenance args", () => {
    expect(
      parseArgs([
        "--target",
        "generated-docs",
        "--source-repo",
        "openclaw/openclaw",
        "--source-sha",
        "abc123",
        "--clawhub-repo",
        "../clawhub",
        "--clawhub-source-repo",
        "openclaw/clawhub",
        "--clawhub-source-sha",
        "def456",
      ]),
    ).toMatchObject({
      clawhubRepo: "../clawhub",
      clawhubSourceRepo: "openclaw/clawhub",
      clawhubSourceSha: "def456",
      sourceRepo: "openclaw/openclaw",
      sourceSha: "abc123",
      target: "generated-docs",
    });
  });

  it("rejects missing docs sync option values", () => {
    for (const flag of [
      "--target",
      "--source-repo",
      "--source-sha",
      "--clawhub-repo",
      "--clawhub-source-repo",
      "--clawhub-source-sha",
    ]) {
      expect(() => parseArgs([flag])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([flag, "--target", "generated-docs"])).toThrow(
        `${flag} requires a value`,
      );
      expect(() => parseArgs([flag, "-h"])).toThrow(`${flag} requires a value`);
    }
  });

  it("defers orphan locale deletion to translation finalization", () => {
    const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docs-sync-"));
    const mirroredEnglish = path.join(docsDir, "clawhub", "api.md");
    const localizedMirror = path.join(docsDir, "de", "clawhub", "api.md");
    const orphan = path.join(docsDir, "de", "removed.md");

    fs.mkdirSync(path.dirname(mirroredEnglish), { recursive: true });
    fs.mkdirSync(path.dirname(localizedMirror), { recursive: true });
    fs.writeFileSync(mirroredEnglish, "# ClawHub API\n");
    fs.writeFileSync(localizedMirror, "# ClawHub-API\n");
    fs.writeFileSync(orphan, "# Removed\n");

    try {
      expect(reportOrphanLocaleDocs(docsDir)).toBe(1);
      expect(fs.existsSync(localizedMirror)).toBe(true);
      expect(fs.existsSync(orphan)).toBe(true);
    } finally {
      fs.rmSync(docsDir, { recursive: true, force: true });
    }
  });

  it("keeps generated locale navigation aligned with English routes", () => {
    const config = composeDocsConfig() as {
      navigation: {
        languages: Array<{
          language: string;
          tabs: Array<{
            tab: string;
            groups?: Array<{ group: string; pages?: unknown }>;
          }>;
        }>;
      };
    };
    const english = config.navigation.languages.find((entry) => entry.language === "en");
    const simplifiedChinese = config.navigation.languages.find(
      (entry) => entry.language === "zh-Hans",
    );
    const german = config.navigation.languages.find((entry) => entry.language === "de");

    expect(english).toBeDefined();
    expect(simplifiedChinese).toBeDefined();
    expect(german).toBeDefined();
    expect(english!.tabs.slice(-4).map((tab) => tab.tab)).toEqual([
      "Gateway & Ops",
      "Reference",
      "Release & CI",
      "Help",
    ]);

    const releaseRoutes = [
      "releases/index",
      "releases/2026.7.1",
      "releases/2026.6.11",
      "maturity/scorecard",
      "maturity/taxonomy",
      "reference/RELEASING",
      "reference/full-release-validation",
      "reference/release-performance-sweep",
      "reference/test",
      "ci",
      "help/scripts",
    ];
    const releaseTab = english!.tabs.find((tab) => tab.tab === "Release & CI");
    expect(collectPages(releaseTab)).toEqual(releaseRoutes);

    const englishWithoutClawHub = {
      ...english,
      tabs: english!.tabs.filter((tab) => tab.tab !== "ClawHub"),
    };
    const expectedZhPages = collectPages(englishWithoutClawHub)
      .map((page) => `zh-CN/${page}`)
      .toSorted();
    expect(collectPages(simplifiedChinese).toSorted()).toEqual(expectedZhPages);
    expect(simplifiedChinese!.tabs[0]?.tab).toBe("快速开始");
    expect(simplifiedChinese!.tabs[0]?.groups?.[0]?.group).toBe("首页");
    const simplifiedChineseReleaseTab = simplifiedChinese!.tabs.find(
      (tab) => tab.tab === "发布与 CI",
    );
    expect(simplifiedChineseReleaseTab?.groups?.[0]?.group).toBe("发布策略");
    expect(collectPages(simplifiedChineseReleaseTab)).toEqual(
      releaseRoutes.map((page) => `zh-CN/${page}`),
    );

    expect(collectPages(german)).toHaveLength(collectPages(englishWithoutClawHub).length);
    expect(german!.tabs[0]?.tab).toBe("Loslegen");
    expect(german!.tabs[0]?.groups?.[0]?.group).toBe("Überblick");
  });
});
