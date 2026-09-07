import fs from "node:fs";
import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../../config/env-vars.js";
import { createConfigIO } from "../../config/io.js";
import { resolveConfiguredAgentDatabaseCandidatePaths } from "../../config/sessions/targets.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  preflightOpenClawDatabaseSchemas,
  type IncompatibleOpenClawDatabase,
  type IndeterminateOpenClawDatabase,
  type OpenClawDatabaseSchemaPreflight,
} from "../../state/openclaw-database-preflight.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { UpdatePreMutationError } from "./shared.js";

type TargetDatabaseSchemaContext = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
};

export function formatSchemaRefusalLines(
  schemas: {
    incompatible: readonly IncompatibleOpenClawDatabase[];
    indeterminate: readonly IndeterminateOpenClawDatabase[];
  },
  dryRun = false,
): string[] {
  const prefix = dryRun ? "Would refuse update" : "Update refused";
  return [
    ...schemas.incompatible.map((database) => {
      const agent = database.agentId ? ` (agent ${database.agentId})` : "";
      return `${prefix}: ${database.kind} database${agent} ${database.path} has schema ${database.foundVersion}; target supports ${database.supportedVersion}; writer build ${database.writerAppVersion ?? "unknown"}.`;
    }),
    ...schemas.indeterminate.map(
      (database) =>
        `${prefix}: could not inspect ${database.kind} database ${database.path}: ${database.reason}; retry once the gateway releases it.`,
    ),
    OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
    "Installing manually via npm bypasses this guard; back up first and verify compatibility.",
  ];
}

async function checkTargetDatabaseSchemas(
  supportedVersions: OpenClawSchemaVersions,
  context: TargetDatabaseSchemaContext,
): Promise<OpenClawDatabaseSchemaPreflight> {
  let configuredAgentDatabaseCandidatePaths: string[];
  try {
    configuredAgentDatabaseCandidatePaths = resolveConfiguredAgentDatabaseCandidatePaths(
      context.config,
      { env: context.env },
    );
  } catch (error) {
    throw new UpdatePreMutationError(
      "database-schema-preflight",
      `Update refused: could not inspect configured database paths: ${formatErrorMessage(error)}`,
    );
  }
  return preflightOpenClawDatabaseSchemas({
    env: context.env,
    supportedVersions,
    // Include default on-disk stores that update-time Doctor can later touch,
    // without resolving configured candidates into writable migration owners.
    configuredAgentDatabaseTargets: [],
    // Inspection keeps registered paths without adopting their migration ownership.
    configuredAgentDatabaseCandidatePaths,
  });
}

export async function captureTargetDatabaseSchemaContext(env: NodeJS.ProcessEnv) {
  // Do not load plugins, recover config, record observations, or change the
  // caller's environment just to discover the stores selected by this config.
  const inspectionEnv = cloneEnvWithPlatformSemantics(env);
  const readEnv = cloneEnvWithPlatformSemantics(env);
  const snapshot = await createConfigIO({
    env: inspectionEnv,
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  if (!snapshot.valid || snapshot.readError) {
    throw new UpdatePreMutationError(
      "database-schema-preflight",
      `Update refused: could not inspect configured database paths from ${snapshot.path}. Correct the configuration before retrying.`,
    );
  }
  return {
    env: inspectionEnv,
    config: snapshot.sourceConfig ?? snapshot.config,
    configSnapshot: snapshot,
    readEnv,
  };
}

function canonicalDatabaseIdentity(database: { kind: "agent" | "state"; path: string }): string {
  let canonical: string;
  try {
    // Native traversal must see the original locator before any lexical
    // normalization: link/../file can name a different database from resolve().
    canonical = fs.realpathSync.native(database.path);
  } catch {
    canonical = path.resolve(database.path);
  }
  const comparable = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return `${database.kind}\0${comparable}`;
}

/** Inspect the union of caller/service stores without granting migration ownership. */
export async function checkTargetDatabaseSchemasForContexts(
  supportedVersions: OpenClawSchemaVersions | undefined,
  contexts: readonly TargetDatabaseSchemaContext[],
): Promise<OpenClawDatabaseSchemaPreflight> {
  if (!supportedVersions) {
    return { incompatible: [], indeterminate: [] };
  }
  const incompatible = new Map<string, IncompatibleOpenClawDatabase>();
  const indeterminate = new Map<string, IndeterminateOpenClawDatabase>();
  for (const context of contexts) {
    const result = await checkTargetDatabaseSchemas(supportedVersions, context);
    for (const database of result.incompatible) {
      const identity = canonicalDatabaseIdentity(database);
      incompatible.set(identity, incompatible.get(identity) ?? database);
      indeterminate.delete(identity);
    }
    for (const database of result.indeterminate) {
      const identity = canonicalDatabaseIdentity(database);
      if (!incompatible.has(identity) && !indeterminate.has(identity)) {
        indeterminate.set(identity, database);
      }
    }
  }
  return { incompatible: [...incompatible.values()], indeterminate: [...indeterminate.values()] };
}

export function hasSchemaRefusal(schemas: OpenClawDatabaseSchemaPreflight): boolean {
  return schemas.incompatible.length > 0 || schemas.indeterminate.length > 0;
}
