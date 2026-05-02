import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import {
  resolveChannelStreamingBlockCoalesce,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingChunkMode,
} from "openclaw/plugin-sdk/channel-streaming";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { normalizeResolvedSecretInputString, normalizeSecretInputString } from "../secret-input.js";
import type {
  MattermostAccountConfig,
  MattermostChatMode,
  MattermostChatTypeKey,
  MattermostReplyToMode,
} from "../types.js";
import { normalizeMattermostBaseUrl } from "./client.js";
import type { OpenClawConfig } from "./runtime-api.js";

type MattermostTokenSource = "env" | "config" | "none";
type MattermostBaseUrlSource = "env" | "config" | "none";

export type ResolvedMattermostAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  botToken?: string;
  baseUrl?: string;
  botTokenSource: MattermostTokenSource;
  baseUrlSource: MattermostBaseUrlSource;
  config: MattermostAccountConfig;
  chatmode?: MattermostChatMode;
  oncharPrefixes?: string[];
  requireMention?: boolean;
  textChunkLimit?: number;
  chunkMode?: MattermostAccountConfig["chunkMode"];
  blockStreaming?: boolean;
  blockStreamingCoalesce?: MattermostAccountConfig["blockStreamingCoalesce"];
};

const mattermostAccountHelpers = createAccountListHelpers("mattermost");

export function listMattermostAccountIds(cfg: OpenClawConfig): string[] {
  return mattermostAccountHelpers.listAccountIds(cfg);
}

export function resolveDefaultMattermostAccountId(cfg: OpenClawConfig): string {
  return mattermostAccountHelpers.resolveDefaultAccountId(cfg);
}

function mergeMattermostAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): MattermostAccountConfig {
  return resolveMergedAccountConfig<MattermostAccountConfig>({
    channelConfig: cfg.channels?.mattermost as MattermostAccountConfig | undefined,
    accounts: cfg.channels?.mattermost?.accounts as
      | Record<string, Partial<MattermostAccountConfig>>
      | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
    nestedObjectKeys: ["commands"],
  });
}

function resolveMattermostRequireMention(config: MattermostAccountConfig): boolean | undefined {
  if (config.chatmode === "oncall") {
    return true;
  }
  if (config.chatmode === "onmessage") {
    return false;
  }
  if (config.chatmode === "onchar") {
    return true;
  }
  return config.requireMention;
}

export function resolveMattermostAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  allowUnresolvedSecretRef?: boolean;
}): ResolvedMattermostAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultMattermostAccountId(params.cfg),
  );
  const baseEnabled = params.cfg.channels?.mattermost?.enabled !== false;
  const merged = mergeMattermostAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv ? process.env.MATTERMOST_BOT_TOKEN?.trim() : undefined;
  const envUrl = allowEnv ? process.env.MATTERMOST_URL?.trim() : undefined;
  const configToken = params.allowUnresolvedSecretRef
    ? normalizeSecretInputString(merged.botToken)
    : normalizeResolvedSecretInputString({
        value: merged.botToken,
        path: `channels.mattermost.accounts.${accountId}.botToken`,
      });
  const configUrl = merged.baseUrl?.trim();
  const botToken = configToken || envToken;
  const baseUrl = normalizeMattermostBaseUrl(configUrl || envUrl);
  const requireMention = resolveMattermostRequireMention(merged);

  const botTokenSource: MattermostTokenSource = configToken ? "config" : envToken ? "env" : "none";
  const baseUrlSource: MattermostBaseUrlSource = configUrl ? "config" : envUrl ? "env" : "none";

  return {
    accountId,
    enabled,
    name: normalizeOptionalString(merged.name),
    botToken,
    baseUrl,
    botTokenSource,
    baseUrlSource,
    config: merged,
    chatmode: merged.chatmode,
    oncharPrefixes: merged.oncharPrefixes,
    requireMention,
    textChunkLimit: merged.textChunkLimit,
    chunkMode: resolveChannelStreamingChunkMode(merged) ?? merged.chunkMode,
    blockStreaming: resolveChannelStreamingBlockEnabled(merged) ?? merged.blockStreaming,
    blockStreamingCoalesce:
      resolveChannelStreamingBlockCoalesce(merged) ?? merged.blockStreamingCoalesce,
  };
}

/**
 * Resolve the effective replyToMode for a given chat type.
 * Mattermost auto-threading only applies to channel and group messages.
 */
export function resolveMattermostReplyToMode(
  account: ResolvedMattermostAccount,
  kind: MattermostChatTypeKey,
): MattermostReplyToMode {
  if (kind === "direct") {
    return "off";
  }
  return account.config.replyToMode ?? "off";
}
