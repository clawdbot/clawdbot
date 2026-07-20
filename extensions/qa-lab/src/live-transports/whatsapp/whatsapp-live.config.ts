// QA Lab WhatsApp credential, config, and channel setup.
import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeStringEntries, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import type { WhatsAppQaConfigOverrides, WhatsAppQaRuntimeEnv } from "./whatsapp-live.contracts.js";

const WHATSAPP_QA_ENV_KEYS = [
  "OPENCLAW_QA_WHATSAPP_DRIVER_PHONE_E164",
  "OPENCLAW_QA_WHATSAPP_SUT_PHONE_E164",
  "OPENCLAW_QA_WHATSAPP_DRIVER_AUTH_ARCHIVE_BASE64",
  "OPENCLAW_QA_WHATSAPP_SUT_AUTH_ARCHIVE_BASE64",
] as const;
const whatsappQaCredentialPayloadSchema = z.object({
  driverPhoneE164: z.string().trim().min(1),
  sutPhoneE164: z.string().trim().min(1),
  driverAuthArchiveBase64: z.string().trim().min(1),
  sutAuthArchiveBase64: z.string().trim().min(1),
  groupJid: z.string().trim().min(1).optional(),
});

function resolveEnvValue(env: NodeJS.ProcessEnv, key: (typeof WHATSAPP_QA_ENV_KEYS)[number]) {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing ${key}.`);
  }
  return value;
}

function normalizePhone(value: string, label: string) {
  const normalized = normalizeE164(value);
  if (!/^\+[1-9]\d{6,14}$/u.test(normalized)) {
    throw new Error(`${label} must be an E.164 phone number.`);
  }
  return normalized;
}

function validateWhatsAppQaRuntimeEnv(
  runtimeEnv: WhatsAppQaRuntimeEnv,
  label: string,
): WhatsAppQaRuntimeEnv {
  const driverPhoneE164 = normalizePhone(runtimeEnv.driverPhoneE164, `${label} driverPhoneE164`);
  const sutPhoneE164 = normalizePhone(runtimeEnv.sutPhoneE164, `${label} sutPhoneE164`);
  if (driverPhoneE164 === sutPhoneE164) {
    throw new Error(`${label} requires two distinct WhatsApp phone numbers.`);
  }
  return {
    ...runtimeEnv,
    driverPhoneE164,
    sutPhoneE164,
  };
}

export function resolveWhatsAppQaRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env,
): WhatsAppQaRuntimeEnv {
  return validateWhatsAppQaRuntimeEnv(
    {
      driverPhoneE164: resolveEnvValue(env, "OPENCLAW_QA_WHATSAPP_DRIVER_PHONE_E164"),
      sutPhoneE164: resolveEnvValue(env, "OPENCLAW_QA_WHATSAPP_SUT_PHONE_E164"),
      driverAuthArchiveBase64: resolveEnvValue(
        env,
        "OPENCLAW_QA_WHATSAPP_DRIVER_AUTH_ARCHIVE_BASE64",
      ),
      sutAuthArchiveBase64: resolveEnvValue(env, "OPENCLAW_QA_WHATSAPP_SUT_AUTH_ARCHIVE_BASE64"),
      groupJid: env.OPENCLAW_QA_WHATSAPP_GROUP_JID?.trim() || undefined,
    },
    "OPENCLAW_QA_WHATSAPP",
  );
}

export function parseWhatsAppQaCredentialPayload(payload: unknown): WhatsAppQaRuntimeEnv {
  const parsed = whatsappQaCredentialPayloadSchema.parse(payload);
  return validateWhatsAppQaRuntimeEnv(parsed, "WhatsApp credential payload");
}

function buildNonMatchingWhatsAppQaAllowFrom(existingAllowFrom: string[]) {
  const existing = new Set(
    existingAllowFrom
      .map((value) => normalizeE164(value))
      .filter((value): value is string => Boolean(value)),
  );
  for (let suffix = 0; suffix <= 9999; suffix += 1) {
    const candidate = `+1555${String(suffix).padStart(7, "0")}`;
    if (!existing.has(candidate)) {
      return [candidate];
    }
  }
  throw new Error("Unable to derive a WhatsApp QA groupAllowFrom entry outside allowFrom.");
}

type WhatsAppQaAgentConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

function buildWhatsAppQaScenarioAgent(agentId: string): WhatsAppQaAgentConfig {
  const identityName =
    agentId === "main"
      ? "Main WhatsApp QA"
      : agentId === "qa-second"
        ? "Second WhatsApp QA"
        : `WhatsApp QA ${agentId}`;
  return {
    id: agentId,
    identity: {
      name: identityName,
    },
  };
}

function appendWhatsAppQaAgents(
  agents: OpenClawConfig["agents"],
  agentIds: readonly string[],
): OpenClawConfig["agents"] {
  if (agentIds.length === 0) {
    return agents;
  }
  const list = [...(agents?.list ?? [])];
  const existingIds = new Set(list.map((agent) => agent.id));
  for (const agentId of agentIds) {
    if (!existingIds.has(agentId)) {
      list.push(buildWhatsAppQaScenarioAgent(agentId));
      existingIds.add(agentId);
    }
  }
  return {
    ...agents,
    list,
  };
}

function buildWhatsAppQaBroadcastConfig(
  baseCfg: OpenClawConfig,
  params: {
    broadcast?: WhatsAppQaConfigOverrides["broadcast"];
    groupJid?: string;
  },
): Pick<OpenClawConfig, "agents" | "broadcast"> {
  if (!params.broadcast) {
    return {};
  }
  const agentIds = uniqueStrings(normalizeStringEntries(params.broadcast.agents));
  return {
    ...(params.groupJid
      ? {
          broadcast: {
            ...baseCfg.broadcast,
            strategy: params.broadcast.strategy ?? baseCfg.broadcast?.strategy ?? "parallel",
            [params.groupJid]: agentIds,
          },
        }
      : {}),
    ...(agentIds.length > 0
      ? {
          agents: appendWhatsAppQaAgents(baseCfg.agents, agentIds),
        }
      : {}),
  };
}

export function buildWhatsAppQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    allowFrom: string[];
    authDir: string;
    dmPolicy: "allowlist" | "disabled" | "open" | "pairing";
    groupJid?: string;
    ownerAllowFrom: string[];
    overrides?: WhatsAppQaConfigOverrides;
    sutAccountId: string;
  },
): OpenClawConfig {
  const pluginAllow = uniqueStrings([...(baseCfg.plugins?.allow ?? []), "whatsapp"]);
  const approvalOverrides = params.overrides?.approvals;
  const groupPolicy = params.overrides?.groupPolicy ?? "open";
  const groupAllowFrom = params.overrides?.blockGroupSender
    ? buildNonMatchingWhatsAppQaAllowFrom(params.allowFrom)
    : undefined;
  const groupHistoryLimit = params.overrides?.groupHistoryLimit;
  const statusReactionOverride =
    typeof params.overrides?.statusReactions === "object"
      ? params.overrides.statusReactions
      : undefined;
  const statusReactionsEnabled = Boolean(params.overrides?.statusReactions);
  const whatsappHistoryLimit =
    typeof groupHistoryLimit === "number" && groupHistoryLimit > 0
      ? { historyLimit: groupHistoryLimit }
      : {};
  const baseWhatsAppConfig = baseCfg.channels?.whatsapp;
  const baseSutAccountConfig = baseWhatsAppConfig?.accounts?.[params.sutAccountId] ?? {};
  const broadcastConfig = buildWhatsAppQaBroadcastConfig(baseCfg, {
    broadcast: params.overrides?.broadcast,
    groupJid: params.groupJid,
  });
  const audioPreflightConfig = params.overrides?.audioPreflight
    ? {
        tools: {
          ...baseCfg.tools,
          media: {
            ...baseCfg.tools?.media,
            audio: {
              ...baseCfg.tools?.media?.audio,
              enabled: true,
              models: [
                {
                  provider: "openai",
                  model: "gpt-4o-transcribe",
                },
              ],
            },
          },
        },
      }
    : {};
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
  const actionToolConfig = params.overrides?.actions
    ? {
        tools: {
          ...baseCfg.tools,
          alsoAllow: uniqueStrings([...(baseCfg.tools?.alsoAllow ?? []), "message"]),
        },
      }
    : {};
  return {
    ...baseCfg,
    ...approvalForwardingConfig,
    ...audioPreflightConfig,
    ...broadcastConfig,
    ...actionToolConfig,
    commands: {
      ...baseCfg.commands,
      ownerAllowFrom: uniqueStrings([
        ...normalizeStringEntries(baseCfg.commands?.ownerAllowFrom),
        ...params.ownerAllowFrom,
      ]),
    },
    plugins: {
      ...baseCfg.plugins,
      allow: pluginAllow,
      entries: {
        ...baseCfg.plugins?.entries,
        whatsapp: { enabled: true },
      },
    },
    channels: {
      ...baseCfg.channels,
      whatsapp: {
        ...baseWhatsAppConfig,
        enabled: true,
        defaultAccount: params.sutAccountId,
        ...whatsappHistoryLimit,
        ...(statusReactionsEnabled
          ? {
              ackReaction: {
                ...baseCfg.channels?.whatsapp?.ackReaction,
                direct: true,
                emoji: "👀",
              },
            }
          : {}),
        ...(params.overrides?.actions
          ? {
              actions: {
                reactions: true,
                polls: true,
              },
              reactionLevel: "minimal" as const,
            }
          : {}),
        accounts: {
          ...baseWhatsAppConfig?.accounts,
          [params.sutAccountId]: {
            ...baseSutAccountConfig,
            enabled: true,
            authDir: params.authDir,
            dmPolicy: params.dmPolicy,
            allowFrom: params.allowFrom,
            ...(params.overrides?.replyToMode
              ? {
                  replyToMode: params.overrides.replyToMode,
                }
              : {}),
            ...(params.overrides?.inboundDebounceMs !== undefined
              ? {
                  debounceMs: params.overrides.inboundDebounceMs,
                }
              : {}),
            ...(params.groupJid
              ? {
                  groupPolicy,
                  ...(groupAllowFrom
                    ? {
                        groupAllowFrom,
                      }
                    : {}),
                  ...(groupPolicy === "open"
                    ? {
                        groups: {
                          ...baseSutAccountConfig.groups,
                          [params.groupJid]: {
                            ...baseSutAccountConfig.groups?.[params.groupJid],
                            requireMention: true,
                          },
                        },
                      }
                    : {}),
                }
              : {}),
          },
        },
      },
    },
    ...(params.groupJid || statusReactionsEnabled
      ? {
          messages: {
            ...baseCfg.messages,
            ...(params.groupJid
              ? {
                  groupChat: {
                    ...baseCfg.messages?.groupChat,
                    visibleReplies: "automatic",
                    mentionPatterns: [
                      ...new Set([
                        ...(baseCfg.messages?.groupChat?.mentionPatterns ?? []),
                        "\\bopenclawqa\\b",
                      ]),
                    ],
                  },
                }
              : {}),
            ...(statusReactionsEnabled
              ? {
                  ...(statusReactionOverride?.removeAckAfterReply !== undefined
                    ? {
                        removeAckAfterReply: statusReactionOverride.removeAckAfterReply,
                      }
                    : {}),
                  statusReactions: {
                    ...baseCfg.messages?.statusReactions,
                    enabled: true,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}
