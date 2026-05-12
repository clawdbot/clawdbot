import {
  ensureAuthProfileStore,
  findNormalizedProviderValue,
  resolveAuthProfileEligibility,
  resolveAuthProfileOrder,
  resolveDefaultAgentDir,
  resolveProfileUnusableUntilForDisplay,
  type AuthProfileCredential,
  type AuthProfileFailureReason,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { CODEX_CONTROL_METHODS, type CodexControlMethod } from "./app-server/capabilities.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./app-server/protocol.js";
import { rememberCodexRateLimits } from "./app-server/rate-limit-cache.js";
import {
  summarizeCodexAccountUsage,
  type CodexAccountUsageSummary,
} from "./app-server/rate-limits.js";
import type { CodexControlRequestOptions, SafeValue } from "./command-rpc.js";

const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

type AuthProfileOrderConfig = Parameters<typeof resolveAuthProfileOrder>[0]["cfg"];

type SafeCodexControlRequest = (
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams: JsonValue | undefined,
  options?: CodexControlRequestOptions,
) => Promise<SafeValue<JsonValue | undefined>>;

export type CodexAccountAuthRow = {
  profileId: string;
  label: string;
  kind: string;
  status: string;
  active: boolean;
  usage?: string;
  billingNote?: string;
};

export type CodexAccountAuthOverview = {
  currentLine?: string;
  subscriptionLabel?: string;
  subscriptionUsage?: string;
  orderTitle: string;
  rows: CodexAccountAuthRow[];
};

export async function readCodexAccountAuthOverview(params: {
  ctx: PluginCommandContext;
  pluginConfig: unknown;
  safeCodexControlRequest: SafeCodexControlRequest;
  account: SafeValue<JsonValue | undefined>;
  limits: SafeValue<JsonValue | undefined>;
}): Promise<CodexAccountAuthOverview | undefined> {
  const config = params.ctx.config;
  const agentDir = resolveDefaultAgentDir(config);
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
    config,
  });
  const order = resolveDisplayAuthOrder({ config, store });
  if (order.length === 0) {
    return undefined;
  }

  const now = Date.now();
  const activeProfileId = resolveActiveProfileId({
    store,
    order,
    config,
    account: params.account,
    limits: params.limits,
    now,
  });
  const subscriptionProfileId = order.find((profileId) =>
    isChatGptSubscriptionProfile(store.profiles[profileId]),
  );
  const activeIsSubscription =
    activeProfileId !== undefined && isChatGptSubscriptionProfile(store.profiles[activeProfileId]);
  const activeUsage =
    activeIsSubscription && params.limits.ok
      ? summarizeCodexAccountUsage(params.limits.value, now)
      : undefined;
  const subscriptionUsage =
    subscriptionProfileId && (!activeIsSubscription || subscriptionProfileId !== activeProfileId)
      ? await readSubscriptionUsage({
          ...params,
          config,
          subscriptionProfileId,
          now,
        })
      : activeUsage;
  if (!params.account.ok && !params.limits.ok && !subscriptionUsage) {
    return undefined;
  }

  const rows = order.map((profileId, index) =>
    buildProfileRow({
      store,
      config,
      profileId,
      activeProfileId,
      activeIndex: activeProfileId ? order.indexOf(activeProfileId) : -1,
      index,
      now,
      usage: profileId === subscriptionProfileId ? subscriptionUsage : undefined,
    }),
  );
  const activeRow = rows.find((row) => row.active);
  if (!activeRow) {
    return {
      currentLine: "OpenAI credentials: no working credential",
      orderTitle: "Auth order",
      rows,
    };
  }
  const activeCredential = store.profiles[activeRow.profileId];
  const activeIsApiKey = activeCredential?.type === "api_key";
  const subscriptionLabel = subscriptionProfileId
    ? formatProfileLabel(subscriptionProfileId, store.profiles[subscriptionProfileId])
    : activeIsSubscription
      ? activeRow.label
      : undefined;
  const subscriptionUsageLine = formatSubscriptionUsageLine(subscriptionUsage);
  return {
    ...(activeIsApiKey ? { currentLine: buildApiKeyActiveLine(activeRow, subscriptionUsage) } : {}),
    ...(subscriptionLabel ? { subscriptionLabel } : {}),
    ...(subscriptionUsageLine ? { subscriptionUsage: subscriptionUsageLine } : {}),
    orderTitle: "Auth order",
    rows,
  };
}

function resolveDisplayAuthOrder(params: {
  config: AuthProfileOrderConfig;
  store: AuthProfileStore;
}): string[] {
  const codexOrder =
    resolveOrder(params.store.order, OPENAI_CODEX_PROVIDER_ID) ??
    resolveOrder(params.config?.auth?.order, OPENAI_CODEX_PROVIDER_ID);
  if (codexOrder && codexOrder.length > 0) {
    return dedupe(codexOrder);
  }
  return resolveAuthProfileOrder({
    cfg: params.config,
    store: params.store,
    provider: OPENAI_CODEX_PROVIDER_ID,
  });
}

function resolveOrder(
  order: Record<string, string[]> | undefined,
  provider: string,
): string[] | undefined {
  return findNormalizedProviderValue(order, provider);
}

function resolveActiveProfileId(params: {
  store: AuthProfileStore;
  order: string[];
  config: AuthProfileOrderConfig;
  account: SafeValue<JsonValue | undefined>;
  limits: SafeValue<JsonValue | undefined>;
  now: number;
}): string | undefined {
  const liveProfileId = resolveLiveAccountProfileId({
    account: params.account,
    store: params.store,
    order: params.order,
  });
  if (liveProfileId) {
    return liveProfileId;
  }
  const lastGood = [
    params.store.lastGood?.[OPENAI_PROVIDER_ID],
    params.store.lastGood?.[OPENAI_CODEX_PROVIDER_ID],
  ].find(
    (profileId): profileId is string =>
      !!profileId &&
      params.order.includes(profileId) &&
      isActiveProfileCandidate(params, profileId),
  );
  if (lastGood) {
    return lastGood;
  }
  const mostRecent = params.order
    .map((profileId) => ({
      profileId,
      lastUsed: params.store.usageStats?.[profileId]?.lastUsed ?? 0,
    }))
    .filter((entry) => entry.lastUsed > 0 && isActiveProfileCandidate(params, entry.profileId))
    .toSorted((left, right) => right.lastUsed - left.lastUsed)[0]?.profileId;
  if (mostRecent) {
    return mostRecent;
  }
  if (shouldInferApiKeyActiveFromRateLimitProbe(params.limits)) {
    const apiKeyProfile = params.order.find(
      (profileId) => params.store.profiles[profileId]?.type === "api_key",
    );
    if (apiKeyProfile) {
      return apiKeyProfile;
    }
  }
  return resolveAuthProfileOrder({
    cfg: params.config,
    store: params.store,
    provider: OPENAI_CODEX_PROVIDER_ID,
  })[0];
}

function isActiveProfileCandidate(
  params: { store: AuthProfileStore; now: number },
  profileId: string,
): boolean {
  const unusableUntil = resolveProfileUnusableUntilForDisplay(params.store, profileId);
  return !isActiveUntil(unusableUntil ?? undefined, params.now);
}

function resolveLiveAccountProfileId(params: {
  account: SafeValue<JsonValue | undefined>;
  store: AuthProfileStore;
  order: string[];
}): string | undefined {
  if (!params.account.ok || !isJsonObject(params.account.value)) {
    return undefined;
  }
  const account = isJsonObject(params.account.value.account)
    ? params.account.value.account
    : params.account.value;
  const type = readString(account, "type")?.toLowerCase();
  if (type === "chatgpt") {
    const email = readString(account, "email")?.toLowerCase();
    const firstSubscription = params.order.find((profileId) =>
      isChatGptSubscriptionProfile(params.store.profiles[profileId]),
    );
    if (!email) {
      return firstSubscription;
    }
    return (
      params.order.find((profileId) => {
        const credential = params.store.profiles[profileId];
        if (!isChatGptSubscriptionProfile(credential)) {
          return false;
        }
        const profileEmail =
          credential.email?.trim().toLowerCase() ?? extractEmailFromProfileId(profileId);
        return profileEmail?.toLowerCase() === email;
      }) ?? firstSubscription
    );
  }
  if (type === "apikey" || type === "api_key") {
    return params.order.find((profileId) => params.store.profiles[profileId]?.type === "api_key");
  }
  return undefined;
}

function shouldInferApiKeyActiveFromRateLimitProbe(
  limits: SafeValue<JsonValue | undefined>,
): boolean {
  return !limits.ok && limits.error.toLowerCase().includes("chatgpt authentication required");
}

async function readSubscriptionUsage(params: {
  pluginConfig: unknown;
  safeCodexControlRequest: SafeCodexControlRequest;
  config: AuthProfileOrderConfig;
  subscriptionProfileId: string;
  now: number;
}): Promise<CodexAccountUsageSummary | undefined> {
  const limits = await params.safeCodexControlRequest(
    params.pluginConfig,
    CODEX_CONTROL_METHODS.rateLimits,
    undefined,
    {
      config: params.config,
      authProfileId: params.subscriptionProfileId,
      isolated: true,
    },
  );
  if (!limits.ok) {
    return undefined;
  }
  rememberCodexRateLimits(limits.value);
  return summarizeCodexAccountUsage(limits.value, params.now);
}

function buildProfileRow(params: {
  store: AuthProfileStore;
  config: AuthProfileOrderConfig;
  profileId: string;
  activeProfileId?: string;
  activeIndex: number;
  index: number;
  now: number;
  usage?: CodexAccountUsageSummary;
}): CodexAccountAuthRow {
  const credential = params.store.profiles[params.profileId];
  const label = formatProfileLabel(params.profileId, credential);
  const kind = formatProfileKind(credential);
  const active = params.profileId === params.activeProfileId;
  const status = active
    ? "active now"
    : params.usage?.blocked
      ? formatUsageBlockedStatus(params.usage)
      : describeInactiveProfileStatus({
          store: params.store,
          config: params.config,
          profileId: params.profileId,
          credential,
          now: params.now,
          afterActive: params.activeIndex >= 0 && params.index > params.activeIndex,
        });
  return {
    profileId: params.profileId,
    label,
    kind,
    status,
    active,
    ...(credential?.type === "api_key" && active ? { billingNote: "billed per token" } : {}),
    ...(params.usage?.usageLine ? { usage: params.usage.usageLine } : {}),
  };
}

function formatUsageBlockedStatus(usage: CodexAccountUsageSummary): string {
  return usage.blocked ? "rate-limited" : "available if needed";
}

function describeInactiveProfileStatus(params: {
  store: AuthProfileStore;
  config: AuthProfileOrderConfig;
  profileId: string;
  credential?: AuthProfileCredential;
  now: number;
  afterActive: boolean;
}): string {
  const stats = params.store.usageStats?.[params.profileId];
  const blockedUntil = stats?.blockedUntil;
  if (isActiveUntil(blockedUntil, params.now)) {
    return `rate-limited - resets ${formatRelativeReset(blockedUntil, params.now)}`;
  }
  const unusableUntil = resolveProfileUnusableUntilForDisplay(params.store, params.profileId);
  if (isActiveUntil(unusableUntil ?? undefined, params.now)) {
    return describeFailureStatus(stats?.disabledReason ?? stats?.cooldownReason, params.credential);
  }
  const eligibility = resolveAuthProfileEligibility({
    cfg: params.config,
    store: params.store,
    provider: OPENAI_CODEX_PROVIDER_ID,
    profileId: params.profileId,
    now: params.now,
  });
  if (!eligibility.eligible) {
    return describeEligibilityStatus(eligibility.reasonCode, params.credential);
  }
  return "available if needed";
}

function buildApiKeyActiveLine(
  activeRow: CodexAccountAuthRow,
  subscriptionUsage: CodexAccountUsageSummary | undefined,
): string {
  if (subscriptionUsage?.blocked) {
    const switchBack = subscriptionUsage.blockedResetRelative
      ? ` · switches back ${subscriptionUsage.blockedResetRelative}`
      : " · switches back automatically";
    return `Now using: ${activeRow.label} - subscription rate-limited${switchBack}`;
  }
  return `Now using: ${activeRow.label} - subscription unavailable · switches back automatically`;
}

function formatSubscriptionUsageLine(
  usage: CodexAccountUsageSummary | undefined,
): string | undefined {
  if (!usage) {
    return undefined;
  }
  const parts = usage.usageLine ? [formatUsageLineForDisplay(usage.usageLine)] : [];
  if (usage.blockedResetRelative) {
    parts.push(`Resets ${usage.blockedResetRelative}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatUsageLineForDisplay(value: string): string {
  return value.replace(/^weekly\b/u, "Weekly").replace(/\bshort-term\b/u, "Short-term");
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isChatGptSubscriptionProfile(credential: AuthProfileCredential | undefined): boolean {
  return credential?.type === "oauth" || credential?.type === "token";
}

function formatProfileKind(credential: AuthProfileCredential | undefined): string {
  if (!credential) {
    return "credential";
  }
  if (isChatGptSubscriptionProfile(credential)) {
    return "ChatGPT subscription";
  }
  if (credential.type === "api_key") {
    return "API key";
  }
  return "credential";
}

function formatProfileLabel(
  profileId: string,
  credential: AuthProfileCredential | undefined,
): string {
  const tail = profileId.includes(":") ? profileId.slice(profileId.indexOf(":") + 1) : profileId;
  const displayName = credential?.displayName?.trim();
  if (displayName) {
    return credential?.type === "api_key"
      ? simplifyApiKeyDisplayName(displayName, tail)
      : displayName;
  }
  const email = credential?.email?.trim() ?? extractEmailFromProfileId(profileId);
  if (email) {
    return email;
  }
  if (credential?.type === "api_key") {
    return tail || "API key";
  }
  return humanizeProfileTail(tail);
}

function simplifyApiKeyDisplayName(value: string, tail: string): string {
  const stripped = value.replace(/^OpenAI\s+/iu, "").trim();
  if (tail && stripped.toLowerCase() === humanizeApiKeyProfileTail(tail).toLowerCase()) {
    return tail;
  }
  return stripped || value;
}

function humanizeApiKeyProfileTail(tail: string): string {
  const words = splitProfileTail(tail);
  const hasBackup = words.includes("backup");
  const customWords = words.filter((word) => word !== "api" && word !== "key" && word !== "backup");
  const prefix = customWords.map(titleCase).join(" ");
  return [prefix, "API key", hasBackup ? "backup" : ""].filter(Boolean).join(" ");
}

function humanizeProfileTail(tail: string): string {
  const words = splitProfileTail(tail);
  return words.length > 0 ? words.map(titleCase).join(" ") : tail;
}

function splitProfileTail(tail: string): string[] {
  return tail
    .replace(/[_\s]+/gu, "-")
    .split("-")
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
}

function titleCase(value: string): string {
  return value ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value;
}

function extractEmailFromProfileId(profileId: string): string | undefined {
  const tail = profileId.includes(":") ? profileId.slice(profileId.indexOf(":") + 1) : profileId;
  return /^[^\s@<>()[\]`]+@[^\s@<>()[\]`]+\.[^\s@<>()[\]`]+$/.test(tail) ? tail : undefined;
}

function describeFailureStatus(
  reason: AuthProfileFailureReason | undefined,
  credential: AuthProfileCredential | undefined,
): string {
  if (reason === "auth" || reason === "auth_permanent" || reason === "session_expired") {
    return credential?.type === "api_key" ? "auth failed - check key" : "sign-in expired";
  }
  if (reason === "billing") {
    return "billing unavailable";
  }
  if (reason === "rate_limit") {
    return "rate-limited";
  }
  return "temporarily unavailable";
}

function describeEligibilityStatus(
  reason: string,
  credential: AuthProfileCredential | undefined,
): string {
  if (reason === "profile_missing" || reason === "missing_credential") {
    return credential?.type === "api_key" ? "not configured" : "sign-in required";
  }
  if (reason === "expired" || reason === "invalid_expires") {
    return "sign-in expired";
  }
  if (reason === "unresolved_ref") {
    return "credential unavailable";
  }
  if (reason === "provider_mismatch") {
    return "wrong provider";
  }
  if (reason === "mode_mismatch") {
    return "wrong credential type";
  }
  return "unavailable";
}

function isActiveUntil(value: number | undefined, now: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > now;
}

function formatRelativeReset(untilMs: number, nowMs: number): string {
  const durationMs = Math.max(1_000, untilMs - nowMs);
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (durationMs < hourMs) {
    const minutes = Math.ceil(durationMs / minuteMs);
    return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  if (durationMs < dayMs) {
    const hours = Math.ceil(durationMs / hourMs);
    return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.ceil(durationMs / dayMs);
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
