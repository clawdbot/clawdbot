#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";
import {
  downloadActionsArtifactArchive,
  describeActionsArtifactFiles,
  inspectActionsArtifactZip,
  inspectActionsArtifactZipWithPolicy,
  readBoundedRegularFile,
  readPublicationArtifactArchive,
  sha256Digest,
  validateActionsArtifactBinding,
  validateActionsArtifactProducerJob,
} from "./lib/actions-artifact-archive.mjs";
import { resolveNpmPublishPlan } from "./lib/npm-publish-plan.mjs";

export {
  downloadActionsArtifactArchive,
  describeActionsArtifactFiles,
  inspectActionsArtifactZip,
  inspectActionsArtifactZipWithPolicy,
  readBoundedRegularFile,
  readPublicationArtifactArchive,
  validateActionsArtifactBinding,
  validateActionsArtifactProducerJob,
};

const MANIFEST_FILENAME = "plugin-publication-manifest.json";
const MANIFEST_SCHEMA = "openclaw.plugin-publication-artifact/v1";
const TAR_BLOCK_BYTES = 512;
const TAR_END_MARKER_BYTES = TAR_BLOCK_BYTES * 2;
const TAR_USTAR_MAGIC = Buffer.from("ustar\0", "ascii");
const TAR_USTAR_VERSION = Buffer.from("00", "ascii");
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_PLUGIN_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_TAR_ENTRIES = 10_000;
const MAX_TAR_PATH_BYTES = 4 * 1024 * 1024;
const MAX_TAR_TOTAL_FILE_BYTES = 512 * 1024 * 1024;
export const CLAWHUB_PUBLICATION_TAR_LIMITS = Object.freeze({
  maxArchiveBytes: 120 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryBytes: 50 * 1024 * 1024,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxPathBytes: 4 * 1024 * 1024,
  maxTotalFileBytes: 50 * 1024 * 1024,
});
const SHA_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const ARTIFACT_DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const VERSION_RE =
  /^[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(?:-(?:alpha|beta)\.[1-9][0-9]*|-[1-9][0-9]*)?$/u;
const NPM_ROUTE_POLICIES = new Map([
  ["npm-oidc", { authMode: "trusted-publisher", capability: "trusted-publisher" }],
  ["npm-token-bootstrap", { authMode: "token-bootstrap", capability: "first-publication" }],
  [
    "npm-token-placeholder-recovery",
    { authMode: "token-bootstrap", capability: "placeholder-recovery" },
  ],
  ["npm-mirror", { authMode: "release-token", capability: "dist-tag-mirror" }],
  ["npm-tag-repair", { authMode: "release-token", capability: "dist-tag-repair" }],
  ["npm-readback", { authMode: "none", capability: "registry-readback" }],
]);
const ROUTES = new Set([
  ...NPM_ROUTE_POLICIES.keys(),
  "clawhub-token-release",
  "clawhub-token-bootstrap",
  "clawhub-readback",
]);
const NPM_TAGS = new Set(["latest", "alpha", "beta", "extended-stable"]);
const CLAWHUB_TAGS = new Set(["latest", "alpha", "beta"]);
const META_PACKAGE = "@openclaw/meta-provider";
const META_PACKAGE_DIR = "extensions/meta";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function npmIntegrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function npmShasum(bytes) {
  return createHash("sha1").update(bytes).digest("hex");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a safe positive integer.`);
  }
  return value;
}

function assertBooleanString(value, label) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${label} must be true or false.`);
}

function hasControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function normalizeManualOverrideReason(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const reason = assertString(value, "manual override reason");
  if (reason.length > 500 || hasControlCharacters(reason)) {
    throw new Error(
      "Manual override reason must be at most 500 characters and contain no control characters.",
    );
  }
  return reason;
}

function assertSafePackageDir(value) {
  const packageDir = assertString(value, "package dir");
  if (!/^extensions\/[a-z0-9][a-z0-9._-]*$/u.test(packageDir) || packageDir.includes("\\")) {
    throw new Error(`Unsafe plugin package dir: ${packageDir}`);
  }
  return packageDir;
}

function assertSafeArtifactName(value) {
  const artifactName = assertString(value, "artifact name");
  if (!ARTIFACT_NAME_RE.test(artifactName)) {
    throw new Error(`Unsafe plugin publication artifact name: ${artifactName}`);
  }
  return artifactName;
}

function assertSafeArchivePath(value, label) {
  const raw = assertString(value, label);
  if (
    raw.startsWith("/") ||
    raw.includes("\\") ||
    raw.includes("\0") ||
    raw.normalize("NFC") !== raw ||
    hasControlCharacters(raw)
  ) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(raw)}`);
  }
  const withoutTrailingSlash = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const parts = withoutTrailingSlash.split("/");
  if (
    withoutTrailingSlash.length === 0 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(raw)}`);
  }
  return withoutTrailingSlash;
}

function normalizePublicationReason(value) {
  const reason = assertString(value, "publication reason");
  if (reason.length > 500 || hasControlCharacters(reason)) {
    throw new Error(
      "Publication reason must be at most 500 characters and contain no control characters.",
    );
  }
  return reason;
}

function normalizePublisherPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Publisher policy must be an object.");
  }
  const keys = Object.keys(value).toSorted();
  if (JSON.stringify(keys) !== JSON.stringify(["policyId", "schema", "sha256"])) {
    throw new Error("Publisher policy must contain exactly schema, policyId, and sha256.");
  }
  const schema = assertString(value.schema, "publisher policy schema");
  const policyId = assertString(value.policyId, "publisher policy id");
  const policySha256 = assertString(value.sha256, "publisher policy SHA-256");
  if (
    schema.length > 200 ||
    policyId.length > 200 ||
    hasControlCharacters(schema) ||
    hasControlCharacters(policyId) ||
    !SHA256_RE.test(policySha256)
  ) {
    throw new Error("Publisher policy identity is invalid.");
  }
  return { policyId, schema, sha256: policySha256 };
}

function boundedTarLimit(value, fallback, label) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > fallback) {
    throw new Error(`${label} must be a positive safe integer no larger than ${fallback}.`);
  }
  return value;
}

function normalizeTarInspectionOptions(options = {}) {
  const maxArchiveBytes = boundedTarLimit(
    options.maxArchiveBytes,
    MAX_ARCHIVE_BYTES,
    "Plugin tarball byte limit",
  );
  const maxExpandedBytes = boundedTarLimit(
    options.maxExpandedBytes,
    MAX_EXPANDED_BYTES,
    "Plugin tarball expanded-byte limit",
  );
  const maxEntryBytes = boundedTarLimit(
    options.maxEntryBytes,
    maxExpandedBytes,
    "Plugin tarball per-entry byte limit",
  );
  const maxTotalFileBytes = boundedTarLimit(
    options.maxTotalFileBytes,
    Math.min(MAX_TAR_TOTAL_FILE_BYTES, maxExpandedBytes),
    "Plugin tarball total-file byte limit",
  );
  const maxEntries = boundedTarLimit(
    options.maxEntries,
    MAX_TAR_ENTRIES,
    "Plugin tarball entry-count limit",
  );
  const maxPathBytes = boundedTarLimit(
    options.maxPathBytes,
    MAX_TAR_PATH_BYTES,
    "Plugin tarball path-byte limit",
  );
  return {
    maxArchiveBytes,
    maxEntries,
    maxEntryBytes,
    maxExpandedBytes,
    maxPathBytes,
    maxTotalFileBytes,
  };
}

function decodeTarString(bytes, label = "tar string field") {
  const nul = bytes.indexOf(0);
  if (nul !== -1 && bytes.subarray(nul + 1).some((byte) => byte !== 0)) {
    throw new Error(`${label} has non-zero bytes after its NUL terminator.`);
  }
  const value = bytes.subarray(0, nul === -1 ? bytes.length : nul);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}

function decodeConsumerTarPathField(bytes, label) {
  const raw = decodeTarString(bytes, label);
  const consumerValue = raw.trim();
  if (raw !== consumerValue) {
    throw new Error(`${label} changes under the pinned ClawHub path normalization.`);
  }
  return consumerValue;
}

function normalizeConsumerTarPath(value, options = {}) {
  const rawPath = options.directory === true && value.endsWith("/") ? value.slice(0, -1) : value;
  const normalized = rawPath.replaceAll("\\", "/").replace(/^\.\/+/u, "");
  const segments = normalized.split("/").filter(Boolean);
  const consumerPath = segments.join("/");
  if (
    consumerPath !== rawPath ||
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(
      `Tar entry path changes under the pinned ClawHub normalization: ${JSON.stringify(value)}.`,
    );
  }
  return assertSafeArchivePath(consumerPath, "tar entry path");
}

function parseCanonicalTarNumber(bytes, label, options = {}) {
  const { allowEmpty = false } = options;
  if ((bytes[0] & 0x80) !== 0) {
    throw new Error(`${label} must not use base-256 encoding.`);
  }
  if (bytes.every((byte) => byte === 0)) {
    if (allowEmpty) {
      return 0;
    }
    throw new Error(`${label} must not be empty.`);
  }
  const raw = bytes.toString("ascii");
  const canonicalDigits = new RegExp(`^[0-7]{${bytes.length - 2}}$`, "u");
  const canonical = canonicalDigits.test(raw.slice(0, -2)) && raw.endsWith(" \0");
  if (!canonical) {
    throw new Error(`${label} is not canonically encoded.`);
  }
  const octal = raw.slice(0, -2);
  const value = Number.parseInt(octal, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(octal)}`);
  }
  return value;
}

function verifyTarChecksum(header) {
  const expected = parseCanonicalTarNumber(header.subarray(148, 156), "tar checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) {
    throw new Error(`Tar header checksum mismatch: expected ${expected}, got ${actual}.`);
  }
}

function verifyCanonicalTarHeader(header) {
  if (
    !header.subarray(257, 263).equals(TAR_USTAR_MAGIC) ||
    !header.subarray(263, 265).equals(TAR_USTAR_VERSION)
  ) {
    throw new Error("Plugin tarball entries must use canonical POSIX USTAR headers.");
  }
  decodeTarString(header.subarray(0, 100), "tar entry name");
  parseCanonicalTarNumber(header.subarray(100, 108), "tar entry mode");
  parseCanonicalTarNumber(header.subarray(108, 116), "tar entry uid", { allowEmpty: true });
  parseCanonicalTarNumber(header.subarray(116, 124), "tar entry gid", { allowEmpty: true });
  parseCanonicalTarNumber(header.subarray(124, 136), "tar entry size");
  parseCanonicalTarNumber(header.subarray(136, 148), "tar entry mtime");
  decodeTarString(header.subarray(157, 257), "tar entry link path");
  decodeTarString(header.subarray(265, 297), "tar entry user name");
  decodeTarString(header.subarray(297, 329), "tar entry group name");
  parseCanonicalTarNumber(header.subarray(329, 337), "tar entry device major");
  parseCanonicalTarNumber(header.subarray(337, 345), "tar entry device minor");
  if (header[475] === 0) {
    decodeTarString(header.subarray(345, 475), "tar entry prefix");
    parseCanonicalTarNumber(header.subarray(476, 488), "tar entry access time", {
      allowEmpty: true,
    });
    parseCanonicalTarNumber(header.subarray(488, 500), "tar entry change time", {
      allowEmpty: true,
    });
  } else {
    decodeTarString(header.subarray(345, 500), "tar entry prefix");
  }
}

function isZeroTarBlock(bytes) {
  return bytes.length === TAR_BLOCK_BYTES && bytes.every((byte) => byte === 0);
}

function parsePackedJson(bytes, label) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(
      `${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function firstGzipMemberEnd(bytes, maxOutputLength) {
  if (
    bytes.length < 18 ||
    bytes[0] !== 0x1f ||
    bytes[1] !== 0x8b ||
    bytes[2] !== 0x08 ||
    (bytes[3] & 0xe0) !== 0
  ) {
    throw new Error("Invalid gzip header.");
  }

  const flags = bytes[3];
  let offset = 10;
  if ((flags & 0x04) !== 0) {
    if (offset + 2 > bytes.length) {
      throw new Error("Truncated gzip extra-field length.");
    }
    const extraLength = bytes.readUInt16LE(offset);
    offset += 2 + extraLength;
    if (offset > bytes.length) {
      throw new Error("Truncated gzip extra field.");
    }
  }
  for (const flag of [0x08, 0x10]) {
    if ((flags & flag) === 0) {
      continue;
    }
    const terminator = bytes.indexOf(0, offset);
    if (terminator === -1) {
      throw new Error("Unterminated gzip header string.");
    }
    offset = terminator + 1;
  }
  if ((flags & 0x02) !== 0) {
    offset += 2;
  }
  if (offset + 8 > bytes.length) {
    throw new Error("Truncated gzip member.");
  }

  const expanded = inflateRawSync(bytes.subarray(offset), {
    info: true,
    maxOutputLength,
  });
  return offset + expanded.engine.bytesWritten + 8;
}

export function inspectPackageTarballBytes(inputBytes, options = {}) {
  if (!(inputBytes instanceof Uint8Array)) {
    throw new Error("Plugin tarball bytes must be a Uint8Array.");
  }
  const tarballBytes = Buffer.from(inputBytes.buffer, inputBytes.byteOffset, inputBytes.byteLength);
  const limits = normalizeTarInspectionOptions(options);
  if (tarballBytes.length === 0 || tarballBytes.length > limits.maxArchiveBytes) {
    throw new Error(`Plugin tarball size is outside the allowed range: ${tarballBytes.length}.`);
  }
  let memberEnd;
  try {
    memberEnd = firstGzipMemberEnd(tarballBytes, limits.maxExpandedBytes);
  } catch (error) {
    throw new Error(
      `Plugin tarball is not canonical gzip or expands beyond ${limits.maxExpandedBytes} bytes.`,
      { cause: error },
    );
  }
  if (memberEnd !== tarballBytes.length) {
    throw new Error("Plugin tarball must contain exactly one gzip member.");
  }
  let tarBytes;
  try {
    const expanded = gunzipSync(tarballBytes, {
      info: true,
      maxOutputLength: limits.maxExpandedBytes,
    });
    if (expanded.engine.bytesWritten !== tarballBytes.length) {
      throw new Error("gzip stream does not consume the full plugin tarball");
    }
    tarBytes = expanded.buffer;
  } catch (error) {
    throw new Error(
      `Plugin tarball is not canonical gzip or expands beyond ${limits.maxExpandedBytes} bytes.`,
      { cause: error },
    );
  }

  const inventory = [];
  const seenPaths = new Set();
  const seenAliases = new Set();
  let packageManifestBytes;
  let pluginManifestBytes;
  let offset = 0;
  let sawEndMarker = false;
  let entryCount = 0;
  let totalFileBytes = 0;
  let totalPathBytes = 0;

  while (offset + TAR_BLOCK_BYTES <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (isZeroTarBlock(header)) {
      const secondEndBlock = tarBytes.subarray(
        offset + TAR_BLOCK_BYTES,
        offset + TAR_END_MARKER_BYTES,
      );
      if (
        !isZeroTarBlock(secondEndBlock) ||
        !tarBytes.subarray(offset + TAR_END_MARKER_BYTES).every((byte) => byte === 0)
      ) {
        throw new Error(
          "Plugin tarball must end with two zero blocks and contain no trailing entries.",
        );
      }
      sawEndMarker = true;
      break;
    }
    entryCount += 1;
    if (entryCount > limits.maxEntries) {
      throw new Error(`Plugin tarball exceeds the ${limits.maxEntries} entry limit.`);
    }
    verifyTarChecksum(header);
    verifyCanonicalTarHeader(header);
    const headerName = decodeConsumerTarPathField(header.subarray(0, 100), "tar entry name");
    const headerPrefix =
      header[475] === 0
        ? decodeConsumerTarPathField(header.subarray(345, 475), "tar entry prefix")
        : decodeConsumerTarPathField(header.subarray(345, 500), "tar entry prefix");
    const headerPath = headerPrefix ? `${headerPrefix}/${headerName}` : headerName;
    const headerSize = parseCanonicalTarNumber(header.subarray(124, 136), "tar entry size");
    const typeFlag = String.fromCharCode(header[156] || 0x30);
    const linkPath = decodeTarString(header.subarray(157, 257), "tar entry link path");
    if (typeFlag === "x" || typeFlag === "g" || typeFlag === "L" || typeFlag === "K") {
      throw new Error("PAX and GNU tar metadata are not supported for plugin artifacts.");
    }
    if (typeFlag !== "0" && typeFlag !== "5") {
      const suffix = linkPath ? ` -> ${linkPath}` : "";
      throw new Error(
        `Unsupported plugin tar entry type ${JSON.stringify(typeFlag)}: ${headerPath}${suffix}`,
      );
    }
    if (typeFlag === "5" && headerSize !== 0) {
      throw new Error(`Directory tar entry ${JSON.stringify(headerPath)} must have size zero.`);
    }
    if (linkPath) {
      throw new Error(
        `Plugin tar entries must not carry link targets: ${headerPath} -> ${linkPath}`,
      );
    }
    if (typeFlag !== "5" && headerPath.endsWith("/")) {
      throw new Error(
        `Non-directory tar entry must not end with a slash: ${JSON.stringify(headerPath)}.`,
      );
    }

    const safePath = normalizeConsumerTarPath(headerPath, { directory: typeFlag === "5" });
    if (safePath !== "package" && !safePath.startsWith("package/")) {
      throw new Error(`Plugin tar entry must stay under package/: ${safePath}`);
    }
    const alias = safePath.toLocaleLowerCase("en-US");
    if (seenPaths.has(safePath) || seenAliases.has(alias)) {
      throw new Error(`Duplicate or aliased plugin tar entry: ${safePath}`);
    }
    seenPaths.add(safePath);
    seenAliases.add(alias);
    totalPathBytes += Buffer.byteLength(safePath, "utf8");
    if (totalPathBytes > limits.maxPathBytes) {
      throw new Error(`Plugin tarball paths exceed the ${limits.maxPathBytes} byte limit.`);
    }

    if (headerSize > limits.maxEntryBytes) {
      throw new Error(`Plugin tar entry ${safePath} exceeds ${limits.maxEntryBytes} bytes.`);
    }
    const dataOffset = offset + TAR_BLOCK_BYTES;
    const dataEnd = dataOffset + headerSize;
    const nextOffset = dataOffset + Math.ceil(headerSize / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (dataEnd > tarBytes.length || nextOffset > tarBytes.length) {
      throw new Error(`Tar entry ${JSON.stringify(safePath)} exceeds the archive boundary.`);
    }
    const content = tarBytes.subarray(dataOffset, dataEnd);
    offset = nextOffset;

    if (typeFlag === "5") {
      inventory.push({ path: safePath, sizeBytes: 0, type: "directory" });
      continue;
    }
    totalFileBytes += content.length;
    if (totalFileBytes > limits.maxTotalFileBytes) {
      throw new Error(`Plugin tarball file payload exceeds ${limits.maxTotalFileBytes} bytes.`);
    }
    const entry = {
      path: safePath,
      sha256: sha256(content),
      sizeBytes: content.length,
      type: "file",
    };
    inventory.push(entry);
    if (safePath === "package/package.json") {
      if (content.length === 0 || content.length > MAX_MANIFEST_BYTES) {
        throw new Error(
          `Packed package.json size is outside the allowed range: ${content.length}.`,
        );
      }
      packageManifestBytes = Buffer.from(content);
    } else if (safePath === "package/openclaw.plugin.json") {
      if (content.length === 0 || content.length > MAX_PLUGIN_MANIFEST_BYTES) {
        throw new Error(
          `Packed openclaw.plugin.json size is outside the allowed range: ${content.length}.`,
        );
      }
      pluginManifestBytes = Buffer.from(content);
    }
  }

  if (!sawEndMarker) {
    throw new Error("Plugin tarball is missing its end marker.");
  }
  if (!packageManifestBytes) {
    throw new Error("Plugin tarball must contain exactly one package/package.json.");
  }
  if (!pluginManifestBytes) {
    throw new Error("Plugin tarball must contain exactly one package/openclaw.plugin.json.");
  }
  inventory.sort((left, right) => compareCodeUnits(left.path, right.path));
  const packageManifest = parsePackedJson(packageManifestBytes, "Packed package.json");
  const pluginManifest = parsePackedJson(pluginManifestBytes, "Packed openclaw.plugin.json");
  return {
    inventory,
    packageManifest,
    packageManifestSha256: sha256(packageManifestBytes),
    pluginManifest,
    pluginManifestSha256: sha256(pluginManifestBytes),
    tarballSizeBytes: tarballBytes.byteLength,
    tarballSha256: sha256(tarballBytes),
    totalFileBytes,
  };
}

export function validatePluginPackageManifest(params, packageManifest) {
  if (packageManifest.name !== params.packageName || packageManifest.version !== params.version) {
    throw new Error(
      `Packed plugin identity ${String(packageManifest.name)}@${String(packageManifest.version)} does not match ${params.packageName}@${params.version}.`,
    );
  }
  if (Object.hasOwn(packageManifest, "tag")) {
    throw new Error(
      `${params.packageName}: packed package.json must not override the approved publication tag.`,
    );
  }
  const release = packageManifest.openclaw?.release;
  const referencesMetaIdentity =
    params.packageName === META_PACKAGE || params.packageDir === META_PACKAGE_DIR;
  if (
    referencesMetaIdentity &&
    (params.packageName !== META_PACKAGE ||
      params.packageDir !== META_PACKAGE_DIR ||
      release?.publishToNpm !== true ||
      release?.publishToClawHub !== true)
  ) {
    throw new Error(
      `${META_PACKAGE}: Meta publication requires ${META_PACKAGE_DIR} with npm and ClawHub enabled.`,
    );
  }
  if (params.route.startsWith("npm-") && release?.publishToNpm !== true) {
    throw new Error(`${params.packageName}: packed plugin is not marked publishToNpm.`);
  }
  if (params.route.startsWith("clawhub-") && release?.publishToClawHub !== true) {
    throw new Error(`${params.packageName}: packed plugin is not marked publishToClawHub.`);
  }
  if (packageManifest.publishConfig !== undefined) {
    throw new Error(
      `${params.packageName}: packed package.json must not override publication through publishConfig.`,
    );
  }
}

function normalizePublicationParams(params) {
  const targetSha = assertString(params.targetSha, "target SHA");
  if (!SHA_RE.test(targetSha)) {
    throw new Error(`Target SHA must be a full lowercase commit SHA: ${targetSha}`);
  }
  const packageDir = assertSafePackageDir(params.packageDir);
  const packageName = assertString(params.packageName, "package name");
  if (!PACKAGE_NAME_RE.test(packageName)) {
    throw new Error(`Invalid plugin package name: ${packageName}`);
  }
  const version = assertString(params.version, "package version");
  if (!VERSION_RE.test(version)) {
    throw new Error(`Invalid plugin package version: ${version}`);
  }
  const route = assertString(params.route, "publication route");
  if (!ROUTES.has(route)) {
    throw new Error(`Unsupported plugin publication route: ${route}`);
  }
  const npmRoutePolicy = NPM_ROUTE_POLICIES.get(route);
  let publicationReason = null;
  let publisherPolicy = null;
  if (npmRoutePolicy) {
    if (params.authMode !== undefined && params.authMode !== npmRoutePolicy.authMode) {
      throw new Error(`${route} auth mode must be ${npmRoutePolicy.authMode}.`);
    }
    if (params.capability !== undefined && params.capability !== npmRoutePolicy.capability) {
      throw new Error(`${route} capability must be ${npmRoutePolicy.capability}.`);
    }
    publicationReason = normalizePublicationReason(params.publicationReason);
    publisherPolicy = normalizePublisherPolicy(params.publisherPolicy);
  } else if (
    params.authMode !== undefined ||
    params.capability !== undefined ||
    params.publicationReason !== undefined ||
    params.publisherPolicy !== undefined
  ) {
    throw new Error(`${route} must not carry npm publisher-policy controls.`);
  }
  const publishTag = assertString(params.publishTag, "publish tag");
  const allowedTags = route.startsWith("npm-") ? NPM_TAGS : CLAWHUB_TAGS;
  if (!allowedTags.has(publishTag)) {
    throw new Error(`Unsupported ${route} publish tag: ${publishTag}`);
  }
  if (route.startsWith("npm-")) {
    const override = publishTag === "extended-stable" ? publishTag : undefined;
    const publishPlan = resolveNpmPublishPlan(version, undefined, override);
    if (publishPlan.publishTag !== publishTag) {
      throw new Error(
        `${packageName}@${version}: npm publish tag ${publishTag} does not match release channel ${publishPlan.channel}.`,
      );
    }
  } else {
    const expectedTag = version.includes("-alpha.")
      ? "alpha"
      : version.includes("-beta.")
        ? "beta"
        : "latest";
    if (publishTag !== expectedTag) {
      throw new Error(
        `${packageName}@${version}: ClawHub publish tag ${publishTag} must be ${expectedTag}.`,
      );
    }
  }
  const artifactName = assertSafeArtifactName(params.artifactName);
  let bootstrapMode = null;
  let requiresManualOverride = false;
  const manualOverrideReason = normalizeManualOverrideReason(params.manualOverrideReason);
  if (route === "clawhub-token-bootstrap") {
    bootstrapMode = assertString(params.bootstrapMode, "bootstrap mode");
    if (bootstrapMode !== "publish" && bootstrapMode !== "configure-only") {
      throw new Error(`Unsupported ClawHub bootstrap mode: ${bootstrapMode}`);
    }
    requiresManualOverride = params.requiresManualOverride === true;
  } else if (route === "clawhub-token-release") {
    requiresManualOverride = params.requiresManualOverride === true;
  } else if (
    params.bootstrapMode !== undefined ||
    params.requiresManualOverride === true ||
    manualOverrideReason !== null
  ) {
    throw new Error(`${route} must not carry ClawHub bootstrap controls.`);
  }
  if (requiresManualOverride !== (manualOverrideReason !== null)) {
    throw new Error(
      `${route} must bind a manual override reason exactly when a manual override is required.`,
    );
  }
  let sourcePackageJsonSha256;
  if (params.sourcePackageJsonSha256 !== undefined) {
    sourcePackageJsonSha256 = assertString(
      params.sourcePackageJsonSha256,
      "source package.json SHA-256",
    );
    if (!SHA256_RE.test(sourcePackageJsonSha256)) {
      throw new Error(
        `Source package.json SHA-256 must be 64 lowercase hex characters: ${sourcePackageJsonSha256}`,
      );
    }
  }
  return {
    artifactName,
    authMode: npmRoutePolicy?.authMode ?? null,
    bootstrapMode,
    capability: npmRoutePolicy?.capability ?? null,
    manualOverrideReason,
    packageDir,
    packageName,
    publicationReason,
    publishTag,
    publisherPolicy,
    requiresManualOverride,
    route,
    sourcePackageJsonSha256,
    targetSha,
    version,
  };
}

function buildManifest(params, tarballName, tarballBytes, inspection) {
  validatePluginPackageManifest(params, inspection.packageManifest);
  const publication = params.authMode
    ? {
        route: params.route,
        authMode: params.authMode,
        capability: params.capability,
        reason: params.publicationReason,
        tag: params.publishTag,
        publisherPolicy: params.publisherPolicy,
      }
    : {
        route: params.route,
        tag: params.publishTag,
        bootstrapMode: params.bootstrapMode,
        manualOverrideReason: params.manualOverrideReason,
        requiresManualOverride: params.requiresManualOverride,
      };
  return {
    schema: MANIFEST_SCHEMA,
    schemaVersion: 1,
    targetSha: params.targetSha,
    package: {
      dir: params.packageDir,
      name: params.packageName,
      version: params.version,
      author: inspection.packageManifest.author ?? null,
      contributors: inspection.packageManifest.contributors ?? null,
      repository: inspection.packageManifest.repository ?? null,
      packageJsonSha256: inspection.packageManifestSha256,
      pluginManifestSha256: inspection.pluginManifestSha256,
      sourcePackageJsonSha256: params.sourcePackageJsonSha256,
    },
    publication,
    artifact: {
      name: params.artifactName,
      tarball: tarballName,
      npmIntegrity: npmIntegrity(tarballBytes),
      npmShasum: npmShasum(tarballBytes),
      sha256: inspection.tarballSha256,
      sizeBytes: tarballBytes.length,
      inventory: inspection.inventory,
    },
  };
}

function tarInspectionOptionsForRoute(route) {
  return route.startsWith("clawhub-") ? CLAWHUB_PUBLICATION_TAR_LIMITS : undefined;
}

function normalizeExpectedInventory(value) {
  if (!Array.isArray(value)) {
    throw new Error("Expected plugin tarball inventory must be an array.");
  }
  const paths = new Set();
  const aliases = new Set();
  const inventory = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Expected plugin tarball inventory entries must be objects.");
    }
    const expectedKeys =
      entry.type === "directory"
        ? ["path", "sizeBytes", "type"]
        : ["path", "sha256", "sizeBytes", "type"];
    if (JSON.stringify(Object.keys(entry).toSorted()) !== JSON.stringify(expectedKeys)) {
      throw new Error("Expected plugin tarball inventory entry shape is invalid.");
    }
    const path = assertSafeArchivePath(entry.path, "expected tar entry path");
    if (path !== entry.path) {
      throw new Error(`Expected plugin tarball path is not canonical: ${entry.path}`);
    }
    const alias = path.toLocaleLowerCase("en-US");
    if (paths.has(path) || aliases.has(alias)) {
      throw new Error(`Expected plugin tarball inventory contains an alias: ${path}`);
    }
    paths.add(path);
    aliases.add(alias);
    if (
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      (entry.type === "directory" && entry.sizeBytes !== 0)
    ) {
      throw new Error(`Expected plugin tarball size is invalid for ${path}.`);
    }
    if (entry.type === "directory") {
      return { path, sizeBytes: 0, type: "directory" };
    }
    if (
      entry.type !== "file" ||
      typeof entry.sha256 !== "string" ||
      !SHA256_RE.test(entry.sha256)
    ) {
      throw new Error(`Expected plugin tarball file identity is invalid for ${path}.`);
    }
    return {
      path,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      type: "file",
    };
  });
  return inventory.toSorted((left, right) => compareCodeUnits(left.path, right.path));
}

function canonicalManifestText(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function createFreshOutputDirectory(path, label) {
  try {
    lstatSync(path);
    throw new Error(`${label} must not already exist.`);
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") {
      throw error;
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const created = lstatSync(path);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    throw new Error(`${label} must be a newly created directory.`);
  }
}

export function createPluginPublicationArtifact(params) {
  const normalized = normalizePublicationParams(params);
  if (!normalized.sourcePackageJsonSha256) {
    throw new Error("Plugin publication creation requires source package.json SHA-256.");
  }
  const artifactDir = resolve(params.artifactDir);
  const entries = readdirSync(artifactDir, { withFileTypes: true });
  const tarballs = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".tgz") && entry.name !== MANIFEST_FILENAME,
  );
  const unexpected = entries.filter((entry) => !(entry.isFile() && entry.name.endsWith(".tgz")));
  if (tarballs.length !== 1 || unexpected.length !== 0) {
    throw new Error(
      `Plugin publication staging dir must contain exactly one .tgz and no other entries; found ${entries.map((entry) => entry.name).join(", ") || "<empty>"}.`,
    );
  }
  const tarballName = assertSafeArchivePath(tarballs[0].name, "tarball filename");
  if (basename(tarballName) !== tarballName) {
    throw new Error(`Plugin tarball must be at the artifact root: ${tarballName}`);
  }
  const tarballPath = join(artifactDir, tarballName);
  const tarballBytes = readBoundedRegularFile(tarballPath, {
    label: "Plugin tarball",
    maxBytes: MAX_ARCHIVE_BYTES,
  });
  const inspection = inspectPackageTarballBytes(
    tarballBytes,
    tarInspectionOptionsForRoute(normalized.route),
  );
  const manifest = buildManifest(normalized, tarballName, tarballBytes, inspection);
  const manifestPath = join(artifactDir, MANIFEST_FILENAME);
  writeFileSync(manifestPath, canonicalManifestText(manifest), { mode: 0o600 });
  return { manifest, manifestPath, tarballPath };
}

function parseBoundedJsonFile(path, label, maxBytes = MAX_MANIFEST_BYTES) {
  let value;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        readBoundedRegularFile(path, {
          label,
          maxBytes,
        }),
      ),
    );
  } catch (error) {
    throw new Error(
      `${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function inspectPluginPublicationArtifactZip(zipBytes) {
  return inspectActionsArtifactZipWithPolicy(zipBytes, {
    minEntries: 2,
    maxEntries: 2,
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
    maxExpandedBytes: MAX_ARCHIVE_BYTES + MAX_MANIFEST_BYTES,
    allowPath: (name) =>
      name === MANIFEST_FILENAME || (basename(name) === name && name.endsWith(".tgz")),
    maxEntryBytes: (name) => (name === MANIFEST_FILENAME ? MAX_MANIFEST_BYTES : MAX_ARCHIVE_BYTES),
  });
}

export function verifyPluginPublicationArtifact(params) {
  const normalized = normalizePublicationParams(params);
  let expectedTarballSha256;
  if (params.expectedTarballSha256 !== undefined) {
    expectedTarballSha256 = assertString(params.expectedTarballSha256, "expected tarball SHA-256");
    if (!SHA256_RE.test(expectedTarballSha256)) {
      throw new Error("Expected tarball SHA-256 must be 64 lowercase hex characters.");
    }
  }
  const expectedTarballSizeBytes =
    params.expectedTarballSizeBytes === undefined
      ? undefined
      : assertPositiveInteger(params.expectedTarballSizeBytes, "expected tarball size");
  const expectedInventory =
    params.expectedInventory === undefined
      ? undefined
      : normalizeExpectedInventory(params.expectedInventory);
  const artifactId = assertPositiveInteger(params.artifactId, "artifact ID");
  const artifactSizeBytes = assertPositiveInteger(params.artifactSizeBytes, "artifact size");
  const runId = assertPositiveInteger(
    params.producerRunId ?? params.runId,
    "producer workflow run ID",
  );
  const runAttempt = assertPositiveInteger(
    params.producerRunAttempt ?? params.runAttempt,
    "producer workflow run attempt",
  );
  const workflowSha = assertString(params.workflowSha, "workflow SHA");
  if (!SHA_RE.test(workflowSha)) {
    throw new Error(`Workflow SHA must be a full lowercase commit SHA: ${workflowSha}`);
  }
  const expectedArtifactDigest = assertString(params.artifactDigest, "artifact digest");
  if (!ARTIFACT_DIGEST_RE.test(expectedArtifactDigest)) {
    throw new Error(`Invalid Actions artifact digest: ${expectedArtifactDigest}`);
  }
  const metadata = parseBoundedJsonFile(params.artifactMetadataPath, "Actions artifact metadata");
  const workflowRun = parseBoundedJsonFile(
    params.workflowRunMetadataPath,
    "Actions workflow run metadata",
  );
  const expectedBinding = {
    artifactDigest: expectedArtifactDigest,
    artifactId,
    artifactName: normalized.artifactName,
    artifactSizeBytes,
    consumerRunAttempt: params.consumerRunAttempt,
    producerJobName: params.producerJobName,
    repository: params.repository,
    runStatePolicy: params.runStatePolicy ?? "completed-success",
    runAttempt,
    runId,
    workflowEvent: params.workflowEvent,
    workflowHeadBranch: params.workflowHeadBranch,
    workflowPath: params.workflowPath,
    workflowSha,
  };
  validateActionsArtifactBinding({
    artifactMetadata: metadata,
    expected: expectedBinding,
    workflowRun,
  });
  if (expectedBinding.runStatePolicy === "same-run-producer-success") {
    const workflowJobs = parseBoundedJsonFile(
      params.workflowJobsMetadataPath,
      "Actions workflow jobs metadata",
    );
    validateActionsArtifactProducerJob({ expected: expectedBinding, workflowJobs });
  }

  const zipBytes = readBoundedRegularFile(params.artifactZipPath, {
    label: "Actions artifact ZIP",
    maxBytes: MAX_ARCHIVE_BYTES,
  });
  if (zipBytes.length !== artifactSizeBytes) {
    throw new Error("Actions artifact ZIP size does not match the immutable publish tuple.");
  }
  const actualArtifactDigest = sha256Digest(zipBytes);
  if (actualArtifactDigest !== expectedArtifactDigest) {
    throw new Error(
      `Actions artifact ZIP digest ${actualArtifactDigest} does not match ${expectedArtifactDigest}.`,
    );
  }
  const files = inspectPluginPublicationArtifactZip(zipBytes);
  const manifestBytes = files.get(MANIFEST_FILENAME);
  const tarballNames = [...files.keys()].filter((name) => name.endsWith(".tgz"));
  if (!manifestBytes || tarballNames.length !== 1) {
    throw new Error(
      `Plugin publication artifact must contain ${MANIFEST_FILENAME} and exactly one .tgz.`,
    );
  }
  if (manifestBytes.length === 0 || manifestBytes.length > MAX_MANIFEST_BYTES) {
    throw new Error(`Plugin publication manifest size is outside the allowed range.`);
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch (error) {
    throw new Error(
      `Plugin publication manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const manifestSourcePackageJsonSha256 = manifest?.package?.sourcePackageJsonSha256;
  if (
    typeof manifestSourcePackageJsonSha256 !== "string" ||
    !SHA256_RE.test(manifestSourcePackageJsonSha256)
  ) {
    throw new Error("Plugin publication manifest source package.json SHA-256 is invalid.");
  }
  if (
    normalized.sourcePackageJsonSha256 !== undefined &&
    normalized.sourcePackageJsonSha256 !== manifestSourcePackageJsonSha256
  ) {
    throw new Error(
      "Plugin publication source package.json SHA-256 does not match the approved target source.",
    );
  }
  const tarballName = tarballNames[0];
  const tarballBytes = files.get(tarballName);
  const inspection = inspectPackageTarballBytes(
    tarballBytes,
    tarInspectionOptionsForRoute(normalized.route),
  );
  if (
    expectedTarballSizeBytes !== undefined &&
    inspection.tarballSizeBytes !== expectedTarballSizeBytes
  ) {
    throw new Error("Plugin tarball size does not match the approved publication tuple.");
  }
  if (expectedTarballSha256 !== undefined && inspection.tarballSha256 !== expectedTarballSha256) {
    throw new Error("Plugin tarball SHA-256 does not match the approved publication tuple.");
  }
  if (
    expectedInventory !== undefined &&
    JSON.stringify(inspection.inventory) !== JSON.stringify(expectedInventory)
  ) {
    throw new Error("Plugin tarball inventory does not match the approved publication tuple.");
  }
  const expectedManifest = buildManifest(
    {
      ...normalized,
      sourcePackageJsonSha256: manifestSourcePackageJsonSha256,
    },
    tarballName,
    tarballBytes,
    inspection,
  );
  const expectedManifestBytes = Buffer.from(canonicalManifestText(expectedManifest), "utf8");
  if (!manifestBytes.equals(expectedManifestBytes)) {
    throw new Error(
      "Plugin publication manifest does not canonically bind the approved package and tarball.",
    );
  }

  const outputDir = resolve(params.outputDir);
  createFreshOutputDirectory(outputDir, "Plugin publication output directory");
  const outputPath = join(outputDir, tarballName);
  writeFileSync(outputPath, tarballBytes, { flag: "wx", mode: 0o600 });
  if (!statSync(outputPath).isFile()) {
    throw new Error(`Verified plugin tarball was not written: ${outputPath}`);
  }
  return {
    artifactDigest: expectedArtifactDigest,
    artifactId,
    artifactName: normalized.artifactName,
    artifactSizeBytes,
    artifactZipSha256: actualArtifactDigest.slice("sha256:".length),
    manifest: expectedManifest,
    npmIntegrity: expectedManifest.artifact.npmIntegrity,
    npmShasum: expectedManifest.artifact.npmShasum,
    packageJsonSha256: expectedManifest.package.packageJsonSha256,
    pluginManifestSha256: expectedManifest.package.pluginManifestSha256,
    producerRunAttempt: runAttempt,
    producerRunId: runId,
    sourcePackageJsonSha256: expectedManifest.package.sourcePackageJsonSha256,
    tarballInventory: inspection.inventory,
    tarballName,
    tarballPath: outputPath,
    tarballSizeBytes: inspection.tarballSizeBytes,
    tarballSha256: inspection.tarballSha256,
  };
}

function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "create" && command !== "verify") {
    throw new Error(
      "Usage: plugin-publication-artifact.mjs <create|verify> --artifact-name <name> ...",
    );
  }
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid ${command} argument near ${key ?? "<missing>"}.`);
    }
    const name = key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (values[name] !== undefined) {
      throw new Error(`Duplicate ${command} option: ${key}`);
    }
    values[name] = value;
  }
  return { command, values };
}

function commonCliParams(values) {
  return {
    artifactName: values.artifactName,
    bootstrapMode: values.bootstrapMode,
    manualOverrideReason: values.manualOverrideReason,
    packageDir: values.packageDir,
    packageName: values.packageName,
    publishTag: values.publishTag,
    requiresManualOverride:
      values.requiresManualOverride === undefined
        ? false
        : assertBooleanString(values.requiresManualOverride, "requires-manual-override"),
    route: values.route,
    publicationReason: values.publicationReason,
    publisherPolicy:
      values.publisherPolicySchema === undefined &&
      values.publisherPolicyId === undefined &&
      values.publisherPolicySha256 === undefined
        ? undefined
        : {
            policyId: values.publisherPolicyId,
            schema: values.publisherPolicySchema,
            sha256: values.publisherPolicySha256,
          },
    sourcePackageJsonSha256: values.sourcePackageJsonSha256,
    targetSha: values.targetSha,
    version: values.packageVersion,
  };
}

function appendGithubOutput(path, values) {
  const lines = Object.entries(values).map(([name, value]) => `${name}=${String(value)}`);
  writeFileSync(path, `${lines.join("\n")}\n`, { flag: "a" });
}

export function main(argv = process.argv.slice(2)) {
  const { command, values } = parseCliArgs(argv);
  const common = commonCliParams(values);
  if (command === "create") {
    const result = createPluginPublicationArtifact({
      ...common,
      artifactDir: values.artifactDir,
    });
    console.log(`Created canonical plugin publication manifest: ${result.manifestPath}`);
    console.log(`Prepared plugin tarball: ${result.tarballPath}`);
    return;
  }
  const result = verifyPluginPublicationArtifact({
    ...common,
    artifactDigest: values.artifactDigest,
    artifactId: Number(values.artifactId),
    artifactMetadataPath: values.artifactMetadata,
    artifactSizeBytes: Number(values.artifactSizeBytes),
    artifactZipPath: values.artifactZip,
    expectedTarballSizeBytes:
      values.expectedTarballSizeBytes === undefined
        ? undefined
        : Number(values.expectedTarballSizeBytes),
    expectedTarballSha256: values.expectedTarballSha256,
    outputDir: values.outputDir,
    consumerRunAttempt:
      values.consumerRunAttempt === undefined ? undefined : Number(values.consumerRunAttempt),
    producerJobName: values.producerJobName,
    producerRunAttempt: Number(values.producerRunAttempt),
    producerRunId: Number(values.producerRunId),
    repository: values.repository,
    workflowEvent: values.workflowEvent,
    workflowHeadBranch: values.workflowHeadBranch,
    workflowPath: values.workflowPath,
    workflowJobsMetadataPath: values.workflowJobsMetadata,
    workflowRunMetadataPath: values.workflowRunMetadata,
    runStatePolicy: values.runStatePolicy,
    workflowSha: values.workflowSha,
  });
  if (values.githubOutput) {
    appendGithubOutput(values.githubOutput, {
      artifact_digest: result.artifactDigest,
      artifact_id: result.artifactId,
      artifact_name: result.artifactName,
      artifact_size_bytes: result.artifactSizeBytes,
      artifact_zip_sha256: result.artifactZipSha256,
      bootstrap_mode: result.manifest.publication.bootstrapMode ?? "",
      manual_override_reason: result.manifest.publication.manualOverrideReason ?? "",
      package_name: result.manifest.package.name,
      package_json_sha256: result.manifest.package.packageJsonSha256,
      package_version: result.manifest.package.version,
      publish_route: result.manifest.publication.route,
      publish_tag: result.manifest.publication.tag,
      producer_run_attempt: result.producerRunAttempt,
      producer_run_id: result.producerRunId,
      requires_manual_override: result.manifest.publication.requiresManualOverride,
      source_package_json_sha256: result.manifest.package.sourcePackageJsonSha256,
      tarball_path: result.tarballPath,
      tarball_sha256: result.tarballSha256,
    });
  }
  console.log(
    `Verified ${result.manifest.package.name}@${result.manifest.package.version} plugin artifact ${result.artifactId} (${result.artifactDigest}).`,
  );
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
