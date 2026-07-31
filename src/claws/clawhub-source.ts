// ClawHub source resolution verifies exact immutable artifacts before lifecycle planning.
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ClawCatalogDetail,
  ClawCatalogEntry,
} from "../../packages/gateway-protocol/src/index.js";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { resolveStateDir } from "../config/paths.js";
import {
  ensureClawHubPackageTrustAcknowledged,
  type ClawHubRiskAcknowledgementRequest,
} from "../infra/clawhub-install-trust.js";
import {
  downloadClawHubPackageArchive,
  fetchClawHubPackageArtifact,
  fetchClawHubPackageDetail,
  fetchClawHubPackageVersion,
  normalizeClawHubSha256Hex,
  searchClawHubPackages,
  type ClawHubPackageDetail,
} from "../infra/clawhub.js";
import { withExtractedArchiveRoot } from "../infra/install-flow.js";
import { readClawManifestFile } from "./reader.js";
import type { ClawReadResult } from "./types.js";

const CLAW_SOURCE_CACHE_DIR = "claws/sources";
const CLAWHUB_TIMEOUT_MS = 30_000;

export type ClawHubCoordinate = { packageName: string; version: string };

export class ClawHubSourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly warning?: string,
  ) {
    super(message);
    this.name = "ClawHubSourceError";
  }
}

function requireClawPackage(detail: ClawHubPackageDetail, requestedName: string) {
  const pkg = detail.package;
  if (!pkg || pkg.family !== "claw" || pkg.name !== requestedName) {
    throw new ClawHubSourceError("clawhub_identity_mismatch", "ClawHub package identity changed.");
  }
  return pkg;
}

export function projectClawHubBrowserWarning(warning?: string): string | undefined {
  if (!warning) {
    return undefined;
  }
  const lines: string[] = [];
  for (const rawLine of stripAnsi(warning).split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^╰─+╯$/u.test(trimmed)) {
      continue;
    }
    const title = /^╭─\s*(.*?)\s*─+╮$/u.exec(trimmed)?.[1];
    const body = /^│(.*)│$/u.exec(trimmed)?.[1];
    const line = sanitizeTerminalText(title ?? body ?? trimmed).trim();
    if (line && lines.at(-1) !== line) {
      lines.push(line);
    }
  }
  return lines.join("\n") || "Review the ClawHub security details before applying this release.";
}

export async function searchClawHubClaws(params: {
  query: string;
  limit?: number;
}): Promise<ClawCatalogEntry[]> {
  const results = await searchClawHubPackages({
    query: params.query,
    family: "claw",
    limit: params.limit ?? 20,
  });
  return results
    .filter((entry) => entry.package.family === "claw")
    .map(({ package: pkg }) => {
      const entry: ClawCatalogEntry = {
        packageName: pkg.name,
        displayName: pkg.displayName,
        channel: pkg.channel,
        official: pkg.isOfficial,
        downloads: Math.max(0, pkg.stats?.downloads ?? 0),
        updatedAtMs: Math.max(0, pkg.updatedAt),
      };
      if (pkg.summary) {
        entry.summary = pkg.summary;
      }
      if (pkg.latestVersion) {
        entry.latestVersion = pkg.latestVersion;
      }
      return entry;
    });
}

export async function readClawHubClawDetail(params: {
  packageName: string;
  version?: string;
}): Promise<ClawCatalogDetail> {
  const detail = await fetchClawHubPackageDetail({ name: params.packageName });
  const pkg = requireClawPackage(detail, params.packageName);
  const version = params.version ?? pkg.latestVersion;
  if (!version) {
    throw new ClawHubSourceError(
      "clawhub_version_unavailable",
      "ClawHub has no published version.",
    );
  }
  const release = await fetchClawHubPackageVersion({ name: pkg.name, version });
  if (release.package?.name !== pkg.name || release.package.family !== "claw") {
    throw new ClawHubSourceError("clawhub_identity_mismatch", "ClawHub release identity changed.");
  }
  const manifest = release.version?.clawManifestSummary ?? pkg.clawManifestSummary;
  if (!release.version || release.version.version !== version || !manifest) {
    throw new ClawHubSourceError(
      "clawhub_manifest_summary_missing",
      "ClawHub did not return a validated Claw summary.",
    );
  }
  return {
    packageName: pkg.name,
    displayName: pkg.displayName,
    ...(pkg.summary ? { summary: pkg.summary } : {}),
    channel: pkg.channel,
    official: pkg.isOfficial,
    version,
    ...(manifest.agent.name ? { agentName: manifest.agent.name } : {}),
    ...(manifest.agent.description ? { agentDescription: manifest.agent.description } : {}),
    workspaceFiles: manifest.workspace.fileCount + manifest.workspace.bootstrapFiles.length,
    skills: manifest.packages.skillCount,
    plugins: manifest.packages.pluginCount,
    mcpServers: manifest.mcpServerCount,
    scheduledJobs: manifest.cronJobCount,
    ...(release.version.verification?.scanStatus
      ? { scanStatus: release.version.verification.scanStatus }
      : pkg.scanStatus
        ? { scanStatus: pkg.scanStatus }
        : {}),
  };
}

async function persistExtractedSource(params: {
  rootDir: string;
  artifactSha256: string;
  stateDir?: string;
}): Promise<string> {
  const cacheRoot = path.join(params.stateDir ?? resolveStateDir(), CLAW_SOURCE_CACHE_DIR);
  const destination = path.join(cacheRoot, params.artifactSha256);
  await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const staging = await fs.mkdtemp(path.join(cacheRoot, ".staging-"));
  const backup = await fs.mkdtemp(path.join(cacheRoot, ".backup-"));
  const stagedPackage = path.join(staging, "package");
  const previousPackage = path.join(backup, "package");
  let hadPrevious = false;
  let preserveBackup = false;
  try {
    await fs.cp(params.rootDir, stagedPackage, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: false,
      verbatimSymlinks: true,
    });
    try {
      await fs.rename(destination, previousPackage);
      hadPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    try {
      await fs.rename(stagedPackage, destination);
    } catch (error) {
      if (hadPrevious) {
        try {
          await fs.rename(previousPackage, destination);
        } catch (restoreError) {
          preserveBackup = true;
          const replacementError = new AggregateError(
            [error, restoreError],
            `Failed to replace or restore cached Claw source; recovery copy retained at ${previousPackage}.`,
            { cause: error },
          );
          throw replacementError;
        }
      }
      throw error;
    }
    return destination;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    if (!preserveBackup) {
      await fs.rm(backup, { recursive: true, force: true });
    }
  }
}

type ResolvedClawHubSource = Extract<ClawReadResult, { ok: true }>;
type PersistClawHubSource = () => Promise<ResolvedClawHubSource>;

async function readVerifiedArtifactSource(params: {
  sourceRoot: string;
  packageName: string;
  version: string;
  artifactSha256: string;
}): Promise<ResolvedClawHubSource> {
  const loaded = await readClawManifestFile(params.sourceRoot);
  if (!loaded.ok) {
    throw new ClawHubSourceError(
      "clawhub_manifest_invalid",
      loaded.diagnostics.map((diagnostic) => diagnostic.message).join(" "),
    );
  }
  if (loaded.source.name !== params.packageName || loaded.source.version !== params.version) {
    throw new ClawHubSourceError(
      "clawhub_identity_mismatch",
      "Downloaded Claw package identity does not match the selected release.",
    );
  }
  return {
    ...loaded,
    source: {
      ...loaded.source,
      integrityKind: "artifact",
      integrity: `sha256:${params.artifactSha256}`,
    },
  };
}

export async function withResolvedClawHubSource<T>(params: {
  coordinate: ClawHubCoordinate;
  mode: "preview" | "apply";
  acknowledgeClawHubRisk?: boolean;
  stateDir?: string;
  run: (
    source: ResolvedClawHubSource,
    trust: { trustWarning?: string; riskAcknowledgementRequired: boolean },
    persistSource: PersistClawHubSource,
  ) => Promise<T>;
}): Promise<{ value: T; trustWarning?: string; riskAcknowledgementRequired: boolean }> {
  const { packageName, version } = params.coordinate;
  const artifact = await fetchClawHubPackageArtifact({ name: packageName, version });
  const artifactVersion =
    typeof artifact.version === "string" ? artifact.version : artifact.version?.version;
  if (
    artifact.package?.name !== packageName ||
    artifact.package.family !== "claw" ||
    artifactVersion !== version ||
    artifact.artifact?.artifactKind !== "npm-pack"
  ) {
    throw new ClawHubSourceError(
      "clawhub_artifact_unavailable",
      "ClawHub did not return an immutable ClawPack artifact.",
    );
  }
  const expectedSha256 = normalizeClawHubSha256Hex(artifact.artifact.artifactSha256 ?? "");
  if (!expectedSha256) {
    throw new ClawHubSourceError(
      "clawhub_artifact_unavailable",
      "ClawHub did not return a valid artifact digest.",
    );
  }

  let acknowledgement: ClawHubRiskAcknowledgementRequest | undefined;
  const trust = await ensureClawHubPackageTrustAcknowledged({
    subject: { kind: "claw", packageName },
    version,
    acknowledgeClawHubRisk: params.acknowledgeClawHubRisk,
    onClawHubRisk:
      params.mode === "preview"
        ? (request) => {
            acknowledgement = request;
            return true;
          }
        : undefined,
  });
  if (!trust.ok) {
    throw new ClawHubSourceError(trust.code ?? "clawhub_trust_failed", trust.error, trust.warning);
  }
  const browserWarning = projectClawHubBrowserWarning(trust.warning);
  const trustProjection = {
    ...(browserWarning ? { trustWarning: browserWarning } : {}),
    riskAcknowledgementRequired:
      acknowledgement !== undefined ||
      trust.trustInstallRecordFields.clawhubTrustAcknowledgedAt !== undefined,
  };

  const download = await downloadClawHubPackageArchive({
    name: packageName,
    version,
    artifact: "clawpack",
    timeoutMs: CLAWHUB_TIMEOUT_MS,
  });
  try {
    if (download.sha256Hex !== expectedSha256) {
      throw new ClawHubSourceError(
        "clawhub_artifact_integrity_mismatch",
        "ClawHub artifact digest changed during download.",
      );
    }
    const extracted = await withExtractedArchiveRoot({
      archivePath: download.archivePath,
      tempDirPrefix: "openclaw-claw-source-",
      timeoutMs: CLAWHUB_TIMEOUT_MS,
      rootMarkers: ["package.json", "CLAW.md", "claw.json"],
      onExtracted: async (rootDir) => {
        const artifactSource = await readVerifiedArtifactSource({
          sourceRoot: rootDir,
          packageName,
          version,
          artifactSha256: expectedSha256,
        });
        let persistedSource: Promise<ResolvedClawHubSource> | undefined;
        const persistSource: PersistClawHubSource = async () => {
          if (params.mode !== "apply") {
            throw new ClawHubSourceError(
              "clawhub_preview_persistence_forbidden",
              "A ClawHub preview cannot persist package content.",
            );
          }
          persistedSource ??= (async () => {
            const sourceRoot = await persistExtractedSource({
              rootDir,
              artifactSha256: expectedSha256,
              stateDir: params.stateDir,
            });
            return await readVerifiedArtifactSource({
              sourceRoot,
              packageName,
              version,
              artifactSha256: expectedSha256,
            });
          })();
          return await persistedSource;
        };
        return {
          ok: true as const,
          value: await params.run(artifactSource, trustProjection, persistSource),
        };
      },
    });
    if (!extracted.ok || !("value" in extracted)) {
      throw new ClawHubSourceError("clawhub_extract_failed", extracted.error);
    }
    return {
      value: extracted.value,
      ...trustProjection,
    };
  } finally {
    await download.cleanup();
  }
}
