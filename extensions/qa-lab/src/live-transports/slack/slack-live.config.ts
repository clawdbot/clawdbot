// QA Lab Slack credentials, instrumentation, and channel config.
import type { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  type SlackQaRuntimeEnv,
  type SlackQaConfigOverrides,
  SLACK_QA_ENV_KEYS,
  slackQaCredentialPayloadSchema,
} from "./slack-live.contracts.js";

function resolveEnvValue(env: NodeJS.ProcessEnv, key: (typeof SLACK_QA_ENV_KEYS)[number]) {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing ${key}.`);
  }
  return value;
}

function normalizeSlackId(value: string, label: string) {
  const normalized = value.trim();
  if (!/^[A-Z][A-Z0-9]+$/.test(normalized)) {
    throw new Error(`${label} must be a Slack id like C123 or U123.`);
  }
  return normalized;
}

function validateSlackQaRuntimeEnv(runtimeEnv: SlackQaRuntimeEnv, label: string) {
  normalizeSlackId(runtimeEnv.channelId, `${label} channelId`);
  return runtimeEnv;
}

export function resolveSlackQaRuntimeEnv(env: NodeJS.ProcessEnv = process.env): SlackQaRuntimeEnv {
  const runtimeEnv = {
    channelId: resolveEnvValue(env, "OPENCLAW_QA_SLACK_CHANNEL_ID"),
    driverBotToken: resolveEnvValue(env, "OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN"),
    sutBotToken: resolveEnvValue(env, "OPENCLAW_QA_SLACK_SUT_BOT_TOKEN"),
    sutAppToken: resolveEnvValue(env, "OPENCLAW_QA_SLACK_SUT_APP_TOKEN"),
  };
  return validateSlackQaRuntimeEnv(runtimeEnv, "OPENCLAW_QA_SLACK");
}

export function parseSlackQaCredentialPayload(payload: unknown): SlackQaRuntimeEnv {
  const parsed = slackQaCredentialPayloadSchema.parse(payload);
  const runtimeEnv = {
    channelId: parsed.channelId,
    driverBotToken: parsed.driverBotToken,
    sutBotToken: parsed.sutBotToken,
    sutAppToken: parsed.sutAppToken,
  };
  return validateSlackQaRuntimeEnv(runtimeEnv, "Slack credential payload");
}

export function asPlainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type SlackQaPostMessageAttempt = {
  failureCode?: string;
  formattingDisabled: boolean;
  nativeDataBlockCount: number;
  status: "failed" | "sent";
};

export function countSlackNativeDataBlocks(value: unknown) {
  if (!Array.isArray(value)) {
    return 0;
  }
  return value.filter((block) => {
    const type = asPlainRecord(block).type;
    return type === "data_table" || type === "data_visualization";
  }).length;
}

function readSlackApiFailureCode(error: unknown) {
  const record = asPlainRecord(error);
  const data = asPlainRecord(record.data);
  const code = data.error ?? record.error;
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/u.test(code) ? code : undefined;
}

export function instrumentSlackPostMessage(client: WebClient) {
  const originalPostMessage = client.chat.postMessage;
  const attempts: SlackQaPostMessageAttempt[] = [];
  client.chat.postMessage = (async (payload) => {
    const payloadRecord = payload as { blocks?: unknown; mrkdwn?: boolean };
    const attempt = {
      formattingDisabled: payloadRecord.mrkdwn === false,
      nativeDataBlockCount: countSlackNativeDataBlocks(payloadRecord.blocks),
    };
    try {
      const response = await originalPostMessage.call(client.chat, payload);
      attempts.push({ ...attempt, status: "sent" });
      return response;
    } catch (error) {
      const failureCode = readSlackApiFailureCode(error);
      attempts.push({
        ...attempt,
        ...(failureCode ? { failureCode } : {}),
        status: "failed",
      });
      throw error;
    }
  }) as typeof client.chat.postMessage;
  return {
    attempts,
    restore: () => {
      client.chat.postMessage = originalPostMessage;
    },
  };
}

export function buildSlackQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    channelId: string;
    driverBotUserId: string;
    overrides?: SlackQaConfigOverrides;
    primaryModel?: string;
    sutAccountId: string;
    sutAppToken: string;
    sutBotToken: string;
  },
): OpenClawConfig {
  const codexApprovalConfig = params.overrides?.codexApproval === true;
  const progressOverrides = params.overrides?.progress;
  const primaryModel = params.primaryModel;
  const pluginAllow = uniqueStrings([
    ...(baseCfg.plugins?.allow ?? []),
    "slack",
    ...(codexApprovalConfig ? ["codex"] : []),
  ]);
  const approvalOverrides = params.overrides?.approvals;
  const codexEntry = baseCfg.plugins?.entries?.codex;
  const codexEntryConfig = asPlainRecord(codexEntry?.config);
  const codexAppServerConfig = asPlainRecord(codexEntryConfig.appServer);
  const approvalForwardingConfig =
    approvalOverrides?.exec || approvalOverrides?.plugin
      ? {
          approvals: {
            ...baseCfg.approvals,
            ...(approvalOverrides.exec
              ? {
                  exec: {
                    ...baseCfg.approvals?.exec,
                    enabled: true,
                    mode: "session" as const,
                  },
                }
              : {}),
            ...(approvalOverrides.plugin
              ? {
                  plugin: {
                    ...baseCfg.approvals?.plugin,
                    enabled: true,
                    mode: "session" as const,
                  },
                }
              : {}),
          },
        }
      : {};
  const codexAgentDefaults =
    codexApprovalConfig && primaryModel
      ? {
          ...baseCfg.agents?.defaults,
          models: {
            ...baseCfg.agents?.defaults?.models,
            [primaryModel]: {
              ...baseCfg.agents?.defaults?.models?.[primaryModel],
              agentRuntime: { id: "codex" as const },
            },
          },
        }
      : baseCfg.agents?.defaults;
  const qaAgentDefaults = progressOverrides
    ? {
        ...codexAgentDefaults,
        ...(progressOverrides.verboseDefault
          ? { verboseDefault: progressOverrides.verboseDefault }
          : {}),
      }
    : codexAgentDefaults;
  const qaAgentList = progressOverrides
    ? baseCfg.agents?.list?.map((agent) => {
        if (agent.id !== "qa") {
          return agent;
        }
        // Slack draft edits cannot preserve custom authorship. Remove the
        // synthetic QA identity so progress scenarios reach the draft path.
        const qaAgent = { ...agent };
        delete qaAgent.identity;
        return qaAgent;
      })
    : baseCfg.agents?.list;
  const execApprovalsConfig = approvalOverrides
    ? {
        enabled: true,
        approvers: [params.driverBotUserId],
        target: approvalOverrides.target ?? ("channel" as const),
      }
    : undefined;
  const explicitToolAllow = baseCfg.tools?.allow;
  const messageToolPolicy = params.overrides?.messageTool
    ? explicitToolAllow && explicitToolAllow.length > 0
      ? { allow: uniqueStrings([...explicitToolAllow, "message"]) }
      : { alsoAllow: uniqueStrings([...(baseCfg.tools?.alsoAllow ?? []), "message"]) }
    : {};
  const toolsConfig =
    codexApprovalConfig || params.overrides?.messageTool
      ? {
          tools: {
            ...baseCfg.tools,
            ...messageToolPolicy,
            ...(codexApprovalConfig
              ? {
                  exec: {
                    ...baseCfg.tools?.exec,
                    mode: "ask" as const,
                  },
                }
              : {}),
          },
        }
      : {};
  return {
    ...baseCfg,
    ...approvalForwardingConfig,
    ...toolsConfig,
    plugins: {
      ...baseCfg.plugins,
      allow: pluginAllow,
      entries: {
        ...baseCfg.plugins?.entries,
        slack: { enabled: true },
        ...(codexApprovalConfig
          ? {
              codex: {
                ...codexEntry,
                enabled: true,
                config: {
                  ...codexEntryConfig,
                  appServer: {
                    ...codexAppServerConfig,
                    mode: "guardian" as const,
                  },
                },
              },
            }
          : {}),
      },
    },
    ...(codexApprovalConfig || progressOverrides
      ? {
          agents: {
            ...baseCfg.agents,
            ...(qaAgentDefaults ? { defaults: qaAgentDefaults } : {}),
            ...(qaAgentList ? { list: qaAgentList } : {}),
          },
        }
      : {}),
    messages: {
      ...baseCfg.messages,
      groupChat: {
        ...baseCfg.messages?.groupChat,
        visibleReplies: "automatic",
      },
    },
    channels: {
      ...baseCfg.channels,
      slack: {
        enabled: true,
        defaultAccount: params.sutAccountId,
        accounts: {
          [params.sutAccountId]: {
            enabled: true,
            mode: "socket",
            botToken: params.sutBotToken,
            appToken: params.sutAppToken,
            allowFrom: params.overrides?.allowFrom ?? [params.driverBotUserId],
            groupPolicy: "allowlist",
            allowBots: true,
            replyToMode: params.overrides?.replyToMode ?? "off",
            ...(progressOverrides
              ? {
                  streaming: {
                    mode: "progress" as const,
                    progress: {
                      label: false,
                      maxLines: 4,
                      toolProgress: progressOverrides.toolProgress,
                      ...(progressOverrides.commentary === undefined
                        ? {}
                        : { commentary: progressOverrides.commentary }),
                    },
                  },
                }
              : {}),
            ...(execApprovalsConfig ? { execApprovals: execApprovalsConfig } : {}),
            channels: {
              [params.channelId]: {
                enabled: params.overrides?.channelEnabled ?? true,
                requireMention: true,
                allowBots: true,
                users: params.overrides?.users ?? [params.driverBotUserId],
              },
            },
          },
        },
      },
    },
  };
}
