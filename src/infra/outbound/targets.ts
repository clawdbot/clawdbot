import type { ClawdbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  getProviderPlugin,
  normalizeProviderId,
} from "../../providers/plugins/index.js";
import type {
  ProviderId,
  ProviderOutboundTargetMode,
} from "../../providers/plugins/types.js";
import type {
  DeliverableMessageProvider,
  GatewayMessageProvider,
} from "../../utils/message-provider.js";

export type OutboundProvider = DeliverableMessageProvider | "none";

export type HeartbeatTarget = OutboundProvider | "last";

export type OutboundTarget = {
  provider: OutboundProvider;
  to?: string;
  reason?: string;
};

export type OutboundTargetResolution =
  | { ok: true; to: string }
  | { ok: false; error: Error };

export function resolveOutboundTarget(params: {
  provider: GatewayMessageProvider;
  to?: string;
  allowFrom?: string[];
  cfg?: ClawdbotConfig;
  accountId?: string | null;
  mode?: ProviderOutboundTargetMode;
}): OutboundTargetResolution {
  if (params.provider === "webchat") {
    return {
      ok: false,
      error: new Error(
        "Delivering to WebChat is not supported via `clawdbot agent`; use WhatsApp/Telegram or run with --deliver=false.",
      ),
    };
  }

  const plugin = getProviderPlugin(params.provider as ProviderId);
  if (!plugin) {
    return {
      ok: false,
      error: new Error(`Unsupported provider: ${params.provider}`),
    };
  }

  const allowFrom =
    params.allowFrom ??
    (params.cfg && plugin.config.resolveAllowFrom
      ? plugin.config.resolveAllowFrom({
          cfg: params.cfg,
          accountId: params.accountId ?? undefined,
        })
      : undefined);

  const resolveTarget = plugin.outbound?.resolveTarget;
  if (resolveTarget) {
    return resolveTarget({
      cfg: params.cfg,
      to: params.to,
      allowFrom,
      accountId: params.accountId ?? undefined,
      mode: params.mode ?? "explicit",
    });
  }

  const trimmed = params.to?.trim();
  if (trimmed) {
    return { ok: true, to: trimmed };
  }
  return {
    ok: false,
    error: new Error(`Delivering to ${plugin.meta.label} requires --to`),
  };
}

export function resolveHeartbeatDeliveryTarget(params: {
  cfg: ClawdbotConfig;
  entry?: SessionEntry;
}): OutboundTarget {
  const { cfg, entry } = params;
  const rawTarget = cfg.agents?.defaults?.heartbeat?.target;
  let target: HeartbeatTarget = "last";
  if (rawTarget === "none" || rawTarget === "last") {
    target = rawTarget;
  } else if (typeof rawTarget === "string") {
    const normalized = normalizeProviderId(rawTarget);
    if (normalized) target = normalized;
  }

  if (target === "none") {
    return { provider: "none", reason: "target-none" };
  }

  const explicitTo =
    typeof cfg.agents?.defaults?.heartbeat?.to === "string" &&
    cfg.agents.defaults.heartbeat.to.trim()
      ? cfg.agents.defaults.heartbeat.to.trim()
      : undefined;

  const lastProvider =
    entry?.lastProvider && entry.lastProvider !== "webchat"
      ? normalizeProviderId(entry.lastProvider)
      : undefined;
  const lastTo = typeof entry?.lastTo === "string" ? entry.lastTo.trim() : "";
  const provider = target === "last" ? lastProvider : target;

  const to =
    explicitTo ||
    (provider && lastProvider === provider ? lastTo : undefined) ||
    (target === "last" ? lastTo : undefined);

  if (!provider || !to) {
    return { provider: "none", reason: "no-target" };
  }

  const accountId =
    provider === lastProvider ? entry?.lastAccountId : undefined;
  const resolved = resolveOutboundTarget({
    provider,
    to,
    cfg,
    accountId,
    mode: "heartbeat",
  });
  if (!resolved.ok) {
    return { provider: "none", reason: "no-target" };
  }

  let reason: string | undefined;
  const plugin = getProviderPlugin(provider as ProviderId);
  if (plugin?.config.resolveAllowFrom) {
    const explicit = resolveOutboundTarget({
      provider,
      to,
      cfg,
      accountId,
      mode: "explicit",
    });
    if (explicit.ok && explicit.to !== resolved.to) {
      reason = "allowFrom-fallback";
    }
  }

  return reason
    ? { provider, to: resolved.to, reason }
    : { provider, to: resolved.to };
}
