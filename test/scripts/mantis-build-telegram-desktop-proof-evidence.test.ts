import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeTelegramDesktopProofEvidence } from "../../scripts/mantis/build-telegram-desktop-proof-evidence.mjs";
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

function makeLane(name: string) {
  const repo = mkdtempSync(path.join(tmpdir(), `mantis-telegram-${name}-repo-`));
  tempDirs.push(repo);
  const outputDir = path.join(repo, ".artifacts", "qa-e2e", name);
  mkdirSync(outputDir, { recursive: true });
  const gif = path.join(outputDir, "telegram-user-crabbox-session-motion-telegram-window.gif");
  const mp4 = path.join(outputDir, "telegram-user-crabbox-session-motion-telegram-window.mp4");
  const screenshot = path.join(outputDir, "telegram-user-crabbox-session.png");
  const report = path.join(outputDir, "telegram-user-crabbox-session-report.md");
  writeFileSync(gif, `${name} gif`);
  writeFileSync(mp4, `${name} mp4`);
  writeFileSync(screenshot, `${name} png`);
  writeFileSync(report, `${name} report`);
  writeFileSync(
    path.join(outputDir, "telegram-user-crabbox-session-summary.json"),
    JSON.stringify({
      artifacts: {
        previewGifCropped: path.relative(repo, gif),
        screenshot: path.relative(repo, screenshot),
        trimmedVideoCropped: path.relative(repo, mp4),
      },
      report: path.relative(repo, report),
      status: "pass",
    }),
  );
  return { outputDir, repo };
}

describe("scripts/mantis/build-telegram-desktop-proof-evidence", () => {
  it("builds paired native Telegram Desktop GIF evidence for PR comments", () => {
    const baseline = makeLane("baseline");
    const candidate = makeLane("candidate");
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
      "aaa",
      "--candidate-repo-root",
      candidate.repo,
      "--candidate-output-dir",
      candidate.outputDir,
      "--candidate-ref",
      "refs/pull/1/head",
      "--candidate-sha",
      "bbb",
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
    const body = renderEvidenceComment({
      artifactRoot: "mantis/telegram-desktop/pr-1/run-1",
      manifest,
      marker: "<!-- mantis-telegram-desktop-proof -->",
      rawBase:
        "https://raw.githubusercontent.com/openclaw/openclaw/qa-artifacts/mantis/telegram-desktop/pr-1/run-1",
      requestSource: "workflow_dispatch",
      runUrl: "https://github.com/openclaw/openclaw/actions/runs/1",
      treeUrl:
        "https://github.com/openclaw/openclaw/tree/qa-artifacts/mantis/telegram-desktop/pr-1/run-1",
    });

    expect(body).toContain("| Main | This PR |");
    expect(body).toContain("baseline/telegram-desktop-proof.gif");
    expect(body).toContain("candidate/telegram-desktop-proof.gif");
  });
});
