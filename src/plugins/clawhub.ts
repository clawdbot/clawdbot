import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import JSZip from "jszip";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_EXTRACTED_BYTES,
  DEFAULT_MAX_ENTRY_BYTES,
  loadZipArchiveWithPreflight,
} from "../infra/archive.js";
import {
  ClawHubRequestError,
  downloadClawHubPackageArchive,
  fetchClawHubPackageDetail,
  fetchClawHubPackageVersion,
  normalizeClawHubSha256Integrity,
  normalizeClawHubSha256Hex,
  parseClawHubPluginSpec,
  resolveLatestVersionFromPackage,
  satisfiesGatewayMinimum,
  satisfiesPluginApiRange,
  type ClawHubPackageChannel,
  type ClawHubPackageCompatibility,
  type ClawHubPackageDetail,
  type ClawHubPackageFamily,
  type ClawHubPackageVersion,
} from "../infra/clawhub.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
import { installPluginFromArchive, type InstallPluginResult } from "./install.js";

export const CLAWHUB_INSTALL_ERROR_CODE = {
  INVALID_SPEC: "invalid_spec",
  PACKAGE_NOT_FOUND: "package_not_found",
  VERSION_NOT_FOUND: "version_not_found",
  NO_INSTALLABLE_VERSION: "no_installable_version",
  SKILL_PACKAGE: "skill_package",
  UNSUPPORTED_FAMILY: "unsupported_family",
  PRIVATE_PACKAGE: "private_package",
  INCOMPATIBLE_PLUGIN_API: "incompatible_plugin_api",
  INCOMPATIBLE_GATEWAY: "incompatible_gateway",
  MISSING_ARCHIVE_INTEGRITY: "missing_archive_integrity",
  ARCHIVE_INTEGRITY_MISMATCH: "archive_integrity_mismatch",
} as const;

export type ClawHubInstallErrorCode =
  (typeof CLAWHUB_INSTALL_ERROR_CODE)[keyof typeof CLAWHUB_INSTALL_ERROR_CODE];

type PluginInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type ClawHubPluginInstallRecordFields = {
  source: "clawhub";
  clawhubUrl: string;
  clawhubPackage: string;
  clawhubFamily: Exclude<ClawHubPackageFamily, "skill">;
  clawhubChannel?: ClawHubPackageChannel;
  version?: string;
  integrity?: string;
  resolvedAt?: string;
  installedAt?: string;
};

type ClawHubInstallFailure = {
  ok: false;
  error: string;
  code?: ClawHubInstallErrorCode;
};

type ClawHubFileEntryLike = {
  path?: unknown;
  sha256?: unknown;
};

type ClawHubFileVerificationEntry = {
  path: string;
  sha256: string;
};

type ClawHubArchiveVerification =
  | {
      kind: "archive-integrity";
      integrity: string;
    }
  | {
      kind: "file-list";
      files: ClawHubFileVerificationEntry[];
    };

type ClawHubArchiveVerificationResolution =
  | {
      ok: true;
      verification: ClawHubArchiveVerification | null;
    }
  | ClawHubInstallFailure;

type ClawHubArchiveFileVerificationResult =
  | {
      ok: true;
      validatedGeneratedPaths: string[];
    }
  | ClawHubInstallFailure;

type JSZipObjectWithSize = JSZip.JSZipObject & {
  // Internal JSZip field from loadAsync() metadata. Use it only as a best-effort
  // size hint; the streaming byte checks below are the authoritative guard.
  _data?: {
    uncompressedSize?: number;
  };
};

const CLAWHUB_GENERATED_ARCHIVE_METADATA_FILE = "_meta.json";

type ClawHubArchiveEntryLimits = {
  maxEntryBytes: number;
  addArchiveBytes: (bytes: number) => boolean;
};

export function formatClawHubSpecifier(params: { name: string; version?: string }): string {
  return `clawhub:${params.name}${params.version ? `@${params.version}` : ""}`;
}

function buildClawHubInstallFailure(
  error: string,
  code?: ClawHubInstallErrorCode,
): ClawHubInstallFailure {
  return { ok: false, error, code };
}

function isClawHubInstallFailure(value: unknown): value is ClawHubInstallFailure {
  return Boolean(
    value &&
    typeof value === "object" &&
    "ok" in value &&
    Object.is((value as { ok?: unknown }).ok, false) &&
    "error" in value,
  );
}

function mapClawHubRequestError(
  error: unknown,
  context: { stage: "package" | "version"; name: string; version?: string },
): ClawHubInstallFailure {
  if (error instanceof ClawHubRequestError && error.status === 404) {
    if (context.stage === "package") {
      return buildClawHubInstallFailure(
        "Package not found on ClawHub.",
        CLAWHUB_INSTALL_ERROR_CODE.PACKAGE_NOT_FOUND,
      );
    }
    return buildClawHubInstallFailure(
      `Version not found on ClawHub: ${context.name}@${context.version ?? "unknown"}.`,
      CLAWHUB_INSTALL_ERROR_CODE.VERSION_NOT_FOUND,
    );
  }
  return buildClawHubInstallFailure(formatErrorMessage(error));
}

function resolveRequestedVersion(params: {
  detail: ClawHubPackageDetail;
  requestedVersion?: string;
}): string | null {
  if (params.requestedVersion) {
    return params.detail.package?.tags?.[params.requestedVersion] ?? params.requestedVersion;
  }
  return resolveLatestVersionFromPackage(params.detail);
}

function readTrimmedString(value: unknown): string | null {
  return normalizeOptionalString(value) ?? null;
}

function normalizeClawHubRelativePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  if (value.trim() !== value || value.includes("\\")) {
    return null;
  }
  if (value.startsWith("/")) {
    return null;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }
  return value;
}

function describeInvalidClawHubRelativePath(value: unknown): string {
  if (typeof value !== "string") {
    return `non-string value of type ${typeof value}`;
  }
  if (value.length === 0) {
    return "empty string";
  }
  if (value.trim() !== value) {
    return `path "${value}" has leading or trailing whitespace`;
  }
  if (value.includes("\\")) {
    return `path "${value}" contains backslashes`;
  }
  if (value.startsWith("/")) {
    return `path "${value}" is absolute`;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return `path "${value}" contains an empty segment`;
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return `path "${value}" contains dot segments`;
  }
  return `path "${value}" failed validation for an unknown reason`;
}

function describeInvalidClawHubSha256(value: unknown): string {
  if (typeof value !== "string") {
    return `non-string value of type ${typeof value}`;
  }
  if (value.length === 0) {
    return "empty string";
  }
  if (value.trim().length === 0) {
    return "whitespace-only string";
  }
  return `value "${value}" is not a 64-character hexadecimal SHA-256 digest`;
}

function resolveClawHubArchiveVerification(
  versionDetail: ClawHubPackageVersion,
  packageName: string,
  version: string,
): ClawHubArchiveVerificationResolution {
  const sha256hashValue = versionDetail.version?.sha256hash;
  const sha256hash = readTrimmedString(sha256hashValue);
  const integrity = sha256hash ? normalizeClawHubSha256Integrity(sha256hash) : null;
  if (integrity) {
    return {
      ok: true,
      verification: {
        kind: "archive-integrity",
        integrity,
      },
    };
  }
  if (sha256hashValue !== undefined && sha256hashValue !== null) {
    const detail =
      typeof sha256hashValue === "string" && sha256hashValue.trim().length === 0
        ? "empty string"
        : typeof sha256hashValue === "string"
          ? `unrecognized value "${sha256hashValue.trim()}"`
          : `non-string value of type ${typeof sha256hashValue}`;
    return buildClawHubInstallFailure(
      `ClawHub version metadata for "${packageName}@${version}" has an invalid sha256hash (${detail}).`,
      CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
    );
  }
  const files = versionDetail.version?.files;
  if (!Array.isArray(files) || files.length === 0) {
    return {
      ok: true,
      verification: null,
    };
  }
  const normalizedFiles: ClawHubFileVerificationEntry[] = [];
  const seenPaths = new Set<string>();
  for (const [index, file] of files.entries()) {
    if (!file || typeof file !== "object") {
      return buildClawHubInstallFailure(
        `ClawHub version metadata for "${packageName}@${version}" has an invalid files[${index}] entry (expected an object, got ${file === null ? "null" : typeof file}).`,
        CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      );
    }
    const fileRecord = file as ClawHubFileEntryLike;
    const filePath = normalizeClawHubRelativePath(fileRecord.path);
    const sha256Value = readTrimmedString(fileRecord.sha256);
    const sha256 = sha256Value ? normalizeClawHubSha256Hex(sha256Value) : null;
    if (!filePath) {
      return buildClawHubInstallFailure(
        `ClawHub version metadata for "${packageName}@${version}" has an invalid files[${index}].path (${describeInvalidClawHubRelativePath(fileRecord.path)}).`,
        CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      );
    }
    if (filePath === CLAWHUB_GENERATED_ARCHIVE_METADATA_FILE) {
      return buildClawHubInstallFailure(
        `ClawHub version metadata for "${packageName}@${version}" must not include generated file "${filePath}" in files[].`,
        CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      );
    }
    if (!sha256) {
      return buildClawHubInstallFailure(
        `ClawHub version metadata for "${packageName}@${version}" has an invalid files[${index}].sha256 (${describeInvalidClawHubSha256(fileRecord.sha256)}).`,
        CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      );
    }
    if (seenPaths.has(filePath)) {
      return buildClawHubInstallFailure(
        `ClawHub version metadata for "${packageName}@${version}" has duplicate files[] path "${filePath}".`,
        CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      );
    }
    seenPaths.add(filePath);
    normalizedFiles.push({ path: filePath, sha256 });
  }
  return {
    ok: true,
    verification: {
      kind: "file-list",
      files: normalizedFiles,
    },
  };
}

async function readLimitedClawHubArchiveEntry<T>(
  entry: JSZip.JSZipObject,
  limits: ClawHubArchiveEntryLimits,
  handlers: {
    onChunk: (buffer: Buffer) => void;
    onEnd: () => T;
  },
): Promise<T | ClawHubInstallFailure> {
  const hintedSize = (entry as JSZipObjectWithSize)._data?.uncompressedSize;
  if (
    typeof hintedSize === "number" &&
    Number.isFinite(hintedSize) &&
    hintedSize > limits.maxEntryBytes
  ) {
    return buildClawHubInstallFailure(
      `ClawHub archive fallback verification rejected "${entry.name}" because it exceeds the per-file size limit.`,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
    );
  }
  let entryBytes = 0;
  return await new Promise<T | ClawHubInstallFailure>((resolve) => {
    let settled = false;
    const stream = entry.nodeStream("nodebuffer") as NodeJS.ReadableStream & {
      destroy?: (error?: Error) => void;
    };
    stream.on("data", (chunk: Buffer | Uint8Array | string) => {
      if (settled) {
        return;
      }
      const buffer =
        typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
      entryBytes += buffer.byteLength;
      if (entryBytes > limits.maxEntryBytes) {
        settled = true;
        stream.destroy?.();
        resolve(
          buildClawHubInstallFailure(
            `ClawHub archive fallback verification rejected "${entry.name}" because it exceeds the per-file size limit.`,
            CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
          ),
        );
        return;
      }
      if (!limits.addArchiveBytes(buffer.byteLength)) {
        settled = true;
        stream.destroy?.();
        resolve(
          buildClawHubInstallFailure(
            "ClawHub archive fallback verification exceeded the total extracted-size limit.",
            CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
          ),
        );
        return;
      }
      handlers.onChunk(buffer);
    });
    stream.once("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(handlers.onEnd());
    });
    stream.once("error", (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(
        buildClawHubInstallFailure(
          error instanceof Error ? error.message : String(error),
          CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        ),
      );
    });
  });
}

async function readClawHubArchiveEntryBuffer(
  entry: JSZip.JSZipObject,
  limits: ClawHubArchiveEntryLimits,
): Promise<Buffer | ClawHubInstallFailure> {
  const chunks: Buffer[] = [];
  return await readLimitedClawHubArchiveEntry(entry, limits, {
    onChunk(buffer) {
      chunks.push(buffer);
    },
    onEnd() {
      return Buffer.concat(chunks);
    },
  });
}

async function hashClawHubArchiveEntry(
  entry: JSZip.JSZipObject,
  limits: ClawHubArchiveEntryLimits,
): Promise<string | ClawHubInstallFailure> {
  const digest = createHash("sha256");
  return await readLimitedClawHubArchiveEntry(entry, limits, {
    onChunk(buffer) {
      digest.update(buffer);
    },
    onEnd() {
      return digest.digest("hex");
    },
  });
}

function validateClawHubArchiveMetaJson(params: {
  packageName: string;
  version: string;
  bytes: Buffer;
}): ClawHubInstallFailure | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.bytes.toString("utf8"));
  } catch {
    return buildClawHubInstallFailure(
      `ClawHub archive contents do not match files[] metadata for "${params.packageName}@${params.version}": _meta.json is not valid JSON.`,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    return buildClawHubInstallFailure(
      `ClawHub archive contents do not match files[] metadata for "${params.packageName}@${params.version}": _meta.json is not a JSON object.`,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
    );
  }
  const record = parsed as { slug?: unknown; version?: unknown };
  if (record.slug !== params.packageName) {
    return buildClawHubInstallFailure(
      `ClawHub archive contents do not match files[] metadata for "${params.packageName}@${params.version}": _meta.json slug does not match the package name.`,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
    );
  }
  if (record.version !== params.version) {
    return buildClawHubInstallFailure(
      `ClawHub archive contents do not match files[] metadata for "${params.packageName}@${params.version}": _meta.json version does not match the package version.`,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
    );
  }
  return null;
}

function mapClawHubArchiveReadFailure(error: unknown): ClawHubInstallFailure {
  if (error instanceof ArchiveLimitError) {
    if (error.code === ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT) {
      return buildClawHubInstallFailure(
        "ClawHub archive fallback verification exceeded the archive entry limit.",
        CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      );
    }
    if (error.code === ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT) {
      return buildClawHubInstallFailure(
        "ClawHub archive fallback verification rejected the downloaded archive because it exceeds the ZIP archive size limit.",
        CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      );
    }
  }
  return buildClawHubInstallFailure(
    "ClawHub archive fallback verification failed while reading the downloaded archive.",
    CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
  );
}

async function verifyClawHubArchiveFiles(params: {
  archivePath: string;
  packageName: string;
  packageVersion: string;
  files: ClawHubFileVerificationEntry[];
}): Promise<ClawHubArchiveFileVerificationResult> {
  try {
    const archiveStat = await fs.stat(params.archivePath);
    if (archiveStat.size > DEFAULT_MAX_ARCHIVE_BYTES_ZIP) {
      return buildClawHubInstallFailure(
        "ClawHub archive fallback verification rejected the downloaded archive because it exceeds the ZIP archive size limit.",
        CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      );
    }
    const archiveBytes = await fs.readFile(params.archivePath);
    const zip = await loadZipArchiveWithPreflight(archiveBytes, {
      maxArchiveBytes: DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
      maxEntries: DEFAULT_MAX_ENTRIES,
      maxExtractedBytes: DEFAULT_MAX_EXTRACTED_BYTES,
      maxEntryBytes: DEFAULT_MAX_ENTRY_BYTES,
    });
    const actualFiles = new Map<string, string>();
    const validatedGeneratedPaths = new Set<string>();
    let entryCount = 0;
    let extractedBytes = 0;
    const addArchiveBytes = (bytes: number): boolean => {
      extractedBytes += bytes;
      return extractedBytes <= DEFAULT_MAX_EXTRACTED_BYTES;
    };
    for (const entry of Object.values(zip.files)) {
      entryCount += 1;
      if (entryCount > DEFAULT_MAX_ENTRIES) {
        return buildClawHubInstallFailure(
          "ClawHub archive fallback verification exceeded the archive entry limit.",
          CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        );
      }
      if (entry.dir) {
        continue;
      }
      const relativePath = normalizeClawHubRelativePath(entry.name);
      if (!relativePath) {
        return buildClawHubInstallFailure(
          `ClawHub archive contents do not match files[] metadata for "${params.packageName}@${params.packageVersion}": invalid package file path "${entry.name}" (${describeInvalidClawHubRelativePath(entry.name)}).`,
          CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        );
      }
      if (relativePath === CLAWHUB_GENERATED_ARCHIVE_METADATA_FILE) {
        const metaResult = await readClawHubArchiveEntryBuffer(entry, {
          maxEntryBytes: DEFAULT_MAX_ENTRY_BYTES,
          addArchiveBytes,
        });
        if (isClawHubInstallFailure(metaResult)) {
          return metaResult;
        }
        const metaFailure = validateClawHubArchiveMetaJson({
          packageName: params.packageName,
          version: params.packageVersion,
          bytes: metaResult,
        });
        if (metaFailure) {
          return metaFailure;
        }
        validatedGeneratedPaths.add(relativePath);
        continue;
      }
      const sha256 = await hashClawHubArchiveEntry(entry, {
        maxEntryBytes: DEFAULT_MAX_ENTRY_BYTES,
        addArchiveBytes,
      });
      if (typeof sha256 !== "string") {
        return sha256;
      }
      actualFiles.set(relativePath, sha256);
    }
    for (const file of params.files) {
      const actualSha256 = actualFiles.get(file.path);
      if (!actualSha256) {
        return buildClawHubInstallFailure(
          `ClawHub archive contents do not match files[] metadata for "${params.packageName}@${params.packageVersion}": missing "${file.path}".`,
          CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        );
      }
      if (actualSha256 !== file.sha256) {
        return buildClawHubInstallFailure(
          `ClawHub archive contents do not match files[] metadata for "${params.packageName}@${params.packageVersion}": expected ${file.path} to hash to ${file.sha256}, got ${actualSha256}.`,
          CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        );
      }
      actualFiles.delete(file.path);
    }
    const unexpectedFile = [...actualFiles.keys()].toSorted()[0];
    if (unexpectedFile) {
      return buildClawHubInstallFailure(
        `ClawHub archive contents do not match files[] metadata for "${params.packageName}@${params.packageVersion}": unexpected file "${unexpectedFile}".`,
        CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      );
    }
    return {
      ok: true,
      validatedGeneratedPaths: [...validatedGeneratedPaths].toSorted(),
    };
  } catch (error) {
    return mapClawHubArchiveReadFailure(error);
  }
}

async function resolveCompatiblePackageVersion(params: {
  detail: ClawHubPackageDetail;
  requestedVersion?: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
}): Promise<
  | {
      ok: true;
      version: string;
      compatibility?: ClawHubPackageCompatibility | null;
      verification: ClawHubArchiveVerification | null;
    }
  | ClawHubInstallFailure
> {
  const requestedVersion = resolveRequestedVersion(params);
  if (!requestedVersion) {
    return buildClawHubInstallFailure(
      `ClawHub package "${params.detail.package?.name ?? "unknown"}" has no installable version.`,
      CLAWHUB_INSTALL_ERROR_CODE.NO_INSTALLABLE_VERSION,
    );
  }
  let versionDetail;
  try {
    versionDetail = await fetchClawHubPackageVersion({
      name: params.detail.package?.name ?? "",
      version: requestedVersion,
      baseUrl: params.baseUrl,
      token: params.token,
      timeoutMs: params.timeoutMs,
    });
  } catch (error) {
    return mapClawHubRequestError(error, {
      stage: "version",
      name: params.detail.package?.name ?? "unknown",
      version: requestedVersion,
    });
  }
  const resolvedVersion = versionDetail.version?.version ?? requestedVersion;
  if (params.detail.package?.family === "skill") {
    return {
      ok: true,
      version: resolvedVersion,
      compatibility:
        versionDetail.version?.compatibility ?? params.detail.package?.compatibility ?? null,
      verification: null,
    };
  }
  const verificationState = resolveClawHubArchiveVerification(
    versionDetail,
    params.detail.package?.name ?? "unknown",
    resolvedVersion,
  );
  if (!verificationState.ok) {
    return verificationState;
  }
  return {
    ok: true,
    version: resolvedVersion,
    compatibility:
      versionDetail.version?.compatibility ?? params.detail.package?.compatibility ?? null,
    verification: verificationState.verification,
  };
}

function validateClawHubPluginPackage(params: {
  detail: ClawHubPackageDetail;
  compatibility?: ClawHubPackageCompatibility | null;
  runtimeVersion: string;
}): ClawHubInstallFailure | null {
  const pkg = params.detail.package;
  if (!pkg) {
    return buildClawHubInstallFailure(
      "Package not found on ClawHub.",
      CLAWHUB_INSTALL_ERROR_CODE.PACKAGE_NOT_FOUND,
    );
  }
  if (pkg.family === "skill") {
    return buildClawHubInstallFailure(
      `"${pkg.name}" is a skill. Use "openclaw skills install ${pkg.name}" instead.`,
      CLAWHUB_INSTALL_ERROR_CODE.SKILL_PACKAGE,
    );
  }
  if (pkg.family !== "code-plugin" && pkg.family !== "bundle-plugin") {
    return buildClawHubInstallFailure(
      `Unsupported ClawHub package family: ${String(pkg.family)}`,
      CLAWHUB_INSTALL_ERROR_CODE.UNSUPPORTED_FAMILY,
    );
  }
  if (pkg.channel === "private") {
    return buildClawHubInstallFailure(
      `"${pkg.name}" is private on ClawHub and cannot be installed anonymously.`,
      CLAWHUB_INSTALL_ERROR_CODE.PRIVATE_PACKAGE,
    );
  }

  const compatibility = params.compatibility;
  const runtimeVersion = params.runtimeVersion;
  if (
    compatibility?.pluginApiRange &&
    !satisfiesPluginApiRange(runtimeVersion, compatibility.pluginApiRange)
  ) {
    return buildClawHubInstallFailure(
      `Plugin "${pkg.name}" requires plugin API ${compatibility.pluginApiRange}, but this OpenClaw runtime exposes ${runtimeVersion}.`,
      CLAWHUB_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API,
    );
  }

  if (
    compatibility?.minGatewayVersion &&
    !satisfiesGatewayMinimum(runtimeVersion, compatibility.minGatewayVersion)
  ) {
    return buildClawHubInstallFailure(
      `Plugin "${pkg.name}" requires OpenClaw >=${compatibility.minGatewayVersion}, but this host is ${runtimeVersion}.`,
      CLAWHUB_INSTALL_ERROR_CODE.INCOMPATIBLE_GATEWAY,
    );
  }
  return null;
}

function logClawHubPackageSummary(params: {
  detail: ClawHubPackageDetail;
  version: string;
  compatibility?: ClawHubPackageCompatibility | null;
  logger?: PluginInstallLogger;
}) {
  const pkg = params.detail.package;
  if (!pkg) {
    return;
  }
  const verification = pkg.verification?.tier ? ` verification=${pkg.verification.tier}` : "";
  params.logger?.info?.(
    `ClawHub ${pkg.family} ${pkg.name}@${params.version} channel=${pkg.channel}${verification}`,
  );
  const compatibilityParts = [
    params.compatibility?.pluginApiRange
      ? `pluginApi=${params.compatibility.pluginApiRange}`
      : null,
    params.compatibility?.minGatewayVersion
      ? `minGateway=${params.compatibility.minGatewayVersion}`
      : null,
  ].filter(Boolean);
  if (compatibilityParts.length > 0) {
    params.logger?.info?.(`Compatibility: ${compatibilityParts.join(" ")}`);
  }
  if (pkg.channel !== "official") {
    params.logger?.warn?.(
      `ClawHub package "${pkg.name}" is ${pkg.channel}; review source and verification before enabling.`,
    );
  }
}

export async function installPluginFromClawHub(
  params: InstallSafetyOverrides & {
    spec: string;
    baseUrl?: string;
    token?: string;
    logger?: PluginInstallLogger;
    mode?: "install" | "update";
    extensionsDir?: string;
    timeoutMs?: number;
    dryRun?: boolean;
    expectedPluginId?: string;
  },
): Promise<
  | ({
      ok: true;
    } & Extract<InstallPluginResult, { ok: true }> & {
        clawhub: ClawHubPluginInstallRecordFields;
        packageName: string;
      })
  | ClawHubInstallFailure
  | Extract<InstallPluginResult, { ok: false }>
> {
  const parsed = parseClawHubPluginSpec(params.spec);
  if (!parsed?.name) {
    return buildClawHubInstallFailure(
      `invalid ClawHub plugin spec: ${params.spec}`,
      CLAWHUB_INSTALL_ERROR_CODE.INVALID_SPEC,
    );
  }

  params.logger?.info?.(`Resolving ${formatClawHubSpecifier(parsed)}…`);
  let detail: ClawHubPackageDetail;
  try {
    detail = await fetchClawHubPackageDetail({
      name: parsed.name,
      baseUrl: params.baseUrl,
      token: params.token,
      timeoutMs: params.timeoutMs,
    });
  } catch (error) {
    return mapClawHubRequestError(error, {
      stage: "package",
      name: parsed.name,
    });
  }
  const versionState = await resolveCompatiblePackageVersion({
    detail,
    requestedVersion: parsed.version,
    baseUrl: params.baseUrl,
    token: params.token,
    timeoutMs: params.timeoutMs,
  });
  if (!versionState.ok) {
    return versionState;
  }
  const runtimeVersion = resolveCompatibilityHostVersion();
  const validationFailure = validateClawHubPluginPackage({
    detail,
    compatibility: versionState.compatibility,
    runtimeVersion,
  });
  if (validationFailure) {
    return validationFailure;
  }
  if (!versionState.verification) {
    return buildClawHubInstallFailure(
      `ClawHub version metadata for "${parsed.name}@${versionState.version}" is missing sha256hash and usable files[] metadata for fallback archive verification.`,
      CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
    );
  }
  const canonicalPackageName = detail.package?.name ?? parsed.name;
  logClawHubPackageSummary({
    detail,
    version: versionState.version,
    compatibility: versionState.compatibility,
    logger: params.logger,
  });

  let archive;
  try {
    archive = await downloadClawHubPackageArchive({
      name: parsed.name,
      version: versionState.version,
      baseUrl: params.baseUrl,
      token: params.token,
      timeoutMs: params.timeoutMs,
    });
  } catch (error) {
    return buildClawHubInstallFailure(formatErrorMessage(error));
  }
  try {
    if (versionState.verification.kind === "archive-integrity") {
      if (archive.integrity !== versionState.verification.integrity) {
        return buildClawHubInstallFailure(
          `ClawHub archive integrity mismatch for "${parsed.name}@${versionState.version}": expected ${versionState.verification.integrity}, got ${archive.integrity}.`,
          CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        );
      }
    } else {
      const validatedPaths = versionState.verification.files
        .map((file) => file.path)
        .toSorted()
        .join(", ");
      const fallbackVerification = await verifyClawHubArchiveFiles({
        archivePath: archive.archivePath,
        packageName: canonicalPackageName,
        packageVersion: versionState.version,
        files: versionState.verification.files,
      });
      if (!fallbackVerification.ok) {
        return fallbackVerification;
      }
      const validatedGeneratedPaths =
        fallbackVerification.validatedGeneratedPaths.length > 0
          ? ` Validated generated metadata files present in archive: ${fallbackVerification.validatedGeneratedPaths.join(", ")} (JSON parse plus slug/version match only).`
          : "";
      params.logger?.warn?.(
        `ClawHub package "${canonicalPackageName}@${versionState.version}" is missing sha256hash; falling back to files[] verification. Validated files: ${validatedPaths}.${validatedGeneratedPaths}`,
      );
    }
    params.logger?.info?.(
      `Downloading ${detail.package?.family === "bundle-plugin" ? "bundle" : "plugin"} ${parsed.name}@${versionState.version} from ClawHub…`,
    );
    const installResult = await installPluginFromArchive({
      archivePath: archive.archivePath,
      dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
      logger: params.logger,
      mode: params.mode,
      extensionsDir: params.extensionsDir,
      timeoutMs: params.timeoutMs,
      dryRun: params.dryRun,
      expectedPluginId: params.expectedPluginId,
    });
    if (!installResult.ok) {
      return installResult;
    }

    const pkg = detail.package!;
    const clawhubFamily =
      pkg.family === "code-plugin" || pkg.family === "bundle-plugin" ? pkg.family : null;
    if (!clawhubFamily) {
      return buildClawHubInstallFailure(
        `Unsupported ClawHub package family: ${pkg.family}`,
        CLAWHUB_INSTALL_ERROR_CODE.UNSUPPORTED_FAMILY,
      );
    }
    return {
      ...installResult,
      packageName: parsed.name,
      clawhub: {
        source: "clawhub",
        clawhubUrl:
          normalizeOptionalString(params.baseUrl) ||
          normalizeOptionalString(process.env.OPENCLAW_CLAWHUB_URL) ||
          "https://clawhub.ai",
        clawhubPackage: parsed.name,
        clawhubFamily,
        clawhubChannel: pkg.channel,
        version: installResult.version ?? versionState.version,
        // For fallback installs this is the observed download digest, not a
        // server-attested sha256hash from ClawHub version metadata.
        integrity: archive.integrity,
        resolvedAt: new Date().toISOString(),
      },
    };
  } finally {
    await archive.cleanup().catch(() => undefined);
  }
}
