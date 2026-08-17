import { matchesApprovalRequestFilters } from "openclaw/plugin-sdk/approval-client-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSignalTarget } from "./aliases.js";
import { normalizeSignalMessagingTarget } from "./normalize.js";

type ApprovalForwardingConfig = NonNullable<NonNullable<OpenClawConfig["approvals"]>["exec"]>;
type ApprovalForwardingMode = NonNullable<ApprovalForwardingConfig["mode"]>;

export type SignalApprovalReactionRoute =
  | {
      deliveryMode: "session";
      agentId?: string;
      sessionKey?: string;
    }
  | {
      deliveryMode: "target";
      to: string;
      accountId?: string;
      agentId?: string;
      sessionKey?: string;
    };

function resolveApprovalForwardingConfig(params: {
  cfg: OpenClawConfig;
  approvalKind: "exec" | "plugin";
}): ApprovalForwardingConfig | undefined {
  return params.approvalKind === "plugin"
    ? params.cfg.approvals?.plugin
    : params.cfg.approvals?.exec;
}

function normalizeApprovalForwardingMode(
  mode: ApprovalForwardingConfig["mode"] | undefined,
): ApprovalForwardingMode {
  return mode ?? "session";
}

function approvalModeIncludesSession(mode: ApprovalForwardingMode): boolean {
  return mode === "session" || mode === "both";
}

function approvalModeIncludesTargets(mode: ApprovalForwardingMode): boolean {
  return mode === "targets" || mode === "both";
}

function matchesSignalApprovalReactionFilters(params: {
  config: ApprovalForwardingConfig;
  route: Pick<SignalApprovalReactionRoute, "agentId" | "sessionKey">;
}): boolean {
  return matchesApprovalRequestFilters({
    request: {
      agentId: params.route.agentId,
      sessionKey: params.route.sessionKey,
    },
    agentFilter: params.config.agentFilter,
    sessionFilter: params.config.sessionFilter,
    fallbackAgentIdFromSessionKey: true,
  });
}

function targetAccountMatches(params: {
  routeAccountId?: string | null;
  configuredAccountId?: string | null;
}): boolean {
  const configuredAccountId = normalizeOptionalString(params.configuredAccountId);
  if (!configuredAccountId) {
    return true;
  }
  const routeAccountId = normalizeOptionalString(params.routeAccountId);
  return Boolean(
    routeAccountId &&
    normalizeAccountId(routeAccountId) === normalizeAccountId(configuredAccountId),
  );
}

function resolveSignalApprovalRouteTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
}): string | null {
  try {
    return (
      resolveSignalTarget({
        cfg: params.cfg,
        accountId: params.accountId,
        input: params.to,
      })?.to ??
      normalizeSignalMessagingTarget(params.to) ??
      null
    );
  } catch {
    return null;
  }
}

function hasMatchingSignalApprovalReactionTarget(params: {
  cfg: OpenClawConfig;
  config: ApprovalForwardingConfig;
  route: Extract<SignalApprovalReactionRoute, { deliveryMode: "target" }>;
}): boolean {
  return (params.config.targets ?? []).some((target) => {
    if (normalizeLowercaseStringOrEmpty(target.channel) !== "signal") {
      return false;
    }
    const configuredTo = resolveSignalApprovalRouteTarget({
      cfg: params.cfg,
      accountId: target.accountId ?? params.route.accountId,
      to: target.to,
    });
    if (!configuredTo || configuredTo !== params.route.to) {
      return false;
    }
    return targetAccountMatches({
      routeAccountId: params.route.accountId,
      configuredAccountId: target.accountId,
    });
  });
}

export function isSignalApprovalReactionRouteStillEnabled(params: {
  cfg: OpenClawConfig;
  target: {
    approvalKind: "exec" | "plugin";
    route: SignalApprovalReactionRoute;
  };
}): boolean {
  const config = resolveApprovalForwardingConfig({
    cfg: params.cfg,
    approvalKind: params.target.approvalKind,
  });
  if (!config?.enabled) {
    return false;
  }
  const mode = normalizeApprovalForwardingMode(config.mode);
  if (params.target.route.deliveryMode === "target") {
    return (
      approvalModeIncludesTargets(mode) &&
      matchesSignalApprovalReactionFilters({ config, route: params.target.route }) &&
      hasMatchingSignalApprovalReactionTarget({
        cfg: params.cfg,
        config,
        route: params.target.route,
      })
    );
  }
  if (!approvalModeIncludesSession(mode)) {
    return false;
  }
  return matchesSignalApprovalReactionFilters({ config, route: params.target.route });
}

export function buildTargetRoute(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  approvalKind: "exec" | "plugin";
  agentId?: string | null;
  sessionKey?: string | null;
}): Extract<SignalApprovalReactionRoute, { deliveryMode: "target" }> | null {
  const to = resolveSignalApprovalRouteTarget({
    cfg: params.cfg,
    accountId: params.accountId,
    to: params.to,
  });
  if (!to) {
    return null;
  }
  const route: Extract<SignalApprovalReactionRoute, { deliveryMode: "target" }> = {
    deliveryMode: "target",
    to,
    ...(normalizeOptionalString(params.accountId)
      ? { accountId: normalizeOptionalString(params.accountId) }
      : {}),
    ...(normalizeOptionalString(params.agentId)
      ? { agentId: normalizeOptionalString(params.agentId) }
      : {}),
    ...(normalizeOptionalString(params.sessionKey)
      ? { sessionKey: normalizeOptionalString(params.sessionKey) }
      : {}),
  };
  return isSignalApprovalReactionRouteStillEnabled({
    cfg: params.cfg,
    target: {
      approvalKind: params.approvalKind,
      route,
    },
  })
    ? route
    : null;
}
