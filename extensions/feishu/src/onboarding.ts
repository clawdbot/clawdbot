
import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import {
    formatDocsLink,
    promptAccountId,
    normalizeAccountId,
    migrateBaseNameToDefaultAccount,
    DEFAULT_ACCOUNT_ID,
    type ChannelOnboardingAdapter,
    type ChannelOnboardingConfigureContext,
    type ChannelOnboardingResult,
    type ChannelOnboardingStatus,
    type ChannelOnboardingStatusContext,
    type WizardPrompter,
} from "clawdbot/plugin-sdk";
import { listFeishuAccountIds, resolveFeishuAccount, isFeishuConfigured } from "./accounts.js";

const channel = "feishu" as const;

function applyFeishuConfig(params: {
    cfg: ClawdbotConfig;
    accountId: string;
    patch: Record<string, unknown>;
}): ClawdbotConfig {
    const { cfg, accountId, patch } = params;

    // Helper to ensure structure exists
    const ensureAccount = (config: ClawdbotConfig, accId: string) => {
        const next = { ...config };
        next.channels = { ...(next.channels ?? {}) };
        next.channels.feishu = { ...(next.channels.feishu ?? {}) };

        if (accId === DEFAULT_ACCOUNT_ID) {
            next.channels.feishu = {
                ...next.channels.feishu,
                enabled: true,
                ...patch,
            };
        } else {
            next.channels.feishu.accounts = { ...(next.channels.feishu.accounts ?? {}) };
            next.channels.feishu.accounts[accId] = {
                ...(next.channels.feishu.accounts[accId] ?? {}),
                enabled: true,
                ...patch,
            };
        }
        return next;
    };

    return ensureAccount(cfg, accountId);
}

async function promptCredentials(params: {
    cfg: ClawdbotConfig;
    prompter: WizardPrompter;
    accountId: string;
}): Promise<ClawdbotConfig> {
    const { cfg, prompter, accountId } = params;
    const current = resolveFeishuAccount({ cfg, accountId });

    const appId = await prompter.text({
        message: "Feishu App ID",
        placeholder: "cli_...",
        initialValue: current.config.appId,
        validate: (value: unknown) => {
            const val = String(value ?? "").trim();
            if (!val) return "Required";
            if (!val.startsWith("cli_")) return "App ID usually starts with 'cli_'";
            return undefined;
        },
    });

    const appSecret = await prompter.text({
        message: "Feishu App Secret",
        placeholder: "...",
        initialValue: current.config.appSecret,
        validate: (value: unknown) => (String(value ?? "").trim() ? undefined : "Required"),
    });

    const encryptKey = await prompter.text({
        message: "Encrypt Key",
        hint: "Optional; required only if you configured Encrypt Key in Feishu Event Subscriptions",
        initialValue: current.config.encryptKey,
    });

    const verificationToken = await prompter.text({
        message: "Verification Token",
        hint: "Optional; required only if you configured Verification Token in Feishu Event Subscriptions",
        initialValue: current.config.verificationToken,
    });

    return applyFeishuConfig({
        cfg,
        accountId,
        patch: {
            appId: String(appId).trim(),
            appSecret: String(appSecret).trim(),
            ...(encryptKey ? { encryptKey: String(encryptKey).trim() } : {}),
            ...(verificationToken ? { verificationToken: String(verificationToken).trim() } : {}),
        },
    });
}

function getStatus(ctx: ChannelOnboardingStatusContext): Promise<ChannelOnboardingStatus> {
    const { cfg } = ctx;
    // Simple check: is default account configured? 
    // Ideally we iterate all accounts, but for status summary usually checking if ANY are configured is enough,
    // or just the generic status.
    // Let's use listAccountIds from plugin config.
    const accountIds = listFeishuAccountIds(cfg);
    const configured = accountIds.some((accId: string) => isFeishuConfigured(resolveFeishuAccount({ cfg, accountId: accId })));

    return Promise.resolve({
        channel,
        configured,
        statusLines: [
            `Feishu: ${configured ? "configured" : "needs credentials"}`,
        ],
        selectionHint: configured ? "configured" : "setup",
    });
}

async function configure(ctx: ChannelOnboardingConfigureContext): Promise<ChannelOnboardingResult> {
    const { cfg, prompter, accountOverrides, shouldPromptAccountIds } = ctx;

    const override = accountOverrides["feishu"]?.trim();
    // Feishu defaults to "default" account ID
    const defaultAccountId = "default";
    let accountId = override ? normalizeAccountId(override) : defaultAccountId;

    if (shouldPromptAccountIds && !override) {
        accountId = await promptAccountId({
            cfg,
            prompter,
            label: "Feishu",
            currentId: accountId,
            listAccountIds: (c: ClawdbotConfig) => listFeishuAccountIds(c),
            defaultAccountId,
        });
    }

    await prompter.note(
        [
            "Feishu setup requires App ID and App Secret from the Feishu Open Platform.",
            "Encrypt Key and Verification Token are optional but recommended for event security.",
            `Docs: ${formatDocsLink("/channels/feishu", "channels/feishu")}`,
        ].join("\n"),
        "Feishu Setup"
    );

    let next = cfg;
    next = await promptCredentials({ cfg: next, prompter, accountId });

    // Ensure migration if needed (standard pattern)
    const namedConfig = migrateBaseNameToDefaultAccount({
        cfg: next,
        channelKey: "feishu",
    });

    return { cfg: namedConfig, accountId };
}

export const feishuOnboardingAdapter: ChannelOnboardingAdapter = {
    channel,
    getStatus,
    configure,
};
