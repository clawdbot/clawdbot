import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadEvidenceManifest,
  renderEvidenceComment,
} from "../../scripts/mantis/publish-pr-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = "scripts/mantis/telegram-visible-proof.mjs";
const BASELINE_SHA = "a".repeat(40);
const CANDIDATE_SHA = "b".repeat(40);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function temp(prefix: string) {
  return tempDirs.make(prefix);
}

function writeMedia(file: string, header: string) {
  const contents = Buffer.concat([Buffer.from(header), Buffer.alloc(12_000, 1)]);
  writeFileSync(file, contents);
  return {
    bytes: contents.length,
    file: path.basename(file),
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function writeLane(
  root: string,
  lane: "baseline" | "candidate",
  sha: string,
  events: unknown[],
  invocations: unknown[],
) {
  const published = path.join(root, "published", lane);
  mkdirSync(published, { recursive: true });
  const artifacts = {
    previewGifCropped: writeMedia(path.join(published, `${lane}.gif`), "GIF89a"),
    screenshot: writeMedia(path.join(published, `${lane}.png`), "PNG"),
    trimmedVideoCropped: writeMedia(path.join(published, `${lane}.mp4`), "MP4"),
  };
  const facts = {
    artifacts,
    attempt: 2,
    botApiRequests: [{ method: "sendMessage", payload: { text: `${lane}-payload` } }],
    cleanupErrors: [],
    invocations,
    lane,
    observation: { events, truncated: false, uptimeMs: 1_500 },
    providerRequests: [{ input: `${lane}-provider-input` }],
    schemaVersion: 2,
    sendCount: 1,
    status: "complete",
    sutAttestation: { lane, sha },
  };
  const file = path.join(root, `${lane}.json`);
  writeFileSync(file, `${JSON.stringify(facts)}\n`);
  writeFileSync(path.join(published, "mantis-lane-facts.json"), `${JSON.stringify(facts)}\n`);
  writeFileSync(path.join(published, "attempt-1-facts.json"), '{"status":"aborted"}\n');
  return file;
}

function runCollector(options?: { candidateSha?: string }) {
  const root = temp("mantis-open-proof-");
  const output = path.join(root, "evidence");
  const events = [
    { actor: "bot", kind: "typing", active: true },
    { actor: "user", kind: "reaction", emoji: "👍" },
    { actor: "bot", kind: "message", text: "done" },
  ];
  const baselineFacts = writeLane(root, "baseline", BASELINE_SHA, events, [
    { command: "exec", args: { command: "replace every gateway setting" } },
  ]);
  const candidateFacts = writeLane(root, "candidate", CANDIDATE_SHA, events, [
    { command: "desktop", args: { actionsFile: "different-experiment.json" } },
    { command: "restart", args: {} },
  ]);
  const agentManifest = path.join(root, "agent-evidence.json");
  writeFileSync(
    agentManifest,
    `${JSON.stringify({
      schemaVersion: 2,
      id: "telegram-visible-proof",
      title: "Mantis Telegram proof — PASS",
      summary: "The unrestricted experiment proved the repair.",
      scenario: "Different adaptive experiments on main and candidate.",
      comparison: {
        baseline: {
          expected: "Reproduce the defect.",
          detail: "The defect reproduced.",
          expectationMet: true,
        },
        candidate: {
          expected: "Confirm the repair.",
          detail: "The repair held.",
          expectationMet: true,
        },
        differential: "The recorded Telegram and SUT evidence differs materially.",
        outcome: "pass",
        pass: true,
      },
    })}\n`,
  );
  execFileSync(
    process.execPath,
    [
      SCRIPT,
      "collect",
      "--agent-manifest",
      agentManifest,
      "--baseline-facts",
      baselineFacts,
      "--baseline-sha",
      BASELINE_SHA,
      "--candidate-facts",
      candidateFacts,
      "--candidate-sha",
      options?.candidateSha ?? CANDIDATE_SHA,
      "--published-root",
      path.join(root, "published"),
      "--output-dir",
      output,
    ],
    { stdio: "pipe" },
  );
  return { output, root };
}

describe("Mantis open-ended Telegram proof collector", () => {
  it("accepts adaptive lane programs and preserves every recorded fact", () => {
    const { output } = runCollector();
    const manifest = JSON.parse(readFileSync(path.join(output, "mantis-evidence.json"), "utf8"));
    const baseline = JSON.parse(
      readFileSync(path.join(output, "baseline", "mantis-lane-facts.json"), "utf8"),
    );
    const candidate = JSON.parse(
      readFileSync(path.join(output, "candidate", "mantis-lane-facts.json"), "utf8"),
    );

    expect(manifest.comparison.outcome).toBe("pass");
    expect(manifest.artifacts.map((artifact: { path: string }) => artifact.path)).toContain(
      "baseline/attempt-1-facts.json",
    );
    expect(baseline.observation.events.map((event: { kind: string }) => event.kind)).toEqual([
      "typing",
      "reaction",
      "message",
    ]);
    expect(candidate.invocations).not.toEqual(baseline.invocations);
    expect(candidate.providerRequests).toHaveLength(1);
    expect(candidate.botApiRequests).toHaveLength(1);
    expect(
      manifest.artifacts.find(
        (artifact: { path: string }) => artifact.path === "baseline/baseline-previewGifCropped.gif",
      ),
    ).toMatchObject({ inline: true, kind: "timeline" });

    const comment = renderEvidenceComment({
      manifest: loadEvidenceManifest(path.join(output, "mantis-evidence.json")),
      marker: "<!-- mantis-telegram-visible-proof -->",
      rawBase: "https://qa.openclaw.ai/mantis/telegram-visible/run-1",
    });
    expect(comment).toContain(
      '<img src="https://qa.openclaw.ai/mantis/telegram-visible/run-1/baseline/baseline-previewGifCropped.gif"',
    );
    expect(comment).not.toContain(
      '<img src="https://qa.openclaw.ai/mantis/telegram-visible/run-1/baseline/baseline-screenshot.png"',
    );
  });

  it("rejects evidence whose independently recorded revision does not match", () => {
    expect(() => runCollector({ candidateSha: "c".repeat(40) })).toThrow(
      "candidate SUT attestation does not match",
    );
  });
});
