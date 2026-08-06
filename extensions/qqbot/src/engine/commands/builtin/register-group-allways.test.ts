// Qqbot tests cover group-allways command plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedMessage } from "../../gateway/message-queue.js";
import type { GatewayAccount } from "../../gateway/types.js";
import { sendText } from "../../messaging/sender.js";
import { trySlashCommand } from "../slash-command-handler.js";
import { installCommandRuntime } from "../slash-command-test-support.js";

vi.mock("../../messaging/outbound.js", () => ({
  sendDocument: vi.fn(async () => undefined),
}));

vi.mock("../../messaging/sender.js", () => ({
  accountToCreds: vi.fn(() => ({ appId: "app", clientSecret: "" })),
  buildDeliveryTarget: vi.fn(() => ({ targetType: "c2c", targetId: "TRUSTED_OPENID" })),
  sendText: vi.fn(async () => undefined),
}));

type WrittenQQBotConfigWithAllways = {
  defaultRequireMention?: unknown;
  accounts?: Record<string, { defaultRequireMention?: unknown }>;
};

type RunCommandParams = {
  account?: GatewayAccount;
  arg?: string;
  config?: OpenClawConfig;
};

const queueSnapshot = {
  totalPending: 0,
  activeUsers: 0,
  maxConcurrentUsers: 1,
  senderPending: 0,
};

function createGroupAllwaysMessage(arg = ""): QueuedMessage {
  return {
    type: "c2c",
    senderId: "TRUSTED_OPENID",
    content: `/bot-group-allways ${arg}`.trim(),
    messageId: "msg-1",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function createAccount(accountId = "default", overrides?: Record<string, unknown>): GatewayAccount {
  return {
    accountId,
    appId: "app",
    clientSecret: "",
    markdownSupport: true,
    config: {
      allowFrom: ["*"],
      ...(accountId === "default" ? { defaultRequireMention: true } : {}),
      ...overrides,
    },
  };
}

function createConfig(qqbot: NonNullable<OpenClawConfig["channels"]>["qqbot"]): OpenClawConfig {
  return {
    commands: {
      allowFrom: { qqbot: ["TRUSTED_OPENID"] },
    },
    channels: { qqbot },
  };
}

function getAllwaysConfig(
  write: OpenClawConfig | undefined,
): WrittenQQBotConfigWithAllways | undefined {
  return write?.channels?.qqbot as WrittenQQBotConfigWithAllways | undefined;
}

async function runGroupAllwaysCommand({
  account = createAccount(),
  arg = "",
  config = createConfig({ allowFrom: ["*"], defaultRequireMention: true }),
}: RunCommandParams = {}) {
  const writes: OpenClawConfig[] = [];
  installCommandRuntime(config, writes);

  const result = await trySlashCommand(createGroupAllwaysMessage(arg), {
    account,
    cfg: config,
    getMessagePeerId: () => "c2c:TRUSTED_OPENID",
    getQueueSnapshot: () => queueSnapshot,
  });

  return {
    result,
    writes,
    reply: vi.mocked(sendText).mock.calls.at(0)?.[1] ?? "",
  };
}

describe("bot-group-allways command", () => {
  beforeEach(() => {
    vi.mocked(sendText).mockClear();
  });

  it.each([
    {
      defaultRequireMention: true,
      expectedReply: "仅被 @ 时回复",
    },
    {
      defaultRequireMention: false,
      expectedReply: "自主判断何时发言",
    },
  ])("shows current status for defaultRequireMention=$defaultRequireMention", async (testCase) => {
    const config = createConfig({
      allowFrom: ["*"],
      defaultRequireMention: testCase.defaultRequireMention,
    });

    const { result, reply, writes } = await runGroupAllwaysCommand({
      account: createAccount("default", {
        defaultRequireMention: testCase.defaultRequireMention,
      }),
      config,
    });

    expect(result).toBe("handled");
    expect(writes).toHaveLength(0);
    expect(reply).toContain(testCase.expectedReply);
  });

  it.each([
    {
      arg: "on",
      currentDefaultRequireMention: true,
      expectedDefaultRequireMention: false,
      expectedReply: "**on**",
    },
    {
      arg: "off",
      currentDefaultRequireMention: false,
      expectedDefaultRequireMention: true,
      expectedReply: "**off**",
    },
  ])("writes defaultRequireMention for default account when toggled $arg", async (testCase) => {
    const config = createConfig({
      allowFrom: ["*"],
      defaultRequireMention: testCase.currentDefaultRequireMention,
    });

    const { result, reply, writes } = await runGroupAllwaysCommand({
      account: createAccount("default", {
        defaultRequireMention: testCase.currentDefaultRequireMention,
      }),
      arg: testCase.arg,
      config,
    });

    expect(result).toBe("handled");
    expect(writes).toHaveLength(1);
    expect(getAllwaysConfig(writes[0])?.defaultRequireMention).toBe(
      testCase.expectedDefaultRequireMention,
    );
    expect(reply).toContain(testCase.expectedReply);
  });

  it("writes to accounts.{accountId}.defaultRequireMention for named accounts", async () => {
    const { result, writes } = await runGroupAllwaysCommand({
      account: createAccount("bot-a"),
      arg: "on",
      config: createConfig({
        allowFrom: ["*"],
        accounts: {
          "bot-a": {},
        },
      }),
    });

    expect(result).toBe("handled");
    expect(writes).toHaveLength(1);
    expect(getAllwaysConfig(writes[0])?.accounts?.["bot-a"]?.defaultRequireMention).toBe(false);
  });

  it("returns no-op when toggling to same state", async () => {
    const { result, reply, writes } = await runGroupAllwaysCommand({
      arg: "off",
      config: createConfig({
        allowFrom: ["*"],
        defaultRequireMention: true,
      }),
    });

    expect(result).toBe("handled");
    expect(writes).toHaveLength(0);
    expect(reply).toContain("无需操作");
  });

  it("returns error for invalid argument", async () => {
    const { result, reply, writes } = await runGroupAllwaysCommand({
      arg: "invalid",
      config: createConfig({
        allowFrom: ["*"],
      }),
    });

    expect(result).toBe("handled");
    expect(writes).toHaveLength(0);
    expect(reply).toContain("参数错误");
  });
});
