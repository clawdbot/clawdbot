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
  fetchClawHubPackageArtifact,
  fetchClawHubPackageDetail,
  fetchClawHubPackageVersion,
  normalizeClawHubSha256Integrity,
  normalizeClawHubSha256Hex,
  parseClawHubPluginSpec,
  resolveLatestVersionFromPackage,
  satisfiesGatewayMinimum,
  satisfiesPluginApiRange,
  type ClawHubPackageArtifactSummary,
  type ClawHubPackageArtifactResolverResponse,
  type ClawHubPackageCompatibility,
  type ClawHubPackageDetail,
  type ClawHubPackageClawPackSummary,
  type ClawHubResolvedArtifact,
  type ClawHubPackageVersion,
} from "../infra/clawhub.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import type { ClawHubPluginInstallRecordFields } from "./clawhub-install-records.js";
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

type ClawHubArtifactResolverVersion = NonNullable<
  Exclude<ClawHubPackageArtifactResolverResponse["version"], string | null | undefined>
>;

type ClawHubInstallArtifactDecision = {
  version: string;
  compatibility?: ClawHubPackageCompatibility | null;
  verification: ClawHubArchiveVerification | null;
  clawpack?: ClawHubPackageArtifactSummary | ClawHubPackageClawPackSummary | null;
};

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

function normalizeClawHubClawPackInstallFields(
  clawpack: ClawHubPackageArtifactSummary | ClawHubPackageClawPackSummary | null | undefined,
): Pick<
  ClawHubPluginInstallRecordFields,
  | "artifactKind"
  | "artifactFormat"
  | "npmIntegrity"
  | "npmShasum"
  | "npmTarballName"
  | "clawpackSha256"
  | "clawpackSpecVersion"
  | "clawpackManifestSha256"
  | "clawpackSize"
> {
  const isNpmPackArtifact =
    clawpack && "kind" in clawpack && normalizeOptionalString(clawpack.kind) === "npm-pack";
  const isLegacyClawPack = clawpack && "available" in clawpack && clawpack.available;
  if (!isNpmPackArtifact && !isLegacyClawPack) {
    return {};
  }

  const clawpackSha256 =
    typeof clawpack.sha256 === "string" ? normalizeClawHubSha256Hex(clawpack.sha256) : null;
  const clawpackManifestSha256 =
    "manifestSha256" in clawpack && typeof clawpack.manifestSha256 === "string"
      ? normalizeClawHubSha256Hex(clawpack.manifestSha256)
      : null;
  const clawpackSpecVersion =
    "specVersion" in clawpack &&
    typeof clawpack.specVersion === "number" &&
    Number.isSafeInteger(clawpack.specVersion) &&
    clawpack.specVersion >= 0
      ? clawpack.specVersion
      : undefined;
  const clawpackSize =
    typeof clawpack.size === "number" && Number.isSafeInteger(clawpack.size) && clawpack.size >= 0
      ? clawpack.size
      : undefined;
  const npmIntegrity = normalizeOptionalString(clawpack.npmIntegrity);
  const npmShasum = normalizeOptionalString(clawpack.npmShasum);
  const npmTarballName = normalizeOptionalString(clawpack.npmTarballName);
  return {
    artifactKind: "npm-pack",
    artifactFormat: "tgz",
    ...(npmIntegrity ? { npmIntegrity } : {}),
    ...(npmShasum ? { npmShasum } : {}),
    ...(npmTarballName ? { npmTarballName } : {}),
    ...(clawpackSha256 ? { clawpackSha256 } : {}),
    ...(clawpackSpecVersion !== undefined ? { clawpackSpecVersion } : {}),
    ...(clawpackManifestSha256 ? { clawpackManifestSha256 } : {}),
    ...(clawpackSize !== undefined ? { clawpackSize } : {}),
  };
}

function isTrustedSourceLinkedOfficialPackage(pkg: NonNullable<ClawHubPackageDetail["package"]>) {
  const sourceRepo = normalizeOptionalString(pkg.verification?.sourceRepo);
  return (
    pkg.channel === "official" &&
    pkg.isOfficial &&
    pkg.verification?.tier === "source-linked" &&
    (sourceRepo === "openclaw/openclaw" ||
      sourceRepo === "github.com/openclaw/openclaw" ||
      sourceRepo === "https://github.com/openclaw/openclaw")
  );
}

function resolveClawHubClawPackArtifactSha256(
  clawpack: ClawHubPackageArtifactSummary | ClawHubPackageClawPackSummary | null | undefined,
): string | null {
  const isNpmPackArtifact =
    clawpack && "kind" in clawpack && normalizeOptionalString(clawpack.kind) === "npm-pack";
  const isLegacyClawPack = clawpack && "available" in clawpack && clawpack.available;
  if ((!isNpmPackArtifact && !isLegacyClawPack) || typeof clawpack.sha256 !== "string") {
    return null;
  }
  return normalizeClawHubSha256Hex(clawpack.sha256);
}

function resolveClawHubNpmIntegrity(
  clawpack: ClawHubPackageArtifactSummary | ClawHubPackageClawPackSummary | null | undefined,
): string | null {
  return normalizeOptionalString(clawpack?.npmIntegrity) ?? null;
}

function resolveClawHubNpmShasum(
  clawpack: ClawHubPackageArtifactSummary | ClawHubPackageClawPackSummary | null | undefined,
): string | null {
  return normalizeOptionalString(clawpack?.npmShasum) ?? null;
}

function resolveClawHubNpmTarballName(
  clawpack: ClawHubPackageArtifactSummary | ClawHubPackageClawPackSummary | null | undefined,
): string | null {
  return normalizeOptionalString(clawpack?.npmTarballName) ?? null;
}

function resolveClawHubNpmPackArtifact(
  version: NonNullable<ClawHubPackageVersion["version"]>,
): ClawHubPackageArtifactSummary | ClawHubPackageClawPackSummary | null {
  if (version.artifact?.kind === "npm-pack") {
    return version.artifact;
  }
  if (version.clawpack?.available === true) {
    return version.clawpack;
  }
  return null;
}

function readArtifactResolverVersion(
  response: ClawHubPackageArtifactResolverResponse,
  requestedVersion: string,
): ClawHubArtifactResolverVersion {
  if (
    response.version &&
    typeof response.version === "object" &&
    !Array.isArray(response.version)
  ) {
    return response.version;
  }
  if (typeof response.version === "string" && response.version.trim().length > 0) {
    return { version: response.version.trim() };
  }
  return { version: requestedVersion };
}

function isClawHubPackageFamily(
  value: unknown,
): value is NonNullable<ClawHubPackageVersion["package"]>["family"] {
  return value === "code-plugin" || value === "bundle-plugin" || value === "skill";
}

function normalizeArtifactResolverFiles(
  files: ClawHubArtifactResolverVersion["files"],
): NonNullable<ClawHubPackageVersion["version"]>["files"] {
  if (!Array.isArray(files)) {
    return undefined;
  }
  return files as NonNullable<ClawHubPackageVersion["version"]>["files"];
}

type ClawHubResolvedArtifactWire = {
  artifactKind?: string | null;
  kind?: string | null;
  artifactSha256?: string | null;
  sha256?: string | null;
  npmIntegrity?: string | null;
  npmShasum?: string | null;
  downloadUrl?: string | null;
};

function resolveTopLevelNpmPackArtifact(
  artifact: ClawHubResolvedArtifact | null | undefined,
): ClawHubPackageArtifactSummary | null {
  const wire = artifact as ClawHubResolvedArtifactWire | null | undefined;
  const artifactKind = wire?.artifactKind ?? wire?.kind;
  if (artifactKind !== "npm-pack") {
    return null;
  }
  if (typeof wire?.npmIntegrity !== "string") {
    return null;
  }
  return {
    kind: "npm-pack",
    format: "tgz",
    sha256: wire.artifactSha256 ?? wire.sha256 ?? null,
    npmIntegrity: wire.npmIntegrity,
    npmShasum: wire.npmShasum ?? null,
    downloadUrl: wire.downloadUrl ?? null,
  };
}

function resolveTopLevelLegacyArchiveVerification(
  artifact: ClawHubResolvedArtifact | null | undefined,
): ClawHubArchiveVerification | null {
  const wire = artifact as ClawHubResolvedArtifactWire | null | undefined;
  const artifactKind = wire?.artifactKind ?? wire?.kind;
  const artifactSha256 = wire?.artifactSha256 ?? wire?.sha256;
  if (artifactKind !== "legacy-zip" || typeof artifactSha256 !== "string") {
    return null;
  }
  const integrity = normalizeClawHubSha256Integrity(artifactSha256);
  return integrity ? { kind: "archive-integrity", integrity } : null;
}

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

function isMissingArtifactResolverRoute(error: unknown): boolean {
  return (
    error instanceof ClawHubRequestError &&
    error.status === 404 &&
    error.requestPath.endsWith("/artifact")
  );
}

function buildArtifactResolverResponseFromVersion(params: {
  detail: ClawHubPackageDetail;
  versionDetail: ClawHubPackageVersion;
}): ClawHubPackageArtifactResolverResponse {
  const packageDetail = params.detail.package;
  const versionPackage = params.versionDetail.package;
  return {
    package: versionPackage
      ? {
          name: versionPackage.name,
          displayName: versionPackage.displayName,
          family: versionPackage.family,
        }
      : packageDetail
        ? {
            name: packageDetail.name,
            displayName: packageDetail.displayName,
            family: packageDetail.family,
          }
        : null,
    version: params.versionDetail.version,
  };
}

function formatClawHubClawPackDownloadError(params: {
  error: unknown;
  packageName: string;
  version: string;
}): string {
  const message = formatErrorMessage(params.error);
  if (!(params.error instanceof ClawHubRequestError)) {
    return message;
  }
  return `ClawHub artifact download for "${params.packageName}@${params.version}" is not available yet (${message}). Use "npm:${params.packageName}@${params.version}" for launch installs while ClawHub artifact routing is being rolled out.`;
}

function formatClawHubMissingArtifactMetadataError(params: {
  packageName: string;
  version: string;
}): string {
  return `ClawHub package "${params.packageName}@${params.version}" does not expose a downloadable plugin artifact yet. Use "npm:${params.packageName}@${params.version}" for launch installs while ClawHub artifact routing is being rolled out.`;
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
}): Promise<({ ok: true } & ClawHubInstallArtifactDecision) | ClawHubInstallFailure> {
  const requestedVersion = resolveRequestedVersion(params);
  if (!requestedVersion) {
    return buildClawHubInstallFailure(
      `ClawHub package "${params.detail.package?.name ?? "unknown"}" has no installable version.`,
      CLAWHUB_INSTALL_ERROR_CODE.NO_INSTALLABLE_VERSION,
    );
  }
  let artifactResponse: ClawHubPackageArtifactResolverResponse;
  try {
    artifactResponse = await fetchClawHubPackageArtifact({
      name: params.detail.package?.name ?? "",
      version: requestedVersion,
      baseUrl: params.baseUrl,
      token: params.token,
      timeoutMs: params.timeoutMs,
    });
  } catch (error) {
    if (isMissingArtifactResolverRoute(error)) {
      try {
        const versionDetail = await fetchClawHubPackageVersion({
          name: params.detail.package?.name ?? "",
          version: requestedVersion,
          baseUrl: params.baseUrl,
          token: params.token,
          timeoutMs: params.timeoutMs,
        });
        artifactResponse = buildArtifactResolverResponseFromVersion({
          detail: params.detail,
          versionDetail,
        });
      } catch (versionError) {
        return mapClawHubRequestError(versionError, {
          stage: "version",
          name: params.detail.package?.name ?? "unknown",
          version: requestedVersion,
        });
      }
    } else {
      return mapClawHubRequestError(error, {
        stage: "version",
        name: params.detail.package?.name ?? "unknown",
        version: requestedVersion,
      });
    }
  }
  const artifactVersion = readArtifactResolverVersion(artifactResponse, requestedVersion);
  const resolvedVersion = normalizeOptionalString(artifactVersion.version) ?? requestedVersion;
  if (params.detail.package?.family === "skill") {
    return {
      ok: true,
      version: resolvedVersion,
      compatibility: artifactVersion.compatibility ?? params.detail.package?.compatibility ?? null,
      verification: null,
      clawpack:
        artifactVersion.clawpack ?? resolveTopLevelNpmPackArtifact(artifactResponse.artifact),
    };
  }
  const artifactFamily = artifactResponse.package?.family;
  const resolvedFamily: NonNullable<ClawHubPackageVersion["package"]>["family"] =
    isClawHubPackageFamily(artifactFamily)
      ? artifactFamily
      : (params.detail.package?.family ?? "code-plugin");
  const versionRecord: NonNullable<ClawHubPackageVersion["version"]> = {
    version: resolvedVersion,
    createdAt: typeof artifactVersion.createdAt === "number" ? artifactVersion.createdAt : 0,
    changelog: typeof artifactVersion.changelog === "string" ? artifactVersion.changelog : "",
    distTags: artifactVersion.distTags,
    files: normalizeArtifactResolverFiles(artifactVersion.files),
    sha256hash: artifactVersion.sha256hash,
    compatibility: artifactVersion.compatibility,
    artifact: artifactVersion.artifact,
    clawpack: artifactVersion.clawpack ?? undefined,
  };
  const versionDetail: ClawHubPackageVersion = {
    package: artifactResponse.package
      ? {
          name: artifactResponse.package.name ?? params.detail.package?.name ?? "",
          displayName:
            artifactResponse.package.displayName ?? params.detail.package?.displayName ?? "",
          family: resolvedFamily,
        }
      : null,
    version: versionRecord,
  };
  const clawpack =
    resolveClawHubNpmPackArtifact(versionRecord) ??
    resolveTopLevelNpmPackArtifact(artifactResponse.artifact);
  const verificationState = resolveClawHubArchiveVerification(
    versionDetail,
    params.detail.package?.name ?? "unknown",
    resolvedVersion,
  );
  if (!verificationState.ok) {
    if (!resolveClawHubClawPackArtifactSha256(clawpack)) {
      return verificationState;
    }
    return {
      ok: true,
      version: resolvedVersion,
      compatibility:
        versionDetail.version?.compatibility ?? params.detail.package?.compatibility ?? null,
      verification: null,
      clawpack,
    };
  }
  const topLevelLegacyVerification = resolveTopLevelLegacyArchiveVerification(
    artifactResponse.artifact,
  );
  return {
    ok: true,
    version: resolvedVersion,
    compatibility:
      versionDetail.version?.compatibility ?? params.detail.package?.compatibility ?? null,
    verification: verificationState.verification ?? topLevelLegacyVerification,
    clawpack,
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
  const expectedClawPackSha256 = resolveClawHubClawPackArtifactSha256(versionState.clawpack);
  const canonicalPackageName = detail.package?.name ?? parsed.name;
  if (!versionState.verification && !expectedClawPackSha256) {
    return buildClawHubInstallFailure(
      formatClawHubMissingArtifactMetadataError({
        packageName: canonicalPackageName,
        version: versionState.version,
      }),
      CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
    );
  }
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
      artifact: expectedClawPackSha256 ? "clawpack" : "archive",
      baseUrl: params.baseUrl,
      token: params.token,
      timeoutMs: params.timeoutMs,
    });
  } catch (error) {
    // Fix-me(clawhub): remove this npm hint once ClawHub ClawPack artifact
    // routing is live for official package installs.
    return buildClawHubInstallFailure(
      expectedClawPackSha256
        ? formatClawHubClawPackDownloadError({
            error,
            packageName: canonicalPackageName,
            version: versionState.version,
          })
        : formatErrorMessage(error),
    );
  }
  try {
    if (expectedClawPackSha256) {
      const expectedIntegrity = normalizeClawHubSha256Integrity(expectedClawPackSha256);
      const expectedNpmIntegrity = resolveClawHubNpmIntegrity(versionState.clawpack);
      if (
        archive.artifact !== "clawpack" ||
        archive.clawpackHeaderSha256 !== expectedClawPackSha256 ||
        archive.sha256Hex !== expectedClawPackSha256 ||
        archive.integrity !== expectedIntegrity
      ) {
        return buildClawHubInstallFailure(
          `ClawHub ClawPack integrity mismatch for "${parsed.name}@${versionState.version}": expected ${expectedClawPackSha256}, got ${archive.sha256Hex}.`,
          CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        );
      }
      if (expectedNpmIntegrity && archive.npmIntegrity !== expectedNpmIntegrity) {
        return buildClawHubInstallFailure(
          `ClawHub ClawPack npm integrity mismatch for "${parsed.name}@${versionState.version}": expected ${expectedNpmIntegrity}, got ${archive.npmIntegrity ?? "unknown"}.`,
          CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        );
      }
      const expectedNpmShasum = resolveClawHubNpmShasum(versionState.clawpack);
      if (expectedNpmShasum && archive.npmShasum !== expectedNpmShasum) {
        return buildClawHubInstallFailure(
          `ClawHub ClawPack npm shasum mismatch for "${parsed.name}@${versionState.version}": expected ${expectedNpmShasum}, got ${archive.npmShasum ?? "unknown"}.`,
          CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        );
      }
    } else if (versionState.verification?.kind === "archive-integrity") {
      if (archive.integrity !== versionState.verification.integrity) {
        return buildClawHubInstallFailure(
          `ClawHub archive integrity mismatch for "${parsed.name}@${versionState.version}": expected ${versionState.verification.integrity}, got ${archive.integrity}.`,
          CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        );
      }
    } else if (versionState.verification) {
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
      trustedSourceLinkedOfficialInstall: isTrustedSourceLinkedOfficialPackage(detail.package!),
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
    const clawpackFields = normalizeClawHubClawPackInstallFields(versionState.clawpack);
    const observedClawPackArtifactFields =
      archive.artifact === "clawpack"
        ? ({
            artifactKind: "npm-pack",
            artifactFormat: "tgz",
            ...(archive.npmIntegrity ? { npmIntegrity: archive.npmIntegrity } : {}),
            ...(archive.npmShasum ? { npmShasum: archive.npmShasum } : {}),
            ...(archive.npmTarballName ? { npmTarballName: archive.npmTarballName } : {}),
          } satisfies Partial<ClawHubPluginInstallRecordFields>)
        : ({
            artifactKind: "legacy-zip",
            artifactFormat: "zip",
          } satisfies Partial<ClawHubPluginInstallRecordFields>);
    const expectedTarballName = resolveClawHubNpmTarballName(versionState.clawpack);
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
        ...clawpackFields,
        ...observedClawPackArtifactFields,
        ...(expectedTarballName && !archive.npmTarballName
          ? { npmTarballName: expectedTarballName }
          : {}),
      },
    };
  } finally {
    await archive.cleanup().catch(() => undefined);
  }
}
