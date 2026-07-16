import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { inflateRawSync } from "node:zlib";

const ACTIONS_ARTIFACT_API_VERSION = "2026-03-10";
const DEFAULT_MAX_ACTIONS_ARTIFACT_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ACTIONS_ARTIFACT_EXPANDED_BYTES = 512 * 1024 * 1024;

const DEFAULT_MAX_JSON_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const ARTIFACT_DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/u;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SUPPORTED_ZIP_FLAGS = 0x0808;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_EOCD_BYTES = 22;
const ZIP_DATA_DESCRIPTOR_BYTES = 16;
const ZIP_MAX_COMMENT_BYTES = 65_535;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function assertTrimmedString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty trimmed string.`);
  }
  return value;
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

function boundedLimit(value, fallback, label) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > fallback) {
    throw new Error(`${label} must be a positive safe integer no larger than ${fallback}.`);
  }
  return value;
}

function asBuffer(bytes, label) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(`${label} must be a Uint8Array.`);
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function decodeUtf8Exact(bytes, label) {
  let value;
  try {
    value = UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
  if (!Buffer.from(value, "utf8").equals(bytes)) {
    throw new Error(`${label} is not canonically encoded UTF-8.`);
  }
  return value;
}

function assertSafeArchivePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.normalize("NFC") !== value ||
    hasControlCharacters(value)
  ) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertArtifactName(value) {
  const name = assertTrimmedString(value, "Actions artifact name");
  if (!ARTIFACT_NAME_RE.test(name)) {
    throw new Error(`Invalid Actions artifact name: ${name}`);
  }
  return name;
}

function assertArtifactDigest(value) {
  const digest = assertTrimmedString(value, "Actions artifact digest");
  if (!ARTIFACT_DIGEST_RE.test(digest)) {
    throw new Error("Actions artifact digest must be sha256:<64 lowercase hex>.");
  }
  return digest;
}

function assertCommitSha(value, label) {
  const sha = assertTrimmedString(value, label);
  if (!COMMIT_SHA_RE.test(sha)) {
    throw new Error(`${label} must be a full lowercase commit SHA.`);
  }
  return sha;
}

function assertWorkflowPath(value) {
  const workflowPath = assertTrimmedString(value, "workflow path");
  if (
    !/^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9_.-]*\.ya?ml$/u.test(workflowPath) ||
    hasControlCharacters(workflowPath)
  ) {
    throw new Error(`Invalid workflow path: ${workflowPath}`);
  }
  return workflowPath;
}

function assertRepository(value) {
  const repository = assertTrimmedString(value, "GitHub repository");
  if (!REPOSITORY_RE.test(repository)) {
    throw new Error("GitHub repository must be owner/name.");
  }
  return repository;
}

export function sha256Digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function describeActionsArtifactFiles(files) {
  if (!(files instanceof Map)) {
    throw new Error("Actions artifact files must be a Map.");
  }
  return [...files.entries()]
    .map(([path, bytes]) => {
      const safePath = assertSafeArchivePath(path, "Actions artifact file path");
      const content = asBuffer(bytes, `Actions artifact file ${safePath}`);
      return {
        path: safePath,
        sha256: sha256Digest(content).slice("sha256:".length),
        sizeBytes: content.byteLength,
      };
    })
    .toSorted((left, right) => compareCodeUnits(left.path, right.path));
}

export function readBoundedRegularFile(path, params) {
  if (!Number.isSafeInteger(params.maxBytes) || params.maxBytes <= 0) {
    throw new Error(`${params.label} byte limit must be a positive safe integer.`);
  }
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile()) {
      throw new Error(`${params.label} must be a regular file.`);
    }
    if (before.size === 0 || before.size > params.maxBytes) {
      throw new Error(`${params.label} size is outside the allowed range: ${before.size}.`);
    }

    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) {
        throw new Error(`${params.label} changed while it was being read.`);
      }
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const extraBytes = readSync(descriptor, extra, 0, 1, before.size);
    const after = fstatSync(descriptor);
    if (extraBytes !== 0 || after.size !== before.size) {
      throw new Error(`${params.label} changed while it was being read.`);
    }
    return bytes;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ELOOP") {
      throw new Error(`${params.label} must be a regular file.`, { cause: error });
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function findEndOfCentralDirectory(bytes) {
  const minOffset = Math.max(0, bytes.length - ZIP_EOCD_BYTES - ZIP_MAX_COMMENT_BYTES);
  for (let offset = bytes.length - ZIP_EOCD_BYTES; offset >= minOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) {
      continue;
    }
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + ZIP_EOCD_BYTES + commentLength === bytes.length) {
      if (commentLength !== 0) {
        throw new Error("Actions artifact ZIP comments are not supported.");
      }
      return offset;
    }
  }
  throw new Error(
    "Actions artifact ZIP is missing an exact terminal end-of-central-directory record.",
  );
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function normalizeArchivePolicy(policy) {
  if (!policy || typeof policy !== "object") {
    throw new Error("Actions artifact ZIP policy is required.");
  }
  const maxArchiveBytes = boundedLimit(
    policy.maxArchiveBytes,
    DEFAULT_MAX_ACTIONS_ARTIFACT_BYTES,
    "Actions artifact ZIP byte limit",
  );
  const maxExpandedBytes = boundedLimit(
    policy.maxExpandedBytes,
    DEFAULT_MAX_ACTIONS_ARTIFACT_EXPANDED_BYTES,
    "Actions artifact ZIP expanded-byte limit",
  );
  let expectedEntries;
  if (policy.expectedEntries !== undefined) {
    if (
      !Array.isArray(policy.expectedEntries) ||
      policy.expectedEntries.length === 0 ||
      policy.expectedEntries.length > 1024
    ) {
      throw new Error("Actions artifact ZIP expected inventory is invalid.");
    }
    expectedEntries = policy.expectedEntries.map((name) =>
      assertSafeArchivePath(name, "expected ZIP entry path"),
    );
    if (new Set(expectedEntries).size !== expectedEntries.length) {
      throw new Error("Actions artifact ZIP expected inventory contains duplicates.");
    }
  }
  const minEntries = expectedEntries?.length ?? policy.minEntries;
  const maxEntries = expectedEntries?.length ?? policy.maxEntries;
  if (
    !Number.isSafeInteger(minEntries) ||
    !Number.isSafeInteger(maxEntries) ||
    minEntries <= 0 ||
    maxEntries < minEntries ||
    maxEntries > 1024
  ) {
    throw new Error("Actions artifact ZIP entry-count policy is invalid.");
  }
  if (!expectedEntries && typeof policy.allowPath !== "function") {
    throw new Error("Actions artifact ZIP path policy is required.");
  }
  if (typeof policy.maxEntryBytes !== "function") {
    throw new Error("Actions artifact ZIP per-entry expanded-byte policy is required.");
  }
  if (
    policy.maxCompressedEntryBytes !== undefined &&
    typeof policy.maxCompressedEntryBytes !== "function"
  ) {
    throw new Error("Actions artifact ZIP per-entry compressed-byte policy is invalid.");
  }
  return {
    expectedEntries,
    expectedEntrySet: expectedEntries ? new Set(expectedEntries) : undefined,
    maxArchiveBytes,
    maxEntries,
    maxExpandedBytes,
    minEntries,
    rejectCaseFoldAliases: policy.rejectCaseFoldAliases !== false,
    allowPath: expectedEntries
      ? (name) => new Set(expectedEntries).has(name)
      : (name) => policy.allowPath(name),
    maxCompressedEntryBytes: (name) =>
      boundedLimit(
        policy.maxCompressedEntryBytes?.(name),
        maxArchiveBytes,
        `Actions artifact ZIP compressed entry limit for ${name}`,
      ),
    maxEntryBytes: (name) =>
      boundedLimit(
        policy.maxEntryBytes(name),
        maxExpandedBytes,
        `Actions artifact ZIP expanded entry limit for ${name}`,
      ),
  };
}

function inspectCentralDirectory(bytes, eocd, policy) {
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const totalEntries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error("Multi-disk and ZIP64 Actions artifacts are not supported.");
  }
  if (
    totalEntries < policy.minEntries ||
    totalEntries > policy.maxEntries ||
    centralOffset + centralSize !== eocd
  ) {
    throw new Error(
      `Actions artifact ZIP must contain between ${policy.minEntries} and ${policy.maxEntries} exact files with a contiguous central directory.`,
    );
  }

  const records = [];
  const names = new Set();
  const aliases = new Set();
  let offset = centralOffset;
  let declaredExpandedBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== ZIP_CENTRAL_HEADER_SIGNATURE) {
      throw new Error("Invalid Actions artifact ZIP central-directory entry.");
    }
    const versionNeeded = bytes.readUInt16LE(offset + 6);
    const flags = bytes.readUInt16LE(offset + 8);
    const compression = bytes.readUInt16LE(offset + 10);
    const expectedCrc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const expandedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const startDisk = bytes.readUInt16LE(offset + 34);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const nextOffset = nameEnd + extraLength + commentLength;
    if (nextOffset > eocd) {
      throw new Error("Actions artifact ZIP central directory exceeds its declared boundary.");
    }
    if (
      versionNeeded > 20 ||
      startDisk !== 0 ||
      nameLength === 0 ||
      extraLength !== 0 ||
      commentLength !== 0
    ) {
      throw new Error("Actions artifact ZIP central-directory encoding is not canonical.");
    }
    if ((flags & ~SUPPORTED_ZIP_FLAGS) !== 0 || (flags & 0x0001) !== 0) {
      throw new Error(`Unsupported Actions artifact ZIP flags 0x${flags.toString(16)}.`);
    }
    if (compression !== 0 && compression !== 8) {
      throw new Error(`Unsupported Actions artifact ZIP compression method ${compression}.`);
    }
    if (
      compressedSize === 0xffffffff ||
      expandedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new Error("ZIP64 Actions artifact entries are not supported.");
    }

    const rawName = Buffer.from(bytes.subarray(nameStart, nameEnd));
    if ((flags & ZIP_UTF8_FLAG) === 0 && rawName.some((byte) => byte >= 0x80)) {
      throw new Error(
        "Actions artifact ZIP non-ASCII entry names must set the UTF-8 language flag.",
      );
    }
    const name = assertSafeArchivePath(
      decodeUtf8Exact(rawName, "Actions artifact ZIP entry path"),
      "ZIP entry path",
    );
    const alias = name.toLocaleLowerCase("en-US");
    if (
      names.has(name) ||
      (policy.rejectCaseFoldAliases && aliases.has(alias)) ||
      !policy.allowPath(name)
    ) {
      throw new Error(`Unexpected, duplicate, or aliased Actions artifact ZIP entry: ${name}`);
    }
    names.add(name);
    aliases.add(alias);

    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const unixType = unixMode & 0o170000;
    const dosAttributes = externalAttributes & 0xffff;
    if ((unixType !== 0 && unixType !== 0o100000) || (dosAttributes & 0x10) !== 0) {
      throw new Error(`Actions artifact ZIP entry is not a regular file: ${name}`);
    }
    const maxCompressedBytes = policy.maxCompressedEntryBytes(name);
    const maxEntryBytes = policy.maxEntryBytes(name);
    if (
      compressedSize > maxCompressedBytes ||
      expandedSize > maxEntryBytes ||
      declaredExpandedBytes + expandedSize > policy.maxExpandedBytes
    ) {
      throw new Error(`Actions artifact ZIP entry is too large: ${name}`);
    }
    if (compression === 0 && compressedSize !== expandedSize) {
      throw new Error(`Stored Actions artifact ZIP entry size mismatch for ${name}.`);
    }
    declaredExpandedBytes += expandedSize;
    records.push({
      compressedSize,
      compression,
      expandedSize,
      expectedCrc,
      flags,
      localOffset,
      maxEntryBytes,
      name,
      rawName,
      versionNeeded,
    });
    offset = nextOffset;
  }
  if (offset !== eocd) {
    throw new Error("Actions artifact ZIP central-directory size mismatch.");
  }
  return { centralOffset, records };
}

function expandZipEntry(compressed, record, remainingExpandedBytes) {
  const outputLimit = Math.min(record.maxEntryBytes, remainingExpandedBytes);
  try {
    if (record.compression === 0) {
      return compressed;
    }
    const result = inflateRawSync(compressed, {
      info: true,
      maxOutputLength: Math.max(1, outputLimit),
    });
    if (result.engine.bytesWritten !== compressed.length) {
      throw new Error("deflate stream does not consume its full compressed member");
    }
    return result.buffer;
  } catch (error) {
    throw new Error(
      `Actions artifact ZIP entry expansion exceeds its allowed range: ${record.name}`,
      { cause: error },
    );
  }
}

function inspectLocalRecords(bytes, centralOffset, records, policy) {
  const files = new Map();
  const ordered = records.toSorted((left, right) => left.localOffset - right.localOffset);
  let expectedOffset = 0;
  let totalExpandedBytes = 0;

  for (const [index, record] of ordered.entries()) {
    if (
      record.localOffset !== expectedOffset ||
      record.localOffset + 30 > centralOffset ||
      bytes.readUInt32LE(record.localOffset) !== ZIP_LOCAL_HEADER_SIGNATURE
    ) {
      throw new Error(
        `Non-contiguous or invalid Actions artifact ZIP local record: ${record.name}`,
      );
    }
    const localVersionNeeded = bytes.readUInt16LE(record.localOffset + 4);
    const localFlags = bytes.readUInt16LE(record.localOffset + 6);
    const localCompression = bytes.readUInt16LE(record.localOffset + 8);
    const localCrc = bytes.readUInt32LE(record.localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(record.localOffset + 18);
    const localExpandedSize = bytes.readUInt32LE(record.localOffset + 22);
    const localNameLength = bytes.readUInt16LE(record.localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(record.localOffset + 28);
    const localNameStart = record.localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    if (
      localNameEnd > centralOffset ||
      localVersionNeeded !== record.versionNeeded ||
      localFlags !== record.flags ||
      localCompression !== record.compression ||
      localExtraLength !== 0
    ) {
      throw new Error(`Actions artifact ZIP local header mismatch for ${record.name}.`);
    }
    const rawLocalName = bytes.subarray(localNameStart, localNameEnd);
    if (!record.rawName.equals(rawLocalName)) {
      throw new Error(`Actions artifact ZIP local and central names differ for ${record.name}.`);
    }
    decodeUtf8Exact(rawLocalName, `Actions artifact ZIP local entry path for ${record.name}`);

    const dataStart = localNameEnd;
    const dataEnd = dataStart + record.compressedSize;
    if (dataEnd > centralOffset) {
      throw new Error(`Actions artifact ZIP data exceeds its boundary: ${record.name}`);
    }

    let recordEnd = dataEnd;
    if ((record.flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0) {
      if (localCrc !== 0 || localCompressedSize !== 0 || localExpandedSize !== 0) {
        throw new Error(
          `Actions artifact ZIP descriptor-backed local sizes must be zero: ${record.name}`,
        );
      }
      if (
        dataEnd + ZIP_DATA_DESCRIPTOR_BYTES > centralOffset ||
        bytes.readUInt32LE(dataEnd) !== ZIP_DATA_DESCRIPTOR_SIGNATURE ||
        bytes.readUInt32LE(dataEnd + 4) !== record.expectedCrc ||
        bytes.readUInt32LE(dataEnd + 8) !== record.compressedSize ||
        bytes.readUInt32LE(dataEnd + 12) !== record.expandedSize
      ) {
        throw new Error(`Invalid Actions artifact ZIP data descriptor for ${record.name}.`);
      }
      recordEnd += ZIP_DATA_DESCRIPTOR_BYTES;
    } else if (
      localCrc !== record.expectedCrc ||
      localCompressedSize !== record.compressedSize ||
      localExpandedSize !== record.expandedSize
    ) {
      throw new Error(`Actions artifact ZIP local sizes or CRC differ for ${record.name}.`);
    }

    const nextOffset = ordered[index + 1]?.localOffset ?? centralOffset;
    if (recordEnd !== nextOffset) {
      throw new Error(`Actions artifact ZIP contains a gap or overlap after ${record.name}.`);
    }

    const compressed = bytes.subarray(dataStart, dataEnd);
    const expanded = expandZipEntry(
      compressed,
      record,
      policy.maxExpandedBytes - totalExpandedBytes,
    );
    if (
      expanded.length !== record.expandedSize ||
      totalExpandedBytes + expanded.length > policy.maxExpandedBytes ||
      crc32(expanded) !== record.expectedCrc
    ) {
      throw new Error(`Actions artifact ZIP checksum mismatch for ${record.name}.`);
    }
    totalExpandedBytes += expanded.length;
    files.set(record.name, Buffer.from(expanded));
    expectedOffset = recordEnd;
  }
  if (expectedOffset !== centralOffset) {
    throw new Error("Actions artifact ZIP local records do not end at the central directory.");
  }
  return files;
}

export function inspectActionsArtifactZipWithPolicy(inputBytes, inputPolicy) {
  const bytes = asBuffer(inputBytes, "Actions artifact ZIP");
  const policy = normalizeArchivePolicy(inputPolicy);
  if (bytes.length === 0 || bytes.length > policy.maxArchiveBytes) {
    throw new Error(`Actions artifact ZIP size is outside the allowed range: ${bytes.length}.`);
  }
  const eocd = findEndOfCentralDirectory(bytes);
  const { centralOffset, records } = inspectCentralDirectory(bytes, eocd, policy);
  const files = inspectLocalRecords(bytes, centralOffset, records, policy);
  if (policy.expectedEntries) {
    const actual = [...files.keys()].toSorted(compareCodeUnits);
    const expected = [...policy.expectedEntries].toSorted(compareCodeUnits);
    if (
      actual.length !== expected.length ||
      actual.some((name, index) => name !== expected[index])
    ) {
      throw new Error(
        `Actions artifact ZIP inventory mismatch: expected ${expected.join(", ")}, found ${actual.join(", ")}.`,
      );
    }
  }
  return files;
}

export function inspectActionsArtifactZip(bytes, expectedEntries = 2, limits = {}) {
  let expectedInventory;
  let expectedCount;
  if (Array.isArray(expectedEntries)) {
    expectedInventory = expectedEntries;
    expectedCount = expectedEntries.length;
  } else {
    expectedCount = assertPositiveInteger(expectedEntries, "Expected Actions artifact entry count");
  }
  const maxArchiveBytes = boundedLimit(
    limits.maxArchiveBytes,
    DEFAULT_MAX_ACTIONS_ARTIFACT_BYTES,
    "Actions artifact ZIP byte limit",
  );
  const maxExpandedBytes = boundedLimit(
    limits.maxExpandedBytes,
    DEFAULT_MAX_ACTIONS_ARTIFACT_EXPANDED_BYTES,
    "Actions artifact ZIP expanded-byte limit",
  );
  const maxEntryBytes = boundedLimit(
    limits.maxEntryBytes,
    maxExpandedBytes,
    "Actions artifact ZIP expanded entry limit",
  );
  const maxCompressedEntryBytes = boundedLimit(
    limits.maxCompressedEntryBytes,
    maxArchiveBytes,
    "Actions artifact ZIP compressed entry limit",
  );
  return inspectActionsArtifactZipWithPolicy(bytes, {
    expectedEntries: expectedInventory,
    minEntries: expectedCount,
    maxEntries: expectedCount,
    maxArchiveBytes,
    maxExpandedBytes,
    allowPath: expectedInventory ? undefined : (name) => basename(name) === name,
    maxCompressedEntryBytes: () => maxCompressedEntryBytes,
    maxEntryBytes: () => maxEntryBytes,
  });
}

function requireExpectedBinding(params) {
  const expected = params.expected;
  if (!expected || typeof expected !== "object") {
    throw new Error("Expected Actions artifact binding is required.");
  }
  const repository = assertRepository(expected.repository);
  const artifactId = assertPositiveInteger(expected.artifactId, "Actions artifact ID");
  const artifactName = assertArtifactName(expected.artifactName);
  const artifactDigest = assertArtifactDigest(expected.artifactDigest);
  const artifactSizeBytes = assertPositiveInteger(
    expected.artifactSizeBytes,
    "Actions artifact size",
  );
  const runId = assertPositiveInteger(expected.runId, "workflow run ID");
  const runAttempt = assertPositiveInteger(expected.runAttempt, "workflow run attempt");
  const workflowSha = assertCommitSha(expected.workflowSha, "workflow SHA");
  const workflowPath = assertWorkflowPath(expected.workflowPath);
  const workflowEvent = assertTrimmedString(expected.workflowEvent, "workflow event");
  const workflowHeadBranch = assertTrimmedString(
    expected.workflowHeadBranch,
    "workflow head branch",
  );
  const runStatePolicy = assertTrimmedString(expected.runStatePolicy, "workflow run-state policy");
  if (runStatePolicy !== "completed-success" && runStatePolicy !== "same-run-producer-success") {
    throw new Error(`Unsupported workflow run-state policy: ${runStatePolicy}`);
  }
  const consumerRunAttempt =
    runStatePolicy === "same-run-producer-success"
      ? assertPositiveInteger(expected.consumerRunAttempt, "consumer workflow run attempt")
      : undefined;
  const producerJobName =
    runStatePolicy === "same-run-producer-success"
      ? assertTrimmedString(expected.producerJobName, "producer job name")
      : undefined;
  if (consumerRunAttempt !== undefined && runAttempt > consumerRunAttempt) {
    throw new Error("Producer workflow run attempt must not be newer than the consumer attempt.");
  }
  return {
    artifactDigest,
    artifactId,
    artifactName,
    artifactSizeBytes,
    consumerRunAttempt,
    producerJobName,
    repository,
    runStatePolicy,
    runAttempt,
    runId,
    workflowEvent,
    workflowHeadBranch,
    workflowPath,
    workflowSha,
  };
}

export function validateActionsArtifactBinding(params) {
  const expected = requireExpectedBinding(params);
  const artifact = params.artifactMetadata;
  const run = params.workflowRun;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error("Actions artifact metadata must be an object.");
  }
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    throw new Error("Actions workflow run metadata must be an object.");
  }
  if (
    artifact.id !== expected.artifactId ||
    artifact.name !== expected.artifactName ||
    artifact.size_in_bytes !== expected.artifactSizeBytes ||
    artifact.expired !== false ||
    artifact.digest !== expected.artifactDigest ||
    artifact.workflow_run?.id !== expected.runId ||
    artifact.workflow_run?.head_sha !== expected.workflowSha
  ) {
    throw new Error("Actions artifact metadata does not match the immutable publication tuple.");
  }
  if (
    run.id !== expected.runId ||
    run.run_attempt !== expected.runAttempt ||
    run.head_sha !== expected.workflowSha ||
    run.head_branch !== expected.workflowHeadBranch ||
    run.event !== expected.workflowEvent ||
    run.path !== expected.workflowPath ||
    run.repository?.full_name !== expected.repository ||
    run.head_repository?.full_name !== expected.repository
  ) {
    throw new Error("Actions workflow run does not match the immutable publication tuple.");
  }
  if (expected.runStatePolicy === "completed-success") {
    if (run.status !== "completed" || run.conclusion !== "success") {
      throw new Error("Actions workflow run does not match the immutable publication tuple.");
    }
  } else if (expected.runAttempt === expected.consumerRunAttempt) {
    if (run.status !== "in_progress" || run.conclusion !== null) {
      throw new Error("Current producer workflow attempt must still be in progress.");
    }
  } else if (
    run.status !== "completed" ||
    typeof run.conclusion !== "string" ||
    run.conclusion.length === 0
  ) {
    throw new Error("Prior producer workflow attempt must be completed.");
  }
  return expected;
}

export function validateActionsArtifactProducerJob(params) {
  const expected = requireExpectedBinding(params);
  if (expected.runStatePolicy !== "same-run-producer-success") {
    return expected;
  }
  const response = params.workflowJobs;
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Actions workflow jobs response must be an object.");
  }
  if (
    !Number.isSafeInteger(response.total_count) ||
    response.total_count < 0 ||
    !Array.isArray(response.jobs) ||
    response.total_count !== response.jobs.length
  ) {
    throw new Error("Actions workflow jobs inventory is incomplete.");
  }
  const matches = response.jobs.filter((job) => job?.name === expected.producerJobName);
  if (matches.length !== 1) {
    throw new Error("Actions artifact producer job must be unique.");
  }
  const [producerJob] = matches;
  if (
    producerJob.run_id !== expected.runId ||
    producerJob.run_attempt !== expected.runAttempt ||
    producerJob.head_sha !== expected.workflowSha ||
    producerJob.status !== "completed" ||
    producerJob.conclusion !== "success"
  ) {
    throw new Error("Actions artifact producer job did not complete successfully.");
  }
  return expected;
}

async function readBoundedResponseBody(response, params) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`${params.label} returned HTTP ${response.status}.`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
      await response.body?.cancel();
      throw new Error(`${params.label} returned an invalid Content-Length.`);
    }
    const declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes > params.maxBytes ||
      (params.expectedBytes !== undefined && declaredBytes !== params.expectedBytes)
    ) {
      await response.body?.cancel();
      throw new Error(`${params.label} Content-Length is outside the approved range.`);
    }
  }

  const chunks = [];
  let totalBytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (
        totalBytes > params.maxBytes ||
        (params.expectedBytes !== undefined && totalBytes > params.expectedBytes)
      ) {
        await reader.cancel();
        throw new Error(`${params.label} exceeded its approved byte count.`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) {
    throw new Error(`${params.label} returned an empty body.`);
  }
  if (params.expectedBytes !== undefined && totalBytes !== params.expectedBytes) {
    throw new Error(`${params.label} size does not match metadata.`);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function runBoundedRetry(label, operation, params) {
  let lastError;
  for (let attempt = 1; attempt <= params.attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === params.attempts) {
        break;
      }
      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, params.delayMs);
      });
    }
  }
  throw new Error(
    `${label} failed after ${params.attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    { cause: lastError },
  );
}

async function fetchBoundedJson(url, request, params) {
  const response = await request.fetchImpl(url, {
    headers: request.headers,
    redirect: "follow",
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  const bytes = await readBoundedResponseBody(response, {
    label: params.label,
    maxBytes: params.maxBytes,
  });
  let value;
  try {
    value = JSON.parse(decodeUtf8Exact(bytes, `${params.label} body`));
  } catch (error) {
    throw new Error(
      `${params.label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${params.label} JSON must be an object.`);
  }
  return value;
}

export async function downloadActionsArtifactArchive(params) {
  const expected = requireExpectedBinding(params);
  const token = assertTrimmedString(params.token, "GitHub token");
  const timeoutMs = boundedLimit(params.timeoutMs, DEFAULT_TIMEOUT_MS, "GitHub request timeout");
  const retryAttempts =
    params.retryAttempts === undefined
      ? 3
      : boundedLimit(params.retryAttempts, 5, "GitHub request retry count");
  const retryDelayMs =
    params.retryDelayMs === undefined
      ? 250
      : boundedLimit(params.retryDelayMs, 5_000, "GitHub retry delay");
  const maxArchiveBytes = boundedLimit(
    params.maxArchiveBytes,
    DEFAULT_MAX_ACTIONS_ARTIFACT_BYTES,
    "Actions artifact ZIP byte limit",
  );
  if (expected.artifactSizeBytes > maxArchiveBytes) {
    throw new Error("Actions artifact size exceeds the configured archive limit.");
  }
  const fetchImpl = params.fetchImpl ?? fetch;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "openclaw-publication-artifact",
    "x-github-api-version": ACTIONS_ARTIFACT_API_VERSION,
  };
  const apiRoot = `https://api.github.com/repos/${expected.repository}`;
  const request = { fetchImpl, headers, timeoutMs };
  const retry = {
    attempts: retryAttempts,
    delayMs: retryDelayMs,
  };
  const artifactMetadata = await runBoundedRetry(
    "GitHub Actions artifact metadata",
    () =>
      fetchBoundedJson(`${apiRoot}/actions/artifacts/${expected.artifactId}`, request, {
        label: "GitHub Actions artifact metadata",
        maxBytes: DEFAULT_MAX_JSON_BYTES,
      }),
    retry,
  );
  const workflowRun = await runBoundedRetry(
    "GitHub Actions workflow attempt",
    () =>
      fetchBoundedJson(
        `${apiRoot}/actions/runs/${expected.runId}/attempts/${expected.runAttempt}`,
        request,
        {
          label: "GitHub Actions workflow attempt",
          maxBytes: DEFAULT_MAX_JSON_BYTES,
        },
      ),
    retry,
  );
  validateActionsArtifactBinding({ artifactMetadata, expected, workflowRun });
  let workflowJobs;
  if (expected.runStatePolicy === "same-run-producer-success") {
    workflowJobs = await runBoundedRetry(
      "GitHub Actions producer jobs",
      () =>
        fetchBoundedJson(
          `${apiRoot}/actions/runs/${expected.runId}/attempts/${expected.runAttempt}/jobs?per_page=100`,
          request,
          {
            label: "GitHub Actions producer jobs",
            maxBytes: DEFAULT_MAX_JSON_BYTES,
          },
        ),
      retry,
    );
    validateActionsArtifactProducerJob({ expected, workflowJobs });
  }

  const archiveBytes = await runBoundedRetry(
    "GitHub Actions artifact download",
    async () => {
      const response = await fetchImpl(`${apiRoot}/actions/artifacts/${expected.artifactId}/zip`, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const bytes = await readBoundedResponseBody(response, {
        expectedBytes: expected.artifactSizeBytes,
        label: "GitHub Actions artifact download",
        maxBytes: maxArchiveBytes,
      });
      const actualDigest = sha256Digest(bytes);
      if (actualDigest !== expected.artifactDigest) {
        throw new Error(
          `GitHub Actions artifact digest ${actualDigest} does not match ${expected.artifactDigest}.`,
        );
      }
      return bytes;
    },
    retry,
  );
  return { archiveBytes, artifactMetadata, binding: expected, workflowJobs, workflowRun };
}

export async function readPublicationArtifactArchive(params) {
  const downloaded = await downloadActionsArtifactArchive(params);
  const files = inspectActionsArtifactZipWithPolicy(downloaded.archiveBytes, params.archivePolicy);
  return { ...downloaded, files };
}
