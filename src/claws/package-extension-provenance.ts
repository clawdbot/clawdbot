import type { ClawAppliedExtension, ClawPackage } from "./types.js";

export const CLAW_PACKAGE_REF_SCHEMA_VERSION = "openclaw.clawPackageRef.v1" as const;
export type ClawPackageRefStatus = "pending" | "complete" | "failed" | "rolled_back";
export type ClawPackageRelationship = "managed" | "referenced";
export type ClawPackageOrigin = "claw-introduced" | "pre-existing";

export type PersistedClawPackageRef = {
  schemaVersion: typeof CLAW_PACKAGE_REF_SCHEMA_VERSION;
  agentId: string;
  clawName: string;
  kind: ClawPackage["kind"];
  source: ClawPackage["source"];
  ref: string;
  version: string;
  integrity: string;
  status: ClawPackageRefStatus;
  relationship: ClawPackageRelationship;
  origin: ClawPackageOrigin;
  independentOwner: boolean;
  extension?: ClawAppliedExtension;
  installedAtMs: number;
  updatedAtMs: number;
};

export type PackageRefRow = {
  schema_version: string;
  agent_id: string;
  claw_name: string;
  package_kind: ClawPackage["kind"];
  package_source: ClawPackage["source"];
  package_ref: string;
  package_version: string;
  package_integrity: string;
  package_status: ClawPackageRefStatus;
  relationship: ClawPackageRelationship;
  origin: ClawPackageOrigin;
  independent_owner: number | bigint;
  extension_id: string | null;
  extension_format: ClawAppliedExtension["format"] | null;
  extension_detected_format: ClawAppliedExtension["detectedFormat"] | null;
  extension_mapped_json: string | null;
  extension_unavailable_json: string | null;
  extension_adapter_identity: string | null;
  installed_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

function parsePackageRefExtension(row: PackageRefRow): ClawAppliedExtension | undefined {
  const values = [
    row.extension_id,
    row.extension_format,
    row.extension_detected_format,
    row.extension_mapped_json,
    row.extension_unavailable_json,
    row.extension_adapter_identity,
  ];
  if (values.every((value) => value === null)) {
    return undefined;
  }
  if (values.some((value) => value === null)) {
    throw new Error(
      `Claw package reference ${row.package_kind}:${row.package_ref} has incomplete extension provenance.`,
    );
  }
  const formats = new Set(["openclaw", "claude", "codex", "cursor"]);
  if (!formats.has(row.extension_format!) || !formats.has(row.extension_detected_format!)) {
    throw new Error(
      `Claw package reference ${row.package_kind}:${row.package_ref} has unsupported extension format provenance.`,
    );
  }
  const mapped = JSON.parse(row.extension_mapped_json!) as unknown;
  const unavailable = JSON.parse(row.extension_unavailable_json!) as unknown;
  if (
    !Array.isArray(mapped) ||
    !mapped.every((value) => typeof value === "string") ||
    !Array.isArray(unavailable) ||
    !unavailable.every((value) => typeof value === "string")
  ) {
    throw new Error(
      `Claw package reference ${row.package_kind}:${row.package_ref} has invalid extension inventory provenance.`,
    );
  }
  return {
    id: row.extension_id!,
    format: row.extension_format!,
    detectedFormat: row.extension_detected_format!,
    mapped,
    unavailable,
    adapterIdentity: row.extension_adapter_identity!,
  };
}

export function rowToPackageRef(row: PackageRefRow): PersistedClawPackageRef {
  const extension = parsePackageRefExtension(row);
  return {
    schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
    agentId: row.agent_id,
    clawName: row.claw_name,
    kind: row.package_kind,
    source: row.package_source,
    ref: row.package_ref,
    version: row.package_version,
    integrity: row.package_integrity,
    status: row.package_status,
    relationship: row.relationship,
    origin: row.origin,
    independentOwner: Number(row.independent_owner) === 1,
    ...(extension ? { extension } : {}),
    installedAtMs: Number(row.installed_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}
