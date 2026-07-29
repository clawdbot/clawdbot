// Qqbot tests cover slash command handler plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedMessage } from "../gateway/message-queue.js";
import type { GatewayAccount } from "../gateway/types.js";
import { sendText } from "../messaging/sender.js";
import { trySlashCommand } from "./slash-command-handler.js";
import { getWrittenQQBotConfig, installCommandRuntime } from "./slash-command-test-support.js";

vi.mock("../messaging/outbound.js", () => ({
  sendDocument: vi.fn(async () => undefined),
}));

vi.mock("../messaging/sender.js", () => ({
  accountToCreds: vi.fn(() => ({ appId: "app", clientSecret: "" })),
  buildDeliveryTarget: vi.fn(() => ({ targetType: "c2c", targetId: "TRUSTED_OPENID" })),
  sendText: vi.fn(async () => undefined),
}));

function createStreamingMessage(): QueuedMessage {
  return {
    type: "c2c",
    senderId: "TRUSTED_OPENID",
    content: "/bot-streaming on",
    messageId: "msg-1",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function createGroupStopMessage(): QueuedMessage {
  return {
    type: "group",
    senderId: "TRUSTED_OPENID",
    content: "/stop",
    messageId: "msg-stop",
    timestamp: "2026-01-01T00:00:00.000Z",
    groupOpenid: "GROUP_OPENID",
  };
}

function createDmStopMessage(): QueuedMessage {
  return {
    type: "c2c",
    senderId: "TRUSTED_OPENID",
    content: "/stop",
    messageId: "msg-stop-dm",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function createAccount(): GatewayAccount {
  return {
    accountId: "default",
    appId: "app",
    clientSecret: "",
    markdownSupport: true,
    config: {
      allowFrom: ["*"],
      streaming: { mode: "off" },
    },
  };
}

function authorizeGroupCommands(account: GatewayAccount): void {
  account.config.groupAllowFrom = ["TRUSTED_OPENID"];
}

describe("trySlashCommand", () => {
  beforeEach(() => {
    vi.mocked(sendText).mockClear();
  });

  it("honors commands.allowFrom for pre-dispatch bot-streaming in open DM configs", async () => {
    const writes: OpenClawConfig[] = [];
    const config: OpenClawConfig = {
      commands: {
        allowFrom: {
          qqbot: ["TRUSTED_OPENID"],
        },
      },
      channels: {
        qqbot: {
          allowFrom: ["*"],
          streaming: { mode: "off" },
        },
      },
    };
    installCommandRuntime(config, writes);

    const result = await trySlashCommand(createStreamingMessage(), {
      account: createAccount(),
      cfg: config,
      getMessagePeerId: () => "c2c:TRUSTED_OPENID",
      getQueueSnapshot: () => ({
        totalPending: 0,
        activeUsers: 0,
        maxConcurrentUsers: 1,
        senderPending: 0,
      }),
    });

    const qqbot = getWrittenQQBotConfig(writes[0]);
    expect(result).toBe("handled");
    expect(writes).toHaveLength(1);
    expect(qqbot?.streaming).toEqual({ mode: "partial", nativeTransport: true });
    expect(vi.mocked(sendText).mock.calls.at(0)?.[1]).toContain("已开启");
  });

  it("keeps group /stop urgent when command level is strict", async () => {
    const account = createAccount();
    authorizeGroupCommands(account);
    account.config.groups = {
      GROUP_OPENID: { commandLevel: "strict" },
    };

    const result = await trySlashCommand(createGroupStopMessage(), {
      account,
      cfg: {},
      getMessagePeerId: () => "group:GROUP_OPENID",
      getQueueSnapshot: () => ({
        totalPending: 0,
        activeUsers: 0,
        maxConcurrentUsers: 1,
        senderPending: 0,
      }),
    });

    expect(result).toBe("urgent");
  });

  it("keeps group /stop urgent outside strict command level", async () => {
    const account = createAccount();
    authorizeGroupCommands(account);

    const result = await trySlashCommand(createGroupStopMessage(), {
      account,
      cfg: {},
      getMessagePeerId: () => "group:GROUP_OPENID",
      getQueueSnapshot: () => ({
        totalPending: 0,
        activeUsers: 0,
        maxConcurrentUsers: 1,
        senderPending: 0,
      }),
    });

    expect(result).toBe("urgent");
  });

  it("does not let unauthorized group /stop bypass the queue", async () => {
    const result = await trySlashCommand(createGroupStopMessage(), {
      account: createAccount(),
      cfg: {},
      getMessagePeerId: () => "group:GROUP_OPENID",
      getQueueSnapshot: () => ({
        totalPending: 0,
        activeUsers: 0,
        maxConcurrentUsers: 1,
        senderPending: 0,
      }),
    });

    expect(result).toBe("enqueue");
  });

  it("keeps open DM /stop urgent", async () => {
    const result = await trySlashCommand(createDmStopMessage(), {
      account: createAccount(),
      cfg: {},
      getMessagePeerId: () => "c2c:TRUSTED_OPENID",
      getQueueSnapshot: () => ({
        totalPending: 0,
        activeUsers: 0,
        maxConcurrentUsers: 1,
        senderPending: 0,
      }),
    });

    expect(result).toBe("urgent");
  });
});
