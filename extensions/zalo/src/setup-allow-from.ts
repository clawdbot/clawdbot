import {
  DEFAULT_ACCOUNT_ID,
  createSetupTranslator,
  formatDocsLink,
  mergeAllowFromEntries,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import { resolveDefaultZaloAccountId, resolveZaloAccount } from "./accounts.js";

const t = createSetupTranslator();

type ZaloAccountSetupConfig = {
  enabled?: boolean;
};

export async function noteZaloTokenHelp(
  prompter: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"],
): Promise<void> {
  await prompter.note(
    [
      t("wizard.zalo.helpOpenPlatform"),
      t("wizard.zalo.helpCreateBot"),
      t("wizard.zalo.helpTokenFormat"),
      t("wizard.zalo.helpEnvTip"),
      `Docs: ${formatDocsLink("/channels/zalo", "zalo")}`,
    ].join("\n"),
    t("wizard.zalo.botTokenTitle"),
  );
}

export async function promptZaloAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: Parameters<NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>>[0]["prompter"];
  accountId?: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter } = params;
  const accountId = params.accountId ?? resolveDefaultZaloAccountId(cfg);
  const resolved = resolveZaloAccount({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  const entry = await prompter.text({
    message: t("wizard.zalo.allowFromPrompt"),
    placeholder: "123456789",
    initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
    validate: (value) => {
      const raw = (value ?? "").trim();
      if (!raw) {
        return t("common.required");
      }
      if (!/^\d+$/.test(raw)) {
        return t("wizard.zalo.allowFromNumeric");
      }
      return undefined;
    },
  });
  const normalized = entry.trim();
  const unique = mergeAllowFromEntries(existingAllowFrom, [normalized]);

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalo: {
          ...cfg.channels?.zalo,
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: unique,
        },
      },
    } as OpenClawConfig;
  }

  const currentAccount = cfg.channels?.zalo?.accounts?.[accountId] as
    | ZaloAccountSetupConfig
    | undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zalo: {
        ...cfg.channels?.zalo,
        enabled: true,
        accounts: {
          ...cfg.channels?.zalo?.accounts,
          [accountId]: {
            ...currentAccount,
            enabled: currentAccount?.enabled ?? true,
            dmPolicy: "allowlist",
            allowFrom: unique,
          },
        },
      },
    },
  } as OpenClawConfig;
}
