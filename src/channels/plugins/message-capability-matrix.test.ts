import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ChannelMessageActionAdapter, ChannelPlugin } from "./types.js";

const telegramDescribeMessageToolMock = vi.fn();
const discordDescribeMessageToolMock = vi.fn();

const telegramPlugin: Pick<ChannelPlugin, "actions"> = {
  actions: {
    describeMessageTool: ({ cfg }) => telegramDescribeMessageToolMock({ cfg }),
    supportsAction: () => true,
  },
};

const discordPlugin: Pick<ChannelPlugin, "actions"> = {
  actions: {
    describeMessageTool: ({ cfg }) => discordDescribeMessageToolMock({ cfg }),
    supportsAction: () => true,
  },
};

// Keep this matrix focused on capability wiring. The extension packages already
// cover their own full channel/plugin boot paths, so local stubs are enough here.
const slackPlugin: Pick<ChannelPlugin, "actions"> = {
  actions: {
    describeMessageTool: ({ cfg }) => {
      const account = cfg.channels?.slack;
      const enabled =
        typeof account?.botToken === "string" &&
        account.botToken.trim() !== "" &&
        typeof account?.appToken === "string" &&
        account.appToken.trim() !== "";
      const capabilities = new Set<string>();
      if (enabled) {
        capabilities.add("presentation");
      }
      if (
        account?.capabilities &&
        (account.capabilities as { interactiveReplies?: unknown }).interactiveReplies === true
      ) {
        capabilities.add("presentation");
      }
      return {
        actions: enabled ? ["send"] : [],
        capabilities: Array.from(capabilities) as Array<"presentation">,
      };
    },
    supportsAction: () => true,
  },
};

const mattermostPlugin: Pick<ChannelPlugin, "actions"> = {
  actions: {
    describeMessageTool: ({ cfg }) => {
      const account = cfg.channels?.mattermost;
      const enabled =
        account?.enabled !== false &&
        typeof account?.botToken === "string" &&
        account.botToken.trim() !== "" &&
        typeof account?.baseUrl === "string" &&
        account.baseUrl.trim() !== "";
      return {
        actions: enabled ? ["send"] : [],
        capabilities: enabled ? (["presentation"] as const) : [],
      };
    },
    supportsAction: () => true,
  },
};

const feishuPlugin: Pick<ChannelPlugin, "actions"> = {
  actions: {
    describeMessageTool: ({ cfg }) => {
      const account = cfg.channels?.feishu;
      const enabled =
        account?.enabled !== false &&
        typeof account?.appId === "string" &&
        account.appId.trim() !== "" &&
        typeof account?.appSecret === "string" &&
        account.appSecret.trim() !== "";
      return {
        actions: enabled ? ["send"] : [],
        capabilities: enabled ? (["presentation"] as const) : [],
      };
    },
    supportsAction: () => true,
  },
};

const msteamsPlugin: Pick<ChannelPlugin, "actions"> = {
  actions: {
    describeMessageTool: ({ cfg }) => {
      const account = cfg.channels?.msteams;
      const enabled =
        account?.enabled !== false &&
        typeof account?.tenantId === "string" &&
        account.tenantId.trim() !== "" &&
        typeof account?.appId === "string" &&
        account.appId.trim() !== "" &&
        typeof account?.appPassword === "string" &&
        account.appPassword.trim() !== "";
      return {
        actions: enabled ? ["poll"] : [],
        capabilities: enabled ? (["presentation"] as const) : [],
      };
    },
    supportsAction: () => true,
  },
};

const zaloPlugin: Pick<ChannelPlugin, "actions"> = {
  actions: {
    describeMessageTool: () => ({ actions: [], capabilities: [] }),
    supportsAction: () => true,
  },
};

describe("channel action capability matrix", () => {
  afterEach(() => {
    telegramDescribeMessageToolMock.mockReset();
    discordDescribeMessageToolMock.mockReset();
  });

  function getCapabilities(plugin: Pick<ChannelPlugin, "actions">, cfg: OpenClawConfig) {
    const describeMessageTool: ChannelMessageActionAdapter["describeMessageTool"] | undefined =
      plugin.actions?.describeMessageTool;
    return [...(describeMessageTool?.({ cfg })?.capabilities ?? [])];
  }

  it("exposes Slack presentation when configured", () => {
    const baseCfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
        },
      },
    } as OpenClawConfig;
    const interactiveCfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
          capabilities: { interactiveReplies: true },
        },
      },
    } as OpenClawConfig;

    expect(getCapabilities(slackPlugin, baseCfg)).toEqual(["presentation"]);
    expect(getCapabilities(slackPlugin, interactiveCfg)).toEqual(["presentation"]);
  });

  it("forwards Telegram action capabilities through the channel wrapper", () => {
    telegramDescribeMessageToolMock.mockReturnValue({
      capabilities: ["presentation"],
    });

    const result = getCapabilities(telegramPlugin, {} as OpenClawConfig);

    expect(result).toEqual(["presentation"]);
    expect(telegramDescribeMessageToolMock).toHaveBeenCalledWith({ cfg: {} });
    discordDescribeMessageToolMock.mockReturnValue({
      capabilities: ["presentation"],
    });

    const discordResult = getCapabilities(discordPlugin, {} as OpenClawConfig);

    expect(discordResult).toEqual(["presentation"]);
    expect(discordDescribeMessageToolMock).toHaveBeenCalledWith({ cfg: {} });
  });

  it("exposes configured channel capabilities only when required credentials are present", () => {
    const configuredCfg = {
      channels: {
        mattermost: {
          enabled: true,
          botToken: "mm-token",
          baseUrl: "https://chat.example.com",
        },
      },
    } as OpenClawConfig;
    const unconfiguredCfg = {
      channels: {
        mattermost: {
          enabled: true,
        },
      },
    } as OpenClawConfig;
    const configuredFeishuCfg = {
      channels: {
        feishu: {
          enabled: true,
          appId: "cli_a",
          appSecret: "secret",
        },
      },
    } as OpenClawConfig;
    const disabledFeishuCfg = {
      channels: {
        feishu: {
          enabled: false,
          appId: "cli_a",
          appSecret: "secret",
        },
      },
    } as OpenClawConfig;
    const configuredMsteamsCfg = {
      channels: {
        msteams: {
          enabled: true,
          tenantId: "tenant",
          appId: "app",
          appPassword: "secret",
        },
      },
    } as OpenClawConfig;
    const disabledMsteamsCfg = {
      channels: {
        msteams: {
          enabled: false,
          tenantId: "tenant",
          appId: "app",
          appPassword: "secret",
        },
      },
    } as OpenClawConfig;

    expect(getCapabilities(mattermostPlugin, configuredCfg)).toEqual(["presentation"]);
    expect(getCapabilities(mattermostPlugin, unconfiguredCfg)).toStrictEqual([]);
    expect(getCapabilities(feishuPlugin, configuredFeishuCfg)).toEqual(["presentation"]);
    expect(getCapabilities(feishuPlugin, disabledFeishuCfg)).toStrictEqual([]);
    expect(getCapabilities(msteamsPlugin, configuredMsteamsCfg)).toEqual(["presentation"]);
    expect(getCapabilities(msteamsPlugin, disabledMsteamsCfg)).toStrictEqual([]);
  });

  it("keeps Zalo actions on the empty capability set", () => {
    const cfg = {
      channels: {
        zalo: {
          enabled: true,
          botToken: "zl-token",
        },
      },
    } as OpenClawConfig;

    expect(getCapabilities(zaloPlugin, cfg)).toStrictEqual([]);
  });
});
