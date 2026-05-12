import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function writeFixtureManifest() {
  const dir = mkdtempSync(path.join(tmpdir(), "mantis-evidence-test-"));
  tempDirs.push(dir);
  mkdirSync(path.join(dir, "baseline"), { recursive: true });
  mkdirSync(path.join(dir, "candidate"), { recursive: true });
  writeFileSync(path.join(dir, "baseline", "timeline.png"), "baseline timeline");
  writeFileSync(path.join(dir, "candidate", "timeline.png"), "candidate timeline");
  writeFileSync(path.join(dir, "baseline", "change.mp4"), "baseline clip");
  const manifestPath = path.join(dir, "mantis-evidence.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      id: "discord-status-reactions",
      title: "Mantis Discord Status Reactions QA",
      summary: "Mantis reran the scenario.",
      scenario: "discord-status-reactions-tool-only",
      comparison: {
        baseline: {
          expected: "queued-only",
          sha: "aaa",
          status: "fail",
        },
        candidate: {
          expected: "queued -> thinking -> done",
          sha: "bbb",
          status: "pass",
        },
        pass: true,
      },
      artifacts: [
        {
          alt: "Baseline timeline",
          kind: "timeline",
          label: "Baseline queued-only",
          lane: "baseline",
          path: "baseline/timeline.png",
          targetPath: "baseline.png",
        },
        {
          alt: "Candidate timeline",
          kind: "timeline",
          label: "Candidate queued -> thinking -> done",
          lane: "candidate",
          path: "candidate/timeline.png",
          targetPath: "candidate.png",
        },
        {
          kind: "motionClip",
          label: "Baseline change MP4",
          lane: "baseline",
          path: "baseline/change.mp4",
          targetPath: "baseline-change.mp4",
        },
      ],
    }),
  );
  return manifestPath;
}

describe("scripts/mantis/publish-pr-evidence", () => {
  it("renders a manifest-driven PR comment with inline screenshots and video links", () => {
    const manifest = loadEvidenceManifest(writeFixtureManifest());
    const body = renderEvidenceComment({
      artifactRoot: "mantis/discord/pr-1/run-1",
      artifactUrl: "https://github.com/openclaw/openclaw/actions/runs/1/artifacts/2",
      manifest,
      marker: "<!-- mantis-discord-status-reactions -->",
      rawBase:
        "https://raw.githubusercontent.com/openclaw/openclaw/qa-artifacts/mantis/discord/pr-1/run-1",
      requestSource: "workflow_dispatch",
      runUrl: "https://github.com/openclaw/openclaw/actions/runs/1",
      treeUrl: "https://github.com/openclaw/openclaw/tree/qa-artifacts/mantis/discord/pr-1/run-1",
    });

    expect(body).toContain("<!-- mantis-discord-status-reactions -->");
    expect(body).toContain("Summary: Mantis reran the scenario.");
    expect(body).toContain('<table width="100%">');
    expect(body).toContain('<th width="50%">Baseline queued-only</th>');
    expect(body).toContain('<th width="50%">Candidate queued -> thinking -> done</th>');
    expect(body).toContain(
      '<td width="50%" align="center"><img src="https://raw.githubusercontent.com/openclaw/openclaw/qa-artifacts/mantis/discord/pr-1/run-1/baseline.png" width="100%"',
    );
    expect(body).toContain(
      "[Baseline change MP4](https://raw.githubusercontent.com/openclaw/openclaw/qa-artifacts/mantis/discord/pr-1/run-1/baseline-change.mp4)",
    );
    expect(body).toContain("- Overall: `true`");
  });

  it("allows failure manifests to omit optional visual artifacts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mantis-evidence-test-"));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ status: "fail" }));
    writeFileSync(path.join(dir, "report.md"), "bootstrap failed before screenshot");
    const manifestPath = path.join(dir, "mantis-evidence.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        id: "slack-desktop-smoke",
        title: "Mantis Slack Desktop Smoke QA",
        summary: "Mantis could not finish VM setup.",
        scenario: "slack-openclaw-desktop-smoke",
        comparison: {
          candidate: {
            expected: "Slack QA and VM gateway setup pass",
            sha: "bbb",
            status: "fail",
          },
          pass: false,
        },
        artifacts: [
          {
            alt: "Slack Web desktop screenshot from the Mantis VM",
            inline: true,
            kind: "desktopScreenshot",
            label: "Slack desktop/VNC browser",
            lane: "candidate",
            path: "slack-desktop-smoke.png",
            required: false,
            targetPath: "slack-desktop.png",
          },
          {
            kind: "metadata",
            label: "Slack desktop summary",
            lane: "run",
            path: "summary.json",
            targetPath: "summary.json",
          },
          {
            kind: "report",
            label: "Slack desktop report",
            lane: "run",
            path: "report.md",
            targetPath: "report.md",
          },
        ],
      }),
    );

    const manifest = loadEvidenceManifest(manifestPath);
    expect(manifest.artifacts.map((artifact) => artifact.targetPath)).toEqual([
      "summary.json",
      "report.md",
      "mantis-evidence.json",
    ]);
    const body = renderEvidenceComment({
      artifactRoot: "mantis/slack/pr-1/run-1",
      artifactUrl: "https://github.com/openclaw/openclaw/actions/runs/1/artifacts/2",
      manifest,
      marker: "<!-- mantis-slack-desktop-smoke -->",
      rawBase:
        "https://raw.githubusercontent.com/openclaw/openclaw/qa-artifacts/mantis/slack/pr-1/run-1",
      requestSource: "workflow_dispatch",
      runUrl: "https://github.com/openclaw/openclaw/actions/runs/1",
      treeUrl: "https://github.com/openclaw/openclaw/tree/qa-artifacts/mantis/slack/pr-1/run-1",
    });

    expect(body).toContain("Summary: Mantis could not finish VM setup.");
    expect(body).toContain("- Overall: `false`");
    expect(body).not.toContain("<img ");
  });

  it("rejects artifact paths that escape the manifest directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mantis-evidence-test-"));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, "mantis-evidence.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        artifacts: [
          {
            kind: "metadata",
            path: "../outside.json",
          },
        ],
        id: "bad",
        scenario: "bad",
        schemaVersion: 1,
        title: "Bad",
      }),
    );

    expect(() => loadEvidenceManifest(manifestPath)).toThrow(/escapes manifest directory/u);
  });
});
