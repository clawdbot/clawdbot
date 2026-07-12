// Imessage tests cover channel plugin behavior.
import { describe, expect, it, vi } from "vitest";

const monitorMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./monitor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor.js")>()),
  monitorIMessageProvider: monitorMock,
}));

const { sendIMessageOutbound, startIMessageGatewayAccount } = await import("./channel.runtime.js");
const { resolveIMessageAccount } = await import("./accounts.js");

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
            default: {},
          },
        },
      },
    } as never;
    const { ctx, abort, logEvents } = makeCtx({ cfg, accountId: "default" });

    const settled = vi.fn();
    const task = startIMessageGatewayAccount(ctx).then(settled);

    await Promise.resolve();
    await Promise.resolve();
    expect(monitorMock).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(logEvents.some((e) => e.line.includes("skipping watcher"))).toBe(true);
    expect(logEvents.some((e) => e.line.includes('using account "swang430-gmail-com"'))).toBe(true);

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
    const { ctx } = makeCtx({ cfg, accountId: "swang430-gmail-com" });

    await startIMessageGatewayAccount(ctx);
    expect(monitorMock).toHaveBeenCalledTimes(1);
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
  });
});
