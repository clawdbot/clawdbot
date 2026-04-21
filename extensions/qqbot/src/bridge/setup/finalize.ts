import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { applyQQBotAccountConfig, resolveQQBotAccount } from "../config.js";

type SetupPrompter = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"];
type SetupRuntime = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["runtime"];

function isQQBotAccountConfigured(cfg: OpenClawConfig, accountId: string): boolean {
  const account = resolveQQBotAccount(cfg, accountId, { allowUnresolvedSecretRef: true });
  return Boolean(account.appId && account.clientSecret);
}

export async function detectQQBotConfigured(
  cfg: OpenClawConfig,
  accountId: string,
): Promise<boolean> {
  return isQQBotAccountConfigured(cfg, accountId);
}

async function linkViaQrCode(params: {
  cfg: OpenClawConfig;
  accountId: string;
  prompter: SetupPrompter;
  runtime: SetupRuntime;
}): Promise<OpenClawConfig> {
  try {
    const { qrConnect } = await import("@tencent-connect/qqbot-connector");

    const accounts: { appId: string; appSecret: string }[] = await qrConnect({
      source: "openclaw",
    });

    if (accounts.length === 0) {
      await params.prompter.note("未获取到任何 QQ Bot 账号信息。", "QQ Bot");
      return params.cfg;
    }

    let next = params.cfg;

    for (let i = 0; i < accounts.length; i++) {
      const { appId, appSecret } = accounts[i];
      // use current account id for first account, and use app id for subsequent accounts
      const targetAccountId = i === 0 ? params.accountId : appId;

      next = applyQQBotAccountConfig(next, targetAccountId, {
        appId,
        clientSecret: appSecret,
      });
    }

    if (accounts.length === 1) {
      params.runtime.log(`✔ QQ Bot 绑定成功！(AppID: ${accounts[0].appId})`);
    } else {
      const idList = accounts.map((a) => a.appId).join(", ");
      params.runtime.log(`✔ ${accounts.length} 个 QQ Bot 绑定成功！(AppID: ${idList})`);
    }

    return next;
  } catch (error) {
    params.runtime.error(`QQ Bot 绑定失败: ${String(error)}`);
    await params.prompter.note(
      [
        "绑定失败，您可以稍后手动配置。",
        `文档: ${formatDocsLink("/channels/qqbot", "qqbot")}`,
      ].join("\n"),
      "QQ Bot",
    );
    return params.cfg;
  }
}

async function linkViaManualInput(params: {
  cfg: OpenClawConfig;
  accountId: string;
  prompter: SetupPrompter;
}): Promise<OpenClawConfig> {
  const appId = await params.prompter.text({
    message: "请输入 QQ Bot AppID",
    validate: (value: string) => (value.trim() ? undefined : "AppID 不能为空"),
  });

  const appSecret = await params.prompter.text({
    message: "请输入 QQ Bot AppSecret",
    validate: (value: string) => (value.trim() ? undefined : "AppSecret 不能为空"),
  });

  const next = applyQQBotAccountConfig(params.cfg, params.accountId, {
    appId: appId.trim(),
    clientSecret: appSecret.trim(),
  });

  await params.prompter.note("✔ QQ Bot 配置完成！", "QQ Bot");
  return next;
}

export async function finalizeQQBotSetup(params: {
  cfg: OpenClawConfig;
  accountId: string;
  forceAllowFrom: boolean;
  prompter: SetupPrompter;
  runtime: SetupRuntime;
}): Promise<{ cfg: OpenClawConfig }> {
  const accountId = params.accountId.trim() || DEFAULT_ACCOUNT_ID;
  let next = params.cfg;

  const configured = isQQBotAccountConfigured(next, accountId);

  const mode = await params.prompter.select({
    message: configured ? "QQ 已绑定，选择操作" : "选择 QQ 绑定方式",
    options: [
      {
        value: "qr",
        label: "扫码绑定（推荐）",
        hint: "使用 QQ 扫描二维码自动完成绑定",
      },
      {
        value: "manual",
        label: "手动输入 QQ Bot AppID 和 AppSecret",
        hint: "需到 QQ 开放平台 q.qq.com 查看",
      },
      {
        value: "skip",
        label: configured ? "保持当前配置" : "稍后配置",
      },
    ],
  });

  if (mode === "qr") {
    next = await linkViaQrCode({
      cfg: next,
      accountId,
      prompter: params.prompter,
      runtime: params.runtime,
    });
  } else if (mode === "manual") {
    next = await linkViaManualInput({
      cfg: next,
      accountId,
      prompter: params.prompter,
    });
  } else if (!configured) {
    await params.prompter.note(
      ["您可以稍后运行以下命令重新选择 QQ Bot 进行配置：", "  openclaw channels add"].join("\n"),
      "QQ Bot",
    );
  }

  return { cfg: next };
}
