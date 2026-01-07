import type { ClawdbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { normalizeE164 } from "../../utils.js";

export type OutboundProvider =
  | "whatsapp"
  | "telegram"
  | "discord"
  | "slack"
  | "matrix"
  | "signal"
  | "imessage"
  | "none";

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
  provider:
    | "whatsapp"
    | "telegram"
    | "discord"
    | "slack"
    | "matrix"
    | "signal"
    | "imessage"
    | "webchat";
  to?: string;
  allowFrom?: string[];
}): OutboundTargetResolution {
  const trimmed = params.to?.trim() || "";
  if (params.provider === "whatsapp") {
    if (trimmed) {
      return { ok: true, to: normalizeE164(trimmed) };
    }
    const fallback = params.allowFrom?.[0]?.trim();
    if (fallback) {
      return { ok: true, to: fallback };
    }
    return {
      ok: false,
      error: new Error(
        "Delivering to WhatsApp requires --to <E.164> or whatsapp.allowFrom[0]",
      ),
    };
  }
  if (params.provider === "telegram") {
    if (!trimmed) {
      return {
        ok: false,
        error: new Error("Delivering to Telegram requires --to <chatId>"),
      };
    }
    return { ok: true, to: trimmed };
  }
  if (params.provider === "discord") {
    if (!trimmed) {
      return {
        ok: false,
        error: new Error(
          "Delivering to Discord requires --to <channelId|user:ID|channel:ID>",
        ),
      };
    }
    return { ok: true, to: trimmed };
  }
  if (params.provider === "slack") {
    if (!trimmed) {
      return {
        ok: false,
        error: new Error(
          "Delivering to Slack requires --to <channelId|user:ID|channel:ID>",
        ),
      };
    }
    return { ok: true, to: trimmed };
  }
  if (params.provider === "matrix") {
    if (!trimmed) {
      return {
        ok: false,
        error: new Error(
          "Delivering to Matrix requires --to <roomId|room:ID|#alias|@user>",
        ),
      };
    }
    return { ok: true, to: trimmed };
  }
  if (params.provider === "signal") {
    if (!trimmed) {
      return {
        ok: false,
        error: new Error(
          "Delivering to Signal requires --to <E.164|group:ID|signal:group:ID|signal:+E.164>",
        ),
      };
    }
    return { ok: true, to: trimmed };
  }
  if (params.provider === "imessage") {
    if (!trimmed) {
      return {
        ok: false,
        error: new Error(
          "Delivering to iMessage requires --to <handle|chat_id:ID>",
        ),
      };
    }
    return { ok: true, to: trimmed };
  }
  return {
    ok: false,
    error: new Error(
      "Delivering to WebChat is not supported via `clawdbot agent`; use WhatsApp/Telegram or run with --deliver=false.",
    ),
  };
}

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
    rawTarget === "matrix" ||
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
    | "matrix"
    | "signal"
    | "imessage"
    | undefined =
    target === "last"
      ? lastProvider
      : target === "whatsapp" ||
          target === "telegram" ||
          target === "discord" ||
          target === "slack" ||
          target === "matrix" ||
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
    const resolved = resolveOutboundTarget({ provider, to });
    return resolved.ok
      ? { provider, to: resolved.to }
      : { provider: "none", reason: "no-target" };
  }

  const rawAllow = cfg.whatsapp?.allowFrom ?? [];
  const resolved = resolveOutboundTarget({
    provider: "whatsapp",
    to,
    allowFrom: rawAllow,
  });
  if (!resolved.ok) {
    return { provider: "none", reason: "no-target" };
  }
  if (rawAllow.includes("*")) return { provider, to: resolved.to };
  const allowFrom = rawAllow
    .map((val) => normalizeE164(val))
    .filter((val) => val.length > 1);
  if (allowFrom.length === 0) return { provider, to: resolved.to };
  if (allowFrom.includes(resolved.to)) return { provider, to: resolved.to };
  return { provider, to: allowFrom[0], reason: "allowFrom-fallback" };
}
