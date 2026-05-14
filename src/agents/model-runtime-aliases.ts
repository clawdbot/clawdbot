import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeStaticProviderModelId } from "./model-ref-shared.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";
import { normalizeProviderId } from "./provider-id.js";

type LegacyRuntimeModelProviderAlias = {
  /** Legacy provider id that encoded the runtime in the model ref. */
  legacyProvider: string;
  /** Canonical provider id that should own model selection. */
  provider: string;
  /** Runtime/backend id that preserves the old execution behavior. */
  runtime: string;
  /** True when the runtime is a CLI backend rather than an embedded harness. */
  cli: boolean;
};

const LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES = [
  { legacyProvider: "codex", provider: "openai", runtime: "codex", cli: false },
  { legacyProvider: "codex-cli", provider: "openai", runtime: "codex-cli", cli: true },
  { legacyProvider: "claude-cli", provider: "anthropic", runtime: "claude-cli", cli: true },
  {
    legacyProvider: "google-gemini-cli",
    provider: "google",
    runtime: "google-gemini-cli",
    cli: true,
  },
] as const satisfies readonly LegacyRuntimeModelProviderAlias[];

const LEGACY_ALIAS_BY_PROVIDER = new Map(
  LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.map((entry) => [
    normalizeProviderId(entry.legacyProvider),
    entry,
  ]),
);

const CLI_RUNTIME_BY_PROVIDER = new Map(
  LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.filter((entry) => entry.cli).map((entry) => [
    `${normalizeProviderId(entry.provider)}:${normalizeProviderId(entry.runtime)}`,
    entry,
  ]),
);

const CLI_RUNTIME_ALIASES = new Set(
  LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.filter((entry) => entry.cli).map((entry) =>
    normalizeProviderId(entry.runtime),
  ),
);

const CLI_RUNTIME_PROVIDER_IDS = new Set(
  LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.filter((entry) => entry.cli).map((entry) =>
    normalizeProviderId(entry.legacyProvider),
  ),
);

export function listLegacyRuntimeModelProviderAliases(): readonly LegacyRuntimeModelProviderAlias[] {
  return LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES;
}

/** True for CLI runtime provider ids such as `claude-cli` and `codex-cli`. */
export function isCliRuntimeProvider(provider: string): boolean {
  return CLI_RUNTIME_PROVIDER_IDS.has(normalizeProviderId(provider));
}

function resolveLegacyRuntimeModelProviderAlias(
  provider: string,
): LegacyRuntimeModelProviderAlias | undefined {
  return LEGACY_ALIAS_BY_PROVIDER.get(normalizeProviderId(provider));
}

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

/** Shared setup/default pickers hide all legacy runtime provider ids. */
export function isLegacyRuntimeModelProvider(provider: string): boolean {
  return resolveLegacyRuntimeModelProviderAlias(provider) !== undefined;
}

export function isCliRuntimeAlias(runtime: string | undefined): boolean {
  const normalized = runtime?.trim();
  return normalized ? CLI_RUNTIME_ALIASES.has(normalizeProviderId(normalized)) : false;
}

function canonicalizeRuntimeAliasProvider(provider: string): string {
  return resolveLegacyRuntimeModelProviderAlias(provider)?.provider ?? provider;
}

function normalizeRuntimeModelRefForComparison(raw: string): string {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return normalizeProviderId(canonicalizeRuntimeAliasProvider(trimmed));
  }
  const provider = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  const canonicalProvider = normalizeProviderId(canonicalizeRuntimeAliasProvider(provider));
  return model ? `${canonicalProvider}/${model}` : canonicalProvider;
}

export function areRuntimeModelRefsEquivalent(left: string, right: string): boolean {
  return (
    normalizeRuntimeModelRefForComparison(left) === normalizeRuntimeModelRefForComparison(right)
  );
}

function resolveConfiguredRuntime(params: {
  cfg?: OpenClawConfig;
  provider: string;
  agentId?: string;
  modelId?: string;
}): string | undefined {
  return resolveModelRuntimePolicy({
    config: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
  }).policy?.id?.trim();
}

export function resolveCliRuntimeExecutionProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentId?: string;
  modelId?: string;
}): string | undefined {
  const provider = normalizeProviderId(params.provider);
  const runtime = resolveConfiguredRuntime({ ...params, provider });
  if (!runtime || runtime === "auto" || runtime === "pi") {
    return undefined;
  }
  return CLI_RUNTIME_BY_PROVIDER.get(`${provider}:${runtime}`)?.runtime;
}
