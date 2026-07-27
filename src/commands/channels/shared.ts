// Shared config loading and account-line formatting helpers for channel commands.
import { hasConfiguredUnavailableCredentialStatus } from "../../channels/account-snapshot-fields.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { resolveCommandConfigWithSecrets } from "../../cli/command-config-resolution.js";
import type { CommandSecretResolutionMode } from "../../cli/command-secret-gateway.js";
import { getChannelsCommandSecretTargetIds } from "../../cli/command-secret-targets.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import {
  requireValidConfigFileSnapshot,
  requireValidConfigSnapshot,
} from "../config-validation.js";

export type ChatChannel = ChannelId;

export { requireValidConfigSnapshot };
export { requireValidConfigFileSnapshot };

/** Load valid channel command config with read-only secret resolution applied. */
export async function requireValidConfig(
  runtime: RuntimeEnv = defaultRuntime,
  secretResolution?: {
    commandName?: string;
    mode?: CommandSecretResolutionMode;
  },
): Promise<OpenClawConfig | null> {
  const cfg = await requireValidConfigSnapshot(runtime);
  if (!cfg) {
    return null;
  }
  const { effectiveConfig } = await resolveCommandConfigWithSecrets({
    config: cfg,
    commandName: secretResolution?.commandName ?? "channels",
    targetIds: getChannelsCommandSecretTargetIds(),
    mode: secretResolution?.mode,
    runtime,
  });
  return effectiveConfig;
}

function formatAccountLabel(params: { accountId: string; name?: string }) {
  const base = params.accountId || DEFAULT_ACCOUNT_ID;
  if (params.name?.trim()) {
    return `${base} (${params.name.trim()})`;
  }
  return base;
}

/** Format a channel/account label with optional display styles for terminal output. */
export function formatChannelAccountLabel(params: {
  channel: ChatChannel;
  accountId: string;
  name?: string;
  channelLabel?: string;
  channelStyle?: (value: string) => string;
  accountStyle?: (value: string) => string;
}): string {
  const channelText = params.channelLabel ?? params.channel;
  const accountText = formatAccountLabel({
    accountId: params.accountId,
    name: params.name,
  });
  const styledChannel = params.channelStyle ? params.channelStyle(channelText) : channelText;
  const styledAccount = params.accountStyle ? params.accountStyle(accountText) : accountText;
  return `${styledChannel} ${styledAccount}`;
}

/** Append common enabled/configured/linked status fragments for account output. */
export function appendEnabledConfiguredLinkedBits(
  bits: string[],
  account: Record<string, unknown>,
) {
  if (typeof account.enabled === "boolean") {
    bits.push(account.enabled ? "enabled" : "disabled");
  }
  if (typeof account.configured === "boolean") {
    if (account.configured) {
      bits.push("configured");
      if (hasConfiguredUnavailableCredentialStatus(account)) {
        bits.push("secret unavailable in this command path");
      }
    } else {
      bits.push("not configured");
    }
  }
  if (typeof account.linked === "boolean") {
    bits.push(account.linked ? "linked" : "not linked");
  }
}

/** Append account mode metadata when present. */
export function appendModeBit(bits: string[], account: Record<string, unknown>) {
  if (typeof account.mode === "string" && account.mode.length > 0) {
    bits.push(`mode:${account.mode}`);
  }
}

/** Append credential source fragments, preserving unavailable-secret state. */
export function appendTokenSourceBits(bits: string[], account: Record<string, unknown>) {
  const appendSourceBit = (label: string, sourceKey: string, statusKey: string) => {
    const source = account[sourceKey];
    if (typeof source !== "string" || !source || source === "none") {
      return;
    }
    const status = account[statusKey];
    const unavailable = status === "configured_unavailable" ? " (unavailable)" : "";
    bits.push(`${label}:${source}${unavailable}`);
  };

  appendSourceBit("token", "tokenSource", "tokenStatus");
  appendSourceBit("bot", "botTokenSource", "botTokenStatus");
  appendSourceBit("app", "appTokenSource", "appTokenStatus");
  appendSourceBit("signing", "signingSecretSource", "signingSecretStatus");
}

/** Append account base URL metadata when present. */
export function appendBaseUrlBit(bits: string[], account: Record<string, unknown>) {
  if (typeof account.baseUrl === "string" && account.baseUrl) {
    bits.push(`url:${account.baseUrl}`);
  }
}

/** Build a complete human-readable channel account status line. */
export function buildChannelAccountLine(
  provider: ChatChannel,
  account: Record<string, unknown>,
  bits: string[],
  opts?: { channelLabel?: string },
): string {
  const accountId = typeof account.accountId === "string" ? account.accountId : DEFAULT_ACCOUNT_ID;
  const name = typeof account.name === "string" ? account.name : undefined;
  const labelText = formatChannelAccountLabel({
    channel: provider,
    accountId,
    name,
    channelLabel: opts?.channelLabel,
  });
  return `- ${labelText}: ${bits.join(", ")}`;
}

/** Return true when the command should use its interactive wizard path. */
export function shouldUseWizard(params?: { hasFlags?: boolean }) {
  return params?.hasFlags === false;
}
