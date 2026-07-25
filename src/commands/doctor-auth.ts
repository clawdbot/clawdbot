/** Doctor notes for auth profile health, OAuth refresh failures, and legacy Codex config. */
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  buildAuthHealthSummary,
  DEFAULT_OAUTH_WARN_MS,
  formatRemainingShort,
  type AuthHealthSummary,
} from "../agents/auth-health.js";
import {
  type AuthCredentialReasonCode,
  ensureAuthProfileStore,
  hasAnyAuthProfileStoreSource,
  hasLocalAuthProfileStoreSource,
  resolveApiKeyForProfile,
  resolveProfileUnusableUntilForDisplay,
} from "../agents/auth-profiles.js";
import { CLAUDE_CLI_PROFILE_ID } from "../agents/auth-profiles/constants.js";
import { formatAuthDoctorHint } from "../agents/auth-profiles/doctor.js";
import {
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailure,
  formatOAuthRefreshFailureLoginCommandMarkdown,
  type OAuthRefreshFailureReason,
} from "../agents/auth-profiles/oauth-refresh-failure.js";
import { resolveAuthStorePathForDisplay } from "../agents/auth-profiles/path-resolve.js";
import { buildProviderAuthRecoveryHint } from "../agents/provider-auth-recovery-hint.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isRecord } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const OPENAI_PROVIDER_ID = "openai";
const LEGACY_CODEX_PROVIDER_ID = "openai-codex";
const CLAUDE_CLI_PROVIDER_ID = "claude-cli";
const CODEX_OAUTH_WARNING_TITLE = "Codex OAuth";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const LEGACY_CODEX_APIS = new Set(["openai-responses", "openai-completions"]);
const AUTH_PROFILES_CHECK_ID = "core/doctor/auth-profiles";
const DOCTOR_REAUTH_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  [LEGACY_CODEX_PROVIDER_ID]: OPENAI_PROVIDER_ID,
};

function hasConfiguredCodexOAuthProfile(cfg: OpenClawConfig): boolean {
  return Object.values(cfg.auth?.profiles ?? {}).some(
    (profile) =>
      (profile.provider === OPENAI_PROVIDER_ID || profile.provider === LEGACY_CODEX_PROVIDER_ID) &&
      profile.mode === "oauth",
  );
}

function hasStoredCodexOAuthProfile(): boolean {
  const store = ensureAuthProfileStore(undefined, { allowKeychainPrompt: false, readOnly: true });
  return Object.values(store.profiles).some(
    (profile) =>
      (profile.provider === OPENAI_PROVIDER_ID || profile.provider === LEGACY_CODEX_PROVIDER_ID) &&
      profile.type === "oauth",
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
    `- models.providers.${LEGACY_CODEX_PROVIDER_ID} contains a legacy transport override while Codex OAuth is configured.`,
    "- Older OpenAI transport settings can shadow the built-in Codex OAuth provider path.",
  ];
  if (isRecord(providerOverride)) {
    const record = providerOverride;
    if (typeof record.api === "string") {
      lines.push(`- models.providers.${LEGACY_CODEX_PROVIDER_ID}.api=${record.api}`);
    }
    if (typeof record.baseUrl === "string") {
      lines.push(`- models.providers.${LEGACY_CODEX_PROVIDER_ID}.baseUrl=${record.baseUrl}`);
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

function legacyCodexProviderOverrideToHealthFinding(providerOverride: unknown): HealthFinding {
  const message =
    "Legacy openai-codex transport override can shadow configured Codex OAuth credentials.";
  const details = buildCodexProviderOverrideWarning(providerOverride);
  return {
    checkId: AUTH_PROFILES_CHECK_ID,
    severity: "warning",
    message,
    path: `models.providers.${LEGACY_CODEX_PROVIDER_ID}`,
    target: LEGACY_CODEX_PROVIDER_ID,
    fixHint: details,
  };
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.doctorAuthTestApi")] = {
    legacyCodexProviderOverrideToHealthFinding,
  };
}

/** Emits a warning when legacy Codex transport overrides can shadow configured Codex OAuth. */
export function noteLegacyCodexProviderOverride(cfg: OpenClawConfig): void {
  const providerOverride = cfg.models?.providers?.[LEGACY_CODEX_PROVIDER_ID];
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

type AuthProfileHealthTarget = {
  agentId: string;
  agentDir: string;
  isDefault: boolean;
};

function formatAgentNoteTitle(title: string, agentId: string, labelAgents: boolean): string {
  return labelAgents ? `${title} (agent: ${agentId})` : title;
}

function listAuthProfileHealthTargets(cfg: OpenClawConfig): AuthProfileHealthTarget[] {
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const targets = new Map<string, AuthProfileHealthTarget>();
  const addTarget = (agentId: string, agentDir: string, isDefault: boolean) => {
    const key = path.resolve(agentDir);
    const existing = targets.get(key);
    if (!existing || isDefault) {
      targets.set(key, { agentId, agentDir, isDefault: isDefault || existing?.isDefault === true });
    }
  };

  addTarget(defaultAgentId, resolveDefaultAgentDir(cfg), true);
  for (const agentId of listAgentIds(cfg)) {
    if (agentId === defaultAgentId) {
      continue;
    }
    const agentDir = resolveAgentDir(cfg, agentId);
    if (hasLocalAuthProfileStoreSource(agentDir)) {
      addTarget(agentId, agentDir, false);
    }
  }

  return [...targets.values()];
}

/** Returns the short doctor hint for disabled or cooldown auth profiles. */
function resolveUnusableProfileHint(params: {
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

/** Formats provider OAuth refresh failures as actionable doctor note lines. */
function formatOAuthRefreshFailureDoctorLine(params: {
  profileId: string;
  provider: string;
  message: string;
}): string | null {
  const classified = classifyOAuthRefreshFailure(params.message);
  if (!classified) {
    return null;
  }
  const rawProvider = classified.provider ?? params.provider;
  const provider = rawProvider
    ? (DOCTOR_REAUTH_PROVIDER_ALIASES[rawProvider] ?? rawProvider)
    : null;
  const command = buildOAuthRefreshFailureLoginCommand(provider, {
    profileId: provider === rawProvider ? params.profileId : undefined,
  });
  const commandMarkdown = formatOAuthRefreshFailureLoginCommandMarkdown(command);
  if (classified.reason) {
    return `- ${params.profileId}: re-auth required [${formatOAuthRefreshFailureReason(classified.reason)}] — Run ${commandMarkdown}.`;
  }
  return `- ${params.profileId}: OAuth refresh failed — Try again; if this persists, run ${commandMarkdown}.`;
}

async function resolveAuthIssueHint(
  issue: AuthIssue,
  cfg: OpenClawConfig,
  store: ReturnType<typeof ensureAuthProfileStore>,
): Promise<string | null> {
  if (issue.reasonCode === "invalid_expires") {
    return "Invalid token expires metadata. Set a future Unix ms timestamp or remove expires.";
  }
  if (issue.reasonCode === "malformed_api_key") {
    return "Paste the API key value, not an OpenClaw onboarding command.";
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

function resolveAuthProfileStorePath(target: AuthProfileHealthTarget): string {
  return resolveAuthStorePathForDisplay(target.agentDir);
}

function authProfileIssueToHealthFinding(params: {
  issue: AuthIssue;
  target: AuthProfileHealthTarget;
  labelAgents: boolean;
  hint: string | null;
}): HealthFinding {
  const remaining =
    params.issue.remainingMs !== undefined
      ? ` (${formatRemainingShort(params.issue.remainingMs)})`
      : "";
  const reason = params.issue.reasonCode ? ` [${params.issue.reasonCode}]` : "";
  const owner = params.labelAgents ? `Agent ${params.target.agentId} auth profile` : "Auth profile";
  return {
    checkId: AUTH_PROFILES_CHECK_ID,
    severity: "warning",
    message: `${owner} ${params.issue.profileId} is ${params.issue.status}${reason}${remaining}.`,
    path: resolveAuthProfileStorePath(params.target),
    target: params.issue.profileId,
    ...(params.issue.reasonCode ? { requirement: params.issue.reasonCode } : {}),
    fixHint:
      params.hint ??
      (params.issue.status === "expiring"
        ? "Run `openclaw doctor --fix` to refresh expiring OAuth profiles, or re-authenticate static tokens."
        : "Run `openclaw doctor --fix` to refresh OAuth profiles, or re-authenticate this provider."),
  };
}

function authProfileCooldownToHealthFinding(params: {
  profileId: string;
  target: AuthProfileHealthTarget;
  labelAgents: boolean;
  kind: string;
  remaining: string;
  hint: string;
}): HealthFinding {
  return {
    checkId: AUTH_PROFILES_CHECK_ID,
    severity: "warning",
    message: params.labelAgents
      ? `Agent ${params.target.agentId} auth profile ${params.profileId} is ${params.kind} (${params.remaining}).`
      : `Auth profile ${params.profileId} is ${params.kind} (${params.remaining}).`,
    path: resolveAuthProfileStorePath(params.target),
    target: params.profileId,
    fixHint: params.hint,
  };
}

function isAuthProfileHealthIssue(profile: AuthHealthSummary["profiles"][number]): boolean {
  if (profile.type === "api_key") {
    return profile.status === "missing";
  }
  // Claude CLI refreshes its short-lived access token when the process runs.
  // Warn once that external credential is unusable, not throughout its normal lifetime.
  if (
    profile.profileId === CLAUDE_CLI_PROFILE_ID &&
    profile.provider === CLAUDE_CLI_PROVIDER_ID &&
    profile.type === "oauth" &&
    profile.status === "expiring"
  ) {
    return false;
  }
  return (
    (profile.type === "oauth" || profile.type === "token") &&
    (profile.status === "expired" || profile.status === "expiring" || profile.status === "missing")
  );
}

async function collectAuthProfileHealthFindingsForTarget(params: {
  cfg: OpenClawConfig;
  allowKeychainPrompt: boolean;
  target: AuthProfileHealthTarget;
  labelAgents: boolean;
}): Promise<readonly HealthFinding[]> {
  const store = ensureAuthProfileStore(params.target.agentDir, {
    allowKeychainPrompt: params.allowKeychainPrompt,
    readOnly: true,
  });
  const findings: HealthFinding[] = [];
  const now = Date.now();
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
    findings.push(
      authProfileCooldownToHealthFinding({
        profileId,
        target: params.target,
        labelAgents: params.labelAgents,
        kind,
        remaining,
        hint,
      }),
    );
  }

  const summary = buildAuthHealthSummary({
    store,
    cfg: params.cfg,
    warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    allowKeychainPrompt: params.allowKeychainPrompt,
  });
  const issues = summary.profiles.filter(isAuthProfileHealthIssue);
  for (const issue of issues) {
    const authIssue: AuthIssue = {
      profileId: issue.profileId,
      provider: issue.provider,
      status: issue.status,
      reasonCode: issue.reasonCode,
      remainingMs: issue.remainingMs,
    };
    findings.push(
      authProfileIssueToHealthFinding({
        issue: authIssue,
        target: params.target,
        labelAgents: params.labelAgents,
        hint: await resolveAuthIssueHint(authIssue, params.cfg, store),
      }),
    );
  }
  return findings;
}

/** Collects read-only structured findings for auth profile health. */
export async function collectAuthProfileHealthFindings(params: {
  cfg: OpenClawConfig;
  allowKeychainPrompt?: boolean;
}): Promise<readonly HealthFinding[]> {
  const configuredProfiles = Object.keys(params.cfg.auth?.profiles ?? {}).length > 0;
  const targets = listAuthProfileHealthTargets(params.cfg);
  const activeTargets = targets.filter((target) =>
    target.isDefault
      ? hasAnyAuthProfileStoreSource(target.agentDir) || configuredProfiles
      : hasLocalAuthProfileStoreSource(target.agentDir),
  );
  const findings: HealthFinding[] = [];
  const labelAgents = activeTargets.length > 1;
  for (const target of activeTargets) {
    findings.push(
      ...(await collectAuthProfileHealthFindingsForTarget({
        cfg: params.cfg,
        allowKeychainPrompt: params.allowKeychainPrompt ?? false,
        target,
        labelAgents,
      })),
    );
  }

  const providerOverride = params.cfg.models?.providers?.[LEGACY_CODEX_PROVIDER_ID];
  if (
    providerOverride &&
    hasLegacyCodexTransportOverride(providerOverride) &&
    (hasConfiguredCodexOAuthProfile(params.cfg) || hasStoredCodexOAuthProfile())
  ) {
    findings.push(legacyCodexProviderOverrideToHealthFinding(providerOverride));
  }
  return findings;
}

async function noteAuthProfileHealthForTarget(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
  allowKeychainPrompt: boolean;
  target: AuthProfileHealthTarget;
  labelAgents: boolean;
}): Promise<string[]> {
  const store = ensureAuthProfileStore(params.target.agentDir, {
    allowKeychainPrompt: params.allowKeychainPrompt,
  });
  const noteTitle = (title: string) =>
    formatAgentNoteTitle(title, params.target.agentId, params.labelAgents);
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
    note(unusable.join("\n"), noteTitle("Auth profile cooldowns"));
  }

  let summary = buildAuthHealthSummary({
    store,
    cfg: params.cfg,
    warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    allowKeychainPrompt: params.allowKeychainPrompt,
  });

  const findIssues = () => summary.profiles.filter(isAuthProfileHealthIssue);

  let issues = findIssues();
  if (issues.length === 0) {
    return [];
  }

  const refreshTargets = issues.filter(
    (issue) => issue.type === "oauth" && ["expired", "expiring", "missing"].includes(issue.status),
  );
  const shouldRefresh =
    refreshTargets.length > 0 &&
    (await params.prompter.confirmAutoFix({
      message: "Refresh expiring OAuth tokens now? (static tokens need re-auth)",
      initialValue: true,
    }));

  if (shouldRefresh) {
    const errors: string[] = [];
    for (const profile of refreshTargets) {
      try {
        await resolveApiKeyForProfile({
          cfg: params.cfg,
          store,
          profileId: profile.profileId,
          agentDir: params.target.agentDir,
          forceRefresh: true,
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
      note(errors.join("\n"), noteTitle("OAuth refresh errors"));
    }
    summary = buildAuthHealthSummary({
      store: ensureAuthProfileStore(params.target.agentDir, {
        allowKeychainPrompt: false,
      }),
      cfg: params.cfg,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
      allowKeychainPrompt: false,
    });
    issues = findIssues();
  }

  return Promise.all(issues.map((issue) => formatAuthIssueLine(issue, params.cfg, store)));
}

/** Checks configured agent auth stores and emits doctor notes for stale or unusable profiles. */
export async function noteAuthProfileHealth(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
  allowKeychainPrompt: boolean;
}): Promise<void> {
  const configuredProfiles = Object.keys(params.cfg.auth?.profiles ?? {}).length > 0;
  const targets = listAuthProfileHealthTargets(params.cfg);
  const activeTargets = targets.filter((target) =>
    target.isDefault
      ? hasAnyAuthProfileStoreSource(target.agentDir) || configuredProfiles
      : hasLocalAuthProfileStoreSource(target.agentDir),
  );
  if (activeTargets.length === 0) {
    return;
  }

  const labelAgents = activeTargets.length > 1;
  const agentsByIssueLine = new Map<string, Set<string>>();
  for (const target of activeTargets) {
    for (const line of await noteAuthProfileHealthForTarget({ ...params, target, labelAgents })) {
      const agentIds = agentsByIssueLine.get(line) ?? new Set<string>();
      agentsByIssueLine.set(line, agentIds.add(target.agentId));
    }
  }
  if (agentsByIssueLine.size === 0) {
    return;
  }
  // One aggregated note; a line shared by every checked agent needs no attribution.
  const lines = [...agentsByIssueLine.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([line, agentIds]) =>
      agentIds.size === activeTargets.length
        ? line
        : `${line} (agents: ${[...agentIds].toSorted().join(", ")})`,
    );
  note(lines.join("\n"), "Model auth");
}
