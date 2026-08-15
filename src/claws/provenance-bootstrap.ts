import type { DatabaseSync } from "node:sqlite";
import { tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";

export function selectClawBootstrapProvenanceColumns(db: DatabaseSync): string {
  const sourcePath = tableHasColumn(db, "claw_installs", "bootstrap_source_path")
    ? "bootstrap_source_path"
    : "NULL AS bootstrap_source_path";
  const contentDigest = tableHasColumn(db, "claw_installs", "bootstrap_content_digest")
    ? "bootstrap_content_digest"
    : "NULL AS bootstrap_content_digest";
  return `${sourcePath}, ${contentDigest}`;
}

export function clawBootstrapProvenanceFromRow(row: {
  bootstrap_source_path: string | null;
  bootstrap_content_digest: string | null;
}) {
  return row.bootstrap_source_path && row.bootstrap_content_digest
    ? {
        bootstrap: {
          sourcePath: row.bootstrap_source_path,
          contentDigest: row.bootstrap_content_digest,
        },
      }
    : {};
}
