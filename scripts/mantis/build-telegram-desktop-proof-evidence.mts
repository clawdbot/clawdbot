#!/usr/bin/env node
// Builds an HTML/manifest evidence bundle from Telegram Desktop proof artifacts.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sanitizeCommentText } from "./publish-pr-evidence.mjs";

type CliArgs = Record<string, string>;
type LaneName = "baseline" | "candidate";
type LaneStatus = "blocked" | "fail" | "pass";
type LaneFacts = {
  attempt: number;
  blocked?: { reason?: string };
  botApiRequests: unknown[];
  error?: string;
  observation: { events: unknown[]; observedSeconds: number };
  providerRequests: unknown[];
  sendCount: number;
};
type LaneDigestCounts = {
  sent: number;
  botMessages: number;
  edits: number;
  deletes: number;
  providerRequests: number;
  injectedBotApiFaults: number;
};
type LaneDigest = {
  counts: LaneDigestCounts;
  text: string;
};
type ManifestLane = {
  detail?: string;
  digest?: string;
  expected: string;
  expectationMet?: boolean;
  status: string;
  ref?: string;
  sha?: string;
};
type SessionSummary = {
  artifacts?: Partial<
    Record<
      "previewGifCropped" | "previewGif" | "screenshot" | "trimmedVideoCropped" | "trimmedVideo",
      string
    >
  >;
  report?: string;
  status?: string;
  sutAttestation?: { lane?: string; sha?: string };
};
type LoadedLane = {
  facts: LaneFacts;
  factsPath: string;
  outputDir: string;
  repoRoot: string;
  status: string;
  summary: SessionSummary;
  summaryPath: string;
};
type EvidenceArtifact = {
  alt?: string;
  inline?: boolean;
  kind: string;
  label: string;
  lane: LaneName | "run";
  path: string;
  required?: boolean;
  targetPath: string;
  width?: number;
};
type TelegramDesktopProofManifest = {
  schemaVersion: number;
  id: string;
  title: string;
  summary: string;
  scenario: string;
  comparison: {
    baseline: ManifestLane;
    candidate: ManifestLane;
    differential?: string;
    outcome: LaneStatus;
    pass: boolean;
  };
  artifacts: EvidenceArtifact[];
};

const MAX_LANE_DETAIL_LENGTH = 300;
const MAX_SENT_INPUT_LENGTH = 80;
const MAX_SENT_INPUTS = 4;
const PASS_SUMMARY =
  "Mantis captured native Telegram Desktop before/after GIF evidence with Convex-leased Telegram credentials.";
const INCOMPLETE_SUMMARY =
  "Mantis did not capture native Telegram Desktop before/after GIF proof. See the Baseline and Candidate lane details below.";

const LANES = [
  {
    altPrefix: "Baseline",
    label: "Main",
    lane: "baseline",
  },
  {
    altPrefix: "Candidate",
    label: "This PR merged onto main",
    lane: "candidate",
  },
] satisfies ReadonlyArray<{
  altPrefix: string;
  label: string;
  lane: LaneName;
}>;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    const name = key.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    args[name] = value;
    index += 1;
  }
  return args;
}

function requireArg(args: CliArgs, name: string): string {
  const value = args[name];
  if (!value) {
    throw new Error(`Missing --${name.replaceAll("_", "-")}.`);
  }
  return value;
}

function readSessionSummary(filePath: string): SessionSummary {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readLaneFacts(filePath: string): LaneFacts {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function copyArtifact({
  outputDir,
  required = true,
  source,
  targetPath,
}: {
  outputDir: string;
  required?: boolean;
  source?: string;
  targetPath: string;
}) {
  if (!source || !existsSync(source)) {
    if (required) {
      throw new Error(`Missing required artifact: ${source}`);
    }
    return false;
  }
  const target = path.join(outputDir, targetPath);
  mkdirSync(path.dirname(target), { recursive: true });
  if (path.resolve(source) !== path.resolve(target)) {
    copyFileSync(source, target);
  }
  return true;
}

function resolveSummaryArtifact(
  lane: LoadedLane,
  key: keyof NonNullable<SessionSummary["artifacts"]>,
) {
  const value = lane.summary.artifacts?.[key];
  return typeof value === "string" ? path.resolve(lane.repoRoot, value) : undefined;
}

function loadLane({
  outputDir,
  repoRoot,
  status,
}: {
  outputDir: string;
  repoRoot: string;
  status?: string;
}): LoadedLane {
  const summaryPath = path.join(outputDir, "telegram-user-crabbox-session-summary.json");
  const factsPath = path.join(outputDir, "mantis-lane-facts.json");
  const summary = readSessionSummary(summaryPath);
  return {
    facts: readLaneFacts(factsPath),
    factsPath,
    outputDir,
    repoRoot,
    status: status || summary.status || "unknown",
    summary,
    summaryPath,
  };
}

function copyLaneArtifacts({
  lane,
  laneName,
  outputDir,
}: {
  lane: LoadedLane;
  laneName: LaneName;
  outputDir: string;
}) {
  const prefix = laneName;
  const gif =
    resolveSummaryArtifact(lane, "previewGifCropped") ?? resolveSummaryArtifact(lane, "previewGif");
  copyArtifact({
    outputDir,
    required: laneStatus(lane) === "pass",
    source: gif,
    targetPath: `${prefix}/telegram-desktop-proof.gif`,
  });
  copyArtifact({
    outputDir,
    required: false,
    source:
      resolveSummaryArtifact(lane, "trimmedVideoCropped") ??
      resolveSummaryArtifact(lane, "trimmedVideo"),
    targetPath: `${prefix}/telegram-desktop-proof.mp4`,
  });
  copyArtifact({
    outputDir,
    required: false,
    source: resolveSummaryArtifact(lane, "screenshot"),
    targetPath: `${prefix}/telegram-desktop-proof.png`,
  });
  copyArtifact({
    outputDir,
    source: lane.summaryPath,
    targetPath: `${prefix}/summary.json`,
  });
  copyArtifact({
    outputDir,
    source: lane.factsPath,
    targetPath: `${prefix}/mantis-lane-facts.json`,
  });
  copyArtifact({
    outputDir,
    required: false,
    source:
      typeof lane.summary.report === "string"
        ? path.resolve(lane.repoRoot, lane.summary.report)
        : undefined,
    targetPath: `${prefix}/report.md`,
  });
}

function laneStatus(lane: LoadedLane): LaneStatus {
  return lane.status === "pass" || lane.status === "blocked" ? lane.status : "fail";
}

function sanitizeLaneDetail(value: string | undefined): string | undefined {
  return sanitizeCommentText(value, MAX_LANE_DETAIL_LENGTH);
}

function laneDetail(lane: LoadedLane, status: LaneStatus): string | undefined {
  if (status === "blocked") {
    return sanitizeLaneDetail(lane.facts.blocked?.reason);
  }
  return status === "fail" ? sanitizeLaneDetail(lane.facts.error) : undefined;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function sentInput(event: Record<string, unknown>): string | undefined {
  const contentType = typeof event.contentType === "string" ? event.contentType : undefined;
  if (contentType && contentType !== "messageText") {
    const recordedType = contentType.startsWith("message")
      ? contentType.slice("message".length)
      : contentType;
    const label = recordedType
      ? `${recordedType.slice(0, 1).toLowerCase()}${recordedType.slice(1)}`
      : contentType;
    const sanitized = sanitizeCommentText(label, MAX_SENT_INPUT_LENGTH);
    return sanitized ? `[${sanitized}]` : undefined;
  }
  return typeof event.text === "string"
    ? sanitizeCommentText(event.text, MAX_SENT_INPUT_LENGTH)
    : undefined;
}

function laneDigest(facts: LaneFacts): LaneDigest | undefined {
  const { attempt, botApiRequests, observation, providerRequests, sendCount } = facts;
  const hasRecordedFacts =
    sendCount > 0 ||
    observation.events.length > 0 ||
    botApiRequests.length > 0 ||
    providerRequests.length > 0 ||
    observation.observedSeconds > 0;
  if (!hasRecordedFacts) {
    return undefined;
  }

  const counts: LaneDigestCounts = {
    sent: sendCount,
    botMessages: 0,
    edits: 0,
    deletes: 0,
    providerRequests: providerRequests.length,
    injectedBotApiFaults: botApiRequests.filter(
      (request) => isRecord(request) && request.injected === true,
    ).length,
  };
  const inputs: string[] = [];
  for (const event of observation.events) {
    if (!isRecord(event)) {
      continue;
    }
    if (event.actor === "bot") {
      if (event.kind === "message") {
        counts.botMessages += 1;
      } else if (event.kind === "edit") {
        counts.edits += 1;
      } else if (event.kind === "delete") {
        counts.deletes += 1;
      }
    } else if (
      event.actor === "user" &&
      event.kind === "message" &&
      inputs.length <= MAX_SENT_INPUTS
    ) {
      const input = sentInput(event);
      if (input) {
        inputs.push(input);
      }
    }
  }

  const pieces = [
    `${counts.sent} sent`,
    countLabel(counts.botMessages, "bot message"),
    countLabel(counts.edits, "edit"),
    countLabel(counts.deletes, "delete"),
    countLabel(counts.providerRequests, "provider request"),
    ...(counts.injectedBotApiFaults > 0
      ? [countLabel(counts.injectedBotApiFaults, "injected Bot API fault")]
      : []),
    `${Math.round(observation.observedSeconds)}s observed`,
    `attempt ${attempt}`,
  ];
  if (inputs.length > 0) {
    const renderedInputs = inputs.slice(0, MAX_SENT_INPUTS).map((input) => `\`${input}\``);
    if (inputs.length > MAX_SENT_INPUTS) {
      renderedInputs.push("…");
    }
    pieces.push(`sent: ${renderedInputs.join(", ")}`);
  }
  return { counts, text: pieces.join(" · ") };
}

function laneDifferential(
  baseline: LaneDigest,
  candidate: LaneDigest,
  outcome: LaneStatus,
): string {
  const fields = [
    ["sent", "sent"],
    ["botMessages", "bot messages"],
    ["edits", "edits"],
    ["deletes", "deletes"],
    ["providerRequests", "provider requests"],
    ["injectedBotApiFaults", "injected Bot API faults"],
  ] as const;
  const differences = fields.flatMap(([field, label]) => {
    const before = baseline.counts[field];
    const after = candidate.counts[field];
    return before === after ? [] : [`${label} ${before}→${after}`];
  });
  if (differences.length > 0) {
    return differences.join(" · ");
  }
  return outcome === "pass"
    ? "no count differences; pass rests on payload facts and the lane judgments"
    : "no count differences";
}

function requireLaneAttestation(lane: LoadedLane, expectedLane: LaneName, expectedSha: string) {
  const attestation = lane.summary.sutAttestation;
  if (attestation?.lane === expectedLane && attestation.sha === expectedSha) {
    return;
  }
  if (
    lane.status === "fail" &&
    lane.summary.status === "infra-error" &&
    attestation == null &&
    Object.keys(lane.summary.artifacts ?? {}).length === 0 &&
    lane.summary.report === undefined
  ) {
    return;
  }
  throw new Error(`SUT attestation mismatch for ${expectedLane}.`);
}

function laneArtifactEntries(statuses: Record<LaneName, LaneStatus>): EvidenceArtifact[] {
  return LANES.flatMap(({ altPrefix, label, lane }) => [
    {
      alt: `${altPrefix} native Telegram Desktop proof GIF`,
      inline: true,
      kind: "motionPreview",
      label,
      lane,
      path: `${lane}/telegram-desktop-proof.gif`,
      required: statuses[lane] === "pass",
      targetPath: `${lane}/telegram-desktop-proof.gif`,
      width: 420,
    },
    {
      kind: "motionClip",
      label: `${label} MP4`,
      lane,
      path: `${lane}/telegram-desktop-proof.mp4`,
      required: false,
      targetPath: `${lane}/telegram-desktop-proof.mp4`,
    },
    {
      alt: `${altPrefix} native Telegram Desktop screenshot`,
      inline: false,
      kind: "desktopScreenshot",
      label: `${label} screenshot`,
      lane,
      path: `${lane}/telegram-desktop-proof.png`,
      required: false,
      targetPath: `${lane}/telegram-desktop-proof.png`,
    },
    {
      kind: "metadata",
      label: `${label} session summary`,
      lane,
      path: `${lane}/summary.json`,
      targetPath: `${lane}/summary.json`,
    },
    {
      kind: "metadata",
      label: `${label} lane facts`,
      lane,
      path: `${lane}/mantis-lane-facts.json`,
      targetPath: `${lane}/mantis-lane-facts.json`,
    },
    {
      kind: "report",
      label: `${label} session report`,
      lane,
      path: `${lane}/report.md`,
      required: false,
      targetPath: `${lane}/report.md`,
    },
  ]);
}

/**
 * Builds the manifest for paired baseline/candidate Telegram Desktop proof artifacts.
 */
function buildTelegramDesktopProofManifest({
  baseline,
  baselineRef,
  baselineSha,
  candidate,
  candidateRef,
  candidateSha,
  scenarioLabel,
}: {
  baseline: LoadedLane;
  baselineRef?: string;
  baselineSha?: string;
  candidate: LoadedLane;
  candidateRef?: string;
  candidateSha?: string;
  scenarioLabel?: string;
}): TelegramDesktopProofManifest {
  const baselineStatus = laneStatus(baseline);
  const candidateStatus = laneStatus(candidate);
  const baselineDetail = laneDetail(baseline, baselineStatus);
  const candidateDetail = laneDetail(candidate, candidateStatus);
  const outcome =
    baselineStatus === "fail" || candidateStatus === "fail"
      ? "fail"
      : baselineStatus === "blocked" || candidateStatus === "blocked"
        ? "blocked"
        : "pass";
  const baselineDigest = laneDigest(baseline.facts);
  const candidateDigest = laneDigest(candidate.facts);
  return {
    schemaVersion: 2,
    id: "telegram-desktop-proof",
    title: "Mantis Telegram Desktop Proof",
    summary: outcome === "pass" ? PASS_SUMMARY : INCOMPLETE_SUMMARY,
    scenario: scenarioLabel || "telegram-desktop-proof",
    comparison: {
      baseline: {
        ...(baselineDetail ? { detail: baselineDetail } : {}),
        ...(baselineDigest ? { digest: baselineDigest.text } : {}),
        ...(baselineSha ? { sha: baselineSha } : {}),
        ...(baselineRef ? { ref: baselineRef } : {}),
        expected: "baseline visual proof captured",
        status: baselineStatus,
      },
      candidate: {
        ...(candidateDetail ? { detail: candidateDetail } : {}),
        ...(candidateDigest ? { digest: candidateDigest.text } : {}),
        ...(candidateSha ? { sha: candidateSha } : {}),
        ...(candidateRef ? { ref: candidateRef } : {}),
        expected: "candidate visual proof captured",
        status: candidateStatus,
      },
      ...(baselineDigest && candidateDigest
        ? { differential: laneDifferential(baselineDigest, candidateDigest, outcome) }
        : {}),
      outcome,
      pass: outcome === "pass",
    },
    artifacts: [
      ...laneArtifactEntries({ baseline: baselineStatus, candidate: candidateStatus }),
      {
        inline: false,
        kind: "attachment",
        label: "Recipe suggestion",
        lane: "run",
        path: "recipe-suggestion.md",
        required: false,
        targetPath: "recipe-suggestion.md",
      },
    ],
  };
}

export function writeTelegramDesktopProofEvidence(rawArgs: string[] = process.argv.slice(2)): {
  manifest: TelegramDesktopProofManifest;
  manifestPath: string;
} {
  const args = parseArgs(rawArgs);
  const baselineOutputDir = requireArg(args, "baseline_output_dir");
  const baselineRepoRoot = requireArg(args, "baseline_repo_root");
  const baselineSha = requireArg(args, "baseline_sha");
  const candidateOutputDir = requireArg(args, "candidate_output_dir");
  const candidateRepoRoot = requireArg(args, "candidate_repo_root");
  const candidateSha = requireArg(args, "candidate_sha");
  const evidenceOutputDir = requireArg(args, "output_dir");

  const outputDir = path.resolve(evidenceOutputDir);
  mkdirSync(outputDir, { recursive: true });
  const baseline = loadLane({
    outputDir: path.resolve(baselineOutputDir),
    repoRoot: path.resolve(baselineRepoRoot),
    status: args.baseline_status,
  });
  const candidate = loadLane({
    outputDir: path.resolve(candidateOutputDir),
    repoRoot: path.resolve(candidateRepoRoot),
    status: args.candidate_status,
  });
  requireLaneAttestation(baseline, "baseline", baselineSha);
  requireLaneAttestation(candidate, "candidate", candidateSha);
  copyLaneArtifacts({ lane: baseline, laneName: "baseline", outputDir });
  copyLaneArtifacts({ lane: candidate, laneName: "candidate", outputDir });
  copyArtifact({
    outputDir,
    required: false,
    source: path.join(outputDir, "recipe-suggestion.md"),
    targetPath: "recipe-suggestion.md",
  });
  const manifest = buildTelegramDesktopProofManifest({
    baseline,
    baselineRef: args.baseline_ref,
    baselineSha,
    candidate,
    candidateRef: args.candidate_ref,
    candidateSha,
    scenarioLabel: args.scenario_label,
  });
  const manifestPath = path.join(outputDir, "mantis-evidence.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, manifestPath };
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (executedPath === fileURLToPath(import.meta.url)) {
  try {
    writeTelegramDesktopProofEvidence();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
