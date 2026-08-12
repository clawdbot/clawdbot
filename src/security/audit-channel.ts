import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
// Audits channel configuration for exposure, auth, and trust risks.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  hasConfiguredUnavailableCredentialStatus,
  hasResolvedCredentialValue,
} from "../channels/account-snapshot-fields.js";
import { resolveDmAllowAuditState } from "../channels/message-access/dm-allow-state.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { inspectReadOnlyChannelAccount } from "../channels/read-only-account-inspect.js";
import { isDangerousNameMatchingEnabled } from "../config/dangerous-name-matching.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  listExactDirectMessageBindingPeerIds,
  resolveAgentRoute,
  resolveUnknownDirectMessageRoute,
  type ResolvedAgentRoute,
} from "../routing/resolve-route.js";
import { parseSessionDeliveryRoute, resolveLinkedDirectPeerId } from "../routing/session-key.js";
import type { SecurityAuditFinding, SecurityAuditSeverity } from "./audit.types.js";

type DmPrincipalRoute = {
  accountKey: string;
  logicalPrincipalKey: string;
  bucketKey: string;
};

/** Classify free-form channel warnings into audit severities. */
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

/** Collect channel-specific security findings across active channel plugins/accounts. */
export async function collectChannelSecurityFindingsCore(params: {
  cfg: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  plugins: ChannelPlugin[];
  mode?: "audit" | "doctor";
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const principalRoutes: DmPrincipalRoute[] = [];
  const sourceConfig = params.sourceConfig ?? params.cfg;
  const includeAuditOnly = params.mode !== "doctor";
  const recordPrincipal = (
    plugin: ChannelPlugin,
    route: ResolvedAgentRoute,
    sessionKey: string,
    logicalPrincipalKey: string,
    indexNamespaces = false,
  ) => {
    const canonicalKey = canonicalizeMainSessionAlias({
      cfg: params.cfg,
      agentId: route.agentId,
      sessionKey,
    });
    const principal = {
      accountKey: `${plugin.id}-${route.accountId}`,
      logicalPrincipalKey,
      bucketKey: `${route.agentId}\0${canonicalKey}`,
    };
    principalRoutes.push(principal);
    if (!indexNamespaces) {
      return;
    }
    const parsed = parseSessionDeliveryRoute(canonicalKey);
    const directChannel =
      parsed?.peerKind === "direct" || parsed?.peerKind === "dm" ? parsed.channel : undefined;
    if (directChannel || (sessionKey === route.sessionKey && route.dmScope === "per-peer")) {
      principalRoutes.push({ ...principal, bucketKey: `${route.agentId}\0symbolic:dm:peer` });
    }
    if (directChannel) {
      principalRoutes.push({
        ...principal,
        bucketKey: `${route.agentId}\0symbolic:dm:channel:${directChannel}`,
      });
    }
  };

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
      // Secret resolution can replace a configured account with an unresolved
      // placeholder. Use source config when needed so audits still explain the
      // originally configured credential surface.
      sourceInspectedAccount &&
      hasConfiguredUnavailableCredentialStatus(sourceInspectedAccount) &&
      (!hasResolvedCredentialValue(resolvedAccount) ||
        (sourceInspection?.configured === true && resolvedInspection?.configured === false)),
    );
    const account = useSourceUnavailableAccount ? sourceInspectedAccount : resolvedAccount;
    const selectedInspection = useSourceUnavailableAccount ? sourceInspection : resolvedInspection;
    const accountRecord = asNullableRecord(account);
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
    approveHint: string;
    normalizeEntry?: (raw: string) => string;
  }) => {
    const policyPath = input.policyPath ?? `${input.allowFromPath}policy`;
    // DM allowlist audit may need channel-specific normalization and async
    // account ownership checks before classifying open/multi-user exposure.
    const auditState = await resolveDmAllowAuditState({
      provider: input.provider,
      accountId: input.accountId,
      allowFrom: input.allowFrom,
      dmPolicy: input.dmPolicy,
      normalizeEntry: input.normalizeEntry,
    });
    const { hasWildcard } = auditState;

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
      return auditState;
    }

    if (input.dmPolicy !== "open" && auditState.admittedPrincipals.length === 0) {
      findings.push({
        checkId: `channels.${input.provider}.dm.locked`,
        severity: "info",
        title: `${input.label} DMs are locked`,
        detail: `${policyPath}="${input.dmPolicy}" has no admitted senders; unknown senders are blocked or receive a pairing code.`,
        remediation: input.approveHint,
      });
    }
    return auditState;
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
    const orderedAccountIds = uniqueStrings([defaultAccountId, ...accountIds]);

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
          title: `[secrets] ${plugin.meta.label ?? plugin.id} account could not be fully resolved`,
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

      const accountNote = formatChannelAccountNote({
        orderedAccountIds,
        hasExplicitAccountPath,
        accountId,
      });
      const accountConfig = (account as { config?: Record<string, unknown> } | null | undefined)
        ?.config;
      if (includeAuditOnly && isDangerousNameMatchingEnabled(accountConfig)) {
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
        const auditState = await warnDmPolicy({
          label: `${plugin.meta.label ?? plugin.id}${accountNote}`,
          provider: plugin.id,
          accountId,
          dmPolicy: dmPolicy.policy,
          allowFrom: dmPolicy.allowFrom,
          policyPath: dmPolicy.policyPath,
          allowFromPath: dmPolicy.allowFromPath,
          approveHint: dmPolicy.approveHint,
          normalizeEntry: dmPolicy.normalizeEntry,
        });
        if (dmPolicy.policy !== "disabled") {
          const dmRouting = plugin.security.dmRouting;
          const admittedPrincipals = uniqueStrings([
            ...auditState.admittedPrincipals,
            ...(auditState.hasWildcard
              ? listExactDirectMessageBindingPeerIds({
                  cfg: params.cfg,
                  channel: plugin.id,
                  accountId,
                })
              : []),
          ]);
          for (const principalId of admittedPrincipals) {
            const principalContext = { cfg: params.cfg, accountId, account, principalId };
            const channelDmScope = dmRouting?.resolveDmScope?.(principalContext);
            const route = resolveAgentRoute({
              cfg: params.cfg,
              channel: plugin.id,
              accountId,
              peer: { kind: "direct", id: principalId },
              dmScope: channelDmScope,
            });
            const result = dmRouting?.resolveDmRoute?.({ ...principalContext, route });
            const sessionKey =
              result && "sessionKey" in result ? result.sessionKey : route.sessionKey;
            const linkedIdentity = resolveLinkedDirectPeerId({
              identityLinks: params.cfg.session?.identityLinks,
              channel: plugin.id,
              peerId: principalId,
            });
            recordPrincipal(
              plugin,
              route,
              sessionKey,
              linkedIdentity
                ? `linked:${normalizeLowercaseStringOrEmpty(linkedIdentity)}`
                : `direct:${plugin.id}:${route.accountId}:${normalizeLowercaseStringOrEmpty(principalId)}`,
              true,
            );
          }
          if (auditState.hasWildcard) {
            const unknownContext = { cfg: params.cfg, accountId, account };
            const route = resolveUnknownDirectMessageRoute({
              cfg: params.cfg,
              channel: plugin.id,
              accountId,
              dmScope: dmRouting?.resolveDmScope?.(unknownContext),
            });
            const customRoute = dmRouting?.resolveDmRoute;
            const result = customRoute?.({ ...unknownContext, route });
            if (customRoute && !result) {
              findings.push({
                checkId: `channels.${plugin.id}.dm.wildcard_routing_unverified.${route.accountId}`,
                severity: "warn",
                title: `${plugin.meta.label ?? plugin.id}${accountNote} wildcard DM isolation is unverified`,
                detail:
                  "dmRouting.resolveDmRoute returned no unknown-principal policy; isolation for arbitrary senders cannot be established.",
              });
            }
            const useCoreRoute =
              !customRoute || Boolean(result && "kind" in result && result.kind === "core");
            const sessionKey =
              result && "sessionKey" in result
                ? result.sessionKey
                : useCoreRoute && route.dmScope === "main"
                  ? route.sessionKey
                  : undefined;
            if (sessionKey) {
              for (const suffix of ["1", "2"]) {
                recordPrincipal(
                  plugin,
                  route,
                  sessionKey,
                  `wildcard:shared:${plugin.id}-${route.accountId}:${suffix}`,
                );
              }
            } else if (
              useCoreRoute &&
              (route.dmScope === "per-channel-peer" || route.dmScope === "per-peer")
            ) {
              const namespaces =
                route.dmScope === "per-peer" ? ["peer"] : [`channel:${plugin.id}`, "peer"];
              for (const namespace of namespaces) {
                principalRoutes.push({
                  accountKey: `${plugin.id}-${route.accountId}`,
                  logicalPrincipalKey: `wildcard:${route.dmScope}:${plugin.id}-${route.accountId}`,
                  bucketKey: `${route.agentId}\0symbolic:dm:${namespace}`,
                });
              }
            }
          }
        }
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
      if (includeAuditOnly && plugin.security.collectAuditFindings) {
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

  const routesByBucket = new Map<string, DmPrincipalRoute[]>();
  for (const route of principalRoutes) {
    const routes = routesByBucket.get(route.bucketKey) ?? [];
    routes.push(route);
    routesByBucket.set(route.bucketKey, routes);
  }
  const groupedRoutes = [...routesByBucket.entries()].filter(
    ([, routes]) => new Set(routes.map((route) => route.logicalPrincipalKey)).size > 1,
  );
  const broadWildcardAgents = new Set(
    groupedRoutes
      .filter(
        ([bucketKey, routes]) =>
          bucketKey.endsWith("\0symbolic:dm:peer") &&
          routes.some((route) => route.logicalPrincipalKey.startsWith("wildcard:per-peer:")),
      )
      .map(([bucketKey]) => bucketKey.split("\0", 1)[0]),
  );
  const collisions = groupedRoutes
    .filter(([bucketKey, routes]) => {
      if (!bucketKey.includes("\0symbolic:")) {
        return true;
      }
      const agentId = bucketKey.split("\0", 1)[0];
      if (bucketKey.endsWith("\0symbolic:dm:peer")) {
        return routes.some((route) => route.logicalPrincipalKey.startsWith("wildcard:per-peer:"));
      }
      return (
        !broadWildcardAgents.has(agentId) &&
        routes.some((route) => route.logicalPrincipalKey.startsWith("wildcard:per-channel-peer:"))
      );
    })
    .toSorted(([left], [right]) => left.localeCompare(right));
  for (const [collisionIndex, [bucketKey, routes]] of collisions.entries()) {
    const accountKeys = uniqueStrings(routes.map((route) => route.accountKey)).toSorted();
    const symbolic = bucketKey.includes("\0symbolic:");
    findings.push({
      checkId: `channels.dm.session_collision.${accountKeys.join("_")}.${collisionIndex + 1}`,
      severity: "warn",
      title: symbolic ? "DM principals may share a session" : "DM principals share a session",
      detail:
        `Collision topology ${collisionIndex + 1}: ${new Set(routes.map((route) => route.logicalPrincipalKey)).size} distinct admitted DM principals from ${accountKeys.join(", ")} ` +
        `${symbolic ? "can resolve" : "resolve"} to the same session bucket owned by agent "${bucketKey.split("\0", 1)[0]}"` +
        (params.cfg.session?.scope === "global" ? ' under session.scope="global".' : ".") +
        " This can leak context across users.",
      remediation:
        "Set the effective DM route to an account-safe isolated scope; update the matching binding or session.dmScope as applicable.",
    });
  }

  return dedupeFindings(findings);
}
