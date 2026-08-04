/** Resolves cheap, secret-free local credential evidence declared by provider manifests. */
import fs from "node:fs";
import os from "node:os";
import { normalizeOptionalString as normalizeOptionalPathInput } from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";

type LocalProviderAuthEvidence = {
  type: "local-file-with-env";
  fileEnvVar?: string;
  fallbackPaths?: readonly string[];
  requiresAnyEnv?: readonly string[];
  requiresAllEnv?: readonly string[];
  credentialMarker: string;
  source?: string;
};

type ResolvedLocalProviderAuthEvidence = {
  credentialMarker: string;
  source: string;
};

function expandAuthEvidencePath(
  rawPath: string,
  env: NodeJS.ProcessEnv,
): { path: string; explicitOverride: boolean } | undefined {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return undefined;
  }
  let unresolvedPlaceholder = false;
  let explicitOverride = false;
  const expanded = trimmed.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, name: string) => {
    const value =
      name === "HOME"
        ? (normalizeOptionalPathInput(env.HOME) ?? os.homedir())
        : normalizeOptionalPathInput(env[name]);
    if (!value) {
      unresolvedPlaceholder = true;
      return "";
    }
    if (name !== "HOME" && name !== "APPDATA") {
      explicitOverride = true;
    }
    return value;
  });
  return unresolvedPlaceholder || expanded.includes("${")
    ? undefined
    : { path: expanded, explicitOverride };
}

function hasRequiredAuthEvidenceEnv(
  evidence: LocalProviderAuthEvidence,
  env: NodeJS.ProcessEnv,
): boolean {
  const hasEnv = (key: string) => Boolean(normalizeOptionalSecretInput(env[key]));
  if (evidence.requiresAnyEnv?.length && !evidence.requiresAnyEnv.some(hasEnv)) {
    return false;
  }
  if (evidence.requiresAllEnv?.length && !evidence.requiresAllEnv.every(hasEnv)) {
    return false;
  }
  return true;
}

function hasLocalFileAuthEvidence(
  evidence: LocalProviderAuthEvidence,
  env: NodeJS.ProcessEnv,
): boolean {
  if (evidence.fileEnvVar) {
    const explicitPath = normalizeOptionalPathInput(env[evidence.fileEnvVar]);
    if (explicitPath) {
      return fs.existsSync(explicitPath);
    }
  }
  for (const rawPath of evidence.fallbackPaths ?? []) {
    const expandedPath = expandAuthEvidencePath(rawPath, env);
    if (!expandedPath) {
      continue;
    }
    if (fs.existsSync(expandedPath.path)) {
      return true;
    }
    // An explicit provider directory owns identity; never select stale platform credentials.
    if (expandedPath.explicitOverride) {
      return false;
    }
  }
  return false;
}

export function resolveLocalProviderAuthEvidence(
  evidenceEntries: readonly LocalProviderAuthEvidence[] | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedLocalProviderAuthEvidence | null {
  for (const evidence of evidenceEntries ?? []) {
    if (
      evidence.type !== "local-file-with-env" ||
      !hasRequiredAuthEvidenceEnv(evidence, env) ||
      !hasLocalFileAuthEvidence(evidence, env)
    ) {
      continue;
    }
    return {
      credentialMarker: evidence.credentialMarker,
      source: evidence.source ?? "local auth evidence",
    };
  }
  return null;
}
