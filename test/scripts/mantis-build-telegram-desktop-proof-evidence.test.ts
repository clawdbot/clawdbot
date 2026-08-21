// Mantis Build Telegram Desktop Proof Evidence tests cover mantis build telegram desktop proof evidence script behavior.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeTelegramDesktopProofEvidence } from "../../scripts/mantis/build-telegram-desktop-proof-evidence.mts";
import {
  loadEvidenceManifest,
  renderEvidenceComment,
} from "../../scripts/mantis/publish-pr-evidence.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeLane(
  name: "baseline" | "candidate",
  sha: string,
  options: {
    diagnosticOnly?: boolean;
    status?: "blocked" | "fail" | "pass";
    withGif?: boolean;
  } = {},
) {
  const repo = mkdtempSync(path.join(tmpdir(), `mantis-telegram-${name}-repo-`));
  tempDirs.push(repo);
  const outputDir = path.join(repo, ".artifacts", "qa-e2e", name);
  mkdirSync(outputDir, { recursive: true });
  const gif = path.join(outputDir, "telegram-user-crabbox-session-motion-telegram-window.gif");
  const mp4 = path.join(outputDir, "telegram-user-crabbox-session-motion-telegram-window.mp4");
  const screenshot = path.join(outputDir, "telegram-user-crabbox-session.png");
  const report = path.join(outputDir, "telegram-user-crabbox-session-report.md");
  if (options.withGif !== false && !options.diagnosticOnly) {
    writeFileSync(gif, `${name} gif`);
  }
  if (!options.diagnosticOnly) {
    writeFileSync(mp4, `${name} mp4`);
    writeFileSync(screenshot, `${name} png`);
    writeFileSync(report, `${name} report`);
  }
  writeFileSync(
    path.join(outputDir, "telegram-user-crabbox-session-summary.json"),
    JSON.stringify({
      artifacts: {
        ...(options.withGif === false || options.diagnosticOnly
          ? {}
          : { previewGifCropped: path.relative(repo, gif) }),
        ...(options.diagnosticOnly
          ? {}
          : {
              screenshot: path.relative(repo, screenshot),
              trimmedVideoCropped: path.relative(repo, mp4),
            }),
      },
      ...(options.diagnosticOnly ? {} : { report: path.relative(repo, report) }),
      status: options.diagnosticOnly ? "infra-error" : (options.status ?? "pass"),
      ...(options.diagnosticOnly ? {} : { sutAttestation: { lane: name, sha } }),
    }),
  );
  return { outputDir, repo };
}

describe("scripts/mantis/build-telegram-desktop-proof-evidence", () => {
  it("builds paired native Telegram Desktop GIF evidence for PR comments", () => {
    const baselineSha = "a".repeat(40);
    const candidateSha = "b".repeat(40);
    const baseline = makeLane("baseline", baselineSha);
    const candidate = makeLane("candidate", candidateSha);
    const outputDir = mkdtempSync(path.join(tmpdir(), "mantis-telegram-proof-"));
    tempDirs.push(outputDir);

    const result = writeTelegramDesktopProofEvidence([
      "--output-dir",
      outputDir,
      "--baseline-repo-root",
      baseline.repo,
      "--baseline-output-dir",
      baseline.outputDir,
      "--baseline-ref",
      "main",
      "--baseline-sha",
      baselineSha,
      "--candidate-repo-root",
      candidate.repo,
      "--candidate-output-dir",
      candidate.outputDir,
      "--candidate-ref",
      "refs/pull/1/head",
      "--candidate-sha",
      candidateSha,
      "--scenario-label",
      "telegram-desktop-proof",
    ]);

    expect(
      readFileSync(path.join(outputDir, "baseline", "telegram-desktop-proof.gif"), "utf8"),
    ).toBe("baseline gif");
    const manifest = loadEvidenceManifest(result.manifestPath);
    expect(manifest.comparison.pass).toBe(true);
    expect(manifest.artifacts.map((artifact) => artifact.targetPath)).toContain(
      "candidate/telegram-desktop-proof.gif",
    );
    const artifactUrl = "https://github.com/openclaw/openclaw/actions/runs/1/artifacts/2";
    const body = renderEvidenceComment({
      artifactUrl,
      manifest,
      marker: "<!-- mantis-telegram-desktop-proof -->",
      rawBase: "https://qa.openclaw.ai/mantis/telegram-desktop/pr-1/run-1",
      requestSource: "workflow_dispatch",
      runUrl: "https://github.com/openclaw/openclaw/actions/runs/1",
      treeUrl: "https://qa.openclaw.ai/mantis/telegram-desktop/pr-1/run-1/index.json",
    });

    expect(body).toContain("<!-- mantis-telegram-desktop-proof -->");
    expect(body).toContain("## Mantis Telegram Desktop Proof");
    expect(body).toContain(
      `- Baseline: \`pass\` at \`${baselineSha}\`, expected baseline visual proof captured`,
    );
    expect(body).toContain(
      `- Candidate: \`pass\` at \`${candidateSha}\`, expected candidate visual proof captured`,
    );
    expect(body).toContain(`- Artifact: ${artifactUrl}`);
    expect(body).toContain('<table width="100%">');
    expect(body).toContain(
      '<img src="https://qa.openclaw.ai/mantis/telegram-desktop/pr-1/run-1/baseline/telegram-desktop-proof.gif" width="100%"',
    );
    expect(body).toContain(
      '<img src="https://qa.openclaw.ai/mantis/telegram-desktop/pr-1/run-1/candidate/telegram-desktop-proof.gif" width="100%"',
    );
    expect(body).toContain(
      "Raw QA files: https://qa.openclaw.ai/mantis/telegram-desktop/pr-1/run-1/index.json",
    );
    expect(body).not.toContain("undefined/");
    expect(body).not.toContain("| Main | This PR |");
  });

  it("rejects a candidate session that attests the baseline lane", () => {
    const baselineSha = "a".repeat(40);
    const candidateSha = "b".repeat(40);
    const baseline = makeLane("baseline", baselineSha);
    const candidate = makeLane("baseline", baselineSha);
    const outputDir = mkdtempSync(path.join(tmpdir(), "mantis-telegram-proof-mismatch-"));
    tempDirs.push(outputDir);

    expect(() =>
      writeTelegramDesktopProofEvidence([
        "--output-dir",
        outputDir,
        "--baseline-repo-root",
        baseline.repo,
        "--baseline-output-dir",
        baseline.outputDir,
        "--baseline-sha",
        baselineSha,
        "--candidate-repo-root",
        candidate.repo,
        "--candidate-output-dir",
        candidate.outputDir,
        "--candidate-sha",
        candidateSha,
      ]),
    ).toThrow("SUT attestation mismatch for candidate.");
  });

  it("preserves failed-lane evidence without requiring a success GIF", () => {
    const baselineSha = "a".repeat(40);
    const candidateSha = "b".repeat(40);
    const baseline = makeLane("baseline", baselineSha);
    const candidate = makeLane("candidate", candidateSha, { status: "fail", withGif: false });
    const outputDir = mkdtempSync(path.join(tmpdir(), "mantis-telegram-failure-proof-"));
    tempDirs.push(outputDir);

    const { manifest } = writeTelegramDesktopProofEvidence([
      "--output-dir",
      outputDir,
      "--baseline-repo-root",
      baseline.repo,
      "--baseline-output-dir",
      baseline.outputDir,
      "--baseline-sha",
      baselineSha,
      "--candidate-repo-root",
      candidate.repo,
      "--candidate-output-dir",
      candidate.outputDir,
      "--candidate-sha",
      candidateSha,
    ]);

    expect(manifest.comparison.pass).toBe(false);
    expect(manifest.comparison.outcome).toBe("fail");
    expect(manifest.artifacts).toContainEqual(
      expect.objectContaining({
        lane: "candidate",
        kind: "motionPreview",
        required: false,
      }),
    );
    expect(
      readFileSync(path.join(outputDir, "candidate", "telegram-desktop-proof.png"), "utf8"),
    ).toBe("candidate png");
  });

  it("preserves a blocked lane as a distinct non-failure outcome", () => {
    const baselineSha = "a".repeat(40);
    const candidateSha = "b".repeat(40);
    const baseline = makeLane("baseline", baselineSha, { status: "blocked", withGif: false });
    const candidate = makeLane("candidate", candidateSha, { status: "blocked", withGif: false });
    const outputDir = mkdtempSync(path.join(tmpdir(), "mantis-telegram-blocked-proof-"));
    tempDirs.push(outputDir);

    const { manifest } = writeTelegramDesktopProofEvidence([
      "--output-dir",
      outputDir,
      "--baseline-repo-root",
      baseline.repo,
      "--baseline-output-dir",
      baseline.outputDir,
      "--baseline-sha",
      baselineSha,
      "--baseline-status",
      "blocked",
      "--candidate-repo-root",
      candidate.repo,
      "--candidate-output-dir",
      candidate.outputDir,
      "--candidate-sha",
      candidateSha,
      "--candidate-status",
      "blocked",
    ]);

    expect(manifest.comparison).toMatchObject({
      baseline: { status: "blocked" },
      candidate: { status: "blocked" },
      outcome: "blocked",
      pass: false,
    });
  });

  it("preserves an unattested diagnostic-only startup failure", () => {
    const baselineSha = "a".repeat(40);
    const candidateSha = "b".repeat(40);
    const baseline = makeLane("baseline", baselineSha, { diagnosticOnly: true });
    const candidate = makeLane("candidate", candidateSha);
    const outputDir = mkdtempSync(path.join(tmpdir(), "mantis-telegram-startup-failure-"));
    tempDirs.push(outputDir);

    const { manifest } = writeTelegramDesktopProofEvidence([
      "--output-dir",
      outputDir,
      "--baseline-repo-root",
      baseline.repo,
      "--baseline-output-dir",
      baseline.outputDir,
      "--baseline-sha",
      baselineSha,
      "--baseline-status",
      "fail",
      "--candidate-repo-root",
      candidate.repo,
      "--candidate-output-dir",
      candidate.outputDir,
      "--candidate-sha",
      candidateSha,
    ]);

    expect(manifest.comparison).toMatchObject({
      baseline: { status: "fail" },
      candidate: { status: "pass" },
      pass: false,
    });
    expect(
      JSON.parse(readFileSync(path.join(outputDir, "baseline", "summary.json"), "utf8")),
    ).toEqual({ artifacts: {}, status: "infra-error" });
  });
});
