import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listMemoryWikiImportInsights } from "./import-insights.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("listMemoryWikiImportInsights", () => {
  it("clusters ChatGPT import pages by topic and extracts digest fields", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-import-insights-",
      initialize: true,
    });
    await fs.mkdir(path.join(rootDir, "sources"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "sources", "chatgpt-travel.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.chatgpt.travel",
          title: "ChatGPT Export: BA flight receipts process",
          sourceType: "chatgpt-export",
          riskLevel: "low",
          riskReasons: [],
          labels: ["domain/personal", "area/travel", "topic/travel"],
          createdAt: "2026-01-11T14:07:58.552Z",
          updatedAt: "2026-01-11T14:08:45.377Z",
        },
        body: [
          "# ChatGPT Export: BA flight receipts process",
          "",
          "## Auto Digest",
          "- User messages: 2",
          "- Assistant messages: 2",
          "- First user line: how do i get receipts?",
          "- Last user line: that option does not exist",
          "- Preference signals:",
          "  - prefers direct airline receipts",
          "",
          "## Active Branch Transcript",
          "### User",
          "",
          "how do i get receipts?",
          "",
          "### Assistant",
          "",
          "Try the BA receipt request flow first.",
          "",
        ].join("\n"),
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "chatgpt-health.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.chatgpt.health",
          title: "ChatGPT Export: Migraine Medication Advice",
          sourceType: "chatgpt-export",
          riskLevel: "high",
          riskReasons: ["health"],
          labels: ["domain/personal", "area/health", "topic/health"],
          updatedAt: "2026-01-31T20:18:00.000Z",
        },
        body: [
          "# ChatGPT Export: Migraine Medication Advice",
          "",
          "## Auto Digest",
          "- Auto digest withheld from durable-candidate generation until reviewed.",
          "- Risk reasons: health content",
          "- First user line: i have a migraine, pink or yellow?",
          "- Last user line: should i take this now?",
          "- Preference signals:",
          "  - prefers color-coded medication guidance",
          "",
          "## Active Branch Transcript",
          "### User",
          "",
          "i have a migraine, pink or yellow?",
          "",
          "### Assistant",
          "",
          "You're right, let's reset and stick to safe dosing guidance.",
          "",
        ].join("\n"),
      }),
      "utf8",
    );

    const result = await listMemoryWikiImportInsights(config);

    expect(result.sourceType).toBe("chatgpt");
    expect(result.totalItems).toBe(2);
    expect(result.totalClusters).toBe(2);
    expect(result.clusters[0]).toMatchObject({
      key: "topic/health",
      label: "Health",
      itemCount: 1,
      highRiskCount: 1,
      withheldCount: 1,
    });
    expect(result.clusters[1]).toMatchObject({
      key: "topic/travel",
      label: "Travel",
      itemCount: 1,
      preferenceSignalCount: 1,
    });
    expect(result.clusters[1]?.items[0]).toMatchObject({
      title: "BA flight receipts process",
      riskReasons: [],
      activeBranchMessages: 0,
      userMessageCount: 2,
      assistantMessageCount: 2,
      firstUserLine: "how do i get receipts?",
      lastUserLine: "that option does not exist",
      assistantOpener: "Try the BA receipt request flow first.",
      summary: "Try the BA receipt request flow first.",
      candidateSignals: ["prefers direct airline receipts"],
      correctionSignals: [],
      preferenceSignals: ["prefers direct airline receipts"],
      digestStatus: "available",
    });
    const healthItem = result.clusters
      .flatMap((cluster) => cluster.items)
      .find((item) => item.title === "Migraine Medication Advice");
    expect(healthItem).toMatchObject({
      summary:
        "Sensitive health chat withheld from durable-memory extraction because it touches health.",
      candidateSignals: [],
      correctionSignals: [],
      preferenceSignals: [],
      userMessageCount: 1,
      assistantMessageCount: 1,
    });
    expect(healthItem?.firstUserLine).toBeUndefined();
    expect(healthItem?.lastUserLine).toBeUndefined();
    expect(healthItem?.assistantOpener).toBeUndefined();
  });
});
