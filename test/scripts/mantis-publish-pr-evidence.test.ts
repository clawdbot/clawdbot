import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadEvidenceManifest,
  renderEvidenceComment,
} from "../../scripts/mantis/publish-pr-evidence.mjs";

function writeFixtureManifest() {
  const dir = mkdtempSync(path.join(tmpdir(), "mantis-evidence-test-"));
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
    expect(body).toContain("| Baseline queued-only | Candidate queued -> thinking -> done |");
    expect(body).toContain(
      '<img src="https://raw.githubusercontent.com/openclaw/openclaw/qa-artifacts/mantis/discord/pr-1/run-1/baseline.png"',
    );
    expect(body).toContain(
      "[Baseline change MP4](https://raw.githubusercontent.com/openclaw/openclaw/qa-artifacts/mantis/discord/pr-1/run-1/baseline-change.mp4)",
    );
    expect(body).toContain("- Overall: `true`");
  });

  it("rejects artifact paths that escape the manifest directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mantis-evidence-test-"));
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
