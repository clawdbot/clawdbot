import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";

type TelegramChannelStatus = {
  accountId?: string;
  connected?: boolean;
  lastConnectedAt?: number;
  lastDisconnect?: unknown;
  lastError?: string | null;
  restartPending?: boolean;
  running?: boolean;
};

type TelegramGatewayClient = {
  call: (method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
};

const TELEGRAM_QA_DEFAULT_READY_TIMEOUT_MS = 45_000;

export function buildTelegramQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    apiRoot: string;
    groupId: string;
    requireMention: boolean;
    sutAccountId: string;
    sutToken: string;
    testerUserId: string;
  },
): OpenClawConfig {
  return {
    ...baseCfg,
    agents: {
      ...baseCfg.agents,
      defaults: {
        ...baseCfg.agents?.defaults,
        models: {
          ...baseCfg.agents?.defaults?.models,
          "openai/gpt-5.6-luna": {
            ...baseCfg.agents?.defaults?.models?.["openai/gpt-5.6-luna"],
            agentRuntime: { id: "openclaw" },
          },
        },
        skipBootstrap: true,
      },
    },
    plugins: {
      ...baseCfg.plugins,
      allow: uniqueStrings([...(baseCfg.plugins?.allow ?? []), "telegram"]),
      entries: {
        ...baseCfg.plugins?.entries,
        telegram: { enabled: true },
      },
    },
    messages: {
      ...baseCfg.messages,
      groupChat: {
        ...baseCfg.messages?.groupChat,
        visibleReplies: "automatic",
      },
    },
    channels: {
      ...baseCfg.channels,
      telegram: {
        enabled: true,
        defaultAccount: params.sutAccountId,
        accounts: {
          [params.sutAccountId]: {
            enabled: true,
            botToken: params.sutToken,
            apiRoot: params.apiRoot,
            dmPolicy: "disabled",
            groups: {
              [params.groupId]: {
                groupPolicy: "allowlist",
                allowFrom: [params.testerUserId],
                requireMention: params.requireMention,
              },
            },
          },
        },
      },
    },
  };
}

function resolveTelegramQaReadyTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS;
  return raw
    ? (parseStrictPositiveInteger(raw) ?? TELEGRAM_QA_DEFAULT_READY_TIMEOUT_MS)
    : TELEGRAM_QA_DEFAULT_READY_TIMEOUT_MS;
}

export async function waitForTelegramChannelRunning(
  gateway: TelegramGatewayClient,
  accountId: string,
  options?: { env?: NodeJS.ProcessEnv; pollMs?: number; timeoutMs?: number },
) {
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? resolveTelegramQaReadyTimeoutMs(options?.env);
  const pollMs = options?.pollMs ?? 500;
  let lastProbeError: string | undefined;
  let lastStatus: TelegramChannelStatus | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = (await gateway.call(
        "channels.status",
        { probe: false, timeoutMs: 2_000 },
        { timeoutMs: 5_000 },
      )) as { channelAccounts?: Record<string, TelegramChannelStatus[]> };
      const match = (payload.channelAccounts?.telegram ?? []).find(
        (entry) => entry.accountId === accountId,
      );
      lastProbeError = undefined;
      lastStatus = match;
      if (match?.running && match.connected === true && match.restartPending !== true) {
        return;
      }
    } catch (error) {
      lastProbeError = formatErrorMessage(error);
    }
    await sleep(pollMs);
  }
  const details = lastStatus
    ? `; last status: ${JSON.stringify(lastStatus)}`
    : lastProbeError
      ? `; last probe error: ${lastProbeError}`
      : "";
  throw new Error(`telegram account "${accountId}" did not become ready${details}`);
}
