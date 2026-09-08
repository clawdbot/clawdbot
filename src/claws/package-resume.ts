import { stableStringify } from "@openclaw/normalization-core";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import {
  openExistingOpenClawStateDatabaseReadOnly,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  readClawInstallRecordFromDatabase,
  readClawPackageRefs,
  type PersistedClawInstall,
  type PersistedClawPackageRef,
} from "./provenance.js";
import type { ClawPackage, ClawPackagePreflightResult } from "./types.js";

function ownerInstallIsNewerThanRef(
  installedAt: string | undefined,
  ref: PersistedClawPackageRef,
): boolean {
  const timestamp = Date.parse(installedAt ?? "");
  return Number.isFinite(timestamp) && timestamp > ref.updatedAtMs;
}

function persistedExtensionMatchesPreflight(
  ref: PersistedClawPackageRef,
  preflight: ClawPackagePreflightResult,
): boolean {
  if (!ref.extension) {
    return true;
  }
  if (!preflight.ok) {
    return false;
  }
  return (
    stableStringify({
      detectedFormat: ref.extension.detectedFormat,
      mapped: ref.extension.mapped,
      unavailable: ref.extension.unavailable,
      adapterIdentity: ref.extension.adapterIdentity,
    }) ===
    stableStringify({
      detectedFormat: preflight.detectedFormat,
      mapped: preflight.mapped ?? [],
      unavailable: preflight.unavailable ?? [],
      adapterIdentity: preflight.adapterIdentity,
    })
  );
}

export function findResumableIntroducedPluginRequirement(params: {
  agentId: string;
  pkg: ClawPackage;
  preflight: ClawPackagePreflightResult;
  refs: readonly PersistedClawPackageRef[];
  expectedIntegrity?: string;
}): PersistedClawPackageRef | undefined {
  if (params.pkg.kind !== "plugin" || !params.preflight.ok || params.preflight.action !== "reuse") {
    return undefined;
  }
  const expectedRawIntegrity = params.expectedIntegrity ?? params.preflight.integrity;
  if (!expectedRawIntegrity || !params.preflight.installedIntegrity) {
    return undefined;
  }
  const expectedIntegrity = normalizeClawHubSha256Integrity(expectedRawIntegrity);
  const installedIntegrity = normalizeClawHubSha256Integrity(params.preflight.installedIntegrity);
  if (!expectedIntegrity || installedIntegrity !== expectedIntegrity) {
    return undefined;
  }
  const ref = params.refs.find(
    (candidate) =>
      candidate.agentId === params.agentId &&
      candidate.kind === params.pkg.kind &&
      candidate.source === params.pkg.source &&
      candidate.ref === params.pkg.ref &&
      candidate.version === params.pkg.version &&
      normalizeClawHubSha256Integrity(candidate.integrity) === expectedIntegrity &&
      candidate.status === "complete" &&
      candidate.relationship === "referenced" &&
      candidate.origin === "claw-introduced" &&
      !candidate.independentOwner &&
      persistedExtensionMatchesPreflight(candidate, params.preflight),
  );
  return ref && !ownerInstallIsNewerThanRef(params.preflight.installedAt, ref) ? ref : undefined;
}

export async function readClawResumeStateReadOnly(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): Promise<
  | {
      record: PersistedClawInstall;
      packageRefs: PersistedClawPackageRef[];
    }
  | undefined
> {
  const database = await openExistingOpenClawStateDatabaseReadOnly(options);
  if (!database) {
    return undefined;
  }
  try {
    const hasInstallTable = database.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claw_installs'")
      .get();
    if (!hasInstallTable) {
      return undefined;
    }
    const record = readClawInstallRecordFromDatabase(database.db, agentId);
    if (!record) {
      return undefined;
    }
    return {
      record,
      packageRefs: readClawPackageRefs({ ...options, database, readOnly: true, agentId }),
    };
  } finally {
    database.walMaintenance.close();
  }
}
