import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadEvidenceManifest,
  publishArtifactFiles,
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
      artifactUrl: "https://github.com/openclaw/openclaw/actions/runs/1/artifacts/2",
      manifest,
      marker: "<!-- mantis-discord-status-reactions -->",
      rawBase: "https://qa.openclaw.ai/mantis/discord/pr-1/run-1",
      requestSource: "workflow_dispatch",
      runUrl: "https://github.com/openclaw/openclaw/actions/runs/1",
      treeUrl: "https://qa.openclaw.ai/mantis/discord/pr-1/run-1",
    });

    expect(body).toContain("<!-- mantis-discord-status-reactions -->");
    expect(body).toContain("Summary: Mantis reran the scenario.");
    expect(body).toContain('<table width="100%">');
    expect(body).toContain('<th width="50%">Baseline queued-only</th>');
    expect(body).toContain('<th width="50%">Candidate queued -> thinking -> done</th>');
    expect(body).toContain(
      '<td width="50%" align="center"><img src="https://qa.openclaw.ai/mantis/discord/pr-1/run-1/baseline.png" width="100%"',
    );
    expect(body).toContain(
      "[Baseline change MP4](https://qa.openclaw.ai/mantis/discord/pr-1/run-1/baseline-change.mp4)",
    );
    expect(body).not.toContain("raw.githubusercontent.com");
    expect(body).toContain("- Overall: `true`");
  });

  it("uploads manifest artifacts to R2-compatible object storage", async () => {
    const manifest = loadEvidenceManifest(writeFixtureManifest());
    const requests: Array<{ body: Buffer; headers: HeadersInit; method: string; url: string }> = [];
    const fetchImpl = async (
      url: URL,
      init: { body: Buffer; headers: HeadersInit; method: string },
    ) => {
      requests.push({
        body: init.body,
        headers: init.headers,
        method: init.method,
        url: url.toString(),
      });
      return new Response("", { status: 200 });
    };

    const published = await publishArtifactFiles({
      artifactRoot: "mantis/discord/pr-1/run-1",
      fetchImpl,
      manifest,
      storageConfig: {
        accessKeyId: "access",
        bucket: "qa-artifacts",
        endpoint: "https://example.r2.cloudflarestorage.com",
        publicBaseUrl: "https://qa.openclaw.ai",
        region: "auto",
        secretAccessKey: "secret",
      },
    });

    expect(published).toEqual({
      artifactRoot: "mantis/discord/pr-1/run-1",
      rawBase: "https://qa.openclaw.ai/mantis/discord/pr-1/run-1",
      treeUrl: "https://qa.openclaw.ai/mantis/discord/pr-1/run-1/index.json",
    });
    expect(requests.map((request) => request.method)).toEqual(["PUT", "PUT", "PUT", "PUT", "PUT"]);
    expect(requests.map((request) => request.url)).toEqual([
      "https://example.r2.cloudflarestorage.com/qa-artifacts/mantis/discord/pr-1/run-1/baseline.png",
      "https://example.r2.cloudflarestorage.com/qa-artifacts/mantis/discord/pr-1/run-1/candidate.png",
      "https://example.r2.cloudflarestorage.com/qa-artifacts/mantis/discord/pr-1/run-1/baseline-change.mp4",
      "https://example.r2.cloudflarestorage.com/qa-artifacts/mantis/discord/pr-1/run-1/mantis-evidence.json",
      "https://example.r2.cloudflarestorage.com/qa-artifacts/mantis/discord/pr-1/run-1/index.json",
    ]);
    expect(requests[0]?.headers).toMatchObject({
      "content-type": "image/png",
      "x-amz-date": expect.any(String),
    });
    expect(String((requests[0]?.headers as Record<string, string>).authorization)).toContain(
      "Credential=access/",
    );
    expect(String(requests[4]?.body)).toContain(
      '"url": "https://qa.openclaw.ai/mantis/discord/pr-1/run-1/baseline.png"',
    );
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
      artifactUrl: "https://github.com/openclaw/openclaw/actions/runs/1/artifacts/2",
      manifest,
      marker: "<!-- mantis-slack-desktop-smoke -->",
      rawBase: "https://qa.openclaw.ai/mantis/slack/pr-1/run-1",
      requestSource: "workflow_dispatch",
      runUrl: "https://github.com/openclaw/openclaw/actions/runs/1",
      treeUrl: "https://qa.openclaw.ai/mantis/slack/pr-1/run-1",
    });

    expect(body).toContain("Summary: Mantis could not finish VM setup.");
    expect(body).toContain("- Overall: `false`");
    expect(body).not.toContain("<img ");
  });

  it("renders a successful no-visual-proof manifest without media tables", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mantis-evidence-test-"));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, "mantis-evidence.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        artifacts: [],
        comparison: {
          baseline: {
            expected: "no visible Telegram Desktop delta",
            status: "skipped",
          },
          candidate: {
            expected: "no visible Telegram Desktop delta",
            status: "skipped",
          },
          pass: true,
        },
        id: "telegram-desktop-proof",
        scenario: "telegram-desktop-proof",
        schemaVersion: 1,
        summary:
          "Mantis did not generate before/after GIFs because this PR changes CI wiring only.",
        title: "Mantis Telegram Desktop Proof",
      }),
    );

    const manifest = loadEvidenceManifest(manifestPath);
    const body = renderEvidenceComment({
      artifactRoot: "mantis/telegram-desktop/pr-1/run-1",
      manifest,
      marker: "<!-- mantis-telegram-desktop-proof -->",
      rawBase:
        "https://raw.githubusercontent.com/openclaw/openclaw/qa-artifacts/mantis/telegram-desktop/pr-1/run-1",
      requestSource: "issue_comment",
      runUrl: "https://github.com/openclaw/openclaw/actions/runs/1",
      treeUrl:
        "https://github.com/openclaw/openclaw/tree/qa-artifacts/mantis/telegram-desktop/pr-1/run-1",
    });

    expect(manifest.artifacts.map((artifact) => artifact.targetPath)).toEqual([
      "mantis-evidence.json",
    ]);
    expect(body).toContain(
      "Summary: Mantis did not generate before/after GIFs because this PR changes CI wiring only.",
    );
    expect(body).toContain("- Overall: `true`");
    expect(body).not.toContain("<table");
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
