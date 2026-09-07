import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { markdownToIRWithMeta } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildQaConfidenceReport, renderQaConfidenceMarkdownReport } from "./confidence-report.js";

describe("qa confidence report Markdown", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-confidence-markdown-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it.each([
    {
      name: "ordinary priorities",
      productImpact: "P1",
      qaImpact: "P2",
      expectedImpacts: ["P1", "P2"],
    },
    {
      name: "a product-impact pipe",
      productImpact: "P1 | desktop",
      qaImpact: "P2",
      expectedImpacts: ["P1 | desktop", "P2"],
    },
    {
      name: "a QA-impact pipe",
      productImpact: "P1",
      qaImpact: "P2 | harness",
      expectedImpacts: ["P1", "P2 | harness"],
    },
    {
      name: "a product-impact backslash and pipe",
      productImpact: String.raw`P1 \| desktop`,
      qaImpact: "P2",
      expectedImpacts: [String.raw`P1 \| desktop`, "P2"],
    },
    {
      name: "a QA-impact backslash and pipe",
      productImpact: "P1",
      qaImpact: String.raw`P2 \| harness`,
      expectedImpacts: ["P1", String.raw`P2 \| harness`],
    },
    {
      name: "a product-impact newline",
      productImpact: "P1\ndesktop",
      qaImpact: "P2",
      expectedImpacts: ["P1 desktop", "P2"],
    },
    {
      name: "a QA-impact newline",
      productImpact: "P1",
      qaImpact: "P2\nharness",
      expectedImpacts: ["P1", "P2 harness"],
    },
  ])(
    "preserves $name in the confidence table",
    async ({ productImpact, qaImpact, expectedImpacts }) => {
      const report = await buildQaConfidenceReport({
        manifest: {
          version: 1,
          profile: "confidence-table",
          lanes: [
            {
              id: "missing",
              title: "Missing",
              kind: "qa-suite-summary",
              artifact: "missing/qa-suite-summary.json",
              required: true,
              missingVerdict: "environment-blocked",
              missingReason: String.raw`path\|fallback unavailable`,
              productImpact,
              qaImpact,
            },
            {
              id: "following-control",
              title: "Following control",
              kind: "qa-suite-summary",
              artifact: "control/qa-suite-summary.json",
              required: true,
              missingVerdict: "environment-blocked",
              missingReason: "Control unavailable.",
              productImpact: "P4",
              qaImpact: "P0",
            },
          ],
        },
        artifactRoot: tempRoot,
        strictGlobalPass: true,
        generatedAt: "2026-05-13T00:00:00.000Z",
      });
      const markdown = renderQaConfidenceMarkdownReport(report);
      const { tables } = markdownToIRWithMeta(markdown, { tableMode: "block" });

      expect(tables).toHaveLength(1);
      expect(tables[0]?.headers).toEqual([
        "Lane",
        "Status",
        "Verdict",
        "Product impact",
        "QA impact",
        "Details",
      ]);
      expect(tables[0]?.rows).toEqual([
        [
          "missing",
          "blocked",
          "environment-blocked",
          ...expectedImpacts,
          String.raw`path\|fallback unavailable`,
        ],
        ["following-control", "blocked", "environment-blocked", "P4", "P0", "Control unavailable."],
      ]);
      expect(report.lanes[0]).toMatchObject({
        productImpact,
        qaImpact,
        details: String.raw`path\|fallback unavailable`,
      });
      expect(report.counts).toEqual({
        total: 2,
        passed: 0,
        failed: 0,
        blocked: 2,
        missing: 0,
        unknown: 0,
      });
      expect(report).toMatchObject({ pass: false, zeroUnknowns: true, globalPass: false });
    },
  );
});
