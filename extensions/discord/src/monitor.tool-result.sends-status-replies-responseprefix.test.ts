import { MessageType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectPairingReplyText } from "../../../test/helpers/pairing-reply.js";
import {
  dispatchMock,
  sendMock,
  upsertPairingRequestMock,
} from "./monitor.tool-result.test-harness.js";
import {
  BASE_CFG,
  createCategoryGuildClient,
  createCategoryGuildEvent,
  createCategoryGuildHandler,
  createDmClient,
  createDmHandler,
  type Config,
  resetDiscordToolResultHarness,
} from "./monitor.tool-result.test-helpers.js";

beforeEach(() => {
  resetDiscordToolResultHarness();
});

describe("discord tool result dispatch", () => {
  it("uses channel id allowlists for non-thread channels with categories", async () => {
    let capturedCtx: { SessionKey?: string } | undefined;
    dispatchMock.mockImplementationOnce(async ({ ctx, dispatcher }) => {
      capturedCtx = ctx;
      dispatcher.sendFinalReply({ text: "hi" });
      return { queuedFinal: true, counts: { final: 1 } };
    });

    const handler = await createCategoryGuildHandler();
    const client = createCategoryGuildClient();

    await handler(
      createCategoryGuildEvent({
        messageId: "m-category",
        author: { id: "u1", bot: false, username: "Ada", tag: "Ada#1" },
      }),
      client,
    );

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(capturedCtx?.SessionKey).toBe("agent:main:discord:channel:c1");
  });

  it("prefixes group bodies with sender label", async () => {
    let capturedBody = "";
    dispatchMock.mockImplementationOnce(async ({ ctx, dispatcher }) => {
      capturedBody = ctx.Body ?? "";
      dispatcher.sendFinalReply({ text: "ok" });
      return { queuedFinal: true, counts: { final: 1 } };
    });

    const handler = await createCategoryGuildHandler();
    const client = createCategoryGuildClient();

    await handler(
      createCategoryGuildEvent({
        messageId: "m-prefix",
        timestamp: new Date("2026-01-17T00:00:00Z").toISOString(),
        author: { id: "u1", bot: false, username: "Ada", discriminator: "1234" },
      }),
      client,
    );

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(capturedBody).toContain("Ada (Ada#1234): hello");
  });

  it("replies with pairing code and sender id when dmPolicy is pairing", async () => {
    const cfg: Config = {
      ...BASE_CFG,
      channels: {
        discord: { dm: { enabled: true, policy: "pairing", allowFrom: [] } },
      },
    };

    const handler = await createDmHandler({ cfg });
    const client = createDmClient();

    await handler(
      {
        message: {
          id: "m1",
          content: "hello",
          channelId: "c1",
          timestamp: new Date().toISOString(),
          type: MessageType.Default,
          attachments: [],
          embeds: [],
          mentionedEveryone: false,
          mentionedUsers: [],
          mentionedRoles: [],
          author: { id: "u2", bot: false, username: "Ada" },
        },
        author: { id: "u2", bot: false, username: "Ada" },
        guild_id: null,
      },
      client,
    );

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expectPairingReplyText(String(sendMock.mock.calls[0]?.[1] ?? ""), {
      channel: "discord",
      idLine: "Your Discord user id: u2",
      code: "PAIRCODE",
    });
  }, 10000);
});
