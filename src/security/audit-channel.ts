import {
  hasConfiguredUnavailableCredentialStatus,
  hasResolvedCredentialValue,
} from "../channels/account-snapshot-fields.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { inspectReadOnlyChannelAccount } from "../channels/read-only-account-inspect.js";
import { formatCliCommand } from "../cli/command-format.js";
import { isDangerousNameMatchingEnabled } from "../config/dangerous-name-matching.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { SecurityAuditFinding, SecurityAuditSeverity } from "./audit.types.js";
import { resolveDmAllowState } from "./dm-policy-shared.js";

function classifyChannelWarningSeverity(message: string): SecurityAuditSeverity {
  const s = message.toLowerCase();
  if (
    s.includes("dms: open") ||
    s.includes('grouppolicy="open"') ||
    s.includes('dmpolicy="open"')
  ) {
    return "critical";
  }
  if (s.includes("allows any") || s.includes("anyone can dm") || s.includes("public")) {
    return "critical";
  }
  if (s.includes("locked") || s.includes("disabled")) {
    return "info";
  }
  return "warn";
}

function dedupeFindings(findings: SecurityAuditFinding[]): SecurityAuditFinding[] {
  const seen = new Set<string>();
  const out: SecurityAuditFinding[] = [];
  for (const finding of findings) {
    const key = [
      finding.checkId,
      finding.severity,
      finding.title,
      finding.detail ?? "",
      finding.remediation ?? "",
    ].join("\n");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(finding);
  }
  return out;
}

function hasExplicitProviderAccountConfig(
  cfg: OpenClawConfig,
  provider: string,
  accountId: string,
): boolean {
  const channel = cfg.channels?.[provider];
  if (!channel || typeof channel !== "object") {
    return false;
  }
  const accounts = (channel as { accounts?: Record<string, unknown> }).accounts;
  if (!accounts || typeof accounts !== "object") {
    return false;
  }
  return Object.hasOwn(accounts, accountId);
}

function formatChannelAccountNote(params: {
  orderedAccountIds: string[];
  hasExplicitAccountPath: boolean;
  accountId: string;
}): string {
  return params.orderedAccountIds.length > 1 || params.hasExplicitAccountPath
    ? ` (account: ${params.accountId})`
    : "";
}

export async function collectChannelSecurityFindings(params: {
  cfg: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  plugins: ChannelPlugin[];
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const sourceConfig = params.sourceConfig ?? params.cfg;

  const inspectChannelAccount = async (
    plugin: (typeof params.plugins)[number],
    cfg: OpenClawConfig,
    accountId: string,
  ) => {
    if (plugin.config.inspectAccount) {
      return await plugin.config.inspectAccount(cfg, accountId);
    }
    return await inspectReadOnlyChannelAccount({
      channelId: plugin.id,
      cfg,
      accountId,
    });
  };

  const asAccountRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;

  const resolveChannelAuditAccount = async (
    plugin: (typeof params.plugins)[number],
    accountId: string,
  ) => {
    const diagnostics: string[] = [];
    const sourceInspectedAccount = await inspectChannelAccount(plugin, sourceConfig, accountId);
    const resolvedInspectedAccount = await inspectChannelAccount(plugin, params.cfg, accountId);
    const sourceInspection = sourceInspectedAccount as {
      enabled?: boolean;
      configured?: boolean;
    } | null;
    const resolvedInspection = resolvedInspectedAccount as {
      enabled?: boolean;
      configured?: boolean;
    } | null;
    let resolvedAccount = resolvedInspectedAccount;
    if (!resolvedAccount) {
      try {
        resolvedAccount = plugin.config.resolveAccount(params.cfg, accountId);
      } catch (error) {
        diagnostics.push(
          `${plugin.id}:${accountId}: failed to resolve account (${formatErrorMessage(error)}).`,
        );
      }
    }
    if (!resolvedAccount && sourceInspectedAccount) {
      resolvedAccount = sourceInspectedAccount;
    }
    if (!resolvedAccount) {
      return {
        account: {},
        enabled: false,
        configured: false,
        diagnostics,
      };
    }
    const useSourceUnavailableAccount = Boolean(
      sourceInspectedAccount &&
      hasConfiguredUnavailableCredentialStatus(sourceInspectedAccount) &&
      (!hasResolvedCredentialValue(resolvedAccount) ||
        (sourceInspection?.configured === true && resolvedInspection?.configured === false)),
    );
    const account = useSourceUnavailableAccount ? sourceInspectedAccount : resolvedAccount;
    const selectedInspection = useSourceUnavailableAccount ? sourceInspection : resolvedInspection;
    const accountRecord = asAccountRecord(account);
    let enabled =
      typeof selectedInspection?.enabled === "boolean"
        ? selectedInspection.enabled
        : typeof accountRecord?.enabled === "boolean"
          ? accountRecord.enabled
          : true;
    if (
      typeof selectedInspection?.enabled !== "boolean" &&
      typeof accountRecord?.enabled !== "boolean" &&
      plugin.config.isEnabled
    ) {
      try {
        enabled = plugin.config.isEnabled(account, params.cfg);
      } catch (error) {
        enabled = false;
        diagnostics.push(
          `${plugin.id}:${accountId}: failed to evaluate enabled state (${formatErrorMessage(error)}).`,
        );
      }
    }

    let configured =
      typeof selectedInspection?.configured === "boolean"
        ? selectedInspection.configured
        : typeof accountRecord?.configured === "boolean"
          ? accountRecord.configured
          : true;
    if (
      typeof selectedInspection?.configured !== "boolean" &&
      typeof accountRecord?.configured !== "boolean" &&
      plugin.config.isConfigured
    ) {
      try {
        configured = await plugin.config.isConfigured(account, params.cfg);
      } catch (error) {
        configured = false;
        diagnostics.push(
          `${plugin.id}:${accountId}: failed to evaluate configured state (${formatErrorMessage(error)}).`,
        );
      }
    }

    return { account, enabled, configured, diagnostics };
  };

  const warnDmPolicy = async (input: {
    label: string;
    provider: ChannelId;
    accountId: string;
    dmPolicy: string;
    allowFrom?: Array<string | number> | null;
    policyPath?: string;
    allowFromPath: string;
    normalizeEntry?: (raw: string) => string;
  }) => {
    const policyPath = input.policyPath ?? `${input.allowFromPath}policy`;
    const { hasWildcard, isMultiUserDm } = await resolveDmAllowState({
      provider: input.provider,
      accountId: input.accountId,
      allowFrom: input.allowFrom,
      dmPolicy: input.dmPolicy,
      normalizeEntry: input.normalizeEntry,
    });
    const dmScope = params.cfg.session?.dmScope ?? "main";

    if (input.dmPolicy === "open") {
      const allowFromKey = `${input.allowFromPath}allowFrom`;
      findings.push({
        checkId: `channels.${input.provider}.dm.open`,
        severity: "critical",
        title: `${input.label} DMs are open`,
        detail: `${policyPath}="open" allows anyone to DM the bot.`,
        remediation: `Use pairing/allowlist; if you really need open DMs, ensure ${allowFromKey} includes "*".`,
      });
      if (!hasWildcard) {
        findings.push({
          checkId: `channels.${input.provider}.dm.open_invalid`,
          severity: "warn",
          title: `${input.label} DM config looks inconsistent`,
          detail: `"open" requires ${allowFromKey} to include "*".`,
        });
      }
    }

    if (input.dmPolicy === "disabled") {
      findings.push({
        checkId: `channels.${input.provider}.dm.disabled`,
        severity: "info",
        title: `${input.label} DMs are disabled`,
        detail: `${policyPath}="disabled" ignores inbound DMs.`,
      });
      return;
    }

    if (dmScope === "main" && isMultiUserDm) {
      findings.push({
        checkId: `channels.${input.provider}.dm.scope_main_multiuser`,
        severity: "warn",
        title: `${input.label} DMs share the main session`,
        detail:
          "Multiple DM senders currently share the main session, which can leak context across users.",
        remediation:
          "Run: " +
          formatCliCommand('openclaw config set session.dmScope "per-channel-peer"') +
          ' (or "per-account-channel-peer" for multi-account channels) to isolate DM sessions per sender.',
      });
    }
  };

  for (const plugin of params.plugins) {
    if (!plugin.security) {
      continue;
    }
    const accountIds = plugin.config.listAccountIds(sourceConfig);
    const defaultAccountId = resolveChannelDefaultAccountId({
      plugin,
      cfg: sourceConfig,
      accountIds,
    });
    const orderedAccountIds = Array.from(new Set([defaultAccountId, ...accountIds]));

    for (const accountId of orderedAccountIds) {
      const hasExplicitAccountPath = hasExplicitProviderAccountConfig(
        sourceConfig,
        plugin.id,
        accountId,
      );
      const { account, enabled, configured, diagnostics } = await resolveChannelAuditAccount(
        plugin,
        accountId,
      );
      for (const diagnostic of diagnostics) {
        findings.push({
          checkId: `channels.${plugin.id}.account.read_only_resolution`,
          severity: "warn",
          title: `${plugin.meta.label ?? plugin.id} account could not be fully resolved`,
          detail: diagnostic,
          remediation:
            "Ensure referenced secrets are available in this shell or run with a running gateway snapshot so security audit can inspect the full channel configuration.",
        });
      }
      if (!enabled) {
        continue;
      }
      if (!configured) {
        continue;
      }

      const accountConfig = (account as { config?: Record<string, unknown> } | null | undefined)
        ?.config;
      if (isDangerousNameMatchingEnabled(accountConfig)) {
        const accountNote = formatChannelAccountNote({
          orderedAccountIds,
          hasExplicitAccountPath,
          accountId,
        });
        findings.push({
          checkId: `channels.${plugin.id}.allowFrom.dangerous_name_matching_enabled`,
          severity: "info",
          title: `${plugin.meta.label ?? plugin.id} dangerous name matching is enabled${accountNote}`,
          detail:
            "dangerouslyAllowNameMatching=true re-enables mutable name/email/tag matching for sender authorization. This is a break-glass compatibility mode, not a hardened default.",
          remediation:
            "Prefer stable sender IDs in allowlists, then disable dangerouslyAllowNameMatching.",
        });
      }

      const dmPolicy = plugin.security.resolveDmPolicy?.({
        cfg: params.cfg,
        accountId,
        account,
      });
      if (dmPolicy) {
        await warnDmPolicy({
          label: plugin.meta.label ?? plugin.id,
          provider: plugin.id,
          accountId,
          dmPolicy: dmPolicy.policy,
          allowFrom: dmPolicy.allowFrom,
          policyPath: dmPolicy.policyPath,
          allowFromPath: dmPolicy.allowFromPath,
          normalizeEntry: dmPolicy.normalizeEntry,
        });
      }

      if (plugin.security.collectWarnings) {
        const warnings = await plugin.security.collectWarnings({
          cfg: params.cfg,
          accountId,
          account,
        });
        for (const message of warnings ?? []) {
          const trimmed = message.trim();
          if (!trimmed) {
            continue;
          }
          findings.push({
            checkId: `channels.${plugin.id}.warning.${findings.length + 1}`,
            severity: classifyChannelWarningSeverity(trimmed),
            title: `${plugin.meta.label ?? plugin.id} security warning`,
            detail: trimmed.replace(/^-\s*/, ""),
          });
        }
      }
      if (plugin.security.collectAuditFindings) {
        const auditFindings = await plugin.security.collectAuditFindings({
          cfg: params.cfg,
          sourceConfig,
          accountId,
          account,
          orderedAccountIds,
          hasExplicitAccountPath,
        });
        for (const finding of auditFindings ?? []) {
          findings.push(finding);
        }
      }
    }
  }

  return dedupeFindings(findings);
}
