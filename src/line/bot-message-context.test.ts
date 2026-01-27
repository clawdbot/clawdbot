import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MessageEvent, PostbackEvent } from "@line/bot-sdk";
import type { MoltbotConfig } from "../config/config.js";
import type { ResolvedLineAccount } from "./types.js";
import { buildLineMessageContext, buildLinePostbackContext } from "./bot-message-context.js";

describe("buildLineMessageContext", () => {
  let tmpDir: string;
  let storePath: string;
  let cfg: MoltbotConfig;
  const account: ResolvedLineAccount = {
    accountId: "default",
    enabled: true,
    channelAccessToken: "token",
    channelSecret: "secret",
    tokenSource: "config",
    config: {},
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-line-context-"));
    storePath = path.join(tmpDir, "sessions.json");
    cfg = { session: { store: storePath } };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  });

  it("routes group message replies to the group id", async () => {
    const event = {
      type: "message",
      message: { id: "1", type: "text", text: "hello" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-1", userId: "user-1" },
      mode: "active",
      webhookEventId: "evt-1",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    const context = await buildLineMessageContext({
      event,
      allMedia: [],
      cfg,
      account,
    });

    expect(context.ctxPayload.OriginatingTo).toBe("line:group:group-1");
    expect(context.ctxPayload.To).toBe("line:group:group-1");
  });

  it("routes group postback replies to the group id", async () => {
    const event = {
      type: "postback",
      postback: { data: "action=select" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-2", userId: "user-2" },
      mode: "active",
      webhookEventId: "evt-2",
      deliveryContext: { isRedelivery: false },
    } as PostbackEvent;

    const context = await buildLinePostbackContext({
      event,
      cfg,
      account,
    });

    expect(context?.ctxPayload.OriginatingTo).toBe("line:group:group-2");
    expect(context?.ctxPayload.To).toBe("line:group:group-2");
  });
});
