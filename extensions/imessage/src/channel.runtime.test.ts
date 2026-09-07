// Imessage tests cover channel plugin behavior.
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import { IMessageRpcClient } from "./client.js";
import { sendMessageIMessage } from "./send.js";

const monitorMock = vi.hoisted(() => vi.fn(async () => undefined));
const createRpcClientMock = vi.hoisted(() => vi.fn());

vi.mock("./monitor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor.js")>()),
  monitorIMessageProvider: monitorMock,
}));

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createIMessageRpcClient: createRpcClientMock,
}));

const { sendIMessageOutbound, startIMessageGatewayAccount } = await import("./channel.runtime.js");
const { resolveIMessageAccount } = await import("./accounts.js");
const { imessagePlugin } = await import("./channel.js");

function makeCtx(params: {
  cfg: Parameters<typeof resolveIMessageAccount>[0]["cfg"];
  accountId: string;
}) {
  const account = resolveIMessageAccount({ cfg: params.cfg, accountId: params.accountId });
  const ac = new AbortController();
  const statusEvents: unknown[] = [];
  const logEvents: { level: string; line: string }[] = [];
  return {
    ctx: {
      cfg: params.cfg,
      accountId: params.accountId,
      account,
      runtime: {} as never,
      abortSignal: ac.signal,
      log: {
        info: (line: string) => logEvents.push({ level: "info", line }),
      },
      getStatus: () => ({ accountId: params.accountId }),
      setStatus: (next: unknown) => statusEvents.push(next),
      channelRuntime: undefined as never,
    } as never,
    abort: () => ac.abort(),
    statusEvents,
    logEvents,
  };
}

describe("startIMessageGatewayAccount duplicate-source handling", () => {
  it("parks the watcher slot without spawning monitorIMessageProvider for a non-owner duplicate", async () => {
    monitorMock.mockClear();
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            "swang430-gmail-com": { cliPath: "imsg" },
            default: { enabled: true },
          },
        },
      },
    } as never;
    const { ctx, abort, logEvents, statusEvents } = makeCtx({ cfg, accountId: "default" });

    const settled = vi.fn();
    const task = startIMessageGatewayAccount(ctx).then(settled);

    await vi.waitFor(() => {
      expect(logEvents.some((event) => event.line.includes("skipping watcher"))).toBe(true);
    });
    expect(monitorMock).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(logEvents.some((e) => e.line.includes("skipping watcher"))).toBe(true);
    expect(logEvents.some((e) => e.line.includes('using account "swang430-gmail-com"'))).toBe(true);
    expect(statusEvents).not.toEqual([]);
    expect(statusEvents.every((event) => !(event as Record<string, unknown>).lifecycle)).toBe(true);

    abort();
    await task;
    expect(settled).toHaveBeenCalled();
    expect(monitorMock).not.toHaveBeenCalled();
  });

  it("starts monitorIMessageProvider for the duplicate-source owner", async () => {
    monitorMock.mockClear();
    monitorMock.mockResolvedValueOnce(undefined);
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            "swang430-gmail-com": { cliPath: "imsg" },
            default: {},
          },
        },
      },
    } as never;
    const { ctx, statusEvents } = makeCtx({ cfg, accountId: "swang430-gmail-com" });

    await startIMessageGatewayAccount(ctx);
    expect(monitorMock).toHaveBeenCalledTimes(1);
    expect(statusEvents).toContainEqual(
      expect.objectContaining({ lifecycle: "starting", accountId: "swang430-gmail-com" }),
    );
    expect(monitorMock).toHaveBeenCalledWith(
      expect.objectContaining({ statusSink: expect.any(Function) }),
    );
  });

  it.each([
    {
      name: "an implicit and explicit default database",
      primary: { cliPath: "imsg" },
      secondary: () => ({
        cliPath: "imsg",
        dbPath: path.join(process.env.HOME || os.homedir(), "Library", "Messages", "chat.db"),
      }),
    },
    {
      name: "the same absolute executable with implicit and explicit databases",
      primary: { cliPath: "/usr/local/bin/imsg" },
      secondary: () => ({
        cliPath: "/usr/local/bin/imsg",
        dbPath: path.join(process.env.HOME || os.homedir(), "Library", "Messages", "chat.db"),
      }),
    },
  ])("starts only one real monitor for $name", async ({ primary, secondary }) => {
    monitorMock.mockClear();
    monitorMock.mockResolvedValueOnce(undefined);
    const cfg = {
      channels: {
        imessage: {
          accounts: { primary, secondary: secondary() },
        },
      },
    } as never;
    const owner = makeCtx({ cfg, accountId: "primary" });
    const duplicate = makeCtx({ cfg, accountId: "secondary" });

    await startIMessageGatewayAccount(owner.ctx);
    const duplicateTask = startIMessageGatewayAccount(duplicate.ctx);
    try {
      await vi.waitFor(() => {
        expect(duplicate.logEvents.some((event) => event.line.includes("skipping watcher"))).toBe(
          true,
        );
      });
      expect(monitorMock).toHaveBeenCalledTimes(1);
      expect(duplicate.logEvents.some((event) => event.line.includes("skipping watcher"))).toBe(
        true,
      );
      expect(
        duplicate.statusEvents.every((event) => !(event as Record<string, unknown>).lifecycle),
      ).toBe(true);
    } finally {
      duplicate.abort();
      await duplicateTask;
    }
  });

  it("starts the only configured watcher instead of parking it under an unconfigured account", async () => {
    monitorMock.mockClear();
    monitorMock.mockResolvedValueOnce(undefined);
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            primary: {},
            secondary: { enabled: true, cliPath: "imsg" },
          },
        },
      },
    } as never;
    const configured = makeCtx({ cfg, accountId: "secondary" });
    await startIMessageGatewayAccount(configured.ctx);
    expect(monitorMock).toHaveBeenCalledTimes(1);
    expect(configured.statusEvents).toContainEqual(
      expect.objectContaining({ lifecycle: "starting", accountId: "secondary" }),
    );
  });

  it("starts independent monitors for distinct auto-detected remote wrappers named imsg", async () => {
    monitorMock.mockClear();
    monitorMock.mockResolvedValue(undefined);
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            primary: {
              enabled: true,
              cliPath: "/opt/host-a/imsg",
              dbPath: "/Users/bot/Library/Messages/chat.db",
            },
            secondary: {
              enabled: true,
              cliPath: "/opt/host-b/imsg",
              dbPath: "/Users/bot/Library/Messages/chat.db",
            },
          },
        },
      },
    } as never;
    const first = makeCtx({ cfg, accountId: "primary" });
    const second = makeCtx({ cfg, accountId: "secondary" });

    await startIMessageGatewayAccount(first.ctx);
    await startIMessageGatewayAccount(second.ctx);
    expect(monitorMock).toHaveBeenCalledTimes(2);
    expect(second.logEvents.some((event) => event.line.includes("skipping watcher"))).toBe(false);
  });

  it("starts monitorIMessageProvider when an account has no duplicate sibling", async () => {
    monitorMock.mockClear();
    monitorMock.mockResolvedValueOnce(undefined);
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            solo: { cliPath: "/usr/local/bin/imsg-solo" },
          },
        },
      },
    } as never;
    const { ctx } = makeCtx({ cfg, accountId: "solo" });

    await startIMessageGatewayAccount(ctx);
    expect(monitorMock).toHaveBeenCalledTimes(1);
  });
});

describe("sendIMessageOutbound approval identity", () => {
  it("preserves the original host media capability and supported split reader", async () => {
    const trustedReader = vi.fn(async () => Buffer.from("trusted"));
    const legacyReader = vi.fn(async () => Buffer.from("legacy"));
    const mediaAccess = {
      localRoots: ["/trusted/workspace"],
      workspaceDir: "/trusted/workspace",
      readFile: trustedReader,
    };
    const send = vi.fn(
      async (
        _to: string,
        _text: string,
        options: { mediaAccess?: typeof mediaAccess; mediaReadFile?: typeof legacyReader },
      ) => ({ messageId: "p:0/trusted-media", options }),
    );

    await sendIMessageOutbound({
      cfg: {} as never,
      to: "+15551230000",
      text: "caption",
      mediaUrl: "workspace-image.png",
      mediaAccess,
      mediaLocalRoots: ["/untrusted/legacy"],
      mediaReadFile: legacyReader,
      deps: { imessage: send },
    });

    const forwarded = send.mock.calls[0]?.[2];
    expect(forwarded?.mediaAccess).toBe(mediaAccess);
    expect(forwarded?.mediaReadFile).toBe(legacyReader);
    expect(forwarded).toEqual(expect.objectContaining({ mediaLocalRoots: ["/untrusted/legacy"] }));
  });

  it("keeps a Gateway-shaped host media capability reader-free", async () => {
    const mediaAccess = { localRoots: ["/trusted/workspace"], workspaceDir: "/trusted/workspace" };
    const send = vi.fn(
      async (_to: string, _text: string, options: { mediaAccess?: typeof mediaAccess }) => ({
        messageId: "p:0/gateway-media",
        options,
      }),
    );

    await sendIMessageOutbound({
      cfg: {} as never,
      to: "+15551230000",
      text: "caption",
      mediaUrl: "workspace-image.png",
      mediaAccess,
      deps: { imessage: send },
    });

    expect(send.mock.calls[0]?.[2]?.mediaAccess).toBe(mediaAccess);
    expect(send.mock.calls[0]?.[2]).not.toHaveProperty("mediaReadFile");
  });

  it("promotes the exact tapback GUID and delivered text into channel-private metadata", async () => {
    const send = vi.fn(async () => ({
      messageId: "42",
      guid: "p:0/stable-guid",
      sentText: "delivered approval text",
      receipt: {
        primaryPlatformMessageId: "42",
        platformMessageIds: ["42"],
        parts: [{ platformMessageId: "42", kind: "text" as const, index: 0 }],
        sentAt: 1_000,
      },
    }));

    await expect(
      sendIMessageOutbound({
        cfg: {} as never,
        to: "+15551230000",
        text: "approval text",
        conversationReadOrigin: "delegated",
        deps: { imessage: send },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        messageId: "42",
        meta: {
          imessageMessageGuid: "p:0/stable-guid",
          imessageVisibleText: "delivered approval text",
        },
      }),
    );
    expect(send).toHaveBeenCalledWith(
      "+15551230000",
      "approval text",
      expect.objectContaining({ conversationReadOrigin: "delegated" }),
    );
  });

  it("forwards accepted attachment progress before a later native caption failure", async () => {
    const receipt = {
      primaryPlatformMessageId: "p:0/accepted-attachment",
      platformMessageIds: ["p:0/accepted-attachment"],
      parts: [{ platformMessageId: "p:0/accepted-attachment", kind: "media" as const, index: 0 }],
      sentAt: 1_000,
    };
    const accepted = {
      content: "",
      messageId: "p:0/accepted-attachment",
      messageIds: ["p:0/accepted-attachment"],
      sentText: "",
      receipt,
      visibleReplySent: true as const,
    };
    const captionError = new Error("caption failed after accepted attachment");
    const send = vi.fn(async (_to, _text, options) => {
      await options.onDeliveryResult?.(accepted);
      throw captionError;
    });
    const onDeliveryResult = vi.fn();

    await expect(
      sendIMessageOutbound({
        cfg: {} as never,
        to: "+15551230000",
        text: "caption",
        mediaUrl: "/tmp/report.pdf",
        deps: { imessage: send },
        onDeliveryResult,
      }),
    ).rejects.toBe(captionError);

    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(accepted);
  });
});

describe("iMessage account media limits", () => {
  it.each(["work", undefined])("enforces the resolved account cap for %s", async (accountId) => {
    const state = await createOpenClawTestState({ prefix: "imessage-account-media-" });
    const client = new IMessageRpcClient();
    const delivered: Buffer[] = [];
    const request = vi.spyOn(client, "request").mockImplementation(async (_method, params) => {
      if (typeof params?.file !== "string") {
        throw new Error("Missing native attachment path");
      }
      delivered.push(await readFile(params.file));
      return { guid: "p:0/account-media" };
    });
    try {
      const smallBytes = Buffer.from("%PDF-1.4\nsmall attachment");
      const largeBytes = Buffer.alloc(2 * 1024 * 1024, 0x61);
      const small = state.path("small.pdf");
      const large = state.path("large.pdf");
      await writeFile(small, smallBytes);
      await writeFile(large, largeBytes);
      const send: typeof sendMessageIMessage = (to, text, options) =>
        sendMessageIMessage(to, text, { ...options, client });
      const params = {
        cfg: {
          channels: {
            imessage: {
              cliPath: state.path("fixture-imsg"),
              dbPath: state.path("fixture-chat.db"),
              mediaMaxMb: 8,
              defaultAccount: "work",
              accounts: { Work: { mediaMaxMb: 1 } },
            },
          },
        },
        accountId,
        to: "imessage:+15555550123",
        text: "",
        mediaLocalRoots: [state.root],
        deps: { imessage: send },
      };
      await expect(sendIMessageOutbound({ ...params, mediaUrl: large })).rejects.toThrow(
        /exceeds.*limit/i,
      );
      expect(request).not.toHaveBeenCalled();
      const result = await sendIMessageOutbound({ ...params, mediaUrl: small });
      expect(result.receipt.platformMessageIds).toEqual(["p:0/account-media"]);
      expect(delivered).toEqual([smallBytes]);
      await sendIMessageOutbound({ ...params, accountId: "default", mediaUrl: large });
      expect(delivered).toHaveLength(2);
      expect(delivered[0]?.equals(smallBytes)).toBe(true);
      expect(delivered[1]?.equals(largeBytes)).toBe(true);
    } finally {
      request.mockRestore();
      await client.stop();
      await state.cleanup();
    }
  });
});

describe("imessagePlugin pairing.notifyApproval", () => {
  const pairingCfg = {
    channels: {
      imessage: {
        defaultAccount: "alpha",
        accounts: {
          alpha: { cliPath: "/gateway/alpha-imsg", dbPath: "/gateway/alpha-chat.db" },
          beta: { cliPath: "/gateway/beta-imsg", dbPath: "/gateway/beta-chat.db" },
        },
      },
    },
  };

  it.each([
    {
      name: "the approved account",
      accountId: "beta",
      cliPath: "/gateway/beta-imsg",
      dbPath: "/gateway/beta-chat.db",
    },
    {
      name: "the default account when no account was approved",
      accountId: undefined,
      cliPath: "/gateway/alpha-imsg",
      dbPath: "/gateway/alpha-chat.db",
    },
  ])("sends the approval from $name", async ({ accountId, cliPath, dbPath }) => {
    const notifyApproval = imessagePlugin.pairing?.notifyApproval;
    if (!notifyApproval) {
      throw new Error("imessage pairing.notifyApproval unavailable");
    }
    const request = vi.fn(async () => ({ guid: "p:0/pairing-approval" }));
    createRpcClientMock.mockReset();
    createRpcClientMock.mockResolvedValue({ request, stop: vi.fn(async () => {}) });

    await notifyApproval({
      cfg: pairingCfg,
      id: "+15551234567",
      ...(accountId ? { accountId } : {}),
    });

    expect(createRpcClientMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cliPath, dbPath }),
    );
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "send",
      expect.objectContaining({
        to: "+15551234567",
        text: "✅ OpenClaw access approved. Send a message to start chatting.",
      }),
      expect.any(Object),
    );
  });
});
