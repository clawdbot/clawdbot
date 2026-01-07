import type { ClawdbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { normalizeE164 } from "../../utils.js";

export type OutboundProvider =
  | "whatsapp"
  | "telegram"
  | "discord"
  | "slack"
  | "signal"
  | "imessage"
  | "none";

export type HeartbeatTarget = OutboundProvider | "last";

export type OutboundTarget = {
  provider: OutboundProvider;
  to?: string;
  reason?: string;
};

export function resolveHeartbeatDeliveryTarget(params: {
  cfg: ClawdbotConfig;
  entry?: SessionEntry;
}): OutboundTarget {
  const { cfg, entry } = params;
  const rawTarget = cfg.agent?.heartbeat?.target;
  const target: HeartbeatTarget =
    rawTarget === "whatsapp" ||
    rawTarget === "telegram" ||
    rawTarget === "discord" ||
    rawTarget === "slack" ||
    rawTarget === "signal" ||
    rawTarget === "imessage" ||
    rawTarget === "none" ||
    rawTarget === "last"
      ? rawTarget
      : "last";
  if (target === "none") {
    return { provider: "none", reason: "target-none" };
  }

  const explicitTo =
    typeof cfg.agent?.heartbeat?.to === "string" &&
    cfg.agent.heartbeat.to.trim()
      ? cfg.agent.heartbeat.to.trim()
      : undefined;

  const lastProvider =
    entry?.lastProvider && entry.lastProvider !== "webchat"
      ? entry.lastProvider
      : undefined;
  const lastTo = typeof entry?.lastTo === "string" ? entry.lastTo.trim() : "";

  const provider:
    | "whatsapp"
    | "telegram"
    | "discord"
    | "slack"
    | "signal"
    | "imessage"
    | undefined =
    target === "last"
      ? lastProvider
      : target === "whatsapp" ||
          target === "telegram" ||
          target === "discord" ||
          target === "slack" ||
          target === "signal" ||
          target === "imessage"
        ? target
        : undefined;

  const to =
    explicitTo ||
    (provider && lastProvider === provider ? lastTo : undefined) ||
    (target === "last" ? lastTo : undefined);

  if (!provider || !to) {
    return { provider: "none", reason: "no-target" };
  }

  if (provider !== "whatsapp") {
    return { provider, to };
  }

  const rawAllow = cfg.whatsapp?.allowFrom ?? [];
  if (rawAllow.includes("*")) return { provider, to };
  const allowFrom = rawAllow
    .map((val) => normalizeE164(val))
    .filter((val) => val.length > 1);
  if (allowFrom.length === 0) return { provider, to };

  const normalized = normalizeE164(to);
  if (allowFrom.includes(normalized)) return { provider, to: normalized };
  return { provider, to: allowFrom[0], reason: "allowFrom-fallback" };
}
