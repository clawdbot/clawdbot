import { note as clackNote } from "@clack/prompts";

import type { ClawdbotConfig } from "../config/config.js";
import { readProviderAllowFromStore } from "../pairing/pairing-store.js";
import { readTelegramAllowFromStore } from "../telegram/pairing-store.js";
import { resolveTelegramToken } from "../telegram/token.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";
import { normalizeE164 } from "../utils.js";

const note = (message: string, title?: string) =>
  clackNote(message, stylePromptTitle(title));

export async function noteSecurityWarnings(cfg: ClawdbotConfig) {
  const warnings: string[] = [];

  const warnDmPolicy = async (params: {
    label: string;
    provider:
      | "telegram"
      | "signal"
      | "imessage"
      | "discord"
      | "slack"
      | "whatsapp";
    dmPolicy: string;
    allowFrom?: Array<string | number> | null;
    allowFromPath: string;
    approveHint: string;
    normalizeEntry?: (raw: string) => string;
  }) => {
    const dmPolicy = params.dmPolicy;
    const configAllowFrom = (params.allowFrom ?? []).map((v) =>
      String(v).trim(),
    );
    const hasWildcard = configAllowFrom.includes("*");
    const storeAllowFrom = await readProviderAllowFromStore(
      params.provider,
    ).catch(() => []);
    const normalizedCfg = configAllowFrom
      .filter((v) => v !== "*")
      .map((v) => (params.normalizeEntry ? params.normalizeEntry(v) : v))
      .map((v) => v.trim())
      .filter(Boolean);
    const normalizedStore = storeAllowFrom
      .map((v) => (params.normalizeEntry ? params.normalizeEntry(v) : v))
      .map((v) => v.trim())
      .filter(Boolean);
    const allowCount = Array.from(
      new Set([...normalizedCfg, ...normalizedStore]),
    ).length;

    if (dmPolicy === "open") {
      const policyPath = `${params.allowFromPath}policy`;
      const allowFromPath = `${params.allowFromPath}allowFrom`;
      warnings.push(
        `- ${params.label} DMs: OPEN (${policyPath}="open"). Anyone can DM it.`,
      );
      if (!hasWildcard) {
        warnings.push(
          `- ${params.label} DMs: config invalid — "open" requires ${allowFromPath} to include "*".`,
        );
      }
      return;
    }

    if (dmPolicy === "disabled") {
      const policyPath = `${params.allowFromPath}policy`;
      warnings.push(
        `- ${params.label} DMs: disabled (${policyPath}="disabled").`,
      );
      return;
    }

    if (allowCount === 0) {
      const policyPath = `${params.allowFromPath}policy`;
      warnings.push(
        `- ${params.label} DMs: locked (${policyPath}="${dmPolicy}") with no allowlist; unknown senders will be blocked / get a pairing code.`,
      );
      warnings.push(`  ${params.approveHint}`);
    }
  };

  const telegramConfigured = Boolean(cfg.telegram);
  const { token: telegramToken } = resolveTelegramToken(cfg);
  if (telegramConfigured && telegramToken.trim()) {
    const dmPolicy = cfg.telegram?.dmPolicy ?? "pairing";
    const configAllowFrom = (cfg.telegram?.allowFrom ?? []).map((v) =>
      String(v).trim(),
    );
    const hasWildcard = configAllowFrom.includes("*");
    const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
    const allowCount = Array.from(
      new Set([
        ...configAllowFrom
          .filter((v) => v !== "*")
          .map((v) => v.replace(/^(telegram|tg):/i, ""))
          .filter(Boolean),
        ...storeAllowFrom.filter((v) => v !== "*"),
      ]),
    ).length;

    if (dmPolicy === "open") {
      warnings.push(
        `- Telegram DMs: OPEN (telegram.dmPolicy="open"). Anyone who can find the bot can DM it.`,
      );
      if (!hasWildcard) {
        warnings.push(
          `- Telegram DMs: config invalid — dmPolicy "open" requires telegram.allowFrom to include "*".`,
        );
      }
    } else if (dmPolicy === "disabled") {
      warnings.push(`- Telegram DMs: disabled (telegram.dmPolicy="disabled").`);
    } else if (allowCount === 0) {
      warnings.push(
        `- Telegram DMs: locked (telegram.dmPolicy="${dmPolicy}") with no allowlist; unknown senders will be blocked / get a pairing code.`,
      );
      warnings.push(
        `  Approve via: clawdbot pairing list telegram / clawdbot pairing approve telegram <code>`,
      );
    }

    const groupPolicy = cfg.telegram?.groupPolicy ?? "open";
    const groupAllowlistConfigured =
      cfg.telegram?.groups && Object.keys(cfg.telegram.groups).length > 0;
    if (groupPolicy === "open" && !groupAllowlistConfigured) {
      warnings.push(
        `- Telegram groups: open (groupPolicy="open") with no telegram.groups allowlist; mention-gating applies but any group can add + ping.`,
      );
    }
  }

  if (cfg.discord?.enabled !== false) {
    await warnDmPolicy({
      label: "Discord",
      provider: "discord",
      dmPolicy: cfg.discord?.dm?.policy ?? "pairing",
      allowFrom: cfg.discord?.dm?.allowFrom ?? [],
      allowFromPath: "discord.dm.",
      approveHint:
        "Approve via: clawdbot pairing list discord / clawdbot pairing approve discord <code>",
      normalizeEntry: (raw) =>
        raw.replace(/^(discord|user):/i, "").replace(/^<@!?(\d+)>$/, "$1"),
    });
  }

  if (cfg.slack?.enabled !== false) {
    await warnDmPolicy({
      label: "Slack",
      provider: "slack",
      dmPolicy: cfg.slack?.dm?.policy ?? "pairing",
      allowFrom: cfg.slack?.dm?.allowFrom ?? [],
      allowFromPath: "slack.dm.",
      approveHint:
        "Approve via: clawdbot pairing list slack / clawdbot pairing approve slack <code>",
      normalizeEntry: (raw) => raw.replace(/^(slack|user):/i, ""),
    });
  }

  if (cfg.signal?.enabled !== false) {
    await warnDmPolicy({
      label: "Signal",
      provider: "signal",
      dmPolicy: cfg.signal?.dmPolicy ?? "pairing",
      allowFrom: cfg.signal?.allowFrom ?? [],
      allowFromPath: "signal.",
      approveHint:
        "Approve via: clawdbot pairing list signal / clawdbot pairing approve signal <code>",
      normalizeEntry: (raw) =>
        normalizeE164(raw.replace(/^signal:/i, "").trim()),
    });
  }

  if (cfg.imessage?.enabled !== false) {
    await warnDmPolicy({
      label: "iMessage",
      provider: "imessage",
      dmPolicy: cfg.imessage?.dmPolicy ?? "pairing",
      allowFrom: cfg.imessage?.allowFrom ?? [],
      allowFromPath: "imessage.",
      approveHint:
        "Approve via: clawdbot pairing list imessage / clawdbot pairing approve imessage <code>",
    });
  }

  if (cfg.whatsapp) {
    await warnDmPolicy({
      label: "WhatsApp",
      provider: "whatsapp",
      dmPolicy: cfg.whatsapp?.dmPolicy ?? "pairing",
      allowFrom: cfg.whatsapp?.allowFrom ?? [],
      allowFromPath: "whatsapp.",
      approveHint:
        "Approve via: clawdbot pairing list whatsapp / clawdbot pairing approve whatsapp <code>",
      normalizeEntry: (raw) => normalizeE164(raw),
    });
  }

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Security");
  }
}
