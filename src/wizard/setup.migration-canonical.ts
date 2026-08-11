import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export function canonicalizeSetupMigrationValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeSetupMigrationValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .toSorted()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalizeSetupMigrationValue(record[key])]),
  );
}

export function hashSetupMigrationConfig(config: OpenClawConfig): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalizeSetupMigrationValue(config)))
    .digest("hex");
}
