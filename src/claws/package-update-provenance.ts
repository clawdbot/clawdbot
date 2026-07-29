import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { PersistedClawPackageRef } from "./provenance.js";

export function digestClawPackageRef(ref: PersistedClawPackageRef): string {
  return `sha256:${createHash("sha256").update(stableStringify(ref)).digest("hex")}`;
}

export function replaceClawPackageRefExpected(
  expected: PersistedClawPackageRef | undefined,
  replacement: PersistedClawPackageRef | undefined,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const identity = expected ?? replacement;
  if (!identity) {
    throw new Error("Package reference replacement requires an identity.");
  }
  runOpenClawStateWriteTransaction(({ db }) => {
    if (expected) {
      const result = db /* sqlite-allow-raw: Claw package provenance compare-and-swap delete. */
        .prepare(
          `DELETE FROM claw_package_refs
            WHERE agent_id = @agent_id
              AND package_kind = @package_kind
              AND package_source = @package_source
              AND package_ref = @package_ref
              AND package_version = @package_version
              AND package_integrity = @package_integrity
              AND schema_version = @schema_version
              AND claw_name = @claw_name
              AND package_status = @package_status
              AND relationship = @relationship
              AND origin = @origin
              AND independent_owner = @independent_owner
              AND installed_at_ms = @installed_at_ms
              AND updated_at_ms = @updated_at_ms`,
        )
        .run({
          agent_id: expected.agentId,
          package_kind: expected.kind,
          package_source: expected.source,
          package_ref: expected.ref,
          package_version: expected.version,
          package_integrity: expected.integrity,
          schema_version: expected.schemaVersion,
          claw_name: expected.clawName,
          package_status: expected.status,
          relationship: expected.relationship,
          origin: expected.origin,
          independent_owner: expected.independentOwner ? 1 : 0,
          installed_at_ms: expected.installedAtMs,
          updated_at_ms: expected.updatedAtMs,
        });
      if (Number(result.changes) !== 1) {
        throw new Error(
          `Package reference ${JSON.stringify(`${expected.kind}:${expected.ref}`)} changed after planning.`,
        );
      }
    } else {
      const occupied =
        db /* sqlite-allow-raw: Claw package provenance compare-and-swap occupancy check. */
          .prepare(
            `SELECT 1 FROM claw_package_refs
            WHERE agent_id = ? AND package_kind = ? AND package_source = ? AND package_ref = ?`,
          )
          .get(identity.agentId, identity.kind, identity.source, identity.ref);
      if (occupied) {
        throw new Error(
          `Package reference ${JSON.stringify(`${identity.kind}:${identity.ref}`)} appeared after planning.`,
        );
      }
    }
    if (replacement) {
      db /* sqlite-allow-raw: Claw package provenance compare-and-swap insert. */
        .prepare(
          `INSERT INTO claw_package_refs (
           agent_id, package_kind, package_source, package_ref, package_version, package_integrity,
           schema_version, claw_name, package_status, relationship, origin, independent_owner,
           installed_at_ms, updated_at_ms
         ) VALUES (
           @agent_id, @package_kind, @package_source, @package_ref, @package_version, @package_integrity,
           @schema_version, @claw_name, @package_status, @relationship, @origin,
           @independent_owner, @installed_at_ms, @updated_at_ms
         )`,
        )
        .run({
          agent_id: replacement.agentId,
          package_kind: replacement.kind,
          package_source: replacement.source,
          package_ref: replacement.ref,
          package_version: replacement.version,
          package_integrity: replacement.integrity,
          schema_version: replacement.schemaVersion,
          claw_name: replacement.clawName,
          package_status: replacement.status,
          relationship: replacement.relationship,
          origin: replacement.origin,
          independent_owner: replacement.independentOwner ? 1 : 0,
          installed_at_ms: replacement.installedAtMs,
          updated_at_ms: replacement.updatedAtMs,
        });
    }
  }, options);
}
