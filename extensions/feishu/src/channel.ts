import type {
    ChannelDock,
    ChannelPlugin,
    ClawdbotConfig,
} from "clawdbot/plugin-sdk";
import {
    applyAccountNameToChannelSection,
    buildChannelConfigSchema,
    DEFAULT_ACCOUNT_ID,
    emptyPluginConfigSchema,
    migrateBaseNameToDefaultAccount,
    normalizeAccountId,
} from "clawdbot/plugin-sdk";

import type { FeishuAccount, FeishuConfig } from "./types.js";
import { startFeishuMonitor } from "./monitor.js";
import { sendFeishuMessage } from "./client.js";
import { feishuOnboardingAdapter } from "./onboarding.js";
import { listFeishuAccountIds, resolveFeishuAccount, isFeishuConfigured } from "./accounts.js";

// Dock Definition
export const feishuDock: ChannelDock = {
    id: "feishu",
    capabilities: {
        chatTypes: ["direct", "group"],
        reactions: false, // Pending implementation
        media: false, // Pending implementation
        threads: false, // Pending implementation
        blockStreaming: true,
    },
    outbound: { textChunkLimit: 2000 }, // Feishu limit is usually ~4k chars, safely 2k
    config: {
        resolveAllowFrom: () => [],
        formatAllowFrom: () => [],
    }
};

// Plugin Definition
export const feishuPlugin: ChannelPlugin<FeishuAccount> = {
    id: "feishu",
    meta: {
        id: "feishu",
        label: "Feishu",
        blurb: "Feishu/Lark Workspace",
    },
    onboarding: feishuOnboardingAdapter,
    capabilities: {
        chatTypes: ["direct", "group"],
        reactions: false,
        media: false,
        threads: false,
        nativeCommands: false,
        blockStreaming: true,
    },
    configSchema: emptyPluginConfigSchema(),
    config: {
        listAccountIds: (cfg) => listFeishuAccountIds(cfg as ClawdbotConfig),
        resolveAccount: (cfg, accountId) => resolveFeishuAccount({ cfg: cfg as ClawdbotConfig, accountId }),
        defaultAccountId: () => "default",
        isConfigured: (account) => isFeishuConfigured(account),
        describeAccount: (account) => ({
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: Boolean(account.config.appId && account.config.appSecret),
        }),
    },
    gateway: {
        startAccount: async (ctx) => {
            ctx.log?.info(`[${ctx.account.accountId}] Starting Feishu monitor...`);
            const monitor = await startFeishuMonitor({
                account: ctx.account,
                config: ctx.cfg as ClawdbotConfig,
                runtime: ctx.runtime,
                statusSink: (patch) => ctx.setStatus({ accountId: ctx.account.accountId, ...patch }),
            });
            ctx.setStatus({ accountId: ctx.account.accountId, running: true });

            return () => {
                monitor.stop().catch(console.error);
                ctx.setStatus({ accountId: ctx.account.accountId, running: false });
            };
        },
    },
    messaging: {
        outbound: {
            sendText: async ({ cfg, to, text, accountId }: { cfg: ClawdbotConfig, to: string, text: string, accountId?: string }) => {
                const account = feishuPlugin.config.resolveAccount(cfg, accountId || "default");
                const res = await sendFeishuMessage({
                    account,
                    receiveId: to,
                    msgType: "text",
                    content: JSON.stringify({ text }), // Feishu content is JSON string
                });
                return {
                    channel: "feishu",
                    messageId: res?.message_id,
                    chatId: to,
                };
            }
        }
    },
    setup: {
        resolveAccountId: ({ accountId }: { accountId: string }) => normalizeAccountId(accountId),
        applyAccountName: ({ cfg, accountId, name }: { cfg: ClawdbotConfig, accountId: string, name: string }) =>
            applyAccountNameToChannelSection({
                cfg: cfg as ClawdbotConfig,
                channelKey: "feishu",
                accountId,
                name,
            }),
        validateInput: ({ accountId, input }: { accountId: string, input: any }) => {
            if (!input.appId || !input.appSecret) {
                return "Feishu requires --app-id and --app-secret.";
            }
            return null;
        },
        applyAccountConfig: ({ cfg, accountId, input }: { cfg: ClawdbotConfig, accountId: string, input: any }) => {
            const namedConfig = applyAccountNameToChannelSection({
                cfg: cfg as ClawdbotConfig,
                channelKey: "feishu",
                accountId,
                name: input.name,
            });

            const next = accountId !== DEFAULT_ACCOUNT_ID
                ? migrateBaseNameToDefaultAccount({
                    cfg: namedConfig as ClawdbotConfig,
                    channelKey: "feishu",
                })
                : namedConfig;

            const configPatch = {
                ...(input.appId ? { appId: input.appId } : {}),
                ...(input.appSecret ? { appSecret: input.appSecret } : {}),
                ...(input.encryptKey ? { encryptKey: input.encryptKey } : {}),
                ...(input.verificationToken ? { verificationToken: input.verificationToken } : {}),
            };

            if (accountId === DEFAULT_ACCOUNT_ID) {
                return {
                    ...next,
                    channels: {
                        ...next.channels,
                        "feishu": {
                            ...(next.channels?.["feishu"] ?? {}),
                            enabled: true,
                            ...configPatch,
                        },
                    },
                } as ClawdbotConfig;
            }

            return {
                ...next,
                channels: {
                    ...next.channels,
                    "feishu": {
                        ...(next.channels?.["feishu"] ?? {}),
                        enabled: true,
                        accounts: {
                            ...(next.channels?.["feishu"]?.accounts ?? {}),
                            [accountId]: {
                                ...(next.channels?.["feishu"]?.accounts?.[accountId] ?? {}),
                                enabled: true,
                                ...configPatch,
                            },
                        },
                    },
                },
            } as ClawdbotConfig;
        },
    }
};
