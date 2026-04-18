import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getFrameworkCommands,
  matchSlashCommand,
  type SlashCommandContext,
} from "./slash-commands.js";

/** Build a minimal SlashCommandContext for testing. */
function buildCtx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    type: "c2c",
    senderId: "test-user-001",
    messageId: "msg-001",
    eventTimestamp: new Date().toISOString(),
    receivedAt: Date.now(),
    rawContent: "/bot-ping",
    args: "",
    accountId: "default",
    appId: "000000",
    commandAuthorized: true,
    queueSnapshot: {
      totalPending: 0,
      activeUsers: 0,
      maxConcurrentUsers: 10,
      senderPending: 0,
    },
    ...overrides,
  };
}

function stubEmptyLogFilesystem() {
  vi.spyOn(fs, "existsSync").mockReturnValue(false);
  vi.spyOn(fs, "readdirSync").mockReturnValue([] as never);
  vi.spyOn(fs, "statSync").mockImplementation(() => {
    throw new Error("missing");
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("slash command authorization", () => {
  // ---- /bot-logs (moved to framework registerCommand) ----
  // /bot-logs is registered with the framework via registerCommand() so that
  // resolveCommandAuthorization() enforces commands.allowFrom.qqbot precedence
  // and qqbot: prefix normalization. It is no longer in the pre-dispatch
  // slash-command registry, so matchSlashCommand returns null and lets the
  // normal inbound queue handle it.

  it("passes /bot-logs through to the framework (returns null)", async () => {
    const ctx = buildCtx({ rawContent: "/bot-logs", commandAuthorized: false });
    expect(await matchSlashCommand(ctx)).toBeNull();
  });

  it("passes /bot-logs ? through to the framework (returns null)", async () => {
    const ctx = buildCtx({ rawContent: "/bot-logs ?", commandAuthorized: false });
    expect(await matchSlashCommand(ctx)).toBeNull();
  });

  // ---- /bot-ping (no requireAuth) ----

  it("allows /bot-ping for unauthorized sender", async () => {
    const ctx = buildCtx({
      rawContent: "/bot-ping",
      commandAuthorized: false,
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("pong");
  });

  it("allows /bot-ping for authorized sender", async () => {
    const ctx = buildCtx({
      rawContent: "/bot-ping",
      commandAuthorized: true,
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("pong");
  });

  // ---- /bot-help (no requireAuth) ----

  it("allows /bot-help for unauthorized sender", async () => {
    const ctx = buildCtx({
      rawContent: "/bot-help",
      commandAuthorized: false,
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("QQBot");
  });

  // ---- /bot-version (no requireAuth) ----

  it("allows /bot-version for unauthorized sender", async () => {
    const ctx = buildCtx({
      rawContent: "/bot-version",
      commandAuthorized: false,
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("OpenClaw");
  });

  // ---- unknown commands ----

  it("returns null for unknown slash commands", async () => {
    const ctx = buildCtx({
      rawContent: "/unknown-command",
      commandAuthorized: false,
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeNull();
  });

  it("returns null for non-slash messages", async () => {
    const ctx = buildCtx({
      rawContent: "hello",
      commandAuthorized: false,
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeNull();
  });

  // ---- usage query (?) for remaining pre-dispatch commands ----
});

describe("/bot-logs framework command hardening", () => {
  function getBotLogsHandler() {
    const command = getFrameworkCommands().find((item) => item.name === "bot-logs");
    expect(command).toBeDefined();
    return command!.handler;
  }

  it("rejects /bot-logs when allowFrom is wildcard", async () => {
    const handler = getBotLogsHandler();
    const result = await handler(buildCtx({ accountConfig: { allowFrom: ["*"] } }));
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("权限不足");
  });

  it("rejects /bot-logs when allowFrom mixes wildcard and explicit entries", async () => {
    const handler = getBotLogsHandler();
    const result = await handler(buildCtx({ accountConfig: { allowFrom: ["*", "qqbot:user-1"] } }));
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("权限不足");
  });

  it("rejects /bot-logs when allowFrom uses qqbot:* wildcard form", async () => {
    const handler = getBotLogsHandler();
    const result = await handler(buildCtx({ accountConfig: { allowFrom: ["qqbot:*"] } }));
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("权限不足");
  });

  it("rejects /bot-logs when allowFrom uses qqbot: * wildcard form", async () => {
    const handler = getBotLogsHandler();
    const result = await handler(buildCtx({ accountConfig: { allowFrom: ["qqbot: *"] } }));
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("权限不足");
  });

  it("allows /bot-logs when allowFrom contains numeric sender ids", async () => {
    stubEmptyLogFilesystem();
    const handler = getBotLogsHandler();
    const accountConfig = { allowFrom: [12345] } as unknown as SlashCommandContext["accountConfig"];
    const result = await handler(buildCtx({ accountConfig }));
    expect(result).toContain("未找到日志文件");
  });

  it("allows /bot-logs execution when allowFrom is explicit", async () => {
    stubEmptyLogFilesystem();
    const handler = getBotLogsHandler();
    const result = await handler(buildCtx({ accountConfig: { allowFrom: ["qqbot:user-1"] } }));
    expect(result).toContain("未找到日志文件");
  });
});
