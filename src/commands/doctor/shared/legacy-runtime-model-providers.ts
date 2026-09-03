// Legacy model-provider aliases that encoded runtime/backend selection in model refs.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStaticProviderModelId } from "../../../agents/model-ref-shared.js";
import { PROVIDER_AUTH_ALIAS_MAP } from "../../../agents/provider-auth-aliases.js";

type RetiredProviderId = keyof typeof PROVIDER_AUTH_ALIAS_MAP;

type LegacyRuntimeModelProviderAlias = {
  /** Legacy provider id that encoded the runtime in the model ref. */
  legacyProvider: RetiredProviderId;
  /** Canonical provider id that should own model selection. */
  provider: string;
  /** Runtime/backend id selected for the migrated ref. */
  runtime: string;
  /** True when the runtime is a CLI backend rather than an embedded harness. */
  cli: boolean;
};

// Runtime facts for the retired provider ids that also encoded a backend choice.
// `PROVIDER_AUTH_ALIAS_MAP` owns which ids are retired and what they migrate to;
// `openai-codex` is missing here because its model refs belong to the codex route repair.
const LEGACY_RUNTIME_MODEL_PROVIDER_RUNTIMES = [
  { legacyProvider: "codex", runtime: "codex", cli: false },
  { legacyProvider: "codex-cli", runtime: "codex", cli: false },
  { legacyProvider: "claude-cli", runtime: "claude-cli", cli: true },
  { legacyProvider: "google-gemini-cli", runtime: "google-gemini-cli", cli: true },
] as const satisfies readonly Omit<LegacyRuntimeModelProviderAlias, "provider">[];

const LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES: readonly LegacyRuntimeModelProviderAlias[] =
  LEGACY_RUNTIME_MODEL_PROVIDER_RUNTIMES.map((entry) => ({
    ...entry,
    provider: PROVIDER_AUTH_ALIAS_MAP[entry.legacyProvider],
  }));

function normalizeLegacyRuntimeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return normalized === "anthropic-cli" ? "claude-cli" : normalizeProviderId(normalized);
}

const LEGACY_ALIAS_BY_PROVIDER = new Map(
  LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.map((entry) => [
    normalizeLegacyRuntimeProviderId(entry.legacyProvider),
    entry,
  ]),
);

// A stored row under one of these ids may still hold the runtime inside its model
// ref: the CLI legacy ids plus the canonical providers they migrate to. Canonical
// "openai" stays out on purpose - its rows keep raw model ids that may legitimately
// read as "codex/<model>".
const CLI_RUNTIME_SCOPED_MODEL_PROVIDER_IDS = new Set(
  LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.flatMap((entry) =>
    entry.cli ? [normalizeLegacyRuntimeProviderId(entry.legacyProvider), entry.provider] : [],
  ),
);

/** Resolve the provider/runtime pair a retired whole-agent CLI runtime id migrates to. */
export function resolveLegacyCliRuntimeAlias(
  runtimeId: unknown,
): { provider: string; runtime: string } | undefined {
  const runtime = normalizeOptionalLowercaseString(runtimeId);
  if (!runtime || runtime === "auto" || runtime === "openclaw") {
    return undefined;
  }
  const alias = LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.find(
    (entry) => entry.cli && normalizeProviderId(entry.runtime) === runtime,
  );
  return alias ? { provider: alias.provider, runtime: alias.runtime } : undefined;
}

/** True when a provider id may still carry its CLI runtime inside the model ref. */
export function isCliRuntimeScopedModelProvider(provider: string): boolean {
  return CLI_RUNTIME_SCOPED_MODEL_PROVIDER_IDS.has(normalizeLegacyRuntimeProviderId(provider));
}

function resolveLegacyRuntimeModelProviderAlias(
  provider: string,
): LegacyRuntimeModelProviderAlias | undefined {
  return LEGACY_ALIAS_BY_PROVIDER.get(normalizeLegacyRuntimeProviderId(provider));
}

/** Rewrite a legacy runtime-encoded model ref to canonical provider/model plus runtime intent. */
export function migrateLegacyRuntimeModelRef(raw: string): {
  ref: string;
  legacyProvider: string;
  provider: string;
  model: string;
  runtime: string;
  cli: boolean;
} | null {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return null;
  }
  const alias = resolveLegacyRuntimeModelProviderAlias(trimmed.slice(0, slash));
  if (!alias) {
    return null;
  }
  const rawModel = trimmed.slice(slash + 1).trim();
  const model = normalizeStaticProviderModelId(alias.provider, rawModel);
  if (!model) {
    return null;
  }
  return {
    ref: `${alias.provider}/${model}`,
    legacyProvider: alias.legacyProvider,
    provider: alias.provider,
    model,
    runtime: alias.runtime,
    cli: alias.cli,
  };
}
