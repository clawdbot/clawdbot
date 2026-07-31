import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQQBotIngressEffectOnce } from "../gateway/ingress-effects.js";
import type { QueuedMessage } from "../gateway/message-queue.js";
import type { GatewayAccount } from "../gateway/types.js";
import { sendText } from "../messaging/sender.js";
import { trySlashCommand, type SlashCommandHandlerContext } from "./slash-command-handler.js";

vi.mock("../messaging/outbound.js", () => ({
  sendDocument: vi.fn(async () => undefined),
}));

vi.mock("../messaging/sender.js", () => ({
  accountToCreds: vi.fn(() => ({ appId: "app", clientSecret: "" })),
  buildDeliveryTarget: vi.fn(() => ({ targetType: "c2c", targetId: "TRUSTED_OPENID" })),
  sendText: vi.fn(async () => undefined),
}));

const queueSnapshot = {
  totalPending: 0,
  activeUsers: 0,
  maxConcurrentUsers: 1,
  senderPending: 0,
};

let testRoot = "";

function createAccount(): GatewayAccount {
  return {
    accountId: "default",
    appId: "app",
    clientSecret: "",
    markdownSupport: true,
    config: { allowFrom: ["TRUSTED_OPENID"] },
  };
}

function createClearMessage(): QueuedMessage {
  return {
    type: "c2c",
    senderId: "TRUSTED_OPENID",
    content: "/bot-clear-storage --force",
    messageId: "clear-1",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function createHandlerContext(): SlashCommandHandlerContext {
  return {
    account: createAccount(),
    cfg: {},
    getMessagePeerId: () => "c2c:TRUSTED_OPENID",
    getQueueSnapshot: () => queueSnapshot,
  };
}

function createDownload(name: string): string {
  const downloads = path.join(testRoot, ".openclaw", "media", "qqbot", "downloads");
  fs.mkdirSync(downloads, { recursive: true });
  const filePath = path.join(downloads, name);
  fs.writeFileSync(filePath, "payload", "utf8");
  return filePath;
}

beforeEach(() => {
  resetPluginStateStoreForTests();
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-qqbot-effect-once-"));
  const stateDir = path.join(testRoot, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  vi.stubEnv("OPENCLAW_HOME", testRoot);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.mocked(sendText).mockClear();
});

afterEach(() => {
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(testRoot, { recursive: true, force: true });
  testRoot = "";
});

describe("QQBot slash-command ingress effects", () => {
  it("clears storage once and still replies when the ingress event replays", async () => {
    const filePath = createDownload("first.txt");
    const unlink = vi.spyOn(fs, "unlinkSync");
    const effectOnce = createQQBotIngressEffectOnce({ accountId: "default" });
    const ingress = { eventId: "message:clear-1", effectOnce };

    await expect(
      trySlashCommand(createClearMessage(), createHandlerContext(), ingress),
    ).resolves.toBe("handled");
    await expect(
      trySlashCommand(createClearMessage(), createHandlerContext(), ingress),
    ).resolves.toBe("handled");

    expect(fs.existsSync(filePath)).toBe(false);
    expect(unlink).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendText).mock.calls[0]?.[1]).toContain("清理成功");
    expect(vi.mocked(sendText).mock.calls[1]?.[1]).toContain("已经处理");
  });

  it("releases a failed effect so the same ingress event executes on retry", async () => {
    const filePath = createDownload("retry.txt");
    const targetDir = path.dirname(filePath);
    const failure = new Error("scan failed");
    const realExistsSync = fs.existsSync.bind(fs);
    let failScan = true;
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      if (String(candidate) === targetDir && failScan) {
        failScan = false;
        throw failure;
      }
      return realExistsSync(candidate);
    });
    const effectOnce = createQQBotIngressEffectOnce({ accountId: "default" });
    const ingress = { eventId: "message:clear-retry", effectOnce };

    await expect(
      trySlashCommand(createClearMessage(), createHandlerContext(), ingress),
    ).rejects.toBe(failure);
    expect(realExistsSync(filePath)).toBe(true);

    await expect(
      trySlashCommand(createClearMessage(), createHandlerContext(), ingress),
    ).resolves.toBe("handled");
    expect(realExistsSync(filePath)).toBe(false);
    expect(sendText).toHaveBeenCalledOnce();
    expect(vi.mocked(sendText).mock.calls[0]?.[1]).toContain("清理成功");
  });
});
