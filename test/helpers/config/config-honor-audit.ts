import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeBaseConfigSchemaResponse } from "../../../src/config/schema-base.js";

export type ConfigHonorInventoryRow = {
  key: string;
  schemaPaths: string[];
  typePaths: string[];
  mergePaths: string[];
  consumerPaths: string[];
  reloadPaths: string[];
  testPaths: string[];
  notes?: string[];
};

type ConfigHonorProofKey =
  | "schemaPaths"
  | "typePaths"
  | "mergePaths"
  | "consumerPaths"
  | "reloadPaths"
  | "testPaths";

export type ConfigHonorAuditResult = {
  schemaKeys: string[];
  missingKeys: string[];
  extraKeys: string[];
  missingSchemaPaths: string[];
  missingFiles: string[];
  missingProofs: Array<{
    key: string;
    missing: ConfigHonorProofKey[];
  }>;
};

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BASE_CONFIG_SCHEMA = computeBaseConfigSchemaResponse({
  generatedAt: "2026-05-05T00:00:00.000Z",
});

function hasSchemaPath(schemaPath: string): boolean {
  const segments = schemaPath.split(".");
  let current: unknown = BASE_CONFIG_SCHEMA.schema;
  for (const segment of segments) {
    if (!current || typeof current !== "object") {
      return false;
    }
    if (segment === "*") {
      const items = (current as { items?: unknown }).items;
      if (!items || typeof items !== "object") {
        return false;
      }
      current = items;
      continue;
    }
    const properties = (current as { properties?: Record<string, unknown> }).properties;
    if (!properties || !Object.hasOwn(properties, segment)) {
      return false;
    }
    current = properties[segment];
  }
  return true;
}

export function listSchemaLeafKeysForPrefixes(prefixes: string[]): string[] {
  const keys = new Set<string>();
  for (const prefix of prefixes) {
    const segments = prefix.split(".");
    let current: unknown = BASE_CONFIG_SCHEMA.schema;
    for (const segment of segments) {
      if (!current || typeof current !== "object") {
        current = null;
        break;
      }
      if (segment === "*") {
        current = (current as { items?: unknown }).items ?? null;
        continue;
      }
      current = (current as { properties?: Record<string, unknown> }).properties?.[segment] ?? null;
    }
    const properties = (current as { properties?: Record<string, unknown> } | null)?.properties;
    if (!properties) {
      continue;
    }
    for (const key of Object.keys(properties)) {
      keys.add(key);
    }
  }
  return [...keys].toSorted();
}

export function auditConfigHonorInventory(params: {
  prefixes: string[];
  rows: ConfigHonorInventoryRow[];
  expectedKeys?: string[];
  repoRoot?: string;
}): ConfigHonorAuditResult {
  const repoRoot = params.repoRoot ?? REPO_ROOT;
  const schemaKeys = listSchemaLeafKeysForPrefixes(params.prefixes);
  const expectedKeys = new Set(params.expectedKeys ?? schemaKeys);
  const rowKeys = new Set(params.rows.map((row) => row.key));
  const missingKeys = [...expectedKeys].filter((key) => !rowKeys.has(key)).toSorted();
  const extraKeys = params.rows
    .map((row) => row.key)
    .filter((key) => !expectedKeys.has(key))
    .toSorted();

  const missingSchemaPaths = params.rows.flatMap((row) =>
    row.schemaPaths.filter((schemaPath) => !hasSchemaPath(schemaPath)),
  );

  const missingFiles = params.rows.flatMap((row) => {
    const files = [...row.typePaths, ...row.mergePaths, ...row.consumerPaths, ...row.testPaths];
    return files
      .filter((relativePath) => !fs.existsSync(path.join(repoRoot, relativePath)))
      .map((relativePath) => `${row.key}:${relativePath}`);
  });

  const missingProofs = params.rows
    .map((row) => {
      const missing: ConfigHonorProofKey[] = [
        row.schemaPaths.length === 0 ? "schemaPaths" : null,
        row.typePaths.length === 0 ? "typePaths" : null,
        row.mergePaths.length === 0 ? "mergePaths" : null,
        row.consumerPaths.length === 0 ? "consumerPaths" : null,
        row.reloadPaths.length === 0 ? "reloadPaths" : null,
        row.testPaths.length === 0 ? "testPaths" : null,
      ].filter((value): value is ConfigHonorProofKey => value !== null);
      return missing.length > 0 ? { key: row.key, missing } : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  return {
    schemaKeys,
    missingKeys,
    extraKeys,
    missingSchemaPaths,
    missingFiles,
    missingProofs,
  };
}
