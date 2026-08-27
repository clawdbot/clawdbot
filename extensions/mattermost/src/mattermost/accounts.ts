// Mattermost plugin module implements accounts behavior.
import {
  createAccountListHelpers,
  hasConfiguredAccountValue,
} from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  resolveChannelStreamingBlockCoalesce,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingChunkMode,
  resolveChannelPreviewStreamMode,
  type StreamingMode,
  type TextChunkMode,
} from "openclaw/plugin-sdk/channel-outbound";
import type { BlockStreamingCoalesceConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSecretInputString, type SecretInputStringResolutionMode } from "../secret-input.js";
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
type MattermostCredentialStatus = "available" | "configured_unavailable" | "missing";

export type ResolvedMattermostAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  botToken?: string;
  baseUrl?: string;
  botTokenSource: MattermostTokenSource;
  botTokenStatus?: MattermostCredentialStatus;
  baseUrlSource: MattermostBaseUrlSource;
  config: MattermostAccountConfig;
  chatmode?: MattermostChatMode;
  oncharPrefixes?: string[];
  requireMention?: boolean;
  textChunkLimit?: number;
  chunkMode?: TextChunkMode;
  streamingMode: StreamingMode;
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
};

const {
  listAccountIds: listMattermostAccountIds,
  resolveDefaultAccountId: resolveDefaultMattermostAccountId,
  resolveAccountConfig: mergeMattermostAccountConfig,
} = createAccountListHelpers<MattermostAccountConfig>("mattermost", {
  omitKeys: ["defaultAccount"],
  nestedObjectKeys: ["commands"],
  hasImplicitDefaultAccount: (cfg) => {
    const mattermost = cfg.channels?.mattermost;
    return Boolean(
      mattermost?.baseUrl?.trim() &&
      (hasConfiguredAccountValue(mattermost.botToken) || process.env.MATTERMOST_BOT_TOKEN?.trim()),
    );
  },
});
export { listMattermostAccountIds, resolveDefaultMattermostAccountId };

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

function resolveMattermostAccountWithMode(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  mode: SecretInputStringResolutionMode;
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
  const configToken = resolveSecretInputString({
    value: merged.botToken,
    path: `channels.mattermost.accounts.${accountId}.botToken`,
    mode: params.mode,
  });
  const configUrl = merged.baseUrl?.trim();
  const botToken =
    configToken.status === "available"
      ? configToken.value
      : configToken.status === "missing"
        ? envToken
        : undefined;
  const baseUrl = normalizeMattermostBaseUrl(configUrl || envUrl);
  const requireMention = resolveMattermostRequireMention(merged);

  const botTokenSource: MattermostTokenSource =
    configToken.status !== "missing" ? "config" : envToken ? "env" : "none";
  const botTokenStatus: MattermostCredentialStatus =
    configToken.status !== "missing" ? configToken.status : envToken ? "available" : "missing";
  const baseUrlSource: MattermostBaseUrlSource = configUrl ? "config" : envUrl ? "env" : "none";

  return {
    accountId,
    enabled,
    name: normalizeOptionalString(merged.name),
    botToken,
    baseUrl,
    botTokenSource,
    botTokenStatus,
    baseUrlSource,
    config: merged,
    chatmode: merged.chatmode,
    oncharPrefixes: merged.oncharPrefixes,
    requireMention,
    textChunkLimit: merged.textChunkLimit,
    chunkMode: resolveChannelStreamingChunkMode(merged),
    streamingMode: resolveChannelPreviewStreamMode(merged, "partial"),
    blockStreaming: resolveChannelStreamingBlockEnabled(merged),
    blockStreamingCoalesce: resolveChannelStreamingBlockCoalesce(merged),
  };
}

export function resolveMattermostAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedMattermostAccount {
  return resolveMattermostAccountWithMode({ ...params, mode: "strict" });
}

export function inspectMattermostAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedMattermostAccount {
  return resolveMattermostAccountWithMode({ ...params, mode: "inspect" });
}

/**
 * Resolve the effective replyToMode for a given chat type.
 * Direct messages stay flat unless explicitly opted into a per-chat-type mode.
 */
export function resolveMattermostReplyToMode(
  account: ResolvedMattermostAccount,
  kind: MattermostChatTypeKey,
): MattermostReplyToMode {
  const scopedMode = account.config.replyToModeByChatType?.[kind];
  if (scopedMode !== undefined) {
    return scopedMode;
  }
  if (kind === "direct") {
    return "off";
  }
  return account.config.replyToMode ?? "off";
}
