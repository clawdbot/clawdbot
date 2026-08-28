#!/usr/bin/env node
// Publishes evidence manifest artifacts and optional PR comments for Mantis proof.
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBoundedResponseText } from "../lib/bounded-response.mjs";

/** @typedef {Record<string, unknown> & { detail?: string, digest?: string, expectationMet: boolean, expected?: string, fixed?: boolean, ref?: string, sha?: string, status?: string }} EvidenceLane */
/**
 * @typedef {{
 *   alt?: string,
 *   inline?: boolean,
 *   kind: string,
 *   label: string,
 *   lane: string,
 *   path?: string,
 *   required?: boolean,
 *   source: string,
 *   targetPath: string,
 *   width?: number,
 * }} EvidenceArtifact
 */
/**
 * @typedef {{
 *   artifacts: EvidenceArtifact[],
 *   comparison: { baseline?: EvidenceLane, candidate: EvidenceLane, differential?: string, outcome: "blocked" | "fail" | "pass", pass: boolean, verdictNote?: string },
 *   id: string,
 *   manifestDir: string,
 *   scenario: string,
 *   schemaVersion: number,
 *   summary?: string,
 *   title: string,
 * }} EvidenceManifest
 */
/**
 * @typedef {{
 *   alt?: string,
 *   inline?: boolean,
 *   kind?: string,
 *   label?: string,
 *   lane?: string,
 *   path?: string,
 *   required?: boolean,
 *   targetPath?: string,
 *   width?: number,
 * }} ManifestArtifactEntry
 */
/** @typedef {Omit<EvidenceManifest, "artifacts" | "manifestDir"> & { artifacts?: ManifestArtifactEntry[] }} EvidenceManifestFile */
/** @typedef {{ accessKeyId: string, bucket: string, endpoint: string, publicBaseUrl: string, region: string, secretAccessKey: string }} ObjectStorageConfig */
/** @typedef {(url: URL, init: { body: Buffer, headers: HeadersInit, method: string, signal: AbortSignal }) => Promise<Response>} ArtifactFetch */
/** @typedef {{ body: Buffer, headers: HeadersInit, method: string, url: URL }} SignedPutRequest */
/** @typedef {{ left: EvidenceArtifact, right: EvidenceArtifact }} EvidencePair */
/**
 * @typedef {{
 *   artifactUrl?: string,
 *   manifest: EvidenceManifest,
 *   marker: string,
 *   rawBase: string,
 *   requestSource?: string,
 *   runUrl?: string,
 *   treeUrl?: string,
 * }} RenderEvidenceCommentOptions
 */

// Evidence bundles can include full videos, so allow slow transfers while bounding each PUT.
const MANTIS_ARTIFACT_UPLOAD_TIMEOUT_MS = 300_000;
// Untrusted storage error bodies are for diagnostics only; keep them small.
const MANTIS_UPLOAD_ERROR_BODY_MAX_BYTES = 64 * 1024;
const COMMENT_GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });
const MANTIS_EVIDENCE_SCHEMA_VERSION = 2;

/**
 * @param {string | undefined} value
 * @param {number} maxLength
 * @returns {string | undefined}
 */
export function sanitizeCommentText(value, maxLength) {
  const escaped = value
    ?.trim()
    .replace(/\s+/gu, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("`", "&#96;");
  if (!escaped) {
    return undefined;
  }
  const graphemes = Array.from(
    COMMENT_GRAPHEME_SEGMENTER.segment(escaped),
    ({ segment }) => segment,
  );
  return graphemes.length > maxLength ? `${graphemes.slice(0, maxLength - 1).join("")}…` : escaped;
}

function parseArgs(argv) {
  const args = {};
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
function requireArg(args, name) {
  const value = args[name];
  if (!value) {
    throw new Error(`Missing --${name.replaceAll("_", "-")}.`);
  }
  return value;
}
/** @returns {EvidenceManifestFile} */
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
/**
 * @param {string} manifestDir
 * @param {ManifestArtifactEntry} artifact
 * @returns {EvidenceArtifact | null}
 */
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

function requireExpectationMet(comparison, laneName) {
  const lane = comparison[laneName];
  if (!lane || typeof lane !== "object") {
    throw new Error(`Mantis evidence comparison requires a ${laneName} lane.`);
  }
  if (typeof lane.expectationMet !== "boolean") {
    throw new Error(`Mantis evidence comparison.${laneName}.expectationMet must be a boolean.`);
  }
  return lane.expectationMet;
}

/**
 * @param {EvidenceManifestFile} manifest
 */
function reconcileEvidenceVerdict(manifest) {
  if (!manifest.comparison || typeof manifest.comparison !== "object") {
    throw new Error("Mantis evidence manifest requires a comparison.");
  }
  const laneNames = manifest.comparison.baseline ? ["baseline", "candidate"] : ["candidate"];
  const comparison = { ...manifest.comparison };
  const unmetLanes = laneNames.filter((laneName) => !requireExpectationMet(comparison, laneName));
  const claimedPass = comparison.pass || comparison.outcome === "pass";
  const pass = comparison.pass && unmetLanes.length === 0;
  const outcome = pass ? "pass" : comparison.outcome === "blocked" ? "blocked" : "fail";
  const downgradeNote = `verdict downgraded: ${unmetLanes.join(" and ")} expectation${unmetLanes.length === 1 ? "" : "s"} not met`;
  const verdictNote =
    unmetLanes.length > 0 && (claimedPass || comparison.verdictNote === downgradeNote)
      ? downgradeNote
      : undefined;
  const { verdictNote: _untrustedVerdictNote, ...rest } = comparison;
  return {
    ...manifest,
    comparison: {
      ...rest,
      outcome,
      pass,
      ...(verdictNote ? { verdictNote } : {}),
    },
  };
}

/** @param {string} manifestPath */
export function validateEvidenceManifestFile(manifestPath) {
  const resolvedManifest = path.resolve(manifestPath);
  const manifestDir = path.dirname(resolvedManifest);
  const manifest = validateEvidenceManifest(readJson(resolvedManifest), manifestDir);
  for (const artifact of manifest.artifacts ?? []) {
    resolveArtifact(manifestDir, artifact);
  }
  writeFileSync(resolvedManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

/**
 * @param {EvidenceManifestFile} manifest
 * @param {string} manifestDir
 */
function validateEvidenceManifest(manifest, manifestDir) {
  if (manifest.schemaVersion !== MANTIS_EVIDENCE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Mantis evidence manifest schema: ${manifest.schemaVersion}. Rerun the proof to create schema version 2 evidence.`,
    );
  }
  if (!manifest.id || !manifest.title || !manifest.scenario) {
    throw new Error("Mantis evidence manifest requires id, title, and scenario.");
  }
  return reconcileEvidenceVerdict(manifest);
}
/**
 * Loads and validates an evidence manifest from disk.
 *
 * @param {string} manifestPath
 * @returns {EvidenceManifest}
 */
export function loadEvidenceManifest(manifestPath) {
  const resolvedManifest = path.resolve(manifestPath);
  const manifestDir = path.dirname(resolvedManifest);
  const manifest = validateEvidenceManifestFile(resolvedManifest);
  const artifacts = (manifest.artifacts ?? [])
    .map((artifact) => resolveArtifact(manifestDir, artifact))
    .filter((artifact) => artifact !== null);
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
function encodePathForUrl(input) {
  return input
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}
function artifactUrl(rawBase, artifact) {
  return `${rawBase}/${encodePathForUrl(artifact.targetPath)}`;
}
function requireEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}
/** @returns {ObjectStorageConfig} */
function objectStorageConfig(env = process.env) {
  return {
    accessKeyId: requireEnv(env, "MANTIS_ARTIFACT_R2_ACCESS_KEY_ID"),
    bucket: requireEnv(env, "MANTIS_ARTIFACT_R2_BUCKET"),
    endpoint: requireEnv(env, "MANTIS_ARTIFACT_R2_ENDPOINT").replace(/\/+$/u, ""),
    publicBaseUrl: requireEnv(env, "MANTIS_ARTIFACT_R2_PUBLIC_BASE_URL").replace(/\/+$/u, ""),
    region: requireEnv(env, "MANTIS_ARTIFACT_R2_REGION"),
    secretAccessKey: requireEnv(env, "MANTIS_ARTIFACT_R2_SECRET_ACCESS_KEY"),
  };
}
function digestHex(value) {
  return createHash("sha256").update(value).digest("hex");
}
function hmacBuffer(key, value) {
  return createHmac("sha256", key).update(value).digest();
}
function hmacHex(key, value) {
  return createHmac("sha256", key).update(value).digest("hex");
}
function signingKey({ date, region, secretAccessKey }) {
  const dateKey = hmacBuffer(`AWS4${secretAccessKey}`, date);
  const regionKey = hmacBuffer(dateKey, region);
  const serviceKey = hmacBuffer(regionKey, "s3");
  return hmacBuffer(serviceKey, "aws4_request");
}
function s3Path({ bucket, key }) {
  return `/${encodePathForUrl(bucket)}/${encodePathForUrl(key)}`;
}
function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".gif": "image/gif",
      ".html": "text/html; charset=utf-8",
      ".json": "application/json",
      ".md": "text/markdown; charset=utf-8",
      ".mp4": "video/mp4",
      ".png": "image/png",
      ".webm": "video/webm",
    }[extension] ?? "application/octet-stream"
  );
}
/** @returns {SignedPutRequest} */
function signedPutRequest({ artifact, body, config, key, now = new Date() }) {
  const url = new URL(`${config.endpoint}${s3Path({ bucket: config.bucket, key })}`);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = digestHex(body);
  const headers = {
    "content-type": contentType(artifact.targetPath),
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const canonicalHeaders = Object.entries(headers)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}\n`)
    .join("");
  const signedHeaders = Object.keys(headers).toSorted().join(";");
  const canonicalRequest = [
    "PUT",
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${date}/${config.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, digestHex(canonicalRequest)].join("\n");
  const signature = hmacHex(
    signingKey({ date, region: config.region, secretAccessKey: config.secretAccessKey }),
    stringToSign,
  );
  return {
    body,
    headers: {
      "content-type": headers["content-type"],
      "x-amz-content-sha256": headers["x-amz-content-sha256"],
      "x-amz-date": headers["x-amz-date"],
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    method: "PUT",
    url,
  };
}
function byLane(artifacts, kind) {
  const lanes = new Map();
  for (const artifact of artifacts) {
    if (artifact.kind !== kind) {
      continue;
    }
    lanes.set(artifact.lane, artifact);
  }
  return lanes;
}
function findPair(artifacts, kind, leftLane, rightLane) {
  const lanes = byLane(artifacts, kind);
  const left = lanes.get(leftLane);
  const right = lanes.get(rightLane);
  return left && right ? { left, right } : null;
}
function renderPairTable({ pair, rawBase }) {
  const { left, right } = pair;
  if (!left || !right) {
    return "";
  }
  return [
    '<table width="100%">',
    "  <thead>",
    "    <tr>",
    `      <th width="50%">${left.label}</th>`,
    `      <th width="50%">${right.label}</th>`,
    "    </tr>",
    "  </thead>",
    "  <tbody>",
    "    <tr>",
    `      <td width="50%" align="center"><img src="${artifactUrl(rawBase, left)}" width="100%" alt="${left.alt ?? left.label}"></td>`,
    `      <td width="50%" align="center"><img src="${artifactUrl(rawBase, right)}" width="100%" alt="${right.alt ?? right.label}"></td>`,
    "    </tr>",
    "  </tbody>",
    "</table>",
    "",
  ].join("\n");
}
function renderSingleImageTables({ artifacts, rawBase, pairedKeys }) {
  const renderedPairs = new Set(pairedKeys);
  return artifacts
    .filter(
      (artifact) => artifact.inline && !renderedPairs.has(`${artifact.kind}:${artifact.lane}`),
    )
    .map((artifact) => {
      const width = Math.min(Number(artifact.width ?? 720) || 720, 900);
      return [
        `**${artifact.label}**`,
        "",
        `<img src="${artifactUrl(rawBase, artifact)}" width="${width}" alt="${artifact.alt ?? artifact.label}">`,
        "",
      ].join("\n");
    })
    .join("\n");
}
function renderLinkList({ artifacts, kind, rawBase, title }) {
  const links = artifacts
    .filter((artifact) => artifact.kind === kind)
    .map((artifact) => `- [${artifact.label}](${artifactUrl(rawBase, artifact)})`);
  if (links.length === 0) {
    return "";
  }
  return [`${title}:`, ...links, ""].join("\n");
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
  if (lane.digest) {
    const judgment = lane.detail ?? sanitizeCommentText(lane.expected, 1_000);
    if (judgment) {
      pieces.push(` — ${judgment}`);
    }
    pieces.push(` · facts: ${lane.digest}`);
  } else if (lane.detail) {
    pieces.push(` — ${lane.detail}`);
  } else if (lane.expected) {
    pieces.push(`, expected ${lane.expected}`);
  }
  return pieces.join("");
}
function publicSummary(manifest) {
  return manifest.summary ?? "Mantis captured QA evidence for this scenario.";
}
function overallStatus(manifest) {
  const outcome = manifest.comparison?.outcome;
  if (outcome === "blocked" || outcome === "fail" || outcome === "pass") {
    return outcome;
  }
  const pass = manifest.comparison?.pass;
  return typeof pass === "boolean" ? String(pass) : "";
}
/**
 * @param {EvidenceManifest} manifest
 * @param {{ requestSource?: string }} [options]
 */
export function shouldPublishPrComment() {
  return true;
}
/** @param {RenderEvidenceCommentOptions} options */
export function renderEvidenceComment({
  artifactUrl: actionsArtifactUrl,
  manifest,
  marker,
  rawBase,
  requestSource,
  runUrl,
  treeUrl,
}) {
  const comparison = manifest.comparison ?? {};
  const baseline = comparison.baseline;
  const candidate = comparison.candidate;
  const pairs = [
    findPair(manifest.artifacts, "timeline", "baseline", "candidate"),
    findPair(manifest.artifacts, "desktopScreenshot", "baseline", "candidate"),
    findPair(manifest.artifacts, "motionPreview", "baseline", "candidate"),
  ].filter((pair) => pair !== null);
  const pairedKeys = pairs.flatMap((pair) => [
    `${pair.left.kind}:${pair.left.lane}`,
    `${pair.right.kind}:${pair.right.lane}`,
  ]);
  const lines = [
    marker,
    `## ${manifest.title}`,
    "",
    `Summary: ${publicSummary(manifest)}`,
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
  for (const { lane, laneLabel } of [
    { lane: baseline, laneLabel: "Baseline" },
    { lane: candidate, laneLabel: "Candidate (PR merged onto main)" },
  ]) {
    const laneSummary = laneLine(laneLabel, lane);
    lines.push(...[laneSummary].filter(Boolean));
  }
  if (comparison.differential) {
    lines.push(`- Differential (trusted facts): ${comparison.differential}`);
  }
  if (comparison.verdictNote) {
    lines.push(`- Note: ${comparison.verdictNote}`);
  }
  const overall = overallStatus(manifest);
  if (overall) {
    lines.push(`- Overall: \`${overall}\``);
  }
  lines.push("");
  const pairedSections = pairs.map((pair) => renderPairTable({ pair, rawBase }));
  lines.push(...pairedSections);
  const singleTables = renderSingleImageTables({
    artifacts: manifest.artifacts,
    pairedKeys,
    rawBase,
  });
  if (singleTables) {
    lines.push(singleTables);
  }
  const motionClips = renderLinkList({
    artifacts: manifest.artifacts,
    kind: "motionClip",
    rawBase,
    title: "Motion-trimmed clips",
  });
  if (motionClips) {
    lines.push(motionClips);
  }
  const fullVideos = renderLinkList({
    artifacts: manifest.artifacts,
    kind: "fullVideo",
    rawBase,
    title: "Full videos",
  });
  if (fullVideos) {
    lines.push(fullVideos);
  }
  lines.push(`Raw QA files: ${treeUrl ?? rawBase}`);
  return `${lines.join("\n").replace(/\n{3,}/gu, "\n\n")}\n`;
}
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "inherit"],
  });
}
async function uploadArtifact({ artifact, fetchImpl, request, timeoutMs }) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(request.url, {
      body: request.body,
      headers: request.headers,
      method: request.method,
      signal,
    });
    if (response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    const failurePrefix = `Failed to upload Mantis artifact ${artifact.targetPath}: ${response.status} ${response.statusText}`;
    const responseText = await readBoundedResponseText(
      response,
      "Mantis upload error",
      MANTIS_UPLOAD_ERROR_BODY_MAX_BYTES,
      {
        signal,
        formatTooLargeMessage: (_label, maxBytes) =>
          `${failurePrefix}\nMantis upload error response body exceeded ${maxBytes} bytes`,
      },
    );
    throw new Error(`${failurePrefix}\n${responseText}`);
  } catch (error) {
    if (signal.aborted) {
      throw new Error(
        `Timed out uploading Mantis artifact ${artifact.targetPath} after ${timeoutMs}ms.`,
        { cause: error },
      );
    }
    throw error;
  }
}
/** @type {ArtifactFetch} */
const defaultArtifactFetch = (url, init) => {
  const body =
    init.body.buffer instanceof ArrayBuffer
      ? new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength)
      : Uint8Array.from(init.body);
  return fetch(url, { ...init, body });
};
/**
 * @param {{ artifactRoot: string, fetchImpl?: ArtifactFetch, manifest: EvidenceManifest, storageConfig?: ObjectStorageConfig, timeoutMs?: number }} options
 * @returns {Promise<{ artifactRoot: string, rawBase: string, treeUrl: string }>}
 */
export async function publishArtifactFiles({
  artifactRoot,
  fetchImpl = defaultArtifactFetch,
  manifest,
  storageConfig = objectStorageConfig(),
  timeoutMs = MANTIS_ARTIFACT_UPLOAD_TIMEOUT_MS,
}) {
  const safeArtifactRoot = normalizeTargetPath(artifactRoot);
  const publicRoot = `${storageConfig.publicBaseUrl}/${encodePathForUrl(safeArtifactRoot)}`;
  for (const artifact of manifest.artifacts) {
    const key = normalizeTargetPath(`${safeArtifactRoot}/${artifact.targetPath}`);
    const request = signedPutRequest({
      artifact,
      body: readFileSync(artifact.source),
      config: storageConfig,
      key,
    });
    await uploadArtifact({ artifact, fetchImpl, request, timeoutMs });
  }
  const indexArtifact = {
    targetPath: "index.json",
  };
  const indexRequest = signedPutRequest({
    artifact: indexArtifact,
    body: Buffer.from(
      `${JSON.stringify(
        {
          artifacts: manifest.artifacts.map((artifact) => ({
            kind: artifact.kind,
            label: artifact.label,
            lane: artifact.lane,
            targetPath: artifact.targetPath,
            url: artifactUrl(publicRoot, artifact),
          })),
          comparison: manifest.comparison,
          id: manifest.id,
          rawBase: publicRoot,
          scenario: manifest.scenario,
          summary: manifest.summary,
          title: manifest.title,
        },
        null,
        2,
      )}\n`,
    ),
    config: storageConfig,
    key: normalizeTargetPath(`${safeArtifactRoot}/${indexArtifact.targetPath}`),
  });
  await uploadArtifact({ artifact: indexArtifact, fetchImpl, request: indexRequest, timeoutMs });
  return {
    artifactRoot: safeArtifactRoot,
    rawBase: publicRoot,
    treeUrl: artifactUrl(publicRoot, indexArtifact),
  };
}
function upsertPrComment({ body, createMissing, marker, prNumber, repo }) {
  run("gh", ["api", `repos/${repo}/pulls/${prNumber}`, "--jq", ".number"]);
  const commentId = run("gh", [
    "api",
    "--paginate",
    `repos/${repo}/issues/${prNumber}/comments`,
    "--jq",
    `.[] | select(.user.login == "openclaw-mantis[bot]" and (.body | contains("${marker}"))) | .id`,
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
        if (!createMissing) {
          console.log(
            `Could not update existing Mantis QA evidence comment ${commentId}; create-missing is false.`,
          );
          return;
        }
        console.warn(
          `Could not update existing Mantis QA evidence comment ${commentId}; creating a new one.`,
        );
      }
    }
    if (!createMissing) {
      console.log("No existing Mantis QA evidence comment found and create-missing is false.");
      return;
    }
    run("gh", ["pr", "comment", prNumber, "--body-file", bodyFile], { stdio: "inherit" });
    console.log(`Created Mantis QA evidence comment on PR #${prNumber}.`);
  } finally {
    rmSync(path.dirname(bodyFile), { force: true, recursive: true });
  }
}
/** @param {string[]} [rawArgs] */
export async function publishEvidence(rawArgs = process.argv.slice(2)) {
  const args = parseArgs(rawArgs);
  const manifestPath = requireArg(args, "manifest");
  if (args.validate_only === "true") {
    validateEvidenceManifestFile(manifestPath);
    console.log(`Validated Mantis evidence manifest: ${manifestPath}`);
    return;
  }
  const targetPr = requireArg(args, "target_pr");
  const artifactRoot = requireArg(args, "artifact_root");
  const marker = requireArg(args, "marker");
  if (!/^[0-9]+$/u.test(targetPr)) {
    throw new Error(`--target-pr must be numeric, got ${targetPr}.`);
  }
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY;
  const ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!repo) {
    throw new Error("Missing --repo or GITHUB_REPOSITORY.");
  }
  if (!ghToken) {
    throw new Error("Missing GH_TOKEN or GITHUB_TOKEN.");
  }
  const manifest = loadEvidenceManifest(manifestPath);
  const published = await publishArtifactFiles({
    artifactRoot,
    manifest,
  });
  const body = renderEvidenceComment({
    artifactUrl: args.artifact_url,
    manifest,
    marker,
    rawBase: published.rawBase,
    requestSource: args.request_source,
    runUrl: args.run_url,
    treeUrl: published.treeUrl,
  });
  if (!shouldPublishPrComment(manifest, { requestSource: args.request_source })) {
    console.log("Skipped Mantis QA evidence PR comment because the run did not capture proof.");
    return;
  }
  upsertPrComment({
    body,
    createMissing: args.create_missing !== "false",
    marker,
    prNumber: targetPr,
    repo,
  });
}
const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (executedPath === fileURLToPath(import.meta.url)) {
  try {
    await publishEvidence();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
