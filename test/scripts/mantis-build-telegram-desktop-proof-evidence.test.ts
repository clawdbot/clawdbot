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
    blockedReason?: string;
    diagnosticOnly?: boolean;
    error?: string;
    facts?: Record<string, unknown>;
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
  writeFileSync(
    path.join(outputDir, "mantis-lane-facts.json"),
    JSON.stringify({
      attempt: 1,
      botApiRequests: [],
      invocations: [
        { command: "botapi-fail" },
        { args: { scriptFile: "provider-script.json" }, command: "mock" },
      ],
      lane: name,
      observation: { events: [], observedSeconds: 0 },
      providerRequests: [],
      schemaVersion: 2,
      sendCount: 0,
      ...(options.blockedReason ? { blocked: { reason: options.blockedReason } } : {}),
      ...(options.error ? { error: options.error } : {}),
      ...options.facts,
    }),
  );
  return { outputDir, repo };
}

function recordAssertions(
  manifestPath: string,
  expectationMet: { baseline: boolean; candidate: boolean },
) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const lane of ["baseline", "candidate"] as const) {
    manifest.comparison[lane].assertion = {
      target: "providerRequests",
      mode: expectationMet[lane] ? "absent" : "contains",
      value: "fixture assertion sentinel",
    };
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe("scripts/mantis/build-telegram-desktop-proof-evidence", () => {
  it("builds paired native Telegram Desktop GIF evidence for PR comments", () => {
    const baselineSha = "a".repeat(40);
    const candidateSha = "b".repeat(40);
    const sentEvents = [
      {
        actor: "user",
        contentType: "messageText",
        isOutgoing: true,
        kind: "message",
        messageId: "101",
        text: "/queue <followup> `now`",
      },
      {
        actor: "user",
        contentType: "messageDocument",
        isOutgoing: true,
        kind: "message",
        messageId: "102",
        text: "proof caption",
      },
    ];
    const baseline = makeLane("baseline", baselineSha, {
      facts: {
        attempt: 1,
        botApiRequests: [{ injected: true, method: "sendMessage", status: 429 }],
        observation: {
          events: [
            ...sentEvents,
            { actor: "bot", kind: "message", messageId: "201", text: "draft" },
            { actor: "bot", kind: "message", messageId: "202", text: "second" },
            { actor: "bot", kind: "edit", messageId: "201", text: "final" },
            { actor: "bot", kind: "delete", messageId: "202" },
            { actor: "bot", kind: "typing" },
          ],
          observedSeconds: 133.534,
        },
        providerRequests: [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
        sendCount: 2,
      },
    });
    const candidate = makeLane("candidate", candidateSha, {
      facts: {
        attempt: 1,
        botApiRequests: [{ injected: true, method: "sendMessage", status: 429 }],
        observation: {
          events: [
            ...sentEvents,
            { actor: "bot", kind: "message", messageId: "201", text: "draft" },
            { actor: "bot", kind: "message", messageId: "202", text: "second" },
            { actor: "bot", kind: "message", messageId: "203", text: "third" },
            { actor: "bot", kind: "edit", messageId: "201", text: "final" },
            { actor: "bot", kind: "typing" },
          ],
          observedSeconds: 134.2,
        },
        providerRequests: [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
        sendCount: 2,
      },
    });
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
      candidateSha,
      "--candidate-sha",
      candidateSha,
      "--scenario-label",
      "telegram-desktop-proof",
    ]);

    expect(
      readFileSync(path.join(outputDir, "baseline", "telegram-desktop-proof.gif"), "utf8"),
    ).toBe("baseline gif");
    expect(result.manifest.schemaVersion).toBe(2);
    expect(result.manifest.comparison.baseline).not.toHaveProperty("expectationMet");
    expect(result.manifest.comparison.candidate).not.toHaveProperty("expectationMet");
    recordAssertions(result.manifestPath, { baseline: true, candidate: true });
    const manifest = loadEvidenceManifest(result.manifestPath);
    expect(manifest.comparison.pass).toBe(true);
    expect(manifest.comparison.candidate).toMatchObject({
      expected: "candidate visual proof captured",
      ref: candidateSha,
      sha: candidateSha,
    });
    expect(manifest.comparison.baseline?.digest).toBe(
      "2 sent · 2 bot messages · 1 edit · 1 delete · 3 provider requests · 1 injected Bot API fault · 134s observed · attempt 1 · sent: `/queue &lt;followup&gt; &#96;now&#96;`, `[document]`",
    );
    expect(manifest.comparison.candidate.digest).toBe(
      "2 sent · 3 bot messages · 1 edit · 0 deletes · 3 provider requests · 1 injected Bot API fault · 134s observed · attempt 1 · sent: `/queue &lt;followup&gt; &#96;now&#96;`, `[document]`",
    );
    expect(manifest.comparison.differential).toBe("bot messages 2→3 · deletes 1→0");
    expect(manifest.comparison.candidate).not.toHaveProperty("fixed");
    expect(manifest.artifacts.map((artifact) => artifact.targetPath)).toContain(
      "candidate/telegram-desktop-proof.gif",
    );
    expect(manifest.artifacts.map((artifact) => artifact.targetPath)).toContain(
      "candidate/mantis-lane-facts.json",
    );
    expect(manifest.artifacts).toContainEqual(
      expect.objectContaining({
        alt: "Candidate native Telegram Desktop proof GIF",
        kind: "motionPreview",
        label: "This PR merged onto main",
        lane: "candidate",
      }),
    );
    expect(
      JSON.parse(readFileSync(path.join(outputDir, "candidate", "mantis-lane-facts.json"), "utf8")),
    ).toMatchObject({
      botApiRequests: [{ injected: true, method: "sendMessage", status: 429 }],
      invocations: [{ command: "botapi-fail" }, { command: "mock" }],
    });
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
      `- Baseline: \`pass\` at \`${baselineSha}\` — baseline visual proof captured · facts: ${manifest.comparison.baseline?.digest}`,
    );
    expect(body).toContain(
      `- Candidate (PR merged onto main): \`pass\` at \`${candidateSha}\` — candidate visual proof captured · facts: ${manifest.comparison.candidate.digest}`,
    );
    expect(body).toContain(
      "- Differential (trusted facts): bot messages 2→3 · deletes 1→0\n- Overall: `pass`",
    );
    expect(body).toContain(`- Artifact: ${artifactUrl}`);
    expect(body).toContain('<table width="100%">');
    expect(body).toContain(
      '<img src="https://qa.openclaw.ai/mantis/telegram-desktop/pr-1/run-1/baseline/telegram-desktop-proof.gif" width="100%"',
    );
    expect(body).toContain(
      '<img src="https://qa.openclaw.ai/mantis/telegram-desktop/pr-1/run-1/candidate/telegram-desktop-proof.gif" width="100%" alt="Candidate native Telegram Desktop proof GIF">',
    );
    expect(body).toContain('<th width="50%">This PR merged onto main</th>');
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
    const unsafeReason = `  The lane\nblocked <unsafe> & \`inline\` ${"x".repeat(400)}  `;
    const baseline = makeLane("baseline", baselineSha, {
      blockedReason: unsafeReason,
      status: "blocked",
      withGif: false,
    });
    const candidate = makeLane("candidate", candidateSha, {
      blockedReason: "The queued successor steered instead of queueing.",
      status: "blocked",
      withGif: false,
    });
    const outputDir = mkdtempSync(path.join(tmpdir(), "mantis-telegram-blocked-proof-"));
    tempDirs.push(outputDir);

    const result = writeTelegramDesktopProofEvidence([
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

    expect(result.manifest.comparison).toMatchObject({
      baseline: { status: "blocked" },
      candidate: {
        detail: "The queued successor steered instead of queueing.",
        status: "blocked",
      },
      outcome: "blocked",
      pass: false,
    });
    expect(result.manifest.summary).toBe(
      "Mantis did not capture native Telegram Desktop before/after GIF proof. See the Baseline and Candidate lane details below.",
    );
    expect(result.manifest.comparison.baseline.detail).toHaveLength(300);
    expect(result.manifest.comparison.baseline.detail).toMatch(
      /^The lane blocked &lt;unsafe&gt; &amp; &#96;inline&#96; /u,
    );
    expect(result.manifest.comparison.baseline.detail).toMatch(/…$/u);
    expect(result.manifest.comparison.baseline.detail).not.toMatch(/[<>`\n\r]/u);

    recordAssertions(result.manifestPath, { baseline: false, candidate: false });
    const manifest = loadEvidenceManifest(result.manifestPath);
    const body = renderEvidenceComment({
      manifest,
      marker: "<!-- mantis-telegram-desktop-proof -->",
      rawBase: "https://qa.openclaw.ai/mantis/telegram-desktop/pr-1/run-1",
    });
    expect(body).toContain(
      `- Candidate (PR merged onto main): \`blocked\` at \`${candidateSha}\` — The queued successor steered instead of queueing.`,
    );
    expect(body).toContain(`- Baseline: \`blocked\` at \`${baselineSha}\` — The lane blocked`);
  });

  it("preserves an unattested diagnostic-only startup failure", () => {
    const baselineSha = "a".repeat(40);
    const candidateSha = "b".repeat(40);
    const baseline = makeLane("baseline", baselineSha, {
      diagnosticOnly: true,
      error: "  recorder <failed>\nwith `exit 1` & no frames  ",
    });
    const candidate = makeLane("candidate", candidateSha);
    const outputDir = mkdtempSync(path.join(tmpdir(), "mantis-telegram-startup-failure-"));
    tempDirs.push(outputDir);

    const result = writeTelegramDesktopProofEvidence([
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

    expect(result.manifest.comparison).toMatchObject({
      baseline: {
        detail: "recorder &lt;failed&gt; with &#96;exit 1&#96; &amp; no frames",
        status: "fail",
      },
      candidate: { status: "pass" },
      pass: false,
    });
    expect(
      JSON.parse(readFileSync(path.join(outputDir, "baseline", "summary.json"), "utf8")),
    ).toEqual({ artifacts: {}, status: "infra-error" });
    recordAssertions(result.manifestPath, { baseline: false, candidate: true });
    const manifest = loadEvidenceManifest(result.manifestPath);
    const body = renderEvidenceComment({
      manifest,
      marker: "<!-- mantis-telegram-desktop-proof -->",
      rawBase: "https://qa.openclaw.ai/mantis/telegram-desktop/pr-1/run-1",
    });
    expect(body).toContain(
      `- Baseline: \`fail\` at \`${baselineSha}\` — recorder &lt;failed&gt; with &#96;exit 1&#96; &amp; no frames`,
    );
  });

  it("publishes an optional recipe suggestion as a non-inline attachment", () => {
    const baselineSha = "a".repeat(40);
    const candidateSha = "b".repeat(40);
    const baseline = makeLane("baseline", baselineSha);
    const candidate = makeLane("candidate", candidateSha);
    const outputDir = mkdtempSync(path.join(tmpdir(), "mantis-telegram-recipe-proof-"));
    tempDirs.push(outputDir);
    writeFileSync(path.join(outputDir, "recipe-suggestion.md"), "# Reusable proof\n");

    const result = writeTelegramDesktopProofEvidence([
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

    recordAssertions(result.manifestPath, { baseline: true, candidate: true });
    const manifest = loadEvidenceManifest(result.manifestPath);
    expect(manifest.artifacts).toContainEqual(
      expect.objectContaining({
        inline: false,
        kind: "attachment",
        lane: "run",
        targetPath: "recipe-suggestion.md",
      }),
    );
    expect(readFileSync(path.join(outputDir, "recipe-suggestion.md"), "utf8")).toBe(
      "# Reusable proof\n",
    );
  });
});
