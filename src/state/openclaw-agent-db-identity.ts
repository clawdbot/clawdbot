import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type AgentDatabaseOwner = { db: DatabaseSync };
export type OpenClawAgentDatabaseIdentity = string | symbol;

const identities = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseIdentities"),
  () => new WeakMap<DatabaseSync, { identity: OpenClawAgentDatabaseIdentity; filename: string }>(),
);

/** Prepare physical identity once at open; cached aliases must never be resolved again. */
export function registerOpenClawAgentDatabaseIdentity(db: DatabaseSync): void {
  // sqlite-allow-raw: PRAGMA exposes the connection's actual main filename on Node 22.
  const main = db
    .prepare("PRAGMA database_list")
    .all()
    .find((row) => row.name === "main");
  if (typeof main?.file !== "string") {
    throw new Error("OpenClaw agent database has no main connection filename");
  }
  const file = main.file ? statSync(main.file, { bigint: true }) : undefined;
  const identity = file ? `${file.dev}:${file.ino}` : Symbol("incognito-agent-database");
  identities.set(db, { identity, filename: main.file });
}

function getPreparedIdentity(database: AgentDatabaseOwner) {
  const prepared = identities.get(database.db);
  if (prepared === undefined) {
    throw new Error("OpenClaw agent database identity was not prepared at open");
  }
  return prepared;
}

/** Worker handoffs use the opened filename, never a newly resolved alias. */
export function getOpenClawAgentDatabaseFilename(database: AgentDatabaseOwner): string {
  return getPreparedIdentity(database).filename;
}

export type OpenClawAgentDatabaseClaim = {
  database: AgentDatabaseOwner & { agentId: string; path: string };
  identity: OpenClawAgentDatabaseIdentity;
  isCurrent: () => boolean;
  assertCurrent: () => void;
  release: () => void;
};

export function createOpenClawAgentDatabaseClaim(
  database: OpenClawAgentDatabaseClaim["database"],
  release: () => void,
): OpenClawAgentDatabaseClaim {
  let released = false;
  const isCurrent = () => !released && database.db.isOpen;
  return {
    database,
    identity: getPreparedIdentity(database).identity,
    isCurrent,
    assertCurrent: () => {
      if (!isCurrent()) {
        throw new Error("OpenClaw agent database claim is no longer current");
      }
    },
    release: () => {
      if (!released) {
        released = true;
        release();
      }
    },
  };
}
