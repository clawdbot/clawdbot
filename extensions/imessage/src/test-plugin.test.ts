// Imessage tests cover test plugin plugin behavior.
import fs from "node:fs";
import path from "node:path";
import { buildTypedExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  createMessageReceiptFromOutboundResults,
  sendDurableMessageBatch,
  verifyChannelMessageAdapterCapabilityProofs,
  verifyDurableFinalCapabilityProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearIMessageApprovalReactionTargetsForTest,
  resolveIMessageApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";
import { imessagePlugin } from "./channel.js";
import type { IMessageRpcClient } from "./client.js";
import { extractMarkdownFormatRuns } from "./markdown-format.js";
import { sendMessageIMessage } from "./send.js";

beforeEach(() => {
  clearIMessageApprovalReactionTargetsForTest();
});

type IMessageOutbound = NonNullable<typeof imessagePlugin.outbound>;
type IMessageMessageAdapter = NonNullable<typeof imessagePlugin.message>;
type IMessageMessageSender = NonNullable<IMessageMessageAdapter["send"]>;
const IMESSAGE_WORKSPACE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

function requireOutbound(): IMessageOutbound {
  const outbound = imessagePlugin.outbound;
  if (!outbound) {
    throw new Error("Expected iMessage test plugin outbound adapter");
  }
  return outbound;
}

function requireOutboundSendText(
  outbound: IMessageOutbound,
): NonNullable<IMessageOutbound["sendText"]> {
  const sendText = outbound.sendText;
  if (!sendText) {
    throw new Error("Expected iMessage outbound sendText");
  }
  return sendText;
}

function requireOutboundSendMedia(
  outbound: IMessageOutbound,
): NonNullable<IMessageOutbound["sendMedia"]> {
  const sendMedia = outbound.sendMedia;
  if (!sendMedia) {
    throw new Error("Expected iMessage outbound sendMedia");
  }
  return sendMedia;
}

function requireMessageAdapter(): IMessageMessageAdapter {
  const adapter = imessagePlugin.message;
  if (!adapter) {
    throw new Error("Expected iMessage message adapter");
  }
  return adapter;
}

function requireMessageSendText(
  adapter: IMessageMessageAdapter,
): NonNullable<IMessageMessageSender["text"]> {
  const text = adapter.send?.text;
  if (!text) {
    throw new Error("Expected iMessage message adapter text sender");
  }
  return text;
}

function requireMessageSendMedia(
  adapter: IMessageMessageAdapter,
): NonNullable<IMessageMessageSender["media"]> {
  const media = adapter.send?.media;
  if (!media) {
    throw new Error("Expected iMessage message adapter media sender");
  }
  return media;
}

describe("imessagePlugin contracts", () => {
  it("rejects unqualified provider identifiers and exposes qualification guidance", async () => {
    const targetResolver = imessagePlugin.messaging?.targetResolver;
    const resolveTarget = targetResolver?.resolveTarget;
    if (!resolveTarget) {
      throw new Error("Expected iMessage target resolver");
    }

    expect(targetResolver.hint).toBe(
      "<phone|email|chat_id:ID|auto:contact|imessage:contact|sms:contact>",
    );

    await expect(
      resolveTarget({
        cfg: {} as OpenClawConfig,
        input: "C0AG22RN7L3",
        normalized: "+02273",
      }),
    ).resolves.toBeNull();

    await expect(
      resolveTarget({
        cfg: {} as OpenClawConfig,
        input: "auto:Alice Smith",
        normalized: "auto:AliceSmith",
      }),
    ).resolves.toMatchObject({ kind: "user", to: "auto:AliceSmith" });
  });

  it("declares durable final delivery capabilities", () => {
    expect(imessagePlugin.outbound?.deliveryCapabilities?.durableFinal).toStrictEqual({
      text: true,
      media: true,
      replyTo: true,
      messageSendingHooks: true,
    });
  });

  it("preserves sanitized HTML formatting as native ranges", () => {
    const text = `<strong title="b>">bold</strong> <del data-note='s>'>strike</del>`;
    const sanitized = imessagePlugin.outbound?.sanitizeText?.({ text, payload: { text } });

    expect(sanitized).toBe("**bold** ~~strike~~");
    expect(extractMarkdownFormatRuns(sanitized ?? "")).toEqual({
      text: "bold strike",
      ranges: [
        { start: 0, length: 4, styles: ["bold"] },
        { start: 5, length: 6, styles: ["strikethrough"] },
      ],
    });
  });

  it("declares native iMessage voice memo TTS delivery", () => {
    expect(imessagePlugin.capabilities.tts?.voice).toStrictEqual({
      synthesisTarget: "audio-file",
      audioFileFormats: ["mp3", "caf", "audio/mpeg", "audio/x-caf"],
      preferAudioFileFormat: "caf",
    });
  });

  it("preserves the local approval prompt suppressor through attached-result composition", () => {
    const suppressor = imessagePlugin.outbound?.shouldSuppressLocalPayloadPrompt;
    if (!suppressor) {
      throw new Error("iMessage outbound approval suppressor unavailable");
    }

    expect(
      suppressor({
        cfg: {
          channels: {
            imessage: {
              enabled: true,
              allowFrom: ["+15551230000"],
            },
          },
          approvals: {
            exec: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        accountId: "default",
        payload: {
          text: "Approval required.",
          channelData: {
            execApproval: {
              approvalId: "exec-1",
              approvalSlug: "exec-1",
              approvalKind: "exec",
              sessionKey: "agent:main:imessage:+15551230000",
            },
          },
        },
        hint: {
          kind: "approval-pending",
          approvalKind: "exec",
          nativeRouteActive: true,
        },
      }),
    ).toBe(true);
  });

  it("keeps shared forwarded approvals reaction-resolvable through outbound hooks", async () => {
    const beforeDeliverPayload = imessagePlugin.outbound?.beforeDeliverPayload;
    const afterDeliverPayload = imessagePlugin.outbound?.afterDeliverPayload;
    if (!beforeDeliverPayload || !afterDeliverPayload) {
      throw new Error("Expected iMessage approval delivery hooks");
    }
    const cfg = {
      channels: { imessage: { enabled: true } },
    } as OpenClawConfig;
    const payload = buildTypedExecApprovalPendingReplyPayload({
      approvalId: "exec-shared-hook",
      approvalSlug: "shared-hook",
      command: "echo shared",
      host: "gateway",
      allowedDecisions: ["allow-once", "deny"],
    });
    const target = {
      channel: "imessage",
      to: "+15551230000",
      accountId: "default",
    };

    await beforeDeliverPayload({
      cfg,
      target,
      payload,
      hint: { kind: "approval-pending", approvalKind: "exec" },
    });
    expect(payload.text).toContain("👍 Allow Once");
    expect(payload.text).toContain("👎 Deny");

    await afterDeliverPayload({
      cfg,
      target,
      payload,
      results: [
        {
          channel: "imessage",
          messageId: "42",
          meta: {
            imessageMessageGuid: "p:0/shared-hook-guid",
            imessageVisibleText: payload.text,
          },
        },
      ],
    });
    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "p:0/shared-hook-guid",
        reactionKey: "👍",
      }),
    ).resolves.toEqual({
      approvalId: "exec-shared-hook",
      approvalKind: "exec",
      decision: "allow-once",
    });
  });

  it("backs declared durable final capabilities with delivery proofs", async () => {
    const outbound = requireOutbound();
    const sendText = requireOutboundSendText(outbound);
    const sendMedia = requireOutboundSendMedia(outbound);
    const sendIMessage = async () => ({ messageId: "imsg-1" });

    await verifyDurableFinalCapabilityProofs({
      adapterName: "imessageOutbound",
      capabilities: outbound.deliveryCapabilities?.durableFinal,
      proofs: {
        text: async () => {
          await expect(
            sendText({
              cfg: {} as never,
              to: "+15551234567",
              text: "hello",
              deps: { imessage: sendIMessage },
            }),
          ).resolves.toEqual({ channel: "imessage", messageId: "imsg-1" });
        },
        media: async () => {
          await expect(
            sendMedia({
              cfg: {} as never,
              to: "+15551234567",
              text: "caption",
              mediaUrl: "/tmp/image.png",
              mediaLocalRoots: ["/tmp"],
              deps: { imessage: sendIMessage },
            }),
          ).resolves.toEqual({ channel: "imessage", messageId: "imsg-1" });
        },
        replyTo: async () => {
          await expect(
            sendText({
              cfg: {} as never,
              to: "+15551234567",
              text: "reply",
              replyToId: "reply-1",
              deps: { imessage: sendIMessage },
            }),
          ).resolves.toEqual({ channel: "imessage", messageId: "imsg-1" });
        },
        messageSendingHooks: () => {
          expect(sendText).toBeTypeOf("function");
        },
      },
    });
  });

  it("backs declared message adapter capabilities with delivery proofs", async () => {
    const sendIMessage = async (
      _to: string,
      _text: string,
      opts?: { mediaUrl?: string; replyToId?: string; audioAsVoice?: boolean },
    ) => {
      const messageId = opts?.mediaUrl ? "imsg-media-1" : "imsg-text-1";
      return {
        messageId,
        sentText: opts?.mediaUrl ? "<media:image>" : "hello",
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "imessage", messageId }],
          kind: opts?.audioAsVoice ? "voice" : opts?.mediaUrl ? "media" : "text",
          ...(opts?.replyToId ? { replyToId: opts.replyToId } : {}),
        }),
      };
    };
    const adapter = requireMessageAdapter();
    const sendText = requireMessageSendText(adapter);
    const sendMedia = requireMessageSendMedia(adapter);

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "imessageMessage",
      adapter,
      proofs: {
        text: async () => {
          const result = await sendText({
            cfg: {} as never,
            to: "+15551234567",
            text: "hello",
            deps: { imessage: sendIMessage },
          } as Parameters<typeof sendText>[0] & {
            deps: { imessage: typeof sendIMessage };
          });
          expect(result.receipt.platformMessageIds).toEqual(["imsg-text-1"]);
        },
        media: async () => {
          const result = await sendMedia({
            cfg: {} as never,
            to: "+15551234567",
            text: "caption",
            mediaUrl: "/tmp/image.png",
            mediaLocalRoots: ["/tmp"],
            audioAsVoice: true,
            deps: { imessage: sendIMessage },
          } as Parameters<typeof sendMedia>[0] & {
            deps: { imessage: typeof sendIMessage };
          });
          expect(result.receipt.platformMessageIds).toEqual(["imsg-media-1"]);
          expect(result.receipt.parts.map((part) => part.kind)).toEqual(["voice"]);
        },
        replyTo: async () => {
          const result = await sendText({
            cfg: {} as never,
            to: "+15551234567",
            text: "reply",
            replyToId: "reply-1",
            deps: { imessage: sendIMessage },
          } as Parameters<typeof sendText>[0] & {
            deps: { imessage: typeof sendIMessage };
          });
          expect(result.receipt.replyToId).toBe("reply-1");
        },
        messageSendingHooks: () => {
          expect(sendText).toBeTypeOf("function");
        },
      },
    });
  });

  it.each(["message", "outbound"] as const)(
    "preserves trusted host media access through the real %s adapter",
    async (adapterKind) => {
      const trustedReader = vi.fn(async () => Buffer.from("trusted"));
      const legacyReader = vi.fn(async () => Buffer.from("legacy"));
      const mediaAccess = {
        localRoots: ["/trusted/workspace"],
        workspaceDir: "/trusted/workspace",
        readFile: trustedReader,
      };
      const sendIMessage = vi.fn(
        async (
          _to: string,
          _text: string,
          options: { mediaAccess?: typeof mediaAccess; mediaReadFile?: typeof legacyReader },
        ) => ({
          messageId: "p:0/trusted-media",
          options,
          receipt: createMessageReceiptFromOutboundResults({
            results: [{ channel: "imessage", messageId: "p:0/trusted-media" }],
            kind: "media",
          }),
        }),
      );
      const context = {
        cfg: {} as never,
        to: "+15551234567",
        text: "caption",
        mediaUrl: "workspace-image.png",
        mediaAccess,
        mediaLocalRoots: ["/untrusted/legacy"],
        mediaReadFile: legacyReader,
        deps: { imessage: sendIMessage },
      };

      if (adapterKind === "message") {
        const sendMedia = requireMessageSendMedia(requireMessageAdapter());
        await sendMedia(
          context as Parameters<typeof sendMedia>[0] & {
            deps: { imessage: typeof sendIMessage };
          },
        );
      } else {
        const sendMedia = imessagePlugin.outbound?.sendMedia;
        if (!sendMedia) {
          throw new Error("Expected the actual iMessage outbound adapter");
        }
        await sendMedia(context);
      }

      const forwarded = sendIMessage.mock.calls[0]?.[2];
      expect(forwarded?.mediaAccess).toBe(mediaAccess);
      expect(forwarded?.mediaReadFile).toBe(legacyReader);
      expect(forwarded).toEqual(
        expect.objectContaining({ mediaLocalRoots: ["/untrusted/legacy"] }),
      );
    },
  );

  it("rejects a host media reader without explicit approved roots", async () => {
    const readFile = vi.fn(async () => IMESSAGE_WORKSPACE_PNG);
    const sendMedia = requireMessageSendMedia(requireMessageAdapter());
    const nativeSend = vi.fn(sendMessageIMessage);

    await expect(
      sendMedia({
        cfg: {} as never,
        to: "+15551234567",
        text: "",
        mediaUrl: "workspace-image.png",
        mediaAccess: { workspaceDir: "/trusted/workspace", readFile },
        deps: { imessage: nativeSend },
      } as Parameters<typeof sendMedia>[0] & {
        deps: { imessage: typeof nativeSend };
      }),
    ).rejects.toThrow("Host media read requires explicit localRoots");

    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "workspace traversal despite wider conflicting legacy roots",
      filename: "../outside.png",
      contents: IMESSAGE_WORKSPACE_PNG,
      readerCalls: 0,
      expectedCode: "path-not-allowed",
    },
    {
      name: "private log document",
      filename: "debug.log",
      contents: Buffer.from("private operator logs"),
      readerCalls: 1,
      expectedCode: "unsupported-media-type",
    },
    {
      name: "untrusted HTML before the host reader",
      filename: "report.html",
      contents: Buffer.from("<!doctype html><h1>untrusted</h1>"),
      readerCalls: 0,
      expectedCode: "path-not-allowed",
    },
    {
      name: "plain text disguised as a PDF",
      filename: "report.pdf",
      contents: Buffer.from("private text without a PDF signature"),
      readerCalls: 1,
      expectedCode: "unsupported-media-type",
    },
    {
      name: "binary data disguised as plain text",
      filename: "report.txt",
      contents: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      readerCalls: 1,
      expectedCode: "unsupported-media-type",
    },
  ])(
    "rejects $name before native iMessage delivery",
    async ({ filename, contents, readerCalls, expectedCode }) => {
      await withStateDirEnv("openclaw-imessage-media-policy-", async ({ stateDir }) => {
        const stateRoot = fs.realpathSync(stateDir);
        const workspaceDir = path.join(stateRoot, "workspace");
        fs.mkdirSync(workspaceDir);
        fs.writeFileSync(path.resolve(workspaceDir, filename), contents);
        const readFile = vi.fn(async (filePath: string) => await fs.promises.readFile(filePath));
        const conflictingReader = vi.fn(async () => Buffer.from("conflicting reader"));
        const runCliJson = vi.fn(async () => ({ messageId: "must-not-send" }));
        const nativeSend: typeof sendMessageIMessage = async (to, text, options) =>
          await sendMessageIMessage(to, text, { ...options, runCliJson });
        const sendMedia = requireMessageSendMedia(requireMessageAdapter());

        await expect(
          sendMedia({
            cfg: {} as never,
            to: "+15551234567",
            text: "",
            mediaUrl: filename,
            mediaAccess: { localRoots: [workspaceDir], workspaceDir, readFile },
            mediaLocalRoots: [stateRoot],
            mediaReadFile: conflictingReader,
            deps: { imessage: nativeSend },
          } as Parameters<typeof sendMedia>[0] & {
            deps: { imessage: typeof nativeSend };
          }),
        ).rejects.toMatchObject({ code: expectedCode });

        expect(readFile).toHaveBeenCalledTimes(readerCalls);
        expect(conflictingReader).not.toHaveBeenCalled();
        expect(runCliJson).not.toHaveBeenCalled();
      });
    },
  );

  it("carries the stable iMessage GUID beside the broad adapter delivery identity", async () => {
    const sendText = requireMessageSendText(requireMessageAdapter());
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ channel: "imessage", messageId: "42" }],
      kind: "text",
    });
    const sendIMessage = async () => ({
      messageId: "42",
      guid: "p:0/stable-guid",
      sentText: "hello",
      receipt,
    });

    const result = await sendText({
      cfg: {} as never,
      to: "+15551234567",
      text: "hello",
      deps: { imessage: sendIMessage },
    } as Parameters<typeof sendText>[0] & {
      deps: { imessage: typeof sendIMessage };
    });

    expect(result.messageId).toBe("42");
    expect(result.receipt.primaryPlatformMessageId).toBe("42");
    expect((result as typeof result & { meta?: Record<string, unknown> }).meta).toEqual({
      imessageMessageGuid: "p:0/stable-guid",
      imessageVisibleText: "hello",
    });
  });

  it("preserves provider-accepted attachment progress through actual durable core without replay", async () => {
    const cfg = {
      channels: { imessage: { accounts: { default: {} } } },
    } as OpenClawConfig;
    const captionError = new Error("caption failed after native attachment acceptance");
    const captionClient = {
      request: vi.fn(async () => {
        throw captionError;
      }),
      stop: vi.fn(async () => {}),
    } as unknown as IMessageRpcClient;
    const attachmentBytes = IMESSAGE_WORKSPACE_PNG;
    const runCliJson = vi.fn(async (args: readonly string[]) => {
      const attachmentPath = args[args.indexOf("--file") + 1];
      expect(attachmentPath).toBeDefined();
      expect(fs.readFileSync(attachmentPath!)).toEqual(attachmentBytes);
      return { messageId: "p:0/durable-accepted-attachment" };
    });
    const nativeSend = vi.fn<typeof sendMessageIMessage>(async (to, text, options) =>
      sendMessageIMessage(to, text, {
        ...options,
        client: captionClient,
        runCliJson,
      }),
    );
    const onDeliveryResult = vi.fn();

    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "imessage", plugin: imessagePlugin, source: "test" }]),
    );
    try {
      await withStateDirEnv("openclaw-imessage-durable-attachment-", async ({ stateDir }) => {
        const workspaceDir = fs.realpathSync(stateDir);
        const sourcePath = path.join(workspaceDir, "workspace-image.png");
        fs.writeFileSync(sourcePath, attachmentBytes);
        const readFile = vi.fn(async (filePath: string) => await fs.promises.readFile(filePath));
        const mediaAccess = { localRoots: [workspaceDir], workspaceDir, readFile };

        const result = await sendDurableMessageBatch({
          cfg,
          channel: "imessage",
          to: "+15550004567",
          durability: "required",
          mediaAccess,
          deps: { imessage: nativeSend },
          onDeliveryResult,
          payloads: [{ text: "undelivered caption", mediaUrl: path.basename(sourcePath) }],
        });

        if (result.status === "failed") {
          throw result.error;
        }
        expect(result).toMatchObject({
          status: "partial_failed",
          sentBeforeError: true,
          receipt: { platformMessageIds: ["p:0/durable-accepted-attachment"] },
          results: [
            {
              channel: "imessage",
              messageId: "p:0/durable-accepted-attachment",
            },
          ],
          payloadOutcomes: [{ status: "failed", sentBeforeError: true }],
        });
        expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            channel: "imessage",
            messageId: "p:0/durable-accepted-attachment",
          }),
        );
        expect(readFile.mock.calls).toEqual([[sourcePath], [sourcePath]]);
        const forwardedMediaAccess = nativeSend.mock.calls[0]?.[2]?.mediaAccess;
        expect(forwardedMediaAccess).toEqual(mediaAccess);
        expect(forwardedMediaAccess?.readFile).toBe(readFile);

        await drainPendingDeliveries({
          drainKey: "imessage:default",
          logLabel: "iMessage accepted attachment recovery",
          cfg,
          stateDir,
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          selectEntry: (entry) => ({ match: entry.channel === "imessage" }),
        });
        expect(runCliJson).toHaveBeenCalledTimes(1);
      });
    } finally {
      resetPluginRuntimeStateForTest();
    }
  });

  it("halts native caption delivery when actual durable progress custody rejects", async () => {
    const cfg = {
      channels: { imessage: { accounts: { default: {} } } },
    } as OpenClawConfig;
    const custodyError = new Error("durable accepted-attachment custody rejected");
    const captionRequest = vi.fn(async () => ({ guid: "p:0/caption-must-not-send" }));
    const captionClient = {
      request: captionRequest,
      stop: vi.fn(async () => {}),
    } as unknown as IMessageRpcClient;
    const attachmentBytes = Buffer.from("%PDF-1.4\n% actual durable custody failure\n");
    const runCliJson = vi.fn(async () => ({ messageId: "p:0/durable-custody-attachment" }));
    const nativeSend: typeof sendMessageIMessage = async (to, text, options) =>
      await sendMessageIMessage(to, text, { ...options, client: captionClient, runCliJson });
    const onDeliveryResult = vi.fn(async () => {
      throw custodyError;
    });

    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "imessage", plugin: imessagePlugin, source: "test" }]),
    );
    try {
      await withStateDirEnv("openclaw-imessage-durable-custody-", async ({ stateDir }) => {
        const workspaceDir = fs.realpathSync(stateDir);
        const sourcePath = path.join(workspaceDir, "custody-report.pdf");
        fs.writeFileSync(sourcePath, attachmentBytes);
        const readFile = vi.fn(async (filePath: string) => await fs.promises.readFile(filePath));

        const result = await sendDurableMessageBatch({
          cfg,
          channel: "imessage",
          to: "+15550004567",
          durability: "required",
          mediaAccess: { localRoots: [workspaceDir], workspaceDir, readFile },
          deps: { imessage: nativeSend },
          onDeliveryResult,
          payloads: [{ text: "caption must not send", mediaUrl: sourcePath }],
        });

        expect(result).toMatchObject({
          status: "partial_failed",
          sentBeforeError: true,
          results: [
            {
              channel: "imessage",
              messageId: "p:0/durable-custody-attachment",
            },
          ],
        });
        expect(onDeliveryResult).toHaveBeenCalledOnce();
        expect(runCliJson).toHaveBeenCalledOnce();
        expect(readFile.mock.calls).toEqual([[sourcePath], [sourcePath]]);
        expect(captionRequest).not.toHaveBeenCalled();
      });
    } finally {
      resetPluginRuntimeStateForTest();
    }
  });
});
