// Gateway config snapshot test helpers.
// Builds config snapshots for mocked config module state.
import crypto from "node:crypto";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";

function hashConfigRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

/** Builds a fully-populated config snapshot for config-module mocks. */
export function buildTestConfigSnapshot(params: {
  path: string;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  valid: boolean;
  config: OpenClawConfig;
  issues: ConfigFileSnapshot["issues"];
  warnings?: ConfigFileSnapshot["warnings"];
  legacyIssues: ConfigFileSnapshot["legacyIssues"];
}): ConfigFileSnapshot {
  return {
    path: params.path,
    exists: params.exists,
    raw: params.raw,
    parsed: params.parsed,
    sourceConfig: params.config,
    resolved: params.config,
    valid: params.valid,
    runtimeConfig: params.config,
    config: params.config,
    hash: hashConfigRaw(params.raw),
    issues: params.issues,
    warnings: params.warnings ?? [],
    legacyIssues: params.legacyIssues,
  };
}
