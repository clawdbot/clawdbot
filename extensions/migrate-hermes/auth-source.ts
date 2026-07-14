// Hermes-native auth discovery and reauthentication planning.
import { createMigrationManualItem } from "openclaw/plugin-sdk/migration";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord, readString, readText } from "./helpers.js";
import type { HermesSource } from "./source.js";

const HERMES_OPENAI_CODEX_SOURCE_PROVIDER_ID = "openai-codex";

export type HermesCodexAuthCandidate = {
  access: string;
  accountId?: string;
  refresh: string;
  sourceKind: "hermes-auth-json" | "opencode-auth-json";
  sourceSlot: "provider" | "pool" | "opencode";
  sourceCredentialIndex?: number;
  sourceLabel: string;
  sourcePath: string;
  updatedAt?: number;
};

const HERMES_REAUTH_PROVIDER_MAPPINGS = [
  { sourceProvider: "anthropic", targetProvider: "anthropic" },
  { sourceProvider: "nous", targetProvider: "nous" },
  { sourceProvider: "qwen-oauth", targetProvider: "qwen-oauth" },
  { sourceProvider: "minimax-oauth", targetProvider: "minimax-portal" },
  { sourceProvider: "xai-oauth", targetProvider: "xai" },
] as const;
const HERMES_REAUTH_SOURCE_PROVIDERS = new Set<string>(
  HERMES_REAUTH_PROVIDER_MAPPINGS.map((entry) => entry.sourceProvider),
);

function readTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readHermesProviderCandidate(
  auth: Record<string, unknown>,
  sourcePath: string,
): HermesCodexAuthCandidate | undefined {
  const providers = isRecord(auth.providers) ? auth.providers : {};
  const provider = isRecord(providers[HERMES_OPENAI_CODEX_SOURCE_PROVIDER_ID])
    ? providers[HERMES_OPENAI_CODEX_SOURCE_PROVIDER_ID]
    : undefined;
  const tokens = isRecord(provider?.tokens) ? provider.tokens : undefined;
  const access = readString(tokens?.access_token);
  const refresh = readString(tokens?.refresh_token);
  if (!access || !refresh) {
    return undefined;
  }
  return {
    access,
    refresh,
    sourceKind: "hermes-auth-json",
    sourceSlot: "provider",
    sourceLabel: "Hermes active OpenAI Codex provider",
    sourcePath,
    updatedAt: readTimestamp(provider?.last_refresh),
  };
}

function readHermesPoolCandidates(
  auth: Record<string, unknown>,
  sourcePath: string,
): HermesCodexAuthCandidate[] {
  const pool = isRecord(auth.credential_pool) ? auth.credential_pool : {};
  const entries = Array.isArray(pool[HERMES_OPENAI_CODEX_SOURCE_PROVIDER_ID])
    ? pool[HERMES_OPENAI_CODEX_SOURCE_PROVIDER_ID]
    : [];
  return entries.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const access = readString(entry.access_token);
    const refresh = readString(entry.refresh_token);
    if (!access || !refresh) {
      return [];
    }
    return [
      {
        access,
        refresh,
        sourceKind: "hermes-auth-json" as const,
        sourceSlot: "pool" as const,
        sourceLabel: readString(entry.label) ?? "Hermes OpenAI Codex credential pool",
        sourcePath,
        updatedAt: readTimestamp(entry.last_refresh) ?? readTimestamp(entry.last_status_at),
      },
    ];
  });
}

export async function readHermesCodexAuthCandidates(
  authPath: string | undefined,
): Promise<HermesCodexAuthCandidate[]> {
  const raw = await readText(authPath);
  if (!raw || !authPath) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) {
    return [];
  }
  const candidates = [
    readHermesProviderCandidate(parsed, authPath),
    ...readHermesPoolCandidates(parsed, authPath),
  ]
    .filter((candidate): candidate is HermesCodexAuthCandidate => candidate !== undefined)
    .toSorted((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  candidates.forEach((candidate, index) => {
    candidate.sourceCredentialIndex = index;
  });
  return candidates;
}

async function readHermesOAuthProviderIds(authPath: string | undefined): Promise<Set<string>> {
  const raw = await readText(authPath);
  if (!raw) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return new Set();
    }
    const providers = isRecord(parsed.providers)
      ? Object.keys(parsed.providers).filter((provider) =>
          HERMES_REAUTH_SOURCE_PROVIDERS.has(provider),
        )
      : [];
    const pool = isRecord(parsed.credential_pool)
      ? Object.entries(parsed.credential_pool).flatMap(([provider, entries]) =>
          Array.isArray(entries) &&
          entries.some(
            (entry) => isRecord(entry) && readString(entry.auth_type)?.toLowerCase() === "oauth",
          )
            ? [provider]
            : [],
        )
      : [];
    return new Set([...providers, ...pool]);
  } catch {
    return new Set();
  }
}

export async function buildReauthenticationItems(source: HermesSource): Promise<MigrationItem[]> {
  const profileProviders = await readHermesOAuthProviderIds(source.authPath);
  const globalProviders = await readHermesOAuthProviderIds(source.globalAuthPath);
  return HERMES_REAUTH_PROVIDER_MAPPINGS.flatMap(({ sourceProvider, targetProvider }) => {
    const sourcePath = profileProviders.has(sourceProvider)
      ? source.authPath
      : globalProviders.has(sourceProvider)
        ? source.globalAuthPath
        : undefined;
    if (!sourcePath) {
      return [];
    }
    return [
      createMigrationManualItem({
        id: `manual:auth-reauthenticate:${targetProvider}`,
        source: sourcePath,
        message: `Hermes ${sourceProvider} credentials cannot be reused safely by OpenClaw.`,
        recommendation: `Authenticate ${targetProvider} in OpenClaw after migration.`,
      }),
    ];
  });
}
