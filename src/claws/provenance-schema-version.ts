import type { DatabaseSync } from "node:sqlite";
import { stableStringify } from "@openclaw/normalization-core";

const LEGACY_CLAW_INSTALL_RECORD_SCHEMA_VERSION = "openclaw.clawInstallRecord.v1" as const;
export const CLAW_INSTALL_RECORD_SCHEMA_VERSION = "openclaw.clawInstallRecord.v2" as const;
export const CLAW_ADOPTED_INSTALL_RECORD_SCHEMA_VERSION = "openclaw.clawInstallRecord.v3" as const;

/** Whether Claw created the agent it owns or adopted one the operator already configured. */
export type ClawAgentOrigin = "created" | "adopted";
type ClawInstallRecordSchemaVersion =
  | typeof LEGACY_CLAW_INSTALL_RECORD_SCHEMA_VERSION
  | typeof CLAW_INSTALL_RECORD_SCHEMA_VERSION
  | typeof CLAW_ADOPTED_INSTALL_RECORD_SCHEMA_VERSION;

export function parseClawInstallRecordSchemaVersion(value: string): ClawInstallRecordSchemaVersion {
  if (
    value === LEGACY_CLAW_INSTALL_RECORD_SCHEMA_VERSION ||
    value === CLAW_INSTALL_RECORD_SCHEMA_VERSION ||
    value === CLAW_ADOPTED_INSTALL_RECORD_SCHEMA_VERSION
  ) {
    return value;
  }
  throw new Error(`Unsupported Claw install record schema ${JSON.stringify(value)}.`);
}

export function isLegacyClawInstallRecordSchemaVersion(
  value: ClawInstallRecordSchemaVersion,
): value is typeof LEGACY_CLAW_INSTALL_RECORD_SCHEMA_VERSION {
  return value === LEGACY_CLAW_INSTALL_RECORD_SCHEMA_VERSION;
}

export function upgradeClawInstallSchema<
  TRecord extends {
    schemaVersion: ClawInstallRecordSchemaVersion;
    planIntegrity: string;
    agentConfigDigest: string;
  },
>(
  db: DatabaseSync,
  agentId: string,
  record: TRecord,
  expectedRecord: TRecord | undefined,
  replacement?: Pick<TRecord, "planIntegrity" | "agentConfigDigest">,
): Omit<TRecord, "schemaVersion"> & { schemaVersion: typeof CLAW_INSTALL_RECORD_SCHEMA_VERSION } {
  if (record.schemaVersion !== LEGACY_CLAW_INSTALL_RECORD_SCHEMA_VERSION) {
    throw new Error(
      `Claw install record for agent ${JSON.stringify(agentId)} is not a legacy v1 record.`,
    );
  }
  if (!expectedRecord || stableStringify(record) !== stableStringify(expectedRecord)) {
    throw new Error(
      `Legacy Claw install record for agent ${JSON.stringify(agentId)} is not an exact resumable attempt.`,
    );
  }
  db /* sqlite-allow-raw: exact legacy retry atomically replaces the consent-bound plan identity. */
    .prepare(
      `UPDATE claw_installs
          SET schema_version = ?, plan_integrity = ?, agent_config_digest = ?
        WHERE agent_id = ?`,
    )
    .run(
      CLAW_INSTALL_RECORD_SCHEMA_VERSION,
      replacement?.planIntegrity ?? record.planIntegrity,
      replacement?.agentConfigDigest ?? record.agentConfigDigest,
      agentId,
    );
  return {
    ...record,
    ...replacement,
    schemaVersion: CLAW_INSTALL_RECORD_SCHEMA_VERSION,
  };
}
