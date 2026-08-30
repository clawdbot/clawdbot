#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readClawHubBootstrapManifest } from "./lib/clawhub-bootstrap-artifact.mjs";
import { readBoundedRegularFile } from "./plugin-publication-artifact.mjs";

const DEFAULT_ATTEMPTS = 12;
const DEFAULT_DELAY_MS = 5_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 12;
const MAX_DELAY_MS = 60_000;
const MAX_ARTIFACT_BYTES = 130 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const PACKAGE_VERSION_PATTERN =
  /^[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(?:-(?:alpha|beta)\.[1-9][0-9]*|-[1-9][0-9]*)?$/u;
const PUBLISH_TAG_PATTERN = /^(?:alpha|beta|latest)$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const TOOLCHAIN_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

class PermanentReadbackError extends Error {}

class RetryableReadbackError extends Error {
  constructor(message, requestedDelayMs) {
    super(message);
    this.retryAfterMs = requestedDelayMs;
  }
}

function fail(message) {
  throw new Error(message);
}

function positiveInteger(value, fallback, label, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = value === undefined ? fallback : value;
  const text = raw === undefined ? "" : String(raw);
  if (!/^[1-9][0-9]*$/u.test(text)) {
    fail(`${label} must be an integer from 1 through ${maximum}.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    fail(`${label} must be an integer from 1 through ${maximum}.`);
  }
  return parsed;
}

function requiredPattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function retryAfterMs(headers) {
  const retryAfter = headers?.get("retry-after")?.trim();
  if (!retryAfter) {
    return undefined;
  }
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_DELAY_MS, Math.max(1, Math.round(seconds * 1_000)));
  }
  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) {
    return Math.min(MAX_DELAY_MS, Math.max(1, dateMs - Date.now()));
  }
  return undefined;
}

function retryableStatus(status) {
  return status === 404 || status === 408 || status === 425 || status === 429 || status >= 500;
}

async function cancelResponse(response) {
  await response.body?.cancel().catch(() => undefined);
}

async function readBoundedBytes(response, label, maximumBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maximumBytes) {
      await cancelResponse(response);
      throw new PermanentReadbackError(`${label} exceeded ${maximumBytes} bytes.`);
    }
  }
  if (!response.body) {
    throw new RetryableReadbackError(`${label} returned no response body.`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new PermanentReadbackError(`${label} exceeded ${maximumBytes} bytes.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchResponse(url, options, context) {
  let response;
  try {
    response = await context.fetchImpl(url, {
      ...options,
      redirect: "follow",
      signal: context.signal,
    });
  } catch (error) {
    throw new RetryableReadbackError(
      `${url} request failed: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (retryableStatus(response.status)) {
    const delay = retryAfterMs(response.headers);
    await cancelResponse(response);
    throw new RetryableReadbackError(`${url} returned HTTP ${response.status}.`, delay);
  }
  if (!response.ok) {
    await cancelResponse(response);
    throw new PermanentReadbackError(`${url} returned HTTP ${response.status}.`);
  }
  return response;
}

async function fetchJson(url, context) {
  const response = await fetchResponse(url, { headers: { accept: "application/json" } }, context);
  let bytes;
  try {
    bytes = await readBoundedBytes(response, url, MAX_JSON_BYTES);
  } catch (error) {
    if (error instanceof PermanentReadbackError) {
      throw error;
    }
    throw new RetryableReadbackError(
      `${url} body read failed: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new RetryableReadbackError(
      `${url} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

async function fetchArtifact(url, context) {
  const response = await fetchResponse(url, {}, context);
  let bytes;
  try {
    bytes = await readBoundedBytes(response, url, MAX_ARTIFACT_BYTES);
  } catch (error) {
    if (error instanceof PermanentReadbackError) {
      throw error;
    }
    throw new RetryableReadbackError(
      `${url} body read failed: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  return { bytes, headers: response.headers };
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RetryableReadbackError(`${label} is missing or invalid.`);
  }
  return value;
}

function requireExact(value, expected, label) {
  if (value !== expected) {
    throw new RetryableReadbackError(
      `${label} mismatch: expected ${String(expected)}, found ${String(value)}.`,
    );
  }
}

function artifactIdentity(bytes) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    npmIntegrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    npmShasum: createHash("sha1").update(bytes).digest("hex"),
  };
}

function readExpectedPackageArtifact(directory) {
  const artifactDirectory = requiredString(directory, "expectedArtifactDir");
  const entries = readdirSync(artifactDirectory, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isFile() || !entries[0].name.endsWith(".tgz")) {
    fail("Expected artifact directory must contain exactly one root .tgz regular file.");
  }
  const fileName = entries[0].name;
  const bytes = readBoundedRegularFile(join(artifactDirectory, fileName), {
    label: "Expected ClawHub package artifact",
    maxBytes: MAX_ARTIFACT_BYTES,
  });
  return { bytes, fileName };
}

function validateArtifactMetadata(entry, metadata, identity, headers) {
  const packageDetail = requireObject(metadata.package, `${entry.packageName} artifact package`);
  const artifact = requireObject(metadata.artifact, `${entry.packageName} artifact metadata`);
  requireExact(packageDetail.name, entry.packageName, `${entry.packageName} artifact package name`);
  requireExact(metadata.version, entry.version, `${entry.packageName} artifact version`);
  requireExact(artifact.kind, "npm-pack", `${entry.packageName} artifact kind`);
  requireExact(artifact.sha256, identity.sha256, `${entry.packageName} artifact sha256`);
  requireExact(artifact.size, identity.size, `${entry.packageName} artifact size`);
  requireExact(
    artifact.npmIntegrity,
    identity.npmIntegrity,
    `${entry.packageName} artifact npmIntegrity`,
  );
  requireExact(artifact.npmShasum, identity.npmShasum, `${entry.packageName} artifact npmShasum`);

  const headerSha256 = headers.get("x-clawhub-artifact-sha256");
  const headerIntegrity = headers.get("x-clawhub-npm-integrity");
  const headerShasum = headers.get("x-clawhub-npm-shasum");
  requireExact(headerSha256, identity.sha256, `${entry.packageName} download sha256 header`);
  requireExact(
    headerIntegrity,
    identity.npmIntegrity,
    `${entry.packageName} download npm integrity header`,
  );
  requireExact(headerShasum, identity.npmShasum, `${entry.packageName} download shasum header`);
  return {
    kind: artifact.kind,
    sha256: artifact.sha256,
    size: artifact.size,
    npmIntegrity: artifact.npmIntegrity,
    npmShasum: artifact.npmShasum,
    packageName: packageDetail.name,
    version: metadata.version,
  };
}

async function verifyEntryOnce(entry, options, context) {
  const registry = options.registry;
  const encodedName = encodeURIComponent(entry.packageName);
  const encodedVersion = encodeURIComponent(entry.version);
  const detailUrl = `${registry}/api/v1/packages/${encodedName}`;
  const versionUrl = `${detailUrl}/versions/${encodedVersion}`;
  const metadataUrl = `${versionUrl}/artifact`;
  const artifactUrl = `${metadataUrl}/download`;

  const detail = await fetchJson(detailUrl, context);
  requireExact(
    detail?.package?.tags?.[entry.publishTag],
    entry.version,
    `${entry.packageName} ClawHub tag ${entry.publishTag}`,
  );
  if (options.mode === "postpublish") {
    const trustedPublisher = (await fetchJson(`${detailUrl}/trusted-publisher`, context))
      ?.trustedPublisher;
    requireExact(
      trustedPublisher?.provider,
      "github-actions",
      `${entry.packageName} trusted publisher provider`,
    );
    requireExact(
      trustedPublisher?.repository,
      "openclaw/openclaw",
      `${entry.packageName} trusted publisher repository`,
    );
    requireExact(
      trustedPublisher?.workflowFilename,
      "plugin-clawhub-release.yml",
      `${entry.packageName} trusted publisher workflow`,
    );
    requireExact(
      trustedPublisher?.environment ?? null,
      null,
      `${entry.packageName} trusted publisher environment`,
    );
  }

  const metadata = await fetchJson(metadataUrl, context);
  const { bytes, headers } = await fetchArtifact(artifactUrl, context);
  const identity = artifactIdentity(bytes);
  requireExact(identity.sha256, entry.sha256, `${entry.packageName} registry artifact sha256`);
  requireExact(identity.size, entry.size, `${entry.packageName} registry artifact size`);
  const artifactMetadata = validateArtifactMetadata(entry, metadata, identity, headers);

  return {
    packageName: entry.packageName,
    version: entry.version,
    publishTag: entry.publishTag,
    bootstrapMode: entry.bootstrapMode,
    expectedSha256: entry.sha256,
    expectedSize: entry.size,
    registrySha256: identity.sha256,
    registrySize: identity.size,
    npmIntegrity: identity.npmIntegrity,
    npmShasum: identity.npmShasum,
    artifactMetadata,
  };
}

async function runBoundedRetry(label, operation, retryOptions = {}) {
  const attempts = positiveInteger(
    retryOptions.attempts,
    DEFAULT_ATTEMPTS,
    "attempts",
    MAX_ATTEMPTS,
  );
  const delayMs = positiveInteger(retryOptions.delayMs, DEFAULT_DELAY_MS, "delayMs", MAX_DELAY_MS);
  const timeoutMs = positiveInteger(
    retryOptions.timeoutMs,
    DEFAULT_ATTEMPT_TIMEOUT_MS,
    "timeoutMs",
  );
  const sleep =
    retryOptions.sleep ??
    ((milliseconds) =>
      new Promise((resolveDelay) => {
        setTimeout(resolveDelay, milliseconds);
      }));
  const fetchImpl = retryOptions.fetchImpl ?? fetch;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await operation({ fetchImpl, signal });
    } catch (error) {
      if (error instanceof PermanentReadbackError) {
        throw error;
      }
      lastError = error;
      if (attempt < attempts) {
        const requestedDelay =
          error instanceof RetryableReadbackError ? error.retryAfterMs : undefined;
        await sleep(requestedDelay ?? Math.min(MAX_DELAY_MS, delayMs * attempt));
      }
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label} did not stabilize after ${attempts} attempts; last failure ${detail}`);
}

export async function verifyPublishedClawHubArtifacts(options) {
  const registry = String(options.registry ?? "https://clawhub.ai").replace(/\/+$/u, "");
  const manifest = readClawHubBootstrapManifest(options.manifestPath);
  const expectedToolchain = {
    clawhubToolchainIntegrity: requiredPattern(
      options.clawhubToolchainIntegrity,
      SHA512_INTEGRITY_PATTERN,
      "clawhubToolchainIntegrity",
    ),
    clawhubToolchainSha256: requiredPattern(
      options.clawhubToolchainSha256,
      SHA256_PATTERN,
      "clawhubToolchainSha256",
    ),
    clawhubToolchainVersion: requiredPattern(
      options.clawhubToolchainVersion,
      TOOLCHAIN_VERSION_PATTERN,
      "clawhubToolchainVersion",
    ),
  };
  for (const [key, expected] of Object.entries(expectedToolchain)) {
    if (manifest[key] !== expected) {
      fail(`Validated ClawHub bootstrap manifest ${key} mismatch.`);
    }
  }
  const mode = options.mode ?? "postpublish";
  if (mode !== "postpublish" && mode !== "configure-only-preflight") {
    fail(`Unsupported ClawHub artifact verification mode: ${String(mode)}.`);
  }
  const producerRunAttempt = positiveInteger(manifest.runAttempt, undefined, "manifest runAttempt");
  const terminalRunAttempt = positiveInteger(
    options.terminalRunAttempt,
    undefined,
    "terminalRunAttempt",
  );
  if (terminalRunAttempt < producerRunAttempt) {
    fail("terminalRunAttempt must be greater than or equal to the producer run attempt.");
  }
  const artifactId = String(positiveInteger(options.artifactId, undefined, "artifactId"));
  const artifactDigest = requiredPattern(options.artifactDigest, SHA256_PATTERN, "artifactDigest");

  const entries =
    mode === "configure-only-preflight"
      ? manifest.entries.filter((entry) => entry.bootstrapMode === "configure-only")
      : manifest.entries;
  const results = [];
  for (const entry of entries) {
    results.push(
      await runBoundedRetry(
        `${entry.packageName}@${entry.version} ClawHub artifact`,
        (context) => verifyEntryOnce(entry, { registry, mode }, context),
        options.retryOptions,
      ),
    );
  }
  return {
    schemaVersion: 2,
    repository: manifest.repository,
    targetSha: manifest.targetSha,
    workflowSha: manifest.workflowSha,
    runId: manifest.runId,
    producerRunAttempt: String(producerRunAttempt),
    terminalRunAttempt: String(terminalRunAttempt),
    artifactName: manifest.artifactName,
    artifactId,
    artifactDigest,
    clawhubToolchainIntegrity: manifest.clawhubToolchainIntegrity,
    clawhubToolchainSha256: manifest.clawhubToolchainSha256,
    clawhubToolchainVersion: manifest.clawhubToolchainVersion,
    requestedPlugins: manifest.requestedPlugins,
    verificationMode: mode,
    packages: results,
  };
}

export async function verifyPublishedClawHubPackage(options) {
  const registry = String(options.registry ?? "https://clawhub.ai").replace(/\/+$/u, "");
  const packageName = requiredPattern(options.packageName, PACKAGE_NAME_PATTERN, "packageName");
  const version = requiredPattern(
    options.packageVersion,
    PACKAGE_VERSION_PATTERN,
    "packageVersion",
  );
  const publishTag = requiredPattern(options.publishTag, PUBLISH_TAG_PATTERN, "publishTag");
  const { bytes, fileName } = readExpectedPackageArtifact(options.expectedArtifactDir);
  const expected = artifactIdentity(bytes);
  const entry = {
    bootstrapMode: null,
    packageName,
    publishTag,
    sha256: expected.sha256,
    size: expected.size,
    version,
  };
  const result = await runBoundedRetry(
    `${packageName}@${version} ClawHub artifact`,
    (context) => verifyEntryOnce(entry, { registry, mode: "postpublish" }, context),
    options.retryOptions,
  );
  return {
    schemaVersion: 1,
    verificationMode: "oidc-postpublish",
    expectedArtifact: {
      fileName,
      ...expected,
    },
    package: result,
  };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`Invalid argument: ${String(key)}`);
    }
    result[key.slice(2).replaceAll("-", "_")] = value;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const retryOptions = {
    attempts: positiveInteger(
      process.env.OPENCLAW_CLAWHUB_VERIFY_ATTEMPTS,
      DEFAULT_ATTEMPTS,
      "OPENCLAW_CLAWHUB_VERIFY_ATTEMPTS",
      MAX_ATTEMPTS,
    ),
    delayMs: positiveInteger(
      process.env.OPENCLAW_CLAWHUB_VERIFY_DELAY_MS,
      DEFAULT_DELAY_MS,
      "OPENCLAW_CLAWHUB_VERIFY_DELAY_MS",
      MAX_DELAY_MS,
    ),
    timeoutMs: positiveInteger(
      process.env.OPENCLAW_CLAWHUB_VERIFY_ATTEMPT_TIMEOUT_MS,
      DEFAULT_ATTEMPT_TIMEOUT_MS,
      "OPENCLAW_CLAWHUB_VERIFY_ATTEMPT_TIMEOUT_MS",
    ),
  };
  const directMode = [
    args.expected_artifact_dir,
    args.package_name,
    args.package_version,
    args.publish_tag,
  ].some((value) => value !== undefined);
  if (directMode && args.manifest !== undefined) {
    fail("Direct package verification and bootstrap manifest verification are mutually exclusive.");
  }
  if (!directMode && args.manifest === undefined) {
    fail("Expected --manifest or --expected-artifact-dir.");
  }
  const evidence = directMode
    ? await verifyPublishedClawHubPackage({
        expectedArtifactDir: args.expected_artifact_dir,
        packageName: args.package_name,
        packageVersion: args.package_version,
        publishTag: args.publish_tag,
        registry: args.registry,
        retryOptions,
      })
    : await verifyPublishedClawHubArtifacts({
        registry: args.registry,
        manifestPath: args.manifest,
        artifactId: args.artifact_id,
        artifactDigest: args.artifact_digest,
        clawhubToolchainIntegrity: args.clawhub_toolchain_integrity,
        clawhubToolchainSha256: args.clawhub_toolchain_sha256,
        clawhubToolchainVersion: args.clawhub_toolchain_version,
        mode: args.mode,
        terminalRunAttempt: args.terminal_run_attempt,
        retryOptions,
      });
  if (args.output) {
    await mkdir(dirname(args.output), { recursive: true });
    await writeFile(args.output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
