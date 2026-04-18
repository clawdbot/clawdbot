import {
  buildAuthHealthSummary,
  DEFAULT_OAUTH_WARN_MS,
  formatRemainingShort,
} from "../agents/auth-health.js";
import {
  type AuthCredentialReasonCode,
  ensureAuthProfileStore,
  resolveApiKeyForProfile,
  resolveProfileUnusableUntilForDisplay,
} from "../agents/auth-profiles.js";
import { formatAuthDoctorHint } from "../agents/auth-profiles/doctor.js";
import {
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailure,
  type OAuthRefreshFailureReason,
} from "../agents/auth-profiles/oauth-refresh-failure.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { note } from "../terminal/note.js";
import { isRecord } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import { buildProviderAuthRecoveryHint } from "./provider-auth-guidance.js";
export { maybeRepairLegacyOAuthProfileIds } from "./doctor-auth-legacy-oauth.js";

const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_OAUTH_WARNING_TITLE = "Codex OAuth";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const LEGACY_CODEX_APIS = new Set(["openai-responses", "openai-completions"]);

function hasConfiguredCodexOAuthProfile(cfg: OpenClawConfig): boolean {
  return Object.values(cfg.auth?.profiles ?? {}).some(
    (profile) => profile.provider === CODEX_PROVIDER_ID && profile.mode === "oauth",
  );
}

function hasStoredCodexOAuthProfile(): boolean {
  const store = ensureAuthProfileStore(undefined, { allowKeychainPrompt: false });
  return Object.values(store.profiles).some(
    (profile) => profile.provider === CODEX_PROVIDER_ID && profile.type === "oauth",
  );
}

function normalizeCodexOverrideBaseUrl(baseUrl: unknown): string | undefined {
  if (typeof baseUrl !== "string") {
    return undefined;
  }
  return baseUrl.trim().replace(/\/+$/, "");
}

function isLegacyCodexTransportShape(value: unknown, inheritedBaseUrl?: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const api = typeof value.api === "string" ? value.api : undefined;
  if (!api || !LEGACY_CODEX_APIS.has(api)) {
    return false;
  }
  const baseUrl = normalizeCodexOverrideBaseUrl(value.baseUrl ?? inheritedBaseUrl);
  return !baseUrl || baseUrl === OPENAI_BASE_URL;
}

function hasLegacyCodexTransportOverride(providerOverride: unknown): boolean {
  if (!isRecord(providerOverride)) {
    return false;
  }
  if (isLegacyCodexTransportShape(providerOverride)) {
    return true;
  }
  const models = providerOverride.models;
  if (!Array.isArray(models)) {
    return false;
  }
  return models.some((model) => isLegacyCodexTransportShape(model, providerOverride.baseUrl));
}

function buildCodexProviderOverrideWarning(providerOverride: unknown): string {
  const lines = [
    `- models.providers.${CODEX_PROVIDER_ID} contains a legacy transport override while Codex OAuth is configured.`,
    "- Older OpenAI transport settings can shadow the built-in Codex OAuth provider path.",
  ];
  if (isRecord(providerOverride)) {
    const record = providerOverride;
    if (typeof record.api === "string") {
      lines.push(`- models.providers.${CODEX_PROVIDER_ID}.api=${record.api}`);
    }
    if (typeof record.baseUrl === "string") {
      lines.push(`- models.providers.${CODEX_PROVIDER_ID}.baseUrl=${record.baseUrl}`);
    }
  }
  lines.push(
    `- Remove or rewrite the legacy transport override to restore the built-in Codex OAuth provider path after recent fixes.`,
  );
  lines.push(
    "- Custom proxies and header-only overrides can stay; this warning only targets old OpenAI transport settings.",
  );
  return lines.join("\n");
}

export function noteLegacyCodexProviderOverride(cfg: OpenClawConfig): void {
  const providerOverride = cfg.models?.providers?.[CODEX_PROVIDER_ID];
  if (!providerOverride) {
    return;
  }
  if (!hasLegacyCodexTransportOverride(providerOverride)) {
    return;
  }
  if (!hasConfiguredCodexOAuthProfile(cfg) && !hasStoredCodexOAuthProfile()) {
    return;
  }
  note(buildCodexProviderOverrideWarning(providerOverride), CODEX_OAUTH_WARNING_TITLE);
}

type AuthIssue = {
  profileId: string;
  provider: string;
  status: string;
  reasonCode?: AuthCredentialReasonCode;
  remainingMs?: number;
};

export function resolveUnusableProfileHint(params: {
  kind: "cooldown" | "disabled";
  reason?: string;
}): string {
  if (params.kind === "disabled") {
    if (params.reason === "billing") {
      return "Top up credits (provider billing) or switch provider.";
    }
    if (params.reason === "auth_permanent" || params.reason === "auth") {
      return "Refresh or replace credentials, then retry.";
    }
  }
  return "Wait for cooldown or switch provider.";
}

function formatOAuthRefreshFailureReason(reason: OAuthRefreshFailureReason | null): string {
  switch (reason) {
    case "refresh_token_reused":
      return "refresh_token_reused";
    case "invalid_grant":
      return "invalid_grant";
    case "sign_in_again":
      return "sign in again";
    case "invalid_refresh_token":
      return "invalid refresh token";
    case "revoked":
      return "revoked";
    default:
      return "refresh failed";
  }
}

export function formatOAuthRefreshFailureDoctorLine(params: {
  profileId: string;
  provider: string;
  message: string;
}): string | null {
  const classified = classifyOAuthRefreshFailure(params.message);
  if (!classified) {
    return null;
  }
  const provider = classified.provider ?? params.provider;
  const command = buildOAuthRefreshFailureLoginCommand(provider);
  if (classified.reason) {
    return `- ${params.profileId}: re-auth required [${formatOAuthRefreshFailureReason(classified.reason)}] — Run \`${command}\`.`;
  }
  return `- ${params.profileId}: OAuth refresh failed — Try again; if this persists, run \`${command}\`.`;
}

export async function resolveAuthIssueHint(
  issue: AuthIssue,
  cfg: OpenClawConfig,
  store: ReturnType<typeof ensureAuthProfileStore>,
): Promise<string | null> {
  if (issue.reasonCode === "invalid_expires") {
    return "Invalid token expires metadata. Set a future Unix ms timestamp or remove expires.";
  }
  const providerHint = await formatAuthDoctorHint({
    cfg,
    store,
    provider: issue.provider,
    profileId: issue.profileId,
  });
  if (providerHint.trim()) {
    return providerHint;
  }
  return buildProviderAuthRecoveryHint({
    provider: issue.provider,
  }).replace(/^Run /, "Re-auth via ");
}

async function formatAuthIssueLine(
  issue: AuthIssue,
  cfg: OpenClawConfig,
  store: ReturnType<typeof ensureAuthProfileStore>,
): Promise<string> {
  const remaining =
    issue.remainingMs !== undefined ? ` (${formatRemainingShort(issue.remainingMs)})` : "";
  const hint = await resolveAuthIssueHint(issue, cfg, store);
  const reason = issue.reasonCode ? ` [${issue.reasonCode}]` : "";
  return `- ${issue.profileId}: ${issue.status}${reason}${remaining}${hint ? ` — ${hint}` : ""}`;
}

export async function noteAuthProfileHealth(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
  allowKeychainPrompt: boolean;
}): Promise<void> {
  const store = ensureAuthProfileStore(undefined, {
    allowKeychainPrompt: params.allowKeychainPrompt,
  });
  const unusable = (() => {
    const now = Date.now();
    const out: string[] = [];
    for (const profileId of Object.keys(store.usageStats ?? {})) {
      const until = resolveProfileUnusableUntilForDisplay(store, profileId);
      if (!until || now >= until) {
        continue;
      }
      const stats = store.usageStats?.[profileId];
      const remaining = formatRemainingShort(until - now);
      const disabledActive = typeof stats?.disabledUntil === "number" && now < stats.disabledUntil;
      const kind = disabledActive
        ? `disabled${stats.disabledReason ? `:${stats.disabledReason}` : ""}`
        : "cooldown";
      const hint = resolveUnusableProfileHint({
        kind: disabledActive ? "disabled" : "cooldown",
        reason: stats?.disabledReason,
      });
      out.push(`- ${profileId}: ${kind} (${remaining})${hint ? ` — ${hint}` : ""}`);
    }
    return out;
  })();

  if (unusable.length > 0) {
    note(unusable.join("\n"), "Auth profile cooldowns");
  }

  let summary = buildAuthHealthSummary({
    store,
    cfg: params.cfg,
    warnAfterMs: DEFAULT_OAUTH_WARN_MS,
  });

  const findIssues = () =>
    summary.profiles.filter(
      (profile) =>
        (profile.type === "oauth" || profile.type === "token") &&
        (profile.status === "expired" ||
          profile.status === "expiring" ||
          profile.status === "missing"),
    );

  let issues = findIssues();
  if (issues.length === 0) {
    return;
  }

  const shouldRefresh = await params.prompter.confirmAutoFix({
    message: "Refresh expiring OAuth tokens now? (static tokens need re-auth)",
    initialValue: true,
  });

  if (shouldRefresh) {
    const refreshTargets = issues.filter(
      (issue) =>
        issue.type === "oauth" && ["expired", "expiring", "missing"].includes(issue.status),
    );
    const errors: string[] = [];
    for (const profile of refreshTargets) {
      try {
        await resolveApiKeyForProfile({
          cfg: params.cfg,
          store,
          profileId: profile.profileId,
        });
      } catch (err) {
        const message = formatErrorMessage(err);
        errors.push(
          formatOAuthRefreshFailureDoctorLine({
            profileId: profile.profileId,
            provider: profile.provider,
            message,
          }) ?? `- ${profile.profileId}: ${message}`,
        );
      }
    }
    if (errors.length > 0) {
      note(errors.join("\n"), "OAuth refresh errors");
    }
    summary = buildAuthHealthSummary({
      store: ensureAuthProfileStore(undefined, {
        allowKeychainPrompt: false,
      }),
      cfg: params.cfg,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });
    issues = findIssues();
  }

  if (issues.length > 0) {
    const issueLines = await Promise.all(
      issues.map((issue) =>
        formatAuthIssueLine(
          {
            profileId: issue.profileId,
            provider: issue.provider,
            status: issue.status,
            reasonCode: issue.reasonCode,
            remainingMs: issue.remainingMs,
          },
          params.cfg,
          store,
        ),
      ),
    );
    note(issueLines.join("\n"), "Model auth");
  }
}
