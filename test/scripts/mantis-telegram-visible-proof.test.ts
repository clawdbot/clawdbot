import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateVisibleProof,
  freezeScenario,
  validateScenarioDirectory,
} from "../../scripts/mantis/telegram-visible-proof.mjs";

const tempDirs: string[] = [];
const BASELINE_SHA = "a".repeat(40);
const CANDIDATE_SHA = "b".repeat(40);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function temp(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeScenario(root: string, candidateEquals = 1) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, "run.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
source "$MANTIS_SCENARIO_HELPER"
trap proof_abort EXIT
proof_start start config.json
proof_send send --text '@{sut} MANTIS-Q'
id="$(proof_result send '.sent.messageId')"
proof_observe observe --seconds 10 --since 0
proof_finish finish --focus-message-id "$id"
trap - EXIT
`,
  );
  writeFileSync(path.join(root, "config.json"), '{"mockResponse":"MANTIS-OK"}\n');
  writeFileSync(
    path.join(root, "assertions.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        name: "visible reply",
        baseline: {
          description: "Main shows no repaired reply.",
          expect: [
            {
              type: "count",
              match: {
                kind: "message",
                actor: "bot",
                text: { contains: "MANTIS-FIXED" },
              },
              equals: 0,
            },
          ],
        },
        candidate: {
          description: "The PR shows one repaired reply.",
          expect: [
            {
              type: "count",
              match: {
                kind: "message",
                actor: "bot",
                text: { contains: "MANTIS-FIXED" },
              },
              equals: candidateEquals,
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
}

function artifact(file: string, kind: "gif" | "png" | "mp4") {
  const headers = {
    gif: Buffer.from("GIF89a", "ascii"),
    png: Buffer.from("89504e470d0a1a0a", "hex"),
    mp4: Buffer.from("0000001866747970", "hex"),
  };
  writeFileSync(file, Buffer.concat([headers[kind], Buffer.alloc(12_000, 1)]));
  const bytes = Buffer.byteLength(readFileSync(file));
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  return { bytes, file: path.basename(file), sha256 };
}

function writeLane(params: {
  root: string;
  lane: "baseline" | "candidate";
  sha: string;
  events: unknown[];
  hidden?: string;
  invocations?: unknown[];
}) {
  const published = path.join(params.root, "published", params.lane);
  mkdirSync(published, { recursive: true });
  const records = {
    previewGifCropped: artifact(path.join(published, `${params.lane}.gif`), "gif"),
    screenshot: artifact(path.join(published, `${params.lane}.png`), "png"),
    trimmedVideoCropped: artifact(path.join(published, `${params.lane}.mp4`), "mp4"),
  };
  const facts = path.join(params.root, `${params.lane}.json`);
  writeFileSync(
    facts,
    `${JSON.stringify({
      schemaVersion: 2,
      lane: params.lane,
      status: "complete",
      cleanupErrors: [],
      sendCount: 1,
      sutAttestation: { lane: params.lane, sha: params.sha },
      artifacts: records,
      observation: { events: params.events, truncated: false, uptimeMs: 1000 },
      invocations:
        params.invocations ??
        [
          {
            command: "start",
            args: { config: "scenario/config.json", repoRoot: `/tmp/${params.lane}` },
          },
          { command: "send", args: { text: "@{sut} MANTIS-Q" } },
          {
            command: "finish",
            args: { focusMessageId: params.lane === "baseline" ? "1" : "2" },
          },
        ],
      providerRequests: [{ hidden: params.hidden ?? params.lane }],
      botApiRequests: [{ hidden: params.hidden ?? params.lane }],
    })}\n`,
  );
  return facts;
}

function evaluate(params: {
  scenario: string;
  baselineEvents: unknown[];
  candidateEvents: unknown[];
  candidateInvocations?: unknown[];
}) {
  const laneRoot = temp("mantis-visible-lanes-");
  const output = temp("mantis-visible-output-");
  const validated = validateScenarioDirectory(params.scenario);
  const baselineFacts = writeLane({
    root: laneRoot,
    lane: "baseline",
    sha: BASELINE_SHA,
    events: params.baselineEvents,
    hidden: "old-internal-value",
  });
  const candidateFacts = writeLane({
    root: laneRoot,
    lane: "candidate",
    sha: CANDIDATE_SHA,
    events: params.candidateEvents,
    hidden: "new-internal-value",
    invocations: params.candidateInvocations,
  });
  return evaluateVisibleProof({
    baselineExit: 0,
    baselineFacts,
    baselineRef: "main",
    baselineSha: BASELINE_SHA,
    candidateExit: 0,
    candidateFacts,
    candidateRef: CANDIDATE_SHA,
    candidateSha: CANDIDATE_SHA,
    outputDir: output,
    publishedRoot: path.join(laneRoot, "published"),
    scenarioDir: params.scenario,
    scenarioHash: validated.hash,
  });
}

describe("Mantis Telegram visible proof", () => {
  it("freezes the exact scenario bytes and rejects lane-specific scripts", () => {
    const draft = temp("mantis-visible-draft-");
    const frozen = path.join(temp("mantis-visible-frozen-parent-"), "scenario");
    writeScenario(draft);
    const result = freezeScenario({ draftDir: draft, frozenDir: frozen });
    expect(result.hash).toBe(validateScenarioDirectory(draft).hash);
    expect(validateScenarioDirectory(frozen).hash).toBe(result.hash);

    writeFileSync(
      path.join(draft, "run.sh"),
      `${readFileSync(path.join(draft, "run.sh"), "utf8")}\necho baseline\n`,
    );
    expect(() => validateScenarioDirectory(draft)).toThrow("baseline-specific branching");
  });

  it("rejects symlinks in the frozen scenario", () => {
    const draft = temp("mantis-visible-link-");
    writeScenario(draft);
    mkdirSync(path.join(draft, "assets"));
    symlinkSync(path.join(draft, "config.json"), path.join(draft, "assets", "config-link.json"));
    expect(() => validateScenarioDirectory(draft)).toThrow("cannot contain symlinks");
  });

  it("passes only a genuine Telegram-visible before and after", () => {
    const scenario = temp("mantis-visible-pass-");
    writeScenario(scenario);
    const user = {
      kind: "message",
      actor: "user",
      messageId: "1",
      elapsedMs: 0,
      text: "MANTIS-Q",
    };
    const result = evaluate({
      scenario,
      baselineEvents: [user],
      candidateEvents: [
        { ...user, messageId: "9" },
        {
          kind: "message",
          actor: "bot",
          messageId: "10",
          elapsedMs: 200,
          text: "MANTIS-FIXED",
        },
      ],
    });
    expect(result.manifest.comparison.outcome).toBe("pass");
    expect(result.manifest.id).toBe("telegram-visible-proof");
    expect(result.manifest.artifacts.map((entry) => entry.targetPath)).toEqual(
      expect.arrayContaining(["baseline/before.gif", "candidate/after.gif"]),
    );
  });

  it("blocks identical visible behavior even when hidden facts differ", () => {
    const scenario = temp("mantis-visible-identical-");
    writeScenario(scenario);
    const events = [
      {
        kind: "message",
        actor: "user",
        messageId: "1",
        elapsedMs: 0,
        text: "MANTIS-Q",
      },
    ];
    const result = evaluate({ scenario, baselineEvents: events, candidateEvents: events });
    expect(result.manifest.comparison.outcome).toBe("blocked");
    expect(result.manifest.comparison.differential).toContain("No material Telegram-visible");
  });

  it("fails when the candidate does not satisfy its visible assertion", () => {
    const scenario = temp("mantis-visible-fail-");
    writeScenario(scenario);
    const events = [
      { kind: "message", actor: "user", messageId: "1", elapsedMs: 0, text: "MANTIS-Q" },
    ];
    const result = evaluate({
      scenario,
      baselineEvents: events,
      candidateEvents: [
        ...events,
        { kind: "message", actor: "bot", messageId: "2", text: "WRONG" },
      ],
    });
    expect(result.manifest.comparison.outcome).toBe("fail");
    expect(result.manifest.comparison.differential).toContain("did not satisfy");
  });

  it("blocks divergent scenario actions", () => {
    const scenario = temp("mantis-visible-actions-");
    writeScenario(scenario);
    const user = {
      kind: "message",
      actor: "user",
      messageId: "1",
      elapsedMs: 0,
      text: "MANTIS-Q",
    };
    const result = evaluate({
      scenario,
      baselineEvents: [user],
      candidateEvents: [
        user,
        { kind: "message", actor: "bot", messageId: "2", text: "MANTIS-FIXED" },
      ],
      candidateInvocations: [
        {
          command: "start",
          args: { config: "scenario/config.json", repoRoot: "/tmp/candidate" },
        },
        { command: "send", args: { text: "DIFFERENT" } },
        { command: "finish", args: { focusMessageId: "2" } },
      ],
    });
    expect(result.manifest.comparison.outcome).toBe("blocked");
    expect(result.manifest.comparison.differential).toContain(
      "same normalized scenario actions",
    );
  });
});
