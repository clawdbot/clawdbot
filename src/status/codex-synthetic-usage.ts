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
}): boolean {
  const harness = normalizeOptionalLowercaseString(params.effectiveHarness);
  const provider = normalizeOptionalLowercaseString(params.provider);
  return (
    harness === CODEX_SYNTHETIC_USAGE_HOOK_PROVIDER &&
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

function billingEntryKey(entry: ProviderUsageBilling): string {
  const period = "period" in entry ? (entry.period ?? "") : "";
  return [entry.type, entry.label ?? "", entry.unit, period].join("\0");
}

function mergeBilling(
  preferred: ProviderUsageSnapshot,
  secondary: ProviderUsageSnapshot,
): ProviderUsageBilling[] | undefined {
  const entries = new Map<string, ProviderUsageBilling>();
  for (const entry of secondary.billing ?? []) {
    entries.set(billingEntryKey(entry), entry);
  }
  for (const entry of preferred.billing ?? []) {
    entries.set(billingEntryKey(entry), entry);
  }
  return entries.size > 0 ? [...entries.values()] : undefined;
}

function mergeUsageSnapshots(
  preferred: ProviderUsageSnapshot,
  secondary: ProviderUsageSnapshot,
): ProviderUsageSnapshot {
  const billing = mergeBilling(preferred, secondary);
  // Synthetic and OAuth sources can own different facts for the same provider.
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
    const providerRank = usageSnapshotRank(provider);
    const existingRank = usageSnapshotRank(existing);
    // Synthetic errors must not hide the concrete provider endpoint's error.
    // Synthetic data still wins equal displayable ranks so its live windows stay authoritative.
    const preferred =
      providerRank === 0 && existingRank === 0
        ? existing
        : providerRank >= existingRank
          ? provider
          : existing;
    const secondary = preferred === provider ? existing : provider;
    providersById.set(provider.provider, mergeUsageSnapshots(preferred, secondary));
  }
  return {
    updatedAt: base.updatedAt,
    providers: [...providersById.values()],
  };
}
