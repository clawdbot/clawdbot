#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function signingKey({ date, region, secretAccessKey }) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
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
  const signature = hmac(
    signingKey({ date, region: config.region, secretAccessKey: config.secretAccessKey }),
    stringToSign,
    "hex",
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
  if (lane.expected) {
    pieces.push(`, expected ${lane.expected}`);
  }
  return pieces.join("");
}

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
  ].filter(Boolean);
  const pairedKeys = pairs.flatMap((pair) => [
    `${pair.left.kind}:${pair.left.lane}`,
    `${pair.right.kind}:${pair.right.lane}`,
  ]);
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
    ...options,
  });
}

export async function publishArtifactFiles({
  artifactRoot,
  fetchImpl = fetch,
  manifest,
  storageConfig = objectStorageConfig(),
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
    const response = await fetchImpl(request.url, {
      body: request.body,
      headers: request.headers,
      method: request.method,
    });
    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(
        `Failed to upload Mantis artifact ${artifact.targetPath}: ${response.status} ${response.statusText}\n${responseText}`,
      );
    }
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
  const indexResponse = await fetchImpl(indexRequest.url, {
    body: indexRequest.body,
    headers: indexRequest.headers,
    method: indexRequest.method,
  });
  if (!indexResponse.ok) {
    const responseText = await indexResponse.text();
    throw new Error(
      `Failed to upload Mantis artifact ${indexArtifact.targetPath}: ${indexResponse.status} ${indexResponse.statusText}\n${responseText}`,
    );
  }
  return {
    artifactRoot: safeArtifactRoot,
    rawBase: publicRoot,
    treeUrl: artifactUrl(publicRoot, indexArtifact),
  };
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

export async function publishEvidence(rawArgs = process.argv.slice(2)) {
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

  const manifest = loadEvidenceManifest(args.manifest);
  const published = await publishArtifactFiles({
    artifactRoot: args.artifact_root,
    manifest,
  });
  const body = renderEvidenceComment({
    artifactUrl: args.artifact_url,
    manifest,
    marker: args.marker,
    rawBase: published.rawBase,
    requestSource: args.request_source,
    runUrl: args.run_url,
    treeUrl: published.treeUrl,
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
    await publishEvidence();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
