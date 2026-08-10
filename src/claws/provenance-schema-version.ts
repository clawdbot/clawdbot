const LEGACY_CLAW_INSTALL_RECORD_SCHEMA_VERSION = "openclaw.clawInstallRecord.v1" as const;
export const CLAW_INSTALL_RECORD_SCHEMA_VERSION = "openclaw.clawInstallRecord.v2" as const;
type ClawInstallRecordSchemaVersion =
  | typeof LEGACY_CLAW_INSTALL_RECORD_SCHEMA_VERSION
  | typeof CLAW_INSTALL_RECORD_SCHEMA_VERSION;

export function parseClawInstallRecordSchemaVersion(value: string): ClawInstallRecordSchemaVersion {
  if (
    value === LEGACY_CLAW_INSTALL_RECORD_SCHEMA_VERSION ||
    value === CLAW_INSTALL_RECORD_SCHEMA_VERSION
  ) {
    return value;
  }
  throw new Error(`Unsupported Claw install record schema ${JSON.stringify(value)}.`);
}

export function upgradeClawInstallSchema<
  TRecord extends { schemaVersion: ClawInstallRecordSchemaVersion },
>(
  db: DatabaseSync,
  agentId: string,
  record: TRecord,
): Omit<TRecord, "schemaVersion"> & { schemaVersion: typeof CLAW_INSTALL_RECORD_SCHEMA_VERSION } {
  db /* sqlite-allow-raw: exact legacy retry upgrades only the provenance schema marker. */
    .prepare("UPDATE claw_installs SET schema_version = ? WHERE agent_id = ?")
    .run(CLAW_INSTALL_RECORD_SCHEMA_VERSION, agentId);
  return { ...record, schemaVersion: CLAW_INSTALL_RECORD_SCHEMA_VERSION };
}
import type { DatabaseSync } from "node:sqlite";
