// Telegram supersede policy for durable ingress (authorization-gated).
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  addChannelAllowFromStoreEntry,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it } from "vitest";

let openClawState: OpenClawTestState | undefined;

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await openClawState?.cleanup();
  openClawState = undefined;
});
import type { TelegramSpooledUpdatePayload } from "./telegram-ingress-spool.payload.js";
import {
  isTelegramAmbientSpooledUpdate,
  isTelegramSpooledUpdateSenderAuthorized,
} from "./telegram-ingress-supersede-auth.js";
import { createShouldSupersedeTelegramSpooledPending } from "./telegram-ingress-supersede.js";

const OWNER_ID = "111";
const STRANGER_ID = "999";

function cfgWithOwner(ownerId = OWNER_ID): OpenClawConfig {
  return {
    channels: {
      telegram: {
        allowFrom: [ownerId],
        dmPolicy: "allowlist",
      },
    },
  } as OpenClawConfig;
}

function messageUpdate(params: {
  updateId: number;
  text: string;
  senderId: string;
  chatId?: number;
  chatType?: string;
  messageThreadId?: number;
  isTopicMessage?: boolean;
  isForum?: boolean;
  isDirectMessages?: boolean;
  directMessagesTopicId?: number;
  entities?: Array<{ type: string; offset: number; length: number }>;
}) {
  return {
    update_id: params.updateId,
    message: {
      text: params.text,
      from: { id: Number(params.senderId) },
      chat: {
        id: params.chatId ?? Number(params.senderId),
        type: params.chatType ?? "private",
        ...(params.isForum !== undefined ? { is_forum: params.isForum } : {}),
        ...(params.isDirectMessages !== undefined
          ? { is_direct_messages: params.isDirectMessages }
          : {}),
      },
      ...(params.messageThreadId !== undefined
        ? { message_thread_id: params.messageThreadId }
        : {}),
      ...(params.isTopicMessage !== undefined ? { is_topic_message: params.isTopicMessage } : {}),
      ...(params.directMessagesTopicId !== undefined
        ? { direct_messages_topic: { topic_id: params.directMessagesTopicId } }
        : {}),
      ...(params.entities ? { entities: params.entities } : {}),
    },
  };
}

function record(
  id: string,
  update: unknown,
): {
  id: string;
  channelId: string;
  accountId: string;
  queueName: string;
  payload: TelegramSpooledUpdatePayload;
  receivedAt: number;
  updatedAt: number;
  attempts: number;
} {
  return {
    id,
    channelId: "telegram",
    accountId: "default",
    queueName: "q",
    payload: {
      version: 1,
      updateId: Number(id),
      receivedAt: Number(id),
      update,
    },
    receivedAt: Number(id),
    updatedAt: Number(id),
    attempts: 0,
  };
}

function claim(
  id: string,
  update: unknown,
): ReturnType<typeof record> & {
  claim: { token: string; ownerId: string; claimedAt: number };
} {
  return {
    ...record(id, update),
    claim: { token: "test-auth-token", ownerId: "1:1:x", claimedAt: 1 },
  };
}

describe("telegram ingress supersede policy", () => {
  const auth = { cfg: cfgWithOwner(), accountId: "default" };
  const shouldSupersede = createShouldSupersedeTelegramSpooledPending(auth);

  it("never supersedes on normal messages even from owner", async () => {
    expect(
      await shouldSupersede(
        record("2", messageUpdate({ updateId: 2, text: "hello there", senderId: OWNER_ID })),
        claim("1", messageUpdate({ updateId: 1, text: "prior", senderId: OWNER_ID })),
      ),
    ).toBe(false);
  });

  it("supersedes on authorized abort text", async () => {
    expect(
      await shouldSupersede(
        record("2", messageUpdate({ updateId: 2, text: "stop", senderId: OWNER_ID })),
        claim("1", messageUpdate({ updateId: 1, text: "prior", senderId: OWNER_ID })),
      ),
    ).toBe(true);
  });

  it("does not supersede unauthorized abort text (group stranger)", async () => {
    expect(
      await shouldSupersede(
        record(
          "2",
          messageUpdate({
            updateId: 2,
            text: "stop",
            senderId: STRANGER_ID,
            chatId: -1001,
            chatType: "supergroup",
          }),
        ),
        claim(
          "1",
          messageUpdate({
            updateId: 1,
            text: "prior",
            senderId: OWNER_ID,
            chatId: -1001,
            chatType: "supergroup",
          }),
        ),
      ),
    ).toBe(false);
  });

  it("does not supersede bare slash prefixes that are not recognized commands", async () => {
    expect(
      await shouldSupersede(
        record("2", messageUpdate({ updateId: 2, text: "/notarealcmd", senderId: OWNER_ID })),
        claim("1", messageUpdate({ updateId: 1, text: "prior", senderId: OWNER_ID })),
      ),
    ).toBe(false);
  });

  it("gates command supersede on authorized sender", async () => {
    // /new is a recognized text alias in OpenClaw command set.
    const authorized = await shouldSupersede(
      record("2", messageUpdate({ updateId: 2, text: "/new", senderId: OWNER_ID })),
      claim("1", messageUpdate({ updateId: 1, text: "prior", senderId: OWNER_ID })),
    );
    const unauthorized = await shouldSupersede(
      record(
        "3",
        messageUpdate({
          updateId: 3,
          text: "/new",
          senderId: STRANGER_ID,
          chatId: -1001,
          chatType: "supergroup",
        }),
      ),
      claim(
        "1",
        messageUpdate({
          updateId: 1,
          text: "prior",
          senderId: OWNER_ID,
          chatId: -1001,
          chatType: "supergroup",
        }),
      ),
    );
    expect(authorized).toBe(true);
    expect(unauthorized).toBe(false);
  });

  it("gates ambient room-event supersede on authorized sender", async () => {
    expect(isTelegramAmbientSpooledUpdate({ message_reaction: {} })).toBe(true);
    expect(
      await shouldSupersede(
        record("2", messageUpdate({ updateId: 2, text: "hi", senderId: OWNER_ID })),
        claim("1", { update_id: 1, message_reaction: {} }),
      ),
    ).toBe(true);
    expect(
      await shouldSupersede(
        record("3", messageUpdate({ updateId: 3, text: "hi", senderId: STRANGER_ID })),
        claim("1", { update_id: 1, message_reaction: {} }),
      ),
    ).toBe(false);
  });

  it("supersedes on authorized bot_command entity even without static text alias", async () => {
    const ourBotAuth = {
      ...auth,
      botUsername: "mybot",
    };
    const shouldSupersedeOurBot = createShouldSupersedeTelegramSpooledPending(ourBotAuth);
    const skillCommandUpdate = messageUpdate({
      updateId: 2,
      text: "/deploy@mybot",
      senderId: OWNER_ID,
      entities: [{ type: "bot_command", offset: 0, length: "/deploy@mybot".length }],
    });
    expect(
      await shouldSupersedeOurBot(
        record("2", skillCommandUpdate),
        claim("1", messageUpdate({ updateId: 1, text: "prior", senderId: OWNER_ID })),
      ),
    ).toBe(true);
  });

  it.each([
    {
      name: "does not supersede an identityless foreign targeted command",
      text: "/queue@OtherBot",
      entityText: "/queue@OtherBot",
      expected: false,
    },
    {
      name: "keeps identityless targeted aborts pessimistic",
      text: "/stop@OtherBot!",
      entityText: "/stop@OtherBot",
      expected: true,
    },
  ])("$name", async ({ text, entityText, expected }) => {
    const update = messageUpdate({
      updateId: 2,
      text,
      senderId: OWNER_ID,
      entities: [{ type: "bot_command", offset: 0, length: entityText.length }],
    });

    expect(
      await shouldSupersede(
        record("2", update),
        claim("1", messageUpdate({ updateId: 1, text: "prior", senderId: OWNER_ID })),
      ),
    ).toBe(expected);
  });

  it("does not supersede when a bot_command entity appears inside ordinary text", async () => {
    const ourBotAuth = {
      ...auth,
      botUsername: "mybot",
    };
    const shouldSupersedeOurBot = createShouldSupersedeTelegramSpooledPending(ourBotAuth);
    const commandText = "/deploy@mybot";
    const ordinaryText = `Please run ${commandText} after this finishes`;
    const ordinaryMessage = messageUpdate({
      updateId: 2,
      text: ordinaryText,
      senderId: OWNER_ID,
      entities: [
        {
          type: "bot_command",
          offset: ordinaryText.indexOf(commandText),
          length: commandText.length,
        },
      ],
    });
    const ordinaryCaption = {
      update_id: 3,
      message: {
        caption: ordinaryText,
        caption_entities: [
          {
            type: "bot_command",
            offset: ordinaryText.indexOf(commandText),
            length: commandText.length,
          },
        ],
        from: { id: Number(OWNER_ID) },
        chat: { id: Number(OWNER_ID), type: "private" },
      },
    };

    for (const update of [ordinaryMessage, ordinaryCaption]) {
      expect(
        await shouldSupersedeOurBot(
          record(String(update.update_id), update),
          claim("1", messageUpdate({ updateId: 1, text: "prior", senderId: OWNER_ID })),
        ),
      ).toBe(false);
    }
  });

  it("does not supersede bot_command entities addressed to another bot", async () => {
    const ourBotAuth = {
      ...auth,
      botUsername: "mybot",
    };
    const shouldSupersedeOurBot = createShouldSupersedeTelegramSpooledPending(ourBotAuth);
    const otherBotCommand = messageUpdate({
      updateId: 2,
      text: "/deploy@OtherBot",
      senderId: OWNER_ID,
      entities: [{ type: "bot_command", offset: 0, length: "/deploy@OtherBot".length }],
    });
    expect(
      await shouldSupersedeOurBot(
        record("2", otherBotCommand),
        claim("1", messageUpdate({ updateId: 1, text: "prior", senderId: OWNER_ID })),
      ),
    ).toBe(false);
  });

  it("rejects supersede when topic allowFrom excludes the sender despite account allowFrom *", async () => {
    const topicRestrictedAuth = {
      cfg: {
        channels: {
          telegram: {
            allowFrom: ["*"],
            groupAllowFrom: ["*"],
            groupPolicy: "allowlist",
            groups: {
              "-1001": {
                allowFrom: ["*"],
                topics: {
                  "10": {
                    allowFrom: [OWNER_ID],
                  },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "default",
    };
    const shouldSupersedeTopic = createShouldSupersedeTelegramSpooledPending(topicRestrictedAuth);
    const strangerInRestrictedTopic = messageUpdate({
      updateId: 2,
      text: "stop",
      senderId: STRANGER_ID,
      chatId: -1001,
      chatType: "supergroup",
      messageThreadId: 10,
      isTopicMessage: true,
      isForum: true,
    });
    const pendingInTopic = messageUpdate({
      updateId: 1,
      text: "prior",
      senderId: OWNER_ID,
      chatId: -1001,
      chatType: "supergroup",
      messageThreadId: 10,
      isTopicMessage: true,
      isForum: true,
    });
    expect(
      await shouldSupersedeTopic(
        record("2", strangerInRestrictedTopic),
        claim("1", pendingInTopic),
      ),
    ).toBe(false);
    // Topic-allowlisted owner can still supersede.
    const ownerInRestrictedTopic = messageUpdate({
      updateId: 3,
      text: "stop",
      senderId: OWNER_ID,
      chatId: -1001,
      chatType: "supergroup",
      messageThreadId: 10,
      isTopicMessage: true,
      isForum: true,
    });
    expect(
      await shouldSupersedeTopic(record("3", ownerInRestrictedTopic), claim("1", pendingInTopic)),
    ).toBe(true);
  });

  it.each([
    {
      name: "allows the topic sender when the base chat denies them",
      baseAllowFrom: [STRANGER_ID],
      topicAllowFrom: [OWNER_ID],
      expected: true,
    },
    {
      name: "denies the topic sender when the base chat allows them",
      baseAllowFrom: [OWNER_ID],
      topicAllowFrom: [STRANGER_ID],
      expected: false,
    },
  ])("uses channel-DM topic authorization: $name", async (testCase) => {
    const channelDmAuth = {
      cfg: {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: testCase.baseAllowFrom,
            groups: {
              "-1001": {
                allowFrom: testCase.baseAllowFrom,
                topics: { "77": { allowFrom: testCase.topicAllowFrom } },
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "default",
    };
    const update = messageUpdate({
      updateId: 2,
      text: "stop",
      senderId: OWNER_ID,
      chatId: -1001,
      chatType: "supergroup",
      isDirectMessages: true,
      directMessagesTopicId: 77,
      messageThreadId: 999,
    });

    expect(
      await createShouldSupersedeTelegramSpooledPending(channelDmAuth)(
        record("2", update),
        claim("1", messageUpdate({ updateId: 1, text: "prior", senderId: OWNER_ID })),
      ),
    ).toBe(testCase.expected);
  });

  it("reuses ingress command gate for sender authorization", async () => {
    expect(
      await isTelegramSpooledUpdateSenderAuthorized(
        messageUpdate({ updateId: 1, text: "x", senderId: OWNER_ID }),
        auth,
      ),
    ).toBe(true);
    expect(
      await isTelegramSpooledUpdateSenderAuthorized(
        messageUpdate({
          updateId: 1,
          text: "x",
          senderId: STRANGER_ID,
          chatId: -1001,
          chatType: "supergroup",
        }),
        auth,
      ),
    ).toBe(false);
  });

  it("authorizes paired DM senders via the pairing store under dmPolicy pairing", async () => {
    const pairedId = "424242";
    openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-supersede-store-",
    });
    await addChannelAllowFromStoreEntry({
      channel: "telegram",
      entry: pairedId,
      accountId: "default",
    });
    const pairingAuth = {
      cfg: {
        channels: {
          telegram: {
            dmPolicy: "pairing",
          },
        },
      } as OpenClawConfig,
      accountId: "default",
    };
    const shouldSupersedePaired = createShouldSupersedeTelegramSpooledPending(pairingAuth);

    expect(
      await isTelegramSpooledUpdateSenderAuthorized(
        messageUpdate({ updateId: 1, text: "x", senderId: pairedId }),
        pairingAuth,
      ),
    ).toBe(true);

    expect(
      await shouldSupersedePaired(
        record("2", messageUpdate({ updateId: 2, text: "stop", senderId: pairedId })),
        claim("1", messageUpdate({ updateId: 1, text: "prior", senderId: pairedId })),
      ),
    ).toBe(true);

    expect(
      await shouldSupersedePaired(
        record("3", messageUpdate({ updateId: 3, text: "stop", senderId: STRANGER_ID })),
        claim("1", messageUpdate({ updateId: 1, text: "prior", senderId: pairedId })),
      ),
    ).toBe(false);
  });

  it("authorizes commands.ownerAllowFrom senders for supersede", async () => {
    const ownerId = "777001";
    const ownerAuth = {
      cfg: {
        channels: {
          telegram: {
            dmPolicy: "pairing",
          },
        },
        commands: {
          ownerAllowFrom: [ownerId],
        },
      } as OpenClawConfig,
      accountId: "default",
    };
    const shouldSupersedeOwner = createShouldSupersedeTelegramSpooledPending(ownerAuth);

    expect(
      await isTelegramSpooledUpdateSenderAuthorized(
        messageUpdate({ updateId: 1, text: "x", senderId: ownerId }),
        ownerAuth,
      ),
    ).toBe(true);

    expect(
      await shouldSupersedeOwner(
        record("2", messageUpdate({ updateId: 2, text: "/stop", senderId: ownerId })),
        claim("1", messageUpdate({ updateId: 1, text: "prior", senderId: ownerId })),
      ),
    ).toBe(true);
  });
});
