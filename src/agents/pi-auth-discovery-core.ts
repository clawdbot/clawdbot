import fs from "node:fs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";
import {
  listProviderEnvAuthLookupKeys,
  resolveProviderEnvApiKeyCandidates,
  resolveProviderEnvAuthEvidence,
} from "./model-auth-env-vars.js";
import { resolveEnvApiKey } from "./model-auth-env.js";
import type { PiCredentialMap } from "./pi-auth-credentials.js";

export type PiDiscoveryAuthLookupOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

export function addEnvBackedPiCredentials(
  credentials: PiCredentialMap,
  options: PiDiscoveryAuthLookupOptions = {},
): PiCredentialMap {
  const env = options.env ?? process.env;
  const lookupParams = {
    config: options.config,
    workspaceDir: options.workspaceDir,
    env,
  };
  const candidateMap = resolveProviderEnvApiKeyCandidates(lookupParams);
  const authEvidenceMap = resolveProviderEnvAuthEvidence(lookupParams);
  const next = { ...credentials };
  // pi-coding-agent hides providers from its registry when auth storage lacks
  // a matching credential entry. Mirror env-backed provider auth here so
  // live/model discovery sees the same providers runtime auth can use.
  for (const provider of listProviderEnvAuthLookupKeys({
    envCandidateMap: candidateMap,
    authEvidenceMap,
  })) {
    if (next[provider]) {
      continue;
    }
    const resolved = resolveEnvApiKey(provider, env, {
      config: options.config,
      workspaceDir: options.workspaceDir,
      candidateMap,
      authEvidenceMap,
    });
    if (!resolved?.apiKey) {
      continue;
    }
    next[provider] = {
      type: "api_key",
      key: resolved.apiKey,
    };
  }
  return next;
}

export function scrubLegacyStaticAuthJsonEntriesForDiscovery(pathname: string): void {
  if (process.env.OPENCLAW_AUTH_STORE_READONLY === "1") {
    return;
  }
  if (!fs.existsSync(pathname)) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(pathname, "utf8")) as unknown;
  } catch {
    return;
  }
  if (!isRecord(parsed)) {
    return;
  }

  let changed = false;
  for (const [provider, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      continue;
    }
    if (value.type !== "api_key") {
      continue;
    }
    delete parsed[provider];
    changed = true;
  }

  if (!changed) {
    return;
  }

  if (Object.keys(parsed).length === 0) {
    fs.rmSync(pathname, { force: true });
    return;
  }

  fs.writeFileSync(pathname, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  fs.chmodSync(pathname, 0o600);
}
