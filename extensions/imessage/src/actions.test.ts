import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const probeMock = vi.hoisted(() => ({
  getCachedIMessagePrivateApiStatus: vi.fn(),
  probeIMessagePrivateApi: vi.fn(),
}));

const runtimeMock = vi.hoisted(() => ({
  resolveIMessageMessageId: vi.fn((id: string) => id),
  resolveChatGuidForTarget: vi.fn(),
  sendReaction: vi.fn(),
  sendRichMessage: vi.fn(),
  sendAttachment: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    createSubsystemLogger: () => loggerMock,
  };
});

vi.mock("./probe.js", () => ({
  getCachedIMessagePrivateApiStatus: probeMock.getCachedIMessagePrivateApiStatus,
  probeIMessagePrivateApi: probeMock.probeIMessagePrivateApi,
}));

vi.mock("./private-api-status.js", () => ({
  getCachedIMessagePrivateApiStatus: probeMock.getCachedIMessagePrivateApiStatus,
}));

vi.mock("./actions.runtime.js", () => ({
  imessageActionsRuntime: runtimeMock,
}));

const { imessageMessageActions } = await import("./actions.js");

function cfg(actions?: Record<string, boolean | undefined>): OpenClawConfig {
  return {
    channels: {
      imessage: {
        cliPath: "imsg",
        dbPath: "/tmp/messages.db",
        actions,
      },
    },
  } as OpenClawConfig;
}

function imsgOptions(chatGuid = "") {
  return {
    cliPath: "imsg",
    dbPath: "/tmp/messages.db",
    timeoutMs: undefined,
    chatGuid,
  };
}

describe("imessage message actions", () => {
  beforeEach(() => {
    runtimeMock.resolveIMessageMessageId.mockClear();
    runtimeMock.resolveIMessageMessageId.mockImplementation((id: string) => id);
    runtimeMock.resolveChatGuidForTarget.mockReset();
    runtimeMock.sendReaction.mockReset();
    runtimeMock.sendRichMessage.mockReset();
    runtimeMock.sendAttachment.mockReset();
    probeMock.getCachedIMessagePrivateApiStatus.mockReset();
    probeMock.probeIMessagePrivateApi.mockReset();
    loggerMock.warn.mockReset();
  });

  it("does not advertise private API actions when the bridge is known unavailable", () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
      available: false,
      v2Ready: false,
      selectors: {},
    });

    const described = imessageMessageActions.describeMessageTool({
      cfg: cfg(),
      currentChannelId: "chat_guid:iMessage;+;chat0000",
    } as never);

    expect(described?.actions).toStrictEqual([]);
  });

  it("advertises private API actions while private API status is unknown", () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue(undefined);

    const described = imessageMessageActions.describeMessageTool({
      cfg: cfg(),
      currentChannelId: "chat_guid:iMessage;+;chat0000",
    } as never);

    expect(described?.actions).toStrictEqual([
      "react",
      "edit",
      "reply",
      "sendWithEffect",
      "renameGroup",
      "setGroupIcon",
      "addParticipant",
      "removeParticipant",
      "leaveGroup",
      "upload-file",
    ]);
  });

  it("advertises BB-parity actions when private API and selectors are available", () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
      available: true,
      v2Ready: true,
      selectors: {
        editMessage: true,
        retractMessagePart: true,
      },
    });

    const described = imessageMessageActions.describeMessageTool({
      cfg: cfg(),
      currentChannelId: "chat_guid:iMessage;+;chat0000",
    } as never);

    expect(described?.actions).toStrictEqual([
      "react",
      "edit",
      "unsend",
      "reply",
      "sendWithEffect",
      "renameGroup",
      "setGroupIcon",
      "addParticipant",
      "removeParticipant",
      "leaveGroup",
      "upload-file",
    ]);
  });

  it("respects configured action gates", () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
      available: true,
      v2Ready: true,
      selectors: {
        editMessage: true,
        retractMessagePart: true,
      },
    });

    const described = imessageMessageActions.describeMessageTool({
      cfg: cfg({ reactions: false, reply: false }),
      currentChannelId: "chat_guid:iMessage;+;chat0000",
    } as never);

    expect(described?.actions).not.toContain("react");
    expect(described?.actions).not.toContain("reply");
    expect(described?.actions).toContain("edit");
  });

  it("emits a channels/imessage WARN when the private API bridge is unavailable", async () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue(undefined);
    probeMock.probeIMessagePrivateApi.mockResolvedValue({
      available: false,
      v2Ready: false,
      selectors: {},
    });

    await expect(
      imessageMessageActions.handleAction?.({
        action: "react",
        cfg: cfg(),
        params: {
          chatGuid: "iMessage;+;chat0000",
          messageId: "message-guid",
          emoji: "👍",
        },
      } as never),
    ).rejects.toThrow(/imsg private API bridge/);

    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    const warnArg = String(loggerMock.warn.mock.calls[0][0]);
    expect(warnArg).toMatch(/iMessage react blocked: private API bridge unavailable/);
    expect(warnArg).toMatch(/imsg launch/);
    expect(runtimeMock.sendReaction).not.toHaveBeenCalled();
  });

  it("rejects configured-off actions at execution time", async () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
      available: true,
      v2Ready: true,
      selectors: {},
    });

    await expect(
      imessageMessageActions.handleAction?.({
        action: "react",
        cfg: cfg({ reactions: false }),
        params: {
          chatGuid: "iMessage;+;chat0000",
          messageId: "message-guid",
          emoji: "👍",
        },
      } as never),
    ).rejects.toThrow(/disabled in config/i);

    expect(runtimeMock.sendReaction).not.toHaveBeenCalled();
  });

  it("maps message tool reactions to imsg tapback kinds", async () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
      available: true,
      v2Ready: true,
      selectors: {},
    });
    runtimeMock.sendReaction.mockResolvedValue(undefined);

    await imessageMessageActions.handleAction?.({
      action: "react",
      cfg: cfg(),
      params: {
        chatGuid: "iMessage;+;chat0000",
        messageId: "message-guid",
        emoji: "👍",
      },
    } as never);

    expect(runtimeMock.sendReaction.mock.calls).toStrictEqual([
      [
        {
          chatGuid: "iMessage;+;chat0000",
          messageId: "message-guid",
          reaction: "like",
          remove: undefined,
          partIndex: undefined,
          options: imsgOptions("iMessage;+;chat0000"),
        },
      ],
    ]);
  });

  it("resolves chat_id targets before invoking bridge actions", async () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
      available: true,
      v2Ready: true,
      selectors: {},
    });
    runtimeMock.resolveChatGuidForTarget.mockResolvedValue("iMessage;+;resolved");
    runtimeMock.sendReaction.mockResolvedValue(undefined);

    await imessageMessageActions.handleAction?.({
      action: "react",
      cfg: cfg(),
      params: {
        target: "chat_id:42",
        messageId: "message-guid",
        emoji: "👍",
      },
    } as never);

    expect(runtimeMock.resolveChatGuidForTarget.mock.calls).toStrictEqual([
      [
        {
          target: { kind: "chat_id", chatId: 42 },
          options: imsgOptions(),
        },
      ],
    ]);
    expect(runtimeMock.sendReaction.mock.calls).toStrictEqual([
      [
        {
          chatGuid: "iMessage;+;resolved",
          messageId: "message-guid",
          reaction: "like",
          remove: undefined,
          partIndex: undefined,
          options: imsgOptions("iMessage;+;resolved"),
        },
      ],
    ]);
  });

  it("resolves short message ids before invoking bridge actions", async () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
      available: true,
      v2Ready: true,
      selectors: {},
    });
    runtimeMock.resolveIMessageMessageId.mockReturnValueOnce("full-guid");
    runtimeMock.sendReaction.mockResolvedValue(undefined);

    await imessageMessageActions.handleAction?.({
      action: "react",
      cfg: cfg(),
      params: {
        chatGuid: "iMessage;+;chat0000",
        messageId: "1",
        emoji: "👍",
      },
    } as never);

    expect(runtimeMock.resolveIMessageMessageId).toHaveBeenCalledWith("1", {
      requireKnownShortId: true,
      chatContext: {
        chatGuid: "iMessage;+;chat0000",
        chatIdentifier: undefined,
        chatId: undefined,
      },
    });
    expect(runtimeMock.sendReaction.mock.calls).toStrictEqual([
      [
        {
          chatGuid: "iMessage;+;chat0000",
          messageId: "full-guid",
          reaction: "like",
          remove: undefined,
          partIndex: undefined,
          options: imsgOptions("iMessage;+;chat0000"),
        },
      ],
    ]);
  });

  it("resolves chat_identifier targets before invoking bridge actions", async () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
      available: true,
      v2Ready: true,
      selectors: {},
    });
    runtimeMock.resolveChatGuidForTarget.mockResolvedValue("iMessage;+;resolved-ident");
    runtimeMock.sendRichMessage.mockResolvedValue({ messageId: "reply-guid" });

    await imessageMessageActions.handleAction?.({
      action: "reply",
      cfg: cfg(),
      params: {
        chatIdentifier: "team-thread",
        messageId: "message-guid",
        text: "reply",
      },
    } as never);

    expect(runtimeMock.resolveChatGuidForTarget.mock.calls).toStrictEqual([
      [
        {
          target: { kind: "chat_identifier", chatIdentifier: "team-thread" },
          options: imsgOptions(),
        },
      ],
    ]);
    expect(runtimeMock.sendRichMessage.mock.calls).toStrictEqual([
      [
        {
          chatGuid: "iMessage;+;resolved-ident",
          text: "reply",
          replyToMessageId: "message-guid",
          partIndex: undefined,
          attachment: undefined,
          options: imsgOptions("iMessage;+;resolved-ident"),
        },
      ],
    ]);
  });

  describe("reply with attachment (openclaw/imsg#114 plumbing)", () => {
    // The core message-action runner hydrates path/media/filePath/etc.
    // through the outbound media resolver (mediaLocalRoots/sandbox/size)
    // before reaching this handler, writing the result into `buffer` +
    // `filename`. These tests cover the post-hydration contract: the
    // handler trusts only the buffer and refuses any unhydrated path
    // param so an agent cannot bypass the resolver.
    const stringPath = "/tmp/cute-lobster.png";
    const base64Png = Buffer.from("PNGDATA").toString("base64");

    function readLastAttachment():
      | {
          kind?: string;
          buffer?: Uint8Array;
          filename?: string;
        }
      | undefined {
      const call = runtimeMock.sendRichMessage.mock.calls.at(-1)?.[0] as
        | { attachment?: { kind: string; buffer?: Uint8Array; filename?: string } }
        | undefined;
      return call?.attachment;
    }

    it("threads a hydrated buffer attachment through to sendRichMessage when imsg supports send-rich --file", async () => {
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
        available: true,
        v2Ready: true,
        selectors: {},
        cliCapabilities: { sendRichSupportsAttachment: true },
      });
      runtimeMock.resolveChatGuidForTarget.mockResolvedValue("iMessage;+;resolved-ident");
      runtimeMock.sendRichMessage.mockResolvedValue({ messageId: "reply-guid" });

      await imessageMessageActions.handleAction?.({
        action: "reply",
        cfg: cfg(),
        params: {
          chatIdentifier: "team-thread",
          messageId: "message-guid",
          text: "🦞 here it is",
          buffer: base64Png,
          filename: "card.png",
        },
      } as never);
      expect(runtimeMock.sendRichMessage.mock.calls).toStrictEqual([
        [
          {
            chatGuid: "iMessage;+;resolved-ident",
            text: "🦞 here it is",
            replyToMessageId: "message-guid",
            partIndex: undefined,
            attachment: {
              kind: "buffer",
              buffer: Uint8Array.from(Buffer.from("PNGDATA")),
              filename: "card.png",
            },
            options: imsgOptions("iMessage;+;resolved-ident"),
          },
        ],
      ]);
    });

    it("falls back to attachment.bin when filename is missing (post-hydration)", async () => {
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
        available: true,
        v2Ready: true,
        selectors: {},
        cliCapabilities: { sendRichSupportsAttachment: true },
      });
      runtimeMock.resolveChatGuidForTarget.mockResolvedValue("iMessage;+;resolved-ident");
      runtimeMock.sendRichMessage.mockResolvedValue({ messageId: "reply-guid" });

      await imessageMessageActions.handleAction?.({
        action: "reply",
        cfg: cfg(),
        params: {
          chatIdentifier: "team-thread",
          messageId: "message-guid",
          text: "🦞 here it is",
          buffer: base64Png,
        },
      } as never);
      expect(readLastAttachment()?.filename).toBe("attachment.bin");
    });

    it("rejects unhydrated path-shaped params so agents cannot bypass the media resolver", async () => {
      // The runner's hydrateAttachmentParamsForAction loads any
      // path/media/filePath/mediaUrl/fileUrl through the media resolver
      // and writes the result into `buffer`. If we ever see a path-shaped
      // param without a `buffer`, hydration was skipped — refuse instead
      // of forwarding a raw host path to imsg.
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
        available: true,
        v2Ready: true,
        selectors: {},
        cliCapabilities: { sendRichSupportsAttachment: true },
      });
      runtimeMock.resolveChatGuidForTarget.mockResolvedValue("iMessage;+;resolved-ident");

      for (const field of ["filePath", "path", "media", "mediaUrl", "fileUrl"]) {
        runtimeMock.sendRichMessage.mockClear();
        await expect(
          imessageMessageActions.handleAction?.({
            action: "reply",
            cfg: cfg(),
            params: {
              chatIdentifier: "team-thread",
              messageId: "message-guid",
              text: "🦞 here it is",
              [field]: stringPath,
            },
          } as never),
        ).rejects.toThrow(/did not pass through the outbound media resolver/);
        expect(runtimeMock.sendRichMessage).not.toHaveBeenCalled();
      }
    });

    it("rejects reply + attachment when imsg does not advertise send-rich --file", async () => {
      // Older imsg builds reject `--file` on send-rich, so refuse loudly
      // here rather than letting send-rich ship the text alone and silently
      // drop the attachment (the original openclaw/openclaw#79822 symptom).
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
        available: true,
        v2Ready: true,
        selectors: {},
        cliCapabilities: { sendRichSupportsAttachment: false },
      });
      runtimeMock.resolveChatGuidForTarget.mockResolvedValue("iMessage;+;resolved-ident");

      runtimeMock.sendRichMessage.mockClear();
      await expect(
        imessageMessageActions.handleAction?.({
          action: "reply",
          cfg: cfg(),
          params: {
            chatIdentifier: "team-thread",
            messageId: "message-guid",
            text: "🦞 here it is",
            buffer: base64Png,
            filename: "card.png",
          },
        } as never),
      ).rejects.toThrow(/needs an imsg build that exposes `send-rich --file`/);
      expect(runtimeMock.sendRichMessage).not.toHaveBeenCalled();
    });
  });

  describe("phone-number target end-to-end (regressions caught the hard way)", () => {
    it("synthesizes iMessage;-;<phone> chat_identifier from a handle target and sends through to sendReaction", async () => {
      // Scenario from prod: agent calls react with `target:"+12069106512"` and a
      // known-cached short messageId. resolveChatGuid synthesizes
      // `iMessage;-;+12069106512` and asks the runtime to look it up. The
      // runtime returns the real chat guid. sendReaction must receive the
      // resolved guid, not the synthesized stand-in.
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
        available: true,
        v2Ready: true,
        selectors: {},
      });
      runtimeMock.resolveChatGuidForTarget.mockResolvedValue("any;-;+12069106512");
      runtimeMock.resolveIMessageMessageId.mockReturnValueOnce("full-guid");
      runtimeMock.sendReaction.mockResolvedValue(undefined);

      await imessageMessageActions.handleAction?.({
        action: "react",
        cfg: cfg(),
        params: {
          target: "+12069106512",
          messageId: "5",
          emoji: "👍",
        },
      } as never);

      // resolveChatGuid synthesizes the chat_identifier; the runtime then
      // does the chats.list lookup against it.
      expect(runtimeMock.resolveChatGuidForTarget.mock.calls).toStrictEqual([
        [
          {
            target: {
              kind: "chat_identifier",
              chatIdentifier: "iMessage;-;+12069106512",
            },
            options: imsgOptions(),
          },
        ],
      ]);
      // The cache lookup uses the synthesized chat_identifier as scope so
      // cross-chat checks have something to match against.
      expect(runtimeMock.resolveIMessageMessageId).toHaveBeenCalledWith("5", {
        requireKnownShortId: true,
        chatContext: {
          chatGuid: undefined,
          chatIdentifier: "iMessage;-;+12069106512",
          chatId: undefined,
        },
      });
      // sendReaction lands on the real registered chat guid, not the
      // synthesized stand-in.
      expect(runtimeMock.sendReaction.mock.calls).toStrictEqual([
        [
          {
            chatGuid: "any;-;+12069106512",
            messageId: "full-guid",
            reaction: "like",
            remove: undefined,
            partIndex: undefined,
            options: imsgOptions("any;-;+12069106512"),
          },
        ],
      ]);
    });

    it("rejects react/edit/unsend when the synthesized chat is not registered", async () => {
      // Scenario from prod: agent invokes react against a phone target whose
      // chat has never been touched yet. We refuse rather than fabricate the
      // identifier and let it fail downstream — there's no message to react
      // to in a chat that doesn't exist yet.
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
        available: true,
        v2Ready: true,
        selectors: {},
      });
      runtimeMock.resolveChatGuidForTarget.mockResolvedValue(null);
      runtimeMock.sendReaction.mockResolvedValue(undefined);

      await expect(
        imessageMessageActions.handleAction?.({
          action: "react",
          cfg: cfg(),
          params: {
            target: "+19999999999",
            messageId: "irrelevant",
            emoji: "👍",
          },
        } as never),
      ).rejects.toThrow(/requires a known chat/i);
      expect(runtimeMock.sendReaction).not.toHaveBeenCalled();
    });

    it("falls back to the synthesized identifier for send/reply/sendWithEffect when the chat is not yet registered", async () => {
      // Counterpart to the above: send/reply/sendWithEffect targeting a brand-
      // new phone-number chat is fine — Messages will register the chat as a
      // side effect of the send. Only the mutate-existing-message actions
      // need a registered chat.
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
        available: true,
        v2Ready: true,
        selectors: {},
      });
      runtimeMock.resolveChatGuidForTarget.mockResolvedValue(null);
      runtimeMock.sendRichMessage.mockResolvedValue({ messageId: "ok" });
      runtimeMock.resolveIMessageMessageId.mockReturnValueOnce("parent-guid");

      await imessageMessageActions.handleAction?.({
        action: "reply",
        cfg: cfg(),
        params: {
          target: "+18001234567",
          messageId: "parent-guid",
          text: "first contact",
        },
      } as never);

      expect(runtimeMock.sendRichMessage.mock.calls).toStrictEqual([
        [
          {
            chatGuid: "iMessage;-;+18001234567",
            text: "first contact",
            replyToMessageId: "parent-guid",
            partIndex: undefined,
            attachment: undefined,
            options: imsgOptions("iMessage;-;+18001234567"),
          },
        ],
      ]);
    });

    it("removes a tapback by fanning out across all known kinds when emoji is empty/unknown and remove:true", async () => {
      // Scenario from the audit: agent calls react with `remove: true` but
      // forgot which emoji was originally added (or used a non-mapped emoji
      // like 🦞). We fan a remove out to every known kind; the bridge no-ops
      // kinds that weren't there.
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
        available: true,
        v2Ready: true,
        selectors: {},
      });
      runtimeMock.sendReaction.mockResolvedValue(undefined);

      await imessageMessageActions.handleAction?.({
        action: "react",
        cfg: cfg(),
        params: {
          chatGuid: "iMessage;+;chat0000",
          messageId: "message-guid",
          emoji: "🦞",
          remove: true,
        },
      } as never);

      const kinds = runtimeMock.sendReaction.mock.calls.map(
        (call: unknown[]) => (call[0] as { reaction: string }).reaction,
      );
      expect(kinds.toSorted()).toEqual(
        ["dislike", "emphasize", "laugh", "like", "love", "question"].toSorted(),
      );
      expect(
        runtimeMock.sendReaction.mock.calls.every(
          (call: unknown[]) => (call[0] as { remove: boolean }).remove,
        ),
      ).toBe(true);
    });

    it("rejects an unknown effect with an actionable error message", async () => {
      // Scenario from the audit: agent passes a typo like `invisible_ink`
      // (note underscore vs `invisibleink` alias). We refuse rather than
      // forwarding gibberish to the bridge for an opaque CLI failure.
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
        available: true,
        v2Ready: true,
        selectors: {},
      });
      runtimeMock.sendRichMessage.mockResolvedValue({ messageId: "ok" });

      await expect(
        imessageMessageActions.handleAction?.({
          action: "sendWithEffect",
          cfg: cfg(),
          params: {
            chatGuid: "iMessage;+;chat0000",
            text: "boom",
            effect: "invisible_ink",
          },
        } as never),
      ).rejects.toThrow(/unknown effect|invisible_ink/i);
      expect(runtimeMock.sendRichMessage).not.toHaveBeenCalled();
    });

    it("accepts known effect aliases like 'slam' and 'invisibleink'", async () => {
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
        available: true,
        v2Ready: true,
        selectors: {},
      });
      runtimeMock.sendRichMessage.mockResolvedValue({ messageId: "ok" });

      await imessageMessageActions.handleAction?.({
        action: "sendWithEffect",
        cfg: cfg(),
        params: {
          chatGuid: "iMessage;+;chat0000",
          text: "boom",
          effect: "slam",
        },
      } as never);

      expect(runtimeMock.sendRichMessage.mock.calls).toStrictEqual([
        [
          {
            chatGuid: "iMessage;+;chat0000",
            text: "boom",
            effectId: "com.apple.MobileSMS.expressivesend.impact",
            options: imsgOptions("iMessage;+;chat0000"),
          },
        ],
      ]);
    });

    it.each([
      ["echo", "com.apple.messages.effect.CKEchoEffect"],
      ["happybirthday", "com.apple.messages.effect.CKHappyBirthdayEffect"],
      ["shootingstar", "com.apple.messages.effect.CKShootingStarEffect"],
      ["sparkles", "com.apple.messages.effect.CKSparklesEffect"],
      ["spotlight", "com.apple.messages.effect.CKSpotlightEffect"],
    ])(
      "resolves the screen-effect alias %s that the error message advertises",
      async (alias, canonical) => {
        // Codex review caught these: the error message at effectIdFromParam
        // listed echo / happybirthday / shootingstar / sparkles / spotlight
        // as valid aliases, but they were missing from the alias map. Agents
        // following our own guidance got "unknown effect" thrown back.
        probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
          available: true,
          v2Ready: true,
          selectors: {},
        });
        runtimeMock.sendRichMessage.mockResolvedValue({ messageId: "ok" });

        await imessageMessageActions.handleAction?.({
          action: "sendWithEffect",
          cfg: cfg(),
          params: {
            chatGuid: "iMessage;+;chat0000",
            text: "boom",
            effect: alias,
          },
        } as never);

        expect(runtimeMock.sendRichMessage.mock.calls).toStrictEqual([
          [
            {
              chatGuid: "iMessage;+;chat0000",
              text: "boom",
              effectId: canonical,
              options: imsgOptions("iMessage;+;chat0000"),
            },
          ],
        ]);
      },
    );

    it("trims whitespace-only currentChannelId so parseIMessageTarget never sees it", async () => {
      // Scenario from the audit: a whitespace-only currentChannelId would
      // hit parseIMessageTarget which throws on empty input, aborting the
      // whole action with a confusing "target is required" message.
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
        available: true,
        v2Ready: true,
        selectors: {},
      });

      await expect(
        imessageMessageActions.handleAction?.({
          action: "react",
          cfg: cfg(),
          params: { messageId: "x", emoji: "👍" },
          toolContext: { currentChannelId: "   \t  " },
        } as never),
      ).rejects.toThrow(/requires chatGuid, chatId, chatIdentifier, or a chat target/);
    });
  });

  it.each([
    ["asVoice", { asVoice: true }],
    ["as_voice", { as_voice: true }],
  ])(
    "routes upload-file through the private API attachment bridge with %s",
    async (_label, voiceParam) => {
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
        available: true,
        v2Ready: true,
        selectors: {},
      });
      runtimeMock.sendAttachment.mockResolvedValue({ messageId: "sent-guid" });

      const result = await imessageMessageActions.handleAction?.({
        action: "upload-file",
        cfg: cfg(),
        params: {
          chatGuid: "iMessage;+;chat0000",
          filename: "photo.jpg",
          buffer: Buffer.from("image").toString("base64"),
          ...voiceParam,
        },
      } as never);

      expect(runtimeMock.sendAttachment.mock.calls).toStrictEqual([
        [
          {
            chatGuid: "iMessage;+;chat0000",
            buffer: Uint8Array.from(Buffer.from("image")),
            filename: "photo.jpg",
            asVoice: true,
            options: imsgOptions("iMessage;+;chat0000"),
          },
        ],
      ]);
      expect(result?.details).toEqual({ ok: true, messageId: "sent-guid" });
    },
  );
});
