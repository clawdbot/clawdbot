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

function expandAuthEvidencePath(rawPath: string, env: NodeJS.ProcessEnv): string | undefined {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return undefined;
  }
  const homeDir = normalizeOptionalPathInput(env.HOME) ?? os.homedir();
  const appDataDir = normalizeOptionalPathInput(env.APPDATA);
  if (trimmed.includes("${APPDATA}") && !appDataDir) {
    return undefined;
  }
  return trimmed.replaceAll("${HOME}", homeDir).replaceAll("${APPDATA}", appDataDir ?? "");
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
    if (expandedPath && fs.existsSync(expandedPath)) {
      return true;
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
