#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
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

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function assertInside(parentDir, candidatePath, label) {
  const relative = path.relative(parentDir, candidatePath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return candidatePath;
  }
  throw new Error(`${label} escapes manifest directory: ${candidatePath}`);
}

function normalizeTargetPath(targetPath) {
  const normalized = path.posix.normalize(String(targetPath).replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized === "" ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized)
  ) {
    throw new Error(`Invalid artifact target path: ${targetPath}`);
  }
  return normalized;
}

function resolveArtifact(manifestDir, artifact) {
  if (!artifact || typeof artifact !== "object") {
    throw new Error("Manifest artifact entries must be objects.");
  }
  if (!artifact.path) {
    throw new Error("Manifest artifact entry is missing path.");
  }

  const source = assertInside(
    manifestDir,
    path.resolve(manifestDir, artifact.path),
    `Artifact ${artifact.label ?? artifact.path}`,
  );
  const required = artifact.required !== false;
  if (!existsSync(source)) {
    if (required) {
      throw new Error(`Missing required artifact: ${artifact.path}`);
    }
    return null;
  }
  if (!statSync(source).isFile()) {
    throw new Error(`Artifact is not a file: ${artifact.path}`);
  }

  return {
    ...artifact,
    kind: artifact.kind ?? "attachment",
    lane: artifact.lane ?? "run",
    label: artifact.label ?? artifact.path,
    required,
    source,
    targetPath: normalizeTargetPath(artifact.targetPath ?? path.basename(artifact.path)),
  };
}

export function loadEvidenceManifest(manifestPath) {
  const resolvedManifest = path.resolve(manifestPath);
  const manifestDir = path.dirname(resolvedManifest);
  const manifest = readJson(resolvedManifest);
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported Mantis evidence manifest schema: ${manifest.schemaVersion}`);
  }
  if (!manifest.id || !manifest.title || !manifest.scenario) {
    throw new Error("Mantis evidence manifest requires id, title, and scenario.");
  }
  const artifacts = (manifest.artifacts ?? [])
    .map((artifact) => resolveArtifact(manifestDir, artifact))
    .filter(Boolean);
  artifacts.push({
    kind: "metadata",
    lane: "run",
    label: "Mantis evidence manifest",
    source: resolvedManifest,
    targetPath: "mantis-evidence.json",
  });
  return {
    ...manifest,
    artifacts,
    manifestDir,
  };
}

function renderArtifactFileList(artifacts) {
  const links = artifacts.map((artifact) => `- ${artifact.label}: \`${artifact.targetPath}\``);
  if (links.length === 0) {
    return "";
  }
  return ["Artifact files:", ...links, ""].join("\n");
}

function laneLine(label, lane) {
  if (!lane) {
    return "";
  }
  const pieces = [`- ${label}: \`${lane.status ?? "unknown"}\``];
  if (lane.sha) {
    pieces.push(` at \`${lane.sha}\``);
  } else if (lane.ref) {
    pieces.push(` at \`${lane.ref}\``);
  }
  if (lane.expected) {
    pieces.push(`, expected ${lane.expected}`);
  }
  return pieces.join("");
}

export function renderEvidenceComment({
  artifactUrl: actionsArtifactUrl,
  manifest,
  marker,
  requestSource,
  runUrl,
}) {
  const comparison = manifest.comparison ?? {};
  const baseline = comparison.baseline;
  const candidate = comparison.candidate;
  const lines = [
    marker,
    `## ${manifest.title}`,
    "",
    `Summary: ${manifest.summary ?? "Mantis captured QA evidence for this scenario."}`,
    "",
    `- Scenario: \`${manifest.scenario}\``,
  ];
  if (requestSource) {
    lines.push(`- Trigger: \`${requestSource}\``);
  }
  if (runUrl) {
    lines.push(`- Run: ${runUrl}`);
  }
  if (actionsArtifactUrl) {
    lines.push(`- Artifact: ${actionsArtifactUrl}`);
  }
  const baselineLine = laneLine("Baseline", baseline);
  if (baselineLine) {
    lines.push(baselineLine);
  }
  const candidateLine = laneLine("Candidate", candidate);
  if (candidateLine) {
    lines.push(candidateLine);
  }
  if (typeof comparison.pass === "boolean") {
    lines.push(`- Overall: \`${comparison.pass}\``);
  }
  lines.push("");
  lines.push(renderArtifactFileList(manifest.artifacts));
  lines.push(`Raw QA files: ${actionsArtifactUrl}`);
  return `${lines.join("\n").replace(/\n{3,}/gu, "\n\n")}\n`;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "inherit"],
    ...options,
  });
}

function upsertPrComment({ body, marker, prNumber, repo }) {
  run("gh", ["api", `repos/${repo}/pulls/${prNumber}`, "--jq", ".number"]);
  const commentId = run("gh", [
    "api",
    "--paginate",
    `repos/${repo}/issues/${prNumber}/comments`,
    "--jq",
    `.[] | select(.body | contains("${marker}")) | .id`,
  ])
    .trim()
    .split("\n")
    .findLast((line) => line.length > 0);
  const bodyFile = path.join(mkdtempSync(path.join(tmpdir(), "mantis-comment-")), "body.md");
  writeFileSync(bodyFile, body);
  try {
    if (commentId) {
      const payloadFile = `${bodyFile}.json`;
      writeFileSync(payloadFile, JSON.stringify({ body }));
      try {
        run("gh", [
          "api",
          "--method",
          "PATCH",
          `repos/${repo}/issues/comments/${commentId}`,
          "--input",
          payloadFile,
        ]);
        console.log(`Updated Mantis QA evidence comment on PR #${prNumber}.`);
        return;
      } catch {
        console.warn(
          `Could not update existing Mantis QA evidence comment ${commentId}; creating a new one.`,
        );
      }
    }
    run("gh", ["pr", "comment", prNumber, "--body-file", bodyFile], { stdio: "inherit" });
    console.log(`Created Mantis QA evidence comment on PR #${prNumber}.`);
  } finally {
    rmSync(path.dirname(bodyFile), { force: true, recursive: true });
  }
}

export function publishEvidence(rawArgs = process.argv.slice(2)) {
  const args = parseArgs(rawArgs);
  const required = ["manifest", "target_pr", "artifact_root", "marker"];
  for (const key of required) {
    if (!args[key]) {
      throw new Error(`Missing --${key.replaceAll("_", "-")}.`);
    }
  }
  if (!/^[0-9]+$/u.test(args.target_pr)) {
    throw new Error(`--target-pr must be numeric, got ${args.target_pr}.`);
  }
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY;
  const ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!repo) {
    throw new Error("Missing --repo or GITHUB_REPOSITORY.");
  }
  if (!ghToken) {
    throw new Error("Missing GH_TOKEN or GITHUB_TOKEN.");
  }
  if (!args.artifact_url) {
    throw new Error("Missing --artifact-url. Mantis evidence must use Actions artifacts, not Git.");
  }

  const manifest = loadEvidenceManifest(args.manifest);
  normalizeTargetPath(args.artifact_root);
  const body = renderEvidenceComment({
    artifactUrl: args.artifact_url,
    manifest,
    marker: args.marker,
    requestSource: args.request_source,
    runUrl: args.run_url,
  });
  upsertPrComment({
    body,
    marker: args.marker,
    prNumber: args.target_pr,
    repo,
  });
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (executedPath === fileURLToPath(import.meta.url)) {
  try {
    publishEvidence();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
