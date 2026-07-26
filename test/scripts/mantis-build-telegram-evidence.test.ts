// Mantis Build Telegram Evidence tests cover mantis build telegram evidence script behavior.
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

function makeTelegramOutput({ includeReport = true, summary = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mantis-telegram-evidence-test-"));
  tempDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "qa-evidence.json"),
    JSON.stringify({
      kind: "openclaw.qa.evidence-summary",
      schemaVersion: 2,
      generatedAt: "2026-05-10T00:00:05.000Z",
      entries: [
        {
          test: {
            kind: "live-transport-check",
            id: "telegram-status-command",
            title: "Telegram status command reply",
          },
          coverage: [],
          execution: {
            runner: "host",
            environment: {
              ref: null,
              os: "darwin",
              nodeVersion: "v24.0.0",
            },
            provider: {
              id: "openai",
              live: true,
              model: { name: "gpt-5.5", ref: "openai/gpt-5.5" },
              auth: "live-frontier",
            },
            channel: {
              id: "telegram",
              live: true,
              driver: "native",
            },
            packageSource: { kind: "source-checkout" },
            artifacts: [],
          },
          result: {
            status: "pass",
            timing: { rttMs: 1234 },
          },
        },
      ],
      ...summary,
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
  if (includeReport) {
    writeFileSync(path.join(dir, "qa-suite-report.md"), "# Telegram QA\n\npass\n");
  }
  return dir;
}

describe("scripts/mantis/build-telegram-evidence", () => {
  it("renders redacted Telegram observed messages as a transcript HTML page", () => {
    const html = renderTelegramEvidenceHtml({
      summary: {
        entries: [
          {
            test: {
              id: "telegram-status-command",
              title: "Telegram status command reply",
            },
            execution: {
              provider: { auth: "live-frontier" },
            },
            result: {
              status: "pass",
            },
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
      "telegram-live-transcript.html",
      "report.md",
      "mantis-evidence.json",
    ]);
    expect(result.manifest.artifacts.some((artifact) => artifact.kind === "motionPreview")).toBe(
      true,
    );
  });

  it("does not require observed-message artifacts for current evidence summaries", () => {
    const dir = makeTelegramOutput();
    rmSync(path.join(dir, "telegram-qa-observed-messages.json"), { force: true });

    const result = writeTelegramEvidence(["--output-dir", dir]);

    expect(readFileSync(result.transcriptPath, "utf8")).toContain(
      "No observed Telegram messages were recorded.",
    );
    const targetPaths = result.manifest.artifacts.map((artifact) => artifact.targetPath);
    expect(targetPaths).toContain("summary.json");
    expect(targetPaths).toContain("telegram-live-transcript.html");
    expect(targetPaths).toContain("report.md");
    expect(targetPaths).not.toContain("observed-messages.json");
  });

  it("ignores stale observed-message files beside current evidence summaries", () => {
    const dir = makeTelegramOutput();

    const result = writeTelegramEvidence(["--output-dir", dir]);

    expect(readFileSync(result.transcriptPath, "utf8")).toContain(
      "No observed Telegram messages were recorded.",
    );
    expect(result.manifest.artifacts.map((artifact) => artifact.targetPath)).not.toContain(
      "observed-messages.json",
    );
  });

  it("does not fabricate a required report artifact for passing Telegram summaries", () => {
    const dir = makeTelegramOutput({ includeReport: false });

    expect(() => writeTelegramEvidence(["--output-dir", dir])).toThrow(
      "Missing Telegram QA report for passing summary",
    );
  });

  it("keeps a placeholder report for failing Telegram summaries", () => {
    const dir = makeTelegramOutput({
      includeReport: false,
      summary: {
        entries: [
          {
            test: {
              id: "telegram-status-command",
              title: "Telegram status command reply",
            },
            execution: {
              provider: { auth: "live-frontier" },
            },
            result: {
              status: "fail",
              failure: { reason: "Timed out." },
            },
          },
        ],
      },
    });

    const result = writeTelegramEvidence(["--output-dir", dir]);

    expect(result.manifest.comparison.pass).toBe(false);
    expect(readFileSync(path.join(dir, "qa-suite-report.md"), "utf8")).toContain(
      "Telegram QA report was unavailable",
    );
    expect(loadEvidenceManifest(result.manifestPath).comparison.pass).toBe(false);
  });

  it("marks the comparison failed when any Telegram scenario fails", () => {
    const manifest = buildTelegramEvidenceManifest({
      candidateRef: "main",
      candidateSha: "abc123",
      scenarioLabel: "telegram-live",
      summary: {
        entries: [
          {
            test: { id: "telegram-canary" },
            result: { status: "pass" },
          },
          {
            test: { id: "telegram-status-command" },
            result: { status: "fail" },
          },
        ],
      },
    });

    expect(manifest.comparison.pass).toBe(false);
    expect(manifest.comparison.candidate.status).toBe("fail");
  });
});
