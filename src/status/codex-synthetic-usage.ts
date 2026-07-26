import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { CODEX_APP_SERVER_AUTH_MARKER } from "../agents/model-auth-markers.js";
import type { ProviderAuth } from "../infra/provider-usage.auth.js";
import type {
  ProviderUsageBilling,
  ProviderUsageSnapshot,
  UsageSummary,
} from "../infra/provider-usage.types.js";

const CODEX_SYNTHETIC_USAGE_PROVIDER = "openai";
const CODEX_SYNTHETIC_USAGE_HOOK_PROVIDER = "codex";

/** Maps a provider auth label onto the usage credential type buckets. */
export function resolveUsageCredentialType(
  authLabel?: string,
): "oauth" | "token" | "api_key" | undefined {
  const auth = normalizeOptionalLowercaseString(authLabel);
  if (!auth) {
    return undefined;
  }
  if (auth.startsWith("oauth")) {
    return "oauth";
  }
  if (auth.startsWith("token")) {
    return "token";
  }
  if (auth.startsWith("api-key") || auth.startsWith("api key")) {
    return "api_key";
  }
  return undefined;
}

export function buildCodexSyntheticUsageAuth(
  params: {
    authProfileId?: string;
  } = {},
): ProviderAuth {
  return {
    provider: CODEX_SYNTHETIC_USAGE_PROVIDER,
    token: CODEX_APP_SERVER_AUTH_MARKER,
    ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
    hookProvider: CODEX_SYNTHETIC_USAGE_HOOK_PROVIDER,
  };
}

export function shouldUseCodexSyntheticUsageForRuntime(params: {
  provider?: string;
  effectiveHarness?: string;
  sessionHarnessId?: string;
}): boolean {
  const harness = normalizeOptionalLowercaseString(params.effectiveHarness);
  const sessionHarness = normalizeOptionalLowercaseString(params.sessionHarnessId);
  const provider = normalizeOptionalLowercaseString(params.provider);
  return (
    (harness === CODEX_SYNTHETIC_USAGE_HOOK_PROVIDER ||
      sessionHarness === CODEX_SYNTHETIC_USAGE_HOOK_PROVIDER) &&
    (provider === CODEX_SYNTHETIC_USAGE_PROVIDER || provider === "codex")
  );
}

function hasDisplayableUsageSnapshot(snapshot: ProviderUsageSnapshot): boolean {
  return (
    snapshot.windows.length > 0 ||
    Boolean(snapshot.billing?.length) ||
    Boolean(snapshot.summary?.trim())
  );
}

function usageSnapshotRank(snapshot: ProviderUsageSnapshot): number {
  if (hasDisplayableUsageSnapshot(snapshot)) {
    return 2;
  }
  return snapshot.error ? 0 : 1;
}

type Precedence<T> = [preferred: T, secondary: T];
function byPrecedence<T>(candidate: T, existing: T, rank: (value: T) => number): Precedence<T> {
  const candidateRank = rank(candidate);
  const existingRank = rank(existing);
  return candidateRank >= existingRank && !(candidateRank === 0 && existingRank === 0)
    ? [candidate, existing]
    : [existing, candidate];
}

function billingEntryKey(entry: ProviderUsageBilling): string {
  const period = "period" in entry ? (entry.period ?? "") : "";
  return [entry.type, entry.label ?? "", entry.unit, period].join("\0");
}

function mergeBilling([preferred, secondary]: Precedence<ProviderUsageSnapshot>):
  | ProviderUsageBilling[]
  | undefined {
  const entries = new Map<string, ProviderUsageBilling>();
  for (const entry of secondary.billing ?? []) {
    entries.set(billingEntryKey(entry), entry);
  }
  for (const entry of preferred.billing ?? []) {
    entries.set(billingEntryKey(entry), entry);
  }
  return entries.size > 0 ? [...entries.values()] : undefined;
}

function mergeUsageSnapshots(precedence: Precedence<ProviderUsageSnapshot>): ProviderUsageSnapshot {
  const [preferred, secondary] = precedence;
  const billing = mergeBilling(precedence);
  // Preserve complementary plan/billing data while the preferred source owns windows/errors.
  return {
    ...secondary,
    ...preferred,
    windows: preferred.windows.length > 0 ? preferred.windows : secondary.windows,
    ...(billing ? { billing } : {}),
    ...(preferred.summary?.trim()
      ? { summary: preferred.summary }
      : secondary.summary?.trim()
        ? { summary: secondary.summary }
        : {}),
    ...(preferred.plan?.trim()
      ? { plan: preferred.plan }
      : secondary.plan?.trim()
        ? { plan: secondary.plan }
        : {}),
    ...(!preferred.error ? { error: undefined } : {}),
  };
}

export function mergeUsageSummaries(
  base: UsageSummary,
  extra: UsageSummary | undefined,
): UsageSummary {
  if (!extra || extra.providers.length === 0) {
    return base;
  }
  const providersById = new Map(base.providers.map((provider) => [provider.provider, provider]));
  for (const provider of extra.providers) {
    const existing = providersById.get(provider.provider);
    if (!existing) {
      providersById.set(provider.provider, provider);
      continue;
    }
    // Preserve concrete endpoint errors; synthetic data wins equal displayable ranks.
    providersById.set(
      provider.provider,
      mergeUsageSnapshots(byPrecedence(provider, existing, usageSnapshotRank)),
    );
  }
  return {
    updatedAt: base.updatedAt,
    providers: [...providersById.values()],
  };
}
