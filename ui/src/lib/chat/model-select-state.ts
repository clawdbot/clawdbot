// Chat model select state derivation.
import type {
  FastMode,
  GatewaySessionRow,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { areUiSessionKeysEquivalent } from "../sessions/session-key.ts";
import {
  buildCatalogDisplayLookup,
  buildChatModelOptionFromLookup,
  buildQualifiedChatModelValue,
  formatCatalogChatModelDisplayFromLookup,
  normalizeChatModelProviderId,
  normalizeChatModelOverrideValue,
  resolvePreferredServerChatModelValue,
} from "./model-ref.ts";

type ChatModelSelectStateInput = {
  agentDefaultModel?: string;
  chatModelCatalog: ModelCatalogEntry[];
  modelOverrides: Readonly<Record<string, string | null | undefined>>;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
};

type ChatModelSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type ChatModelSelectState = {
  currentOverride: string;
  defaultModel: string;
  defaultLabel: string;
  modelOverrideSource: GatewaySessionRow["modelOverrideSource"];
  options: ChatModelSelectOption[];
};

export type ChatFastModeSelectValue = "" | "on" | "off" | "auto";

export type ChatFastModeSelectState = {
  /** Fast output is effectively enabled (explicitly or via auto/inherited default). */
  active: boolean;
  currentOverride: ChatFastModeSelectValue;
  disabled: boolean;
  /** Short state word shown inside the speed toggle. */
  label: string;
  /** Value the toggle commits when clicked. */
  nextValue: ChatFastModeSelectValue;
  supported: boolean;
};

type ChatFastModeSelectStateInput = {
  activeRunId: string | null;
  catalog: ModelCatalogEntry[];
  connected: boolean;
  currentModelOverride: string;
  gatewayAvailable: boolean;
  loading: boolean;
  sending: boolean;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
  stream: string | null;
};

// Providers with a runtime fast-mode mapping: Anthropic sets speed (or legacy
// service_tier), OpenAI sets service_tier priority, MiniMax/xAI select fast variants.
// Providers without a wire mapping must not offer the toggle.
const FAST_MODE_PROVIDER_IDS = new Set(["anthropic", "minimax", "minimax-portal", "openai", "xai"]);

function resolveActiveSessionRow(state: ChatModelSelectStateInput) {
  return state.sessionsResult?.sessions?.find((row) =>
    areUiSessionKeysEquivalent(row.key, state.sessionKey),
  );
}

function resolveModelOverrideSource(state: ChatModelSelectStateInput) {
  // A local selection is newer than the row that still reports the previous
  // provenance, so it owns the answer until the refreshed row lands.
  if (Object.hasOwn(state.modelOverrides, state.sessionKey)) {
    return state.modelOverrides[state.sessionKey] == null ? null : "user";
  }
  return resolveActiveSessionRow(state)?.modelOverrideSource;
}

export function resolveChatModelOverrideValue(state: ChatModelSelectStateInput): string {
  const catalog = state.chatModelCatalog ?? [];

  const sharedOverrides = state.modelOverrides;
  if (Object.hasOwn(sharedOverrides, state.sessionKey)) {
    return normalizeChatModelOverrideValue(sharedOverrides[state.sessionKey], catalog);
  }

  const activeRow = resolveActiveSessionRow(state);
  return resolvePreferredServerChatModelValue(activeRow?.model, activeRow?.modelProvider, catalog);
}

function resolveDefaultModelValue(state: ChatModelSelectStateInput): string {
  const agentDefault = resolvePreferredServerChatModelValue(
    state.agentDefaultModel,
    undefined,
    state.chatModelCatalog ?? [],
  );
  if (agentDefault) {
    return agentDefault;
  }
  return resolvePreferredServerChatModelValue(
    state.sessionsResult?.defaults?.model,
    state.sessionsResult?.defaults?.modelProvider,
    state.chatModelCatalog ?? [],
  );
}

function normalizeChatModelAvailabilityKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  const separator = normalized.indexOf("/");
  if (separator <= 0) {
    return normalized;
  }
  return `${normalizeChatModelProviderId(normalized.slice(0, separator))}/${normalized.slice(
    separator + 1,
  )}`;
}

function resolveCatalogChatModelValue(value: string, options: ChatModelSelectOption[]): string {
  const exactValue = value.trim().toLowerCase();
  if (!exactValue) {
    return value;
  }
  const normalizedValue = normalizeChatModelAvailabilityKey(value);
  for (const disabled of [false, true]) {
    const match = options.find(
      (option) =>
        Boolean(option.disabled) === disabled &&
        (option.value.trim().toLowerCase() === exactValue ||
          normalizeChatModelAvailabilityKey(option.value) === normalizedValue),
    );
    if (match) {
      return match.value;
    }
  }
  return value;
}

function buildChatModelOptions(
  catalog: ModelCatalogEntry[],
  displayLookup: ReturnType<typeof buildCatalogDisplayLookup>,
): ChatModelSelectOption[] {
  const seen = new Set<string>();
  const options: ChatModelSelectOption[] = [];

  for (const entry of catalog.toSorted(
    (left, right) =>
      Number(left.available === false) - Number(right.available === false) ||
      Number(left.provider.trim().toLowerCase() !== normalizeChatModelProviderId(left.provider)) -
        Number(
          right.provider.trim().toLowerCase() !== normalizeChatModelProviderId(right.provider),
        ),
  )) {
    const option = buildChatModelOptionFromLookup(entry, displayLookup);
    const value = option.value.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) {
      continue;
    }
    seen.add(key);
    options.push({ ...option, ...(entry.available === false ? { disabled: true } : {}) });
  }
  return options;
}

export function isChatModelUnavailable(
  model: string | null | undefined,
  provider: string | null | undefined,
  catalog: ModelCatalogEntry[],
): boolean {
  const value = resolvePreferredServerChatModelValue(model, provider, catalog);
  const key = normalizeChatModelAvailabilityKey(value);
  const matches = catalog.filter(
    (entry) =>
      normalizeChatModelAvailabilityKey(buildQualifiedChatModelValue(entry.id, entry.provider)) ===
      key,
  );
  return matches.length > 0 && matches.every((entry) => entry.available === false);
}

export function resolveChatModelSelectState(
  state: ChatModelSelectStateInput,
): ChatModelSelectState {
  const catalog = state.chatModelCatalog ?? [];
  const availableKeys = new Set(
    catalog
      .filter((entry) => entry.available !== false)
      .map((entry) =>
        normalizeChatModelAvailabilityKey(buildQualifiedChatModelValue(entry.id, entry.provider)),
      ),
  );
  // Catalog members already have a qualified identity. Prepare one retained inventory
  // so unavailable aliases cannot disambiguate labels for their selectable sibling.
  const pickerCatalog = catalog.filter(
    (entry) =>
      entry.available !== false ||
      !availableKeys.has(
        normalizeChatModelAvailabilityKey(buildQualifiedChatModelValue(entry.id, entry.provider)),
      ),
  );
  const displayLookup = buildCatalogDisplayLookup(pickerCatalog);
  const options = buildChatModelOptions(pickerCatalog, displayLookup);
  const currentOverride = resolveCatalogChatModelValue(
    resolveChatModelOverrideValue(state),
    options,
  );
  const defaultModel = resolveCatalogChatModelValue(resolveDefaultModelValue(state), options);
  const defaultLabel = formatCatalogChatModelDisplayFromLookup(defaultModel, displayLookup);

  return {
    currentOverride,
    defaultModel,
    defaultLabel: defaultModel ? `Default (${defaultLabel})` : "Default model",
    modelOverrideSource: resolveModelOverrideSource(state),
    options,
  };
}

export function normalizeChatFastModeInput(raw: string): FastMode | undefined {
  if (raw === "auto") {
    return "auto";
  }
  if (raw === "on") {
    return true;
  }
  if (raw === "off") {
    return false;
  }
  return undefined;
}

export function resolveChatFastModeStatus(session: GatewaySessionRow | undefined): string {
  const mode = session?.effectiveFastMode ?? session?.fastMode;
  const value =
    mode === "auto"
      ? t("chat.commandResults.fast.autoValue", {
          seconds: String(session?.fastAutoOnSeconds ?? 60),
        })
      : t(mode === true ? "chat.commandResults.fast.on" : "chat.commandResults.fast.off");
  const source = session?.effectiveFastModeSource;
  const sourceSuffix =
    source === "session"
      ? t("chat.commandResults.fast.sourceSession")
      : source === "agent"
        ? t("chat.commandResults.fast.sourceAgent")
        : source === "config"
          ? t("chat.commandResults.fast.sourceModel")
          : source === "default"
            ? t("chat.commandResults.fast.sourceDefault")
            : "";
  return `${t("chat.commandResults.fast.current", { value })}${sourceSuffix}.`;
}

function resolveFastModeProvider(
  value: string,
  catalog: ModelCatalogEntry[],
  sessionProvider: string | null,
  defaultProvider: string | null,
): string | null {
  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue) {
    return sessionProvider ?? defaultProvider;
  }
  const idProviders = new Set<string>();
  const qualifiedProviders = new Set<string>();
  let hasCatalogMatch = false;
  for (const entry of catalog) {
    const matchesId = entry.id.trim().toLowerCase() === normalizedValue;
    const matchesQualified =
      buildQualifiedChatModelValue(entry.id, entry.provider).trim().toLowerCase() ===
      normalizedValue;
    if (!matchesId && !matchesQualified) {
      continue;
    }
    hasCatalogMatch = true;
    const provider = normalizeChatModelProviderId(entry.provider);
    if (provider) {
      if (matchesId) {
        idProviders.add(provider);
      }
      if (matchesQualified) {
        qualifiedProviders.add(provider);
      }
    }
  }
  if (qualifiedProviders.size === 1) {
    return [...qualifiedProviders][0] ?? null;
  }
  if (
    sessionProvider &&
    idProviders.has(sessionProvider) &&
    !qualifiedProviders.has(sessionProvider)
  ) {
    return sessionProvider;
  }
  if (idProviders.size === 1) {
    return [...idProviders][0] ?? null;
  }
  // An ambiguous catalog match must not be replaced by a stale session/default provider.
  return hasCatalogMatch ? null : (sessionProvider ?? defaultProvider);
}

export function resolveChatFastModeSelectState(
  input: ChatFastModeSelectStateInput,
): ChatFastModeSelectState {
  const activeRow = input.sessionsResult?.sessions?.find((row) =>
    areUiSessionKeysEquivalent(row.key, input.sessionKey),
  );
  const activeProvider = normalizeChatModelProviderId(activeRow?.modelProvider ?? "") || null;
  const defaultProvider =
    normalizeChatModelProviderId(input.sessionsResult?.defaults?.modelProvider ?? "") || null;
  const effectiveProvider = resolveFastModeProvider(
    input.currentModelOverride,
    input.catalog,
    activeProvider,
    defaultProvider,
  );
  const configuredOverride =
    activeRow?.fastMode === "auto"
      ? "auto"
      : activeRow?.fastMode === true
        ? "on"
        : activeRow?.fastMode === false
          ? "off"
          : "";
  const isOpenAI = effectiveProvider === "openai";
  const effectiveMode = activeRow?.effectiveFastMode ?? activeRow?.fastMode;
  // OpenAI exposes one optional priority tier. Keep legacy auto unselected so
  // either binary choice replaces it instead of implying the wrong tier.
  const currentOverride = isOpenAI
    ? effectiveMode === true
      ? "on"
      : effectiveMode === "auto"
        ? "auto"
        : "off"
    : configuredOverride;
  const providerSupported = Boolean(
    effectiveProvider && FAST_MODE_PROVIDER_IDS.has(effectiveProvider),
  );
  const supported = providerSupported || Boolean(configuredOverride);
  // The picker exposes speed as a two-state toggle: fast on, or back to the
  // provider baseline (explicit off for OpenAI's priority tier, inherited
  // default elsewhere). Auto and explicit standard overrides remain reachable
  // through /fast and still render truthfully here.
  const active = effectiveMode === true || effectiveMode === "auto";
  const label =
    effectiveMode === "auto"
      ? "Auto"
      : active
        ? "Fast"
        : isOpenAI
          ? "Standard"
          : currentOverride === "off"
            ? "Standard"
            : "Default";
  // A legacy override on a provider without a wire mapping stays visible so it
  // can be cleared, but the toggle must not write a new no-op fast override.
  // For mapped providers an active toggle always writes an explicit off: the
  // inherited baseline is unknowable while an override exists, and clearing
  // could land on a fast default, turning the click into a visible no-op.
  // /fast default remains the way back to the inherited setting.
  const nextValue: ChatFastModeSelectValue = !providerSupported ? "" : active ? "off" : "on";
  return {
    active,
    currentOverride,
    disabled:
      !supported ||
      !input.connected ||
      input.loading ||
      input.sending ||
      Boolean(input.activeRunId) ||
      input.stream !== null ||
      !input.gatewayAvailable,
    label,
    nextValue,
    supported,
  };
}
