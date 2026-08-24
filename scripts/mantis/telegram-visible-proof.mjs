#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";

const OUTCOMES = new Set(["blocked", "fail", "pass"]);
const MEDIA = {
  previewGifCropped: { extension: "gif", kind: "timeline" },
  screenshot: { extension: "png", kind: "attachment" },
  trimmedVideoCropped: { extension: "mp4", kind: "motionClip" },
};

function fail(message) {
  throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function requiredText(value, label, maximum = 4_000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    fail(`${label} must contain 1 to ${maximum} characters.`);
  }
  return value.trim();
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("Invalid collect arguments.");
    }
    args[key.slice(2).replaceAll("-", "_")] = value;
  }
  return args;
}

function requiredArg(args, name) {
  const value = args[name];
  if (!value) {
    fail(`Missing --${name.replaceAll("_", "-")}.`);
  }
  return value;
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function copy(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function validateAgentJudgment(file) {
  const judgment = readJson(file);
  if (!isRecord(judgment) || judgment.schemaVersion !== 2) {
    fail("agent-evidence.json must use schemaVersion 2.");
  }
  const comparison = judgment.comparison;
  if (!isRecord(comparison) || !OUTCOMES.has(comparison.outcome)) {
    fail("agent-evidence.json needs a pass, blocked, or fail outcome.");
  }
  for (const lane of ["baseline", "candidate"]) {
    const value = comparison[lane];
    if (!isRecord(value) || typeof value.expectationMet !== "boolean") {
      fail(`agent-evidence.json comparison.${lane} needs expectationMet.`);
    }
    requiredText(value.expected, `comparison.${lane}.expected`, 1_000);
    requiredText(value.detail, `comparison.${lane}.detail`, 2_000);
  }
  if (comparison.pass !== (comparison.outcome === "pass")) {
    fail("agent-evidence.json pass must agree with outcome.");
  }
  if (
    comparison.outcome === "pass" &&
    (!comparison.baseline.expectationMet || !comparison.candidate.expectationMet)
  ) {
    fail("A passing judgment requires both lane expectations to be met.");
  }
  requiredText(judgment.title, "title", 200);
  requiredText(judgment.summary, "summary", 2_000);
  requiredText(judgment.scenario, "scenario", 1_000);
  requiredText(comparison.differential, "comparison.differential", 2_000);
  return judgment;
}

function artifactRecord(record, lane, name, publishedRoot) {
  if (!isRecord(record) || typeof record.file !== "string") {
    fail(`${lane} facts are missing ${name}.`);
  }
  if (record.file !== path.basename(record.file)) {
    fail(`${lane} ${name} has an invalid filename.`);
  }
  const source = path.join(publishedRoot, lane, record.file);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    fail(`${lane} ${name} is missing.`);
  }
  if (fs.statSync(source).size !== record.bytes || sha256(source) !== record.sha256) {
    fail(`${lane} ${name} failed integrity validation.`);
  }
  return source;
}

function loadLane({ factsFile, expectedSha, lane, outputDir, publishedRoot }) {
  const facts = readJson(factsFile);
  if (!isRecord(facts) || facts.schemaVersion !== 2 || facts.lane !== lane) {
    fail(`${lane} lane facts are invalid.`);
  }
  if (
    !isRecord(facts.sutAttestation) ||
    facts.sutAttestation.lane !== lane ||
    facts.sutAttestation.sha !== expectedSha
  ) {
    fail(`${lane} SUT attestation does not match ${expectedSha}.`);
  }
  if (!Array.isArray(facts.cleanupErrors) || facts.cleanupErrors.length > 0) {
    fail(`${lane} lane cleanup was incomplete.`);
  }
  if (!isRecord(facts.observation) || facts.observation.truncated === true) {
    fail(`${lane} event recording is missing or truncated.`);
  }
  if (!new Set(["blocked", "complete"]).has(facts.status)) {
    fail(`${lane} lane ended with ${facts.status ?? "no status"}: ${facts.error ?? "no detail"}`);
  }

  const laneDir = path.join(outputDir, lane);
  fs.mkdirSync(laneDir, { recursive: true });
  const artifacts = [];
  const copied = new Set();
  const records = isRecord(facts.artifacts) ? facts.artifacts : {};
  if (facts.status === "complete") {
    for (const name of Object.keys(MEDIA)) {
      artifactRecord(records[name], lane, name, publishedRoot);
    }
  }
  for (const [name, media] of Object.entries(MEDIA)) {
    const record = records[name];
    if (!record) {
      continue;
    }
    const source = artifactRecord(record, lane, name, publishedRoot);
    const filename = `${lane}-${name}.${media.extension}`;
    copy(source, path.join(laneDir, filename));
    copied.add(record.file);
    artifacts.push({
      alt: `${lane} ${name}`,
      inline: name === "previewGifCropped",
      kind: media.kind,
      label: lane === "baseline" ? "Before — current main" : "After — this PR",
      lane,
      path: `${lane}/${filename}`,
      required: facts.status === "complete",
      targetPath: `${lane}/${filename}`,
    });
  }

  const trustedLaneDir = path.join(publishedRoot, lane);
  for (const entry of fs.readdirSync(trustedLaneDir, { withFileTypes: true })) {
    if (!entry.isFile() || copied.has(entry.name) || entry.name === "mantis-lane-facts.json") {
      continue;
    }
    copy(path.join(trustedLaneDir, entry.name), path.join(laneDir, entry.name));
    artifacts.push({
      kind: "attachment",
      label: `${lane} ${entry.name}`,
      lane,
      path: `${lane}/${entry.name}`,
      required: false,
      targetPath: `${lane}/${entry.name}`,
    });
  }
  copy(factsFile, path.join(laneDir, "mantis-lane-facts.json"));
  artifacts.push({
    kind: "attachment",
    label: `${lane} complete recorded facts`,
    lane,
    path: `${lane}/mantis-lane-facts.json`,
    required: true,
    targetPath: `${lane}/mantis-lane-facts.json`,
  });
  return { artifacts, facts, status: facts.status === "complete" ? "pass" : "blocked" };
}

function collectProof(options) {
  const judgment = validateAgentJudgment(options.agentManifest);
  if (fs.existsSync(options.outputDir)) {
    fail(`Trusted output already exists: ${options.outputDir}`);
  }
  const baseline = loadLane({
    factsFile: options.baselineFacts,
    expectedSha: options.baselineSha,
    lane: "baseline",
    outputDir: options.outputDir,
    publishedRoot: options.publishedRoot,
  });
  const candidate = loadLane({
    factsFile: options.candidateFacts,
    expectedSha: options.candidateSha,
    lane: "candidate",
    outputDir: options.outputDir,
    publishedRoot: options.publishedRoot,
  });
  let outcome = judgment.comparison.outcome;
  if (outcome === "pass" && (baseline.status !== "pass" || candidate.status !== "pass")) {
    outcome = "fail";
  }

  copy(options.agentManifest, path.join(options.outputDir, "agent-judgment.json"));
  const artifacts = [
    ...baseline.artifacts,
    ...candidate.artifacts,
    {
      kind: "attachment",
      label: "Agent judgment",
      lane: "run",
      path: "agent-judgment.json",
      required: true,
      targetPath: "agent-judgment.json",
    },
  ];
  const laneComparison = (lane, loaded, ref, sha) => ({
    detail: lane.detail,
    expectationMet: lane.expectationMet && loaded.status === "pass",
    expected: lane.expected,
    ref,
    sha,
    status: loaded.status,
  });
  const runtimeSeconds = Math.round(
    (Number(baseline.facts.observation.uptimeMs ?? 0) +
      Number(candidate.facts.observation.uptimeMs ?? 0)) /
      1_000,
  );
  const manifest = {
    artifacts,
    comparison: {
      baseline: laneComparison(judgment.comparison.baseline, baseline, "main", options.baselineSha),
      candidate: laneComparison(
        judgment.comparison.candidate,
        candidate,
        options.candidateSha,
        options.candidateSha,
      ),
      differential: judgment.comparison.differential,
      outcome,
      pass: outcome === "pass",
    },
    id: "telegram-visible-proof",
    runtimeSeconds,
    scenario: judgment.scenario,
    schemaVersion: 2,
    summary: judgment.summary,
    title: judgment.title,
  };
  writeJson(path.join(options.outputDir, "mantis-evidence.json"), manifest);
  return manifest;
}

function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command !== "collect") {
    fail("Usage: telegram-visible-proof.mjs collect [arguments]");
  }
  const args = parseArgs(rest);
  const manifest = collectProof({
    agentManifest: requiredArg(args, "agent_manifest"),
    baselineFacts: requiredArg(args, "baseline_facts"),
    baselineSha: requiredArg(args, "baseline_sha"),
    candidateFacts: requiredArg(args, "candidate_facts"),
    candidateSha: requiredArg(args, "candidate_sha"),
    outputDir: requiredArg(args, "output_dir"),
    publishedRoot: requiredArg(args, "published_root"),
  });
  console.log(JSON.stringify({ outcome: manifest.comparison.outcome }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
