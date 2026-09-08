import type { DatabaseSync } from "node:sqlite";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { readStateSchemaContentVersion } from "./openclaw-state-schema-publication.js";

export function assertSupportedStateSchemaVersion(db: DatabaseSync, pathname: string): number {
  const userVersion = readSqliteUserVersion(db);
  const contentVersion =
    userVersion > OPENCLAW_STATE_SCHEMA_VERSION ? userVersion : readStateSchemaContentVersion(db);
  if (contentVersion > OPENCLAW_STATE_SCHEMA_VERSION) {
    throw createNewerSqliteSchemaVersionError(
      "OpenClaw state database",
      pathname,
      contentVersion,
      OPENCLAW_STATE_SCHEMA_VERSION,
    );
  }
  return userVersion;
}
