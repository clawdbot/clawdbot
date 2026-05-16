import {
  createNonExitingRuntimeEnv,
  createPluginSetupWizardConfigure,
  createPluginSetupWizardStatus,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeishuProbeResult } from "./types.js";

const {
  beginAppRegistrationMock,
  getAppOwnerOpenIdMock,
  initAppRegistrationMock,
  pollAppRegistrationMock,
  printQrCodeMock,
  probeFeishuMock,
} = vi.hoisted(() => ({
  beginAppRegistrationMock: vi.fn(),
  getAppOwnerOpenIdMock: vi.fn(),
  initAppRegistrationMock: vi.fn(),
  pollAppRegistrationMock: vi.fn(),
  printQrCodeMock: vi.fn(),
  probeFeishuMock: vi.fn<() => Promise<FeishuProbeResult>>(async () => ({
    ok: false,
    error: "mocked",
  })),
}));

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./app-registration.js", () => ({
  initAppRegistration: initAppRegistrationMock,
  beginAppRegistration: beginAppRegistrationMock,
  pollAppRegistration: pollAppRegistrationMock,
  printQrCode: printQrCodeMock,
  getAppOwnerOpenId: getAppOwnerOpenIdMock,
}));

import { feishuPlugin } from "./channel.js";

const baseStatusContext = {
  accountOverrides: {},
};

async function withEnvVars(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, prior] of previous.entries()) {
      if (prior === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prior;
      }
    }
  }
}

async function getStatusWithEnvRefs(params: { appIdKey: string; appSecretKey: string }) {
  return await feishuGetStatus({
    cfg: {
      channels: {
        feishu: {
          appId: { source: "env", id: params.appIdKey, provider: "default" },
          appSecret: { source: "env", id: params.appSecretKey, provider: "default" },
        },
      },
    } as never,
    ...baseStatusContext,
  });
}

const feishuConfigure = createPluginSetupWizardConfigure(feishuPlugin);
const feishuGetStatus = createPluginSetupWizardStatus(feishuPlugin);

afterAll(() => {
  vi.doUnmock("./probe.js");
  vi.doUnmock("./app-registration.js");
  vi.resetModules();
});

describe("feishu setup wizard", () => {
  beforeEach(() => {
    probeFeishuMock.mockReset();
    probeFeishuMock.mockResolvedValue({ ok: false, error: "mocked" });
    initAppRegistrationMock.mockReset();
    initAppRegistrationMock.mockRejectedValue(new Error("mocked: scan-to-create not available"));
    beginAppRegistrationMock.mockReset();
    pollAppRegistrationMock.mockReset();
    printQrCodeMock.mockReset();
    printQrCodeMock.mockResolvedValue(undefined);
    getAppOwnerOpenIdMock.mockReset();
    getAppOwnerOpenIdMock.mockResolvedValue(undefined);
  });

  it("uses manual credentials by default instead of starting scan-to-create", async () => {
    const text = vi.fn().mockResolvedValueOnce("cli_manual").mockResolvedValueOnce("secret_manual");
    const prompter = createTestWizardPrompter({ text });

    const result = await runSetupWizardConfigure({
      configure: feishuConfigure,
      cfg: {} as never,
      prompter,
      runtime: createNonExitingRuntimeEnv(),
    });

    expect(initAppRegistrationMock).not.toHaveBeenCalled();
    expect(beginAppRegistrationMock).not.toHaveBeenCalled();
    const feishuConfig = result.cfg.channels?.feishu;
    expect(feishuConfig?.appId).toBe("cli_manual");
    expect(feishuConfig?.appSecret).toBe("secret_manual");
    expect(feishuConfig?.connectionMode).toBe("websocket");
    expect(feishuConfig?.domain).toBe("feishu");
  });

  it("passes selected domain through scan-to-create and poll", async () => {
    initAppRegistrationMock.mockResolvedValueOnce(undefined);
    beginAppRegistrationMock.mockResolvedValueOnce({
      deviceCode: "device-code",
      qrUrl: "https://accounts.larksuite.com/qr",
      userCode: "user-code",
      interval: 1,
      expireIn: 10,
    });
    pollAppRegistrationMock.mockResolvedValueOnce({
      status: "success",
      result: {
        appId: "cli_lark",
        appSecret: "secret_lark",
        domain: "lark",
        openId: "ou_owner",
      },
    });
    const prompter = createTestWizardPrompter({
      select: vi
        .fn()
        .mockResolvedValueOnce("scan")
        .mockResolvedValueOnce("lark")
        .mockResolvedValueOnce("open") as never,
    });

    const result = await runSetupWizardConfigure({
      configure: feishuConfigure,
      cfg: {} as never,
      prompter,
      runtime: createNonExitingRuntimeEnv(),
    });

    expect(initAppRegistrationMock).toHaveBeenCalledWith("lark");
    expect(beginAppRegistrationMock).toHaveBeenCalledWith("lark");
    const [pollOptions] = pollAppRegistrationMock.mock.calls.at(0) ?? [];
    expect(pollOptions?.deviceCode).toBe("device-code");
    expect(pollOptions?.initialDomain).toBe("lark");
    expect(pollOptions?.tp).toBe("ob_cli_app");
    const feishuConfig = result.cfg.channels?.feishu;
    expect(feishuConfig?.appId).toBe("cli_lark");
    expect(feishuConfig?.appSecret).toBe("secret_lark");
    expect(feishuConfig?.domain).toBe("lark");
    expect(feishuConfig?.groupPolicy).toBe("open");
    expect(feishuConfig?.requireMention).toBe(true);
  });

  it("falls back to manual credentials when selected scan-to-create is unavailable", async () => {
    const text = vi
      .fn()
      .mockResolvedValueOnce("cli_from_fallback")
      .mockResolvedValueOnce("secret_from_fallback");
    const prompter = createTestWizardPrompter({
      text,
      select: vi
        .fn()
        .mockResolvedValueOnce("scan")
        .mockResolvedValueOnce("feishu")
        .mockResolvedValueOnce("allowlist") as never,
    });

    const result = await runSetupWizardConfigure({
      configure: feishuConfigure,
      cfg: {} as never,
      prompter,
      runtime: createNonExitingRuntimeEnv(),
    });

    expect(initAppRegistrationMock).toHaveBeenCalledWith("feishu");
    expect(beginAppRegistrationMock).not.toHaveBeenCalled();
    const feishuConfig = result.cfg.channels?.feishu;
    expect(feishuConfig?.appId).toBe("cli_from_fallback");
    expect(feishuConfig?.appSecret).toBe("secret_from_fallback");
    expect(feishuConfig?.domain).toBe("feishu");
  });

  it("prompts over SecretRef appId/appSecret config objects", async () => {
    const text = vi
      .fn()
      .mockResolvedValueOnce("cli_from_prompt")
      .mockResolvedValueOnce("secret_from_prompt");
    const prompter = createTestWizardPrompter({
      text,
      confirm: vi.fn(async () => true),
      select: vi.fn(
        async ({ initialValue }: { initialValue?: string }) => initialValue ?? "bot",
      ) as never,
    });

    const result = await runSetupWizardConfigure({
      configure: feishuConfigure,
      cfg: {
        channels: {
          feishu: {
            appId: { source: "env", id: "FEISHU_APP_ID", provider: "default" },
            appSecret: { source: "env", id: "FEISHU_APP_SECRET", provider: "default" },
          },
        },
      } as never,
      prompter,
      runtime: createNonExitingRuntimeEnv(),
    });

    expect(result.cfg.channels?.feishu).toEqual({
      appId: "cli_from_prompt",
      appSecret: "secret_from_prompt",
      enabled: true,
      domain: "feishu",
      connectionMode: "websocket",
      groupPolicy: "allowlist",
    });
  });
});

describe("feishu setup wizard status", () => {
  beforeEach(() => {
    probeFeishuMock.mockReset();
    probeFeishuMock.mockResolvedValue({ ok: false, error: "mocked" });
  });

  it("treats SecretRef appSecret as configured when appId is present", async () => {
    const status = await feishuGetStatus({
      cfg: {
        channels: {
          feishu: {
            appId: "cli_a123456",
            appSecret: {
              source: "env",
              provider: "default",
              id: "FEISHU_APP_SECRET",
            },
          },
        },
      } as never,
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
  });

  it("probes the resolved default account in multi-account config", async () => {
    probeFeishuMock.mockResolvedValueOnce({ ok: true, botName: "Feishu Main" });

    const status = await feishuGetStatus({
      cfg: {
        channels: {
          feishu: {
            enabled: true,
            defaultAccount: "main-bot",
            accounts: {
              "main-bot": {
                appId: "cli_main",
                appSecret: "main-app-secret", // pragma: allowlist secret
                connectionMode: "websocket",
              },
            },
          },
        },
      } as never,
      ...baseStatusContext,
    });

    expect(status.configured).toBe(true);
    expect(status.statusLines).toEqual(["Feishu: connected as Feishu Main"]);
    expect(probeFeishuMock).toHaveBeenCalledWith({
      accountId: "main-bot",
      selectionSource: "explicit-default",
      enabled: true,
      configured: true,
      name: undefined,
      appId: "cli_main",
      appSecret: "main-app-secret", // pragma: allowlist secret
      encryptKey: undefined,
      verificationToken: undefined,
      domain: "feishu",
      config: {
        enabled: true,
        appId: "cli_main",
        appSecret: "main-app-secret", // pragma: allowlist secret
        connectionMode: "websocket",
      },
    });
  });

  it("localizes existing bot setup prompts and status lines", async () => {
    const previousLocale = process.env.OPENCLAW_LOCALE;
    process.env.OPENCLAW_LOCALE = "zh-CN";
    const confirm = vi.fn(async () => true);
    const note = vi.fn(async () => {});
    const prompter = createTestWizardPrompter({
      confirm,
      note,
    });

    try {
      await runSetupWizardConfigure({
        configure: feishuConfigure,
        cfg: {
          channels: {
            feishu: {
              appId: "cli_a123456",
              appSecret: "sample-app-credential", // pragma: allowlist secret
            },
          },
        } as never,
        prompter,
        runtime: createNonExitingRuntimeEnv(),
      });

      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "发现已有 bot（App ID：cli_a123456）。用于本次设置？",
        }),
      );
      expect(note).toHaveBeenCalledWith("Bot 已配置。", "");
    } finally {
      if (previousLocale === undefined) {
        delete process.env.OPENCLAW_LOCALE;
      } else {
        process.env.OPENCLAW_LOCALE = previousLocale;
      }
    }
  });

  it("localizes new bot setup prompts and progress", async () => {
    const previousLocale = process.env.OPENCLAW_LOCALE;
    process.env.OPENCLAW_LOCALE = "zh-CN";
    const note = vi.fn(async () => {});
    const stop = vi.fn();
    const progress = vi.fn(() => ({ update: vi.fn(), stop }));
    const select = vi.fn(async ({ message }: { message: string }) => {
      if (message === "你想如何连接 Feishu？") {
        return "manual";
      }
      if (message === "选择 Feishu 域名？") {
        return "feishu";
      }
      if (message === "群聊策略") {
        return "allowlist";
      }
      return "feishu";
    });
    const text = vi
      .fn()
      .mockResolvedValueOnce("cli_from_prompt")
      .mockResolvedValueOnce("secret_from_prompt");
    const prompter = createTestWizardPrompter({
      note,
      progress,
      select: select as never,
      text,
    });

    try {
      await runSetupWizardConfigure({
        configure: feishuConfigure,
        cfg: {} as never,
        prompter,
        runtime: createNonExitingRuntimeEnv(),
      });

      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "你想如何连接 Feishu？",
          options: [
            { value: "manual", label: "手动输入 App ID 和 App Secret" },
            { value: "scan", label: "扫描二维码自动创建 bot" },
          ],
        }),
      );
      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "选择 Feishu 域名？",
          options: [
            { value: "feishu", label: "Feishu (feishu.cn) - 中国" },
            { value: "lark", label: "Lark (larksuite.com) - 国际版" },
          ],
        }),
      );
      expect(text).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "输入 Feishu App ID",
        }),
      );
      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "群聊策略",
          options: [
            { value: "allowlist", label: "允许列表 - 只在指定群中响应" },
            { value: "open", label: "开放 - 在所有群中响应（需要提及）" },
            { value: "disabled", label: "禁用 - 不响应群聊" },
          ],
        }),
      );
      expect(progress).toHaveBeenCalledWith("正在配置...");
      expect(stop).toHaveBeenCalledWith("Bot 已配置。");
    } finally {
      if (previousLocale === undefined) {
        delete process.env.OPENCLAW_LOCALE;
      } else {
        process.env.OPENCLAW_LOCALE = previousLocale;
      }
    }
  });

  it("does not fallback to top-level appId when account explicitly sets empty appId", async () => {
    const status = await feishuGetStatus({
      cfg: {
        channels: {
          feishu: {
            appId: "top_level_app",
            accounts: {
              main: {
                appId: "",
                appSecret: "sample-app-credential", // pragma: allowlist secret
              },
            },
          },
        },
      } as never,
      ...baseStatusContext,
    });

    expect(status.configured).toBe(false);
  });

  it("treats env SecretRef appId as not configured when env var is missing", async () => {
    const appIdKey = "FEISHU_APP_ID_STATUS_MISSING_TEST";
    const appSecretKey = "FEISHU_APP_CREDENTIAL_STATUS_MISSING_TEST"; // pragma: allowlist secret
    await withEnvVars(
      {
        [appIdKey]: undefined,
        [appSecretKey]: "env-credential-456", // pragma: allowlist secret
      },
      async () => {
        const status = await getStatusWithEnvRefs({ appIdKey, appSecretKey });
        expect(status.configured).toBe(false);
      },
    );
  });

  it("treats env SecretRef appId/appSecret as configured in status", async () => {
    const appIdKey = "FEISHU_APP_ID_STATUS_TEST";
    const appSecretKey = "FEISHU_APP_CREDENTIAL_STATUS_TEST"; // pragma: allowlist secret
    await withEnvVars(
      {
        [appIdKey]: "cli_env_123",
        [appSecretKey]: "env-credential-456", // pragma: allowlist secret
      },
      async () => {
        const status = await getStatusWithEnvRefs({ appIdKey, appSecretKey });
        expect(status.configured).toBe(true);
      },
    );
  });
});
