import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTelegramEvidenceManifest,
  renderTelegramEvidenceHtml,
  writeTelegramEvidence,
} from "../../scripts/mantis/build-telegram-evidence.mjs";
import { loadEvidenceManifest } from "../../scripts/mantis/publish-pr-evidence.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTelegramOutput() {
  const dir = mkdtempSync(path.join(tmpdir(), "mantis-telegram-evidence-test-"));
  tempDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "telegram-qa-summary.json"),
    JSON.stringify({
      credentials: { source: "convex", kind: "telegram", role: "ci" },
      groupId: "<redacted>",
      startedAt: "2026-05-10T00:00:00.000Z",
      finishedAt: "2026-05-10T00:00:05.000Z",
      cleanupIssues: [],
      counts: { total: 1, passed: 1, failed: 0 },
      scenarios: [
        {
          id: "telegram-status-command",
          title: "Telegram status command reply",
          status: "pass",
          details: "Observed expected status response.",
          rttMs: 1234,
        },
      ],
    }),
  );
  writeFileSync(
    path.join(dir, "telegram-qa-observed-messages.json"),
    JSON.stringify([
      {
        scenarioId: "telegram-status-command",
        scenarioTitle: "Telegram status command reply",
        senderIsBot: true,
        text: "<status ok>",
        inlineButtons: ["Open"],
        mediaKinds: [],
      },
    ]),
  );
  writeFileSync(path.join(dir, "telegram-qa-report.md"), "# Telegram QA\n\npass\n");
  return dir;
}

describe("scripts/mantis/build-telegram-evidence", () => {
  it("renders redacted Telegram observed messages as a transcript HTML page", () => {
    const html = renderTelegramEvidenceHtml({
      summary: {
        credentials: { source: "convex" },
        counts: { total: 1, passed: 1, failed: 0 },
        scenarios: [
          {
            id: "telegram-status-command",
            title: "Telegram status command reply",
            status: "pass",
            details: "ok",
          },
        ],
      },
      observedMessages: [
        {
          senderIsBot: true,
          scenarioId: "telegram-status-command",
          text: "<hello>",
          inlineButtons: ["Approve"],
          mediaKinds: [],
        },
      ],
    });

    expect(html).toContain("Mantis Telegram Live Evidence");
    expect(html).toContain("&lt;hello&gt;");
    expect(html).toContain("status: pass");
    expect(html).not.toContain("<hello>");
  });

  it("writes a Mantis manifest with optional Crabbox GIF and video artifacts", () => {
    const dir = makeTelegramOutput();
    const result = writeTelegramEvidence([
      "--output-dir",
      dir,
      "--candidate-ref",
      "refs/pull/1/head",
      "--candidate-sha",
      "abc123",
      "--scenario-label",
      "telegram-status-command",
    ]);

    expect(readFileSync(result.transcriptPath, "utf8")).toContain("Telegram status command reply");
    const manifest = loadEvidenceManifest(result.manifestPath);
    expect(manifest.comparison.pass).toBe(true);
    expect(manifest.comparison.candidate.sha).toBe("abc123");
    expect(manifest.artifacts.map((artifact) => artifact.targetPath)).toEqual([
      "summary.json",
      "observed-messages.json",
      "telegram-live-transcript.html",
      "report.md",
      "mantis-evidence.json",
    ]);
    expect(result.manifest.artifacts.some((artifact) => artifact.kind === "motionPreview")).toBe(
      true,
    );
  });

  it("marks the comparison failed when any Telegram scenario fails", () => {
    const manifest = buildTelegramEvidenceManifest({
      candidateRef: "main",
      candidateSha: "abc123",
      scenarioLabel: "telegram-live",
      summary: {
        counts: { total: 2, passed: 1, failed: 1 },
        scenarios: [],
      },
    });

    expect(manifest.comparison.pass).toBe(false);
    expect(manifest.comparison.candidate.status).toBe("fail");
  });
});
