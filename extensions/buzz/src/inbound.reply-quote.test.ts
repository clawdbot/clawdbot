import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  BOT_PUBLIC_KEY,
  OTHER_PUBLIC_KEY,
  PARENT_EVENT_ID,
  ROOM_ID,
  SENDER_PUBLIC_KEY,
  createAccount,
  createHistoryParams,
  createMessage,
  firstDispatch,
  handleBuzzInbound,
} from "./inbound.test-helpers.js";
import { setBuzzRuntime } from "./runtime.js";

describe("handleBuzzInbound", () => {
  describe("reply quote context", () => {
    // A Buzz reply names its parent in a NIP-10 "reply" tag. Without resolving
    // that parent, the agent is prompted with "look at this" and no referent.
    function replyMessage() {
      return createMessage({
        id: "trigger",
        text: "@bot what do you think?",
        replyToId: PARENT_EVENT_ID,
        threadId: PARENT_EVENT_ID,
        mentionedPubkeys: [BOT_PUBLIC_KEY],
      });
    }

    it("passes the replied-to message to the agent as quote context", async () => {
      const runtime = createPluginRuntimeMock();
      setBuzzRuntime(runtime);
      const params = createHistoryParams();
      vi.mocked(params.bus.fetchMessageById).mockResolvedValue(
        createMessage({
          id: PARENT_EVENT_ID,
          senderPubkey: OTHER_PUBLIC_KEY,
          text: "The deploy script takes 12 minutes.",
        }),
      );

      await handleBuzzInbound({ ...params, message: replyMessage() });

      expect(params.bus.fetchMessageById).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: PARENT_EVENT_ID }),
      );
      expect(firstDispatch(runtime).ctxPayload).toMatchObject({
        ReplyToBody: "The deploy script takes 12 minutes.",
      });
    });

    it("omits quote context for a top-level message", async () => {
      const runtime = createPluginRuntimeMock();
      setBuzzRuntime(runtime);
      const params = createHistoryParams();

      await handleBuzzInbound({
        ...params,
        message: createMessage({ id: "trigger", mentionedPubkeys: [BOT_PUBLIC_KEY] }),
      });

      expect(params.bus.fetchMessageById).not.toHaveBeenCalled();
      expect(firstDispatch(runtime).ctxPayload.ReplyToBody).toBeUndefined();
    });

    it("ignores a reply tag that names an event in another room", async () => {
      const runtime = createPluginRuntimeMock();
      setBuzzRuntime(runtime);
      const params = createHistoryParams();
      vi.mocked(params.bus.fetchMessageById).mockResolvedValue(
        createMessage({
          id: PARENT_EVENT_ID,
          channelId: "9f1c0d2e-0000-4000-8000-000000000000",
          text: "message from a different room",
        }),
      );

      await handleBuzzInbound({ ...params, message: replyMessage() });

      expect(firstDispatch(runtime).ctxPayload.ReplyToBody).toBeUndefined();
    });

    it("still dispatches when the reply target cannot be fetched", async () => {
      const runtime = createPluginRuntimeMock();
      setBuzzRuntime(runtime);
      const params = createHistoryParams();
      vi.mocked(params.bus.fetchMessageById).mockRejectedValue(new Error("relay timeout"));

      await handleBuzzInbound({ ...params, message: replyMessage() });

      expect(runtime.channel.inbound.dispatch).toHaveBeenCalled();
      expect(firstDispatch(runtime).ctxPayload.ReplyToBody).toBeUndefined();
    });

    it("surfaces cancellation from the lookup instead of dispatching", async () => {
      const runtime = createPluginRuntimeMock();
      setBuzzRuntime(runtime);
      const controller = new AbortController();
      const params = {
        ...createHistoryParams(),
        signal: controller.signal,
        assertCurrent: () => controller.signal.throwIfAborted(),
      };
      vi.mocked(params.bus.fetchMessageById).mockImplementation(async () => {
        controller.abort(new Error("gateway shutting down"));
        throw controller.signal.reason;
      });

      await expect(handleBuzzInbound({ ...params, message: replyMessage() })).rejects.toThrow(
        "gateway shutting down",
      );
      expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    });

    it("omits quote context when the quoted author is no longer a room member", async () => {
      const runtime = createPluginRuntimeMock();
      setBuzzRuntime(runtime);
      const params = createHistoryParams();
      vi.mocked(params.bus.fetchMessageById).mockResolvedValue(
        createMessage({ id: PARENT_EVENT_ID, senderPubkey: "d".repeat(64), text: "left the room" }),
      );

      await handleBuzzInbound({ ...params, message: replyMessage() });

      expect(firstDispatch(runtime).ctxPayload.ReplyToBody).toBeUndefined();
    });

    function visibilityConfig(
      contextVisibility: "all" | "allowlist" | "allowlist_quote",
    ): OpenClawConfig {
      return { channels: { defaults: { contextVisibility } } };
    }

    function allowlistRoomParams() {
      return {
        ...createHistoryParams(),
        account: createAccount({
          historyLimit: 2,
          groupPolicy: "allowlist",
          groupAllowFrom: [SENDER_PUBLIC_KEY],
        }),
      };
    }

    it("keeps an allowlisted author's message as quote context under allowlist visibility", async () => {
      const runtime = createPluginRuntimeMock();
      setBuzzRuntime(runtime);
      const params = { ...allowlistRoomParams(), cfg: visibilityConfig("allowlist") };
      vi.mocked(params.bus.fetchMessageById).mockResolvedValue(
        createMessage({
          id: PARENT_EVENT_ID,
          senderPubkey: SENDER_PUBLIC_KEY,
          text: "Deploy done.",
        }),
      );

      await handleBuzzInbound({ ...params, message: replyMessage() });

      expect(firstDispatch(runtime).ctxPayload.ReplyToBody).toBe("Deploy done.");
    });

    it("withholds the bot's own message under allowlist visibility when it is not allowlisted", async () => {
      const runtime = createPluginRuntimeMock();
      setBuzzRuntime(runtime);
      const params = { ...allowlistRoomParams(), cfg: visibilityConfig("allowlist") };
      vi.mocked(params.bus.fetchMessageById).mockResolvedValue(
        createMessage({ id: PARENT_EVENT_ID, senderPubkey: BOT_PUBLIC_KEY, text: "Deploy done." }),
      );

      await handleBuzzInbound({ ...params, message: replyMessage() });

      // The shared policy judges the quoted author alone; the bot gets no pass.
      expect(runtime.channel.inbound.dispatch).toHaveBeenCalled();
      expect(firstDispatch(runtime).ctxPayload.ReplyToBody).toBeUndefined();
    });

    it("withholds another member's message under allowlist visibility", async () => {
      const runtime = createPluginRuntimeMock();
      setBuzzRuntime(runtime);
      const params = { ...allowlistRoomParams(), cfg: visibilityConfig("allowlist") };
      vi.mocked(params.bus.fetchMessageById).mockResolvedValue(
        createMessage({
          id: PARENT_EVENT_ID,
          senderPubkey: OTHER_PUBLIC_KEY,
          text: "not allowlisted",
        }),
      );

      await handleBuzzInbound({ ...params, message: replyMessage() });

      expect(runtime.channel.inbound.dispatch).toHaveBeenCalled();
      expect(firstDispatch(runtime).ctxPayload.ReplyToBody).toBeUndefined();
    });

    it("points the reply-target id at the parent, not the incoming message", async () => {
      const runtime = createPluginRuntimeMock();
      setBuzzRuntime(runtime);
      const params = createHistoryParams();
      vi.mocked(params.bus.fetchMessageById).mockResolvedValue(
        createMessage({ id: PARENT_EVENT_ID, senderPubkey: OTHER_PUBLIC_KEY, text: "parent body" }),
      );

      await handleBuzzInbound({ ...params, message: replyMessage() });

      // Rendered next to the quote's sender and body, so it must name the same event.
      expect(firstDispatch(runtime).ctxPayload).toMatchObject({
        ReplyToId: PARENT_EVENT_ID,
        ReplyToBody: "parent body",
      });
    });

    it("keeps the anchor on the incoming message for a top-level message", async () => {
      const runtime = createPluginRuntimeMock();
      setBuzzRuntime(runtime);
      const params = createHistoryParams();

      await handleBuzzInbound({
        ...params,
        message: createMessage({ id: "trigger", mentionedPubkeys: [BOT_PUBLIC_KEY] }),
      });

      expect(firstDispatch(runtime).ctxPayload.ReplyToId).toBe("trigger");
    });

    it("never sends a malformed reply marker to the relay", async () => {
      const runtime = createPluginRuntimeMock();
      setBuzzRuntime(runtime);
      const params = createHistoryParams();

      await handleBuzzInbound({
        ...params,
        message: createMessage({
          id: "trigger",
          replyToId: "'; drop the relay --",
          threadId: "'; drop the relay --",
          mentionedPubkeys: [BOT_PUBLIC_KEY],
        }),
      });

      expect(params.bus.fetchMessageById).not.toHaveBeenCalled();
      expect(runtime.channel.inbound.dispatch).toHaveBeenCalled();
      expect(firstDispatch(runtime).ctxPayload.ReplyToBody).toBeUndefined();
    });

    it("accepts a parent whose room tag differs only in hex case", async () => {
      const runtime = createPluginRuntimeMock();
      setBuzzRuntime(runtime);
      const params = createHistoryParams();
      vi.mocked(params.bus.fetchMessageById).mockResolvedValue(
        createMessage({
          id: PARENT_EVENT_ID,
          channelId: ROOM_ID.toUpperCase(),
          senderPubkey: OTHER_PUBLIC_KEY,
          text: "same room, different case",
        }),
      );

      await handleBuzzInbound({ ...params, message: replyMessage() });

      expect(firstDispatch(runtime).ctxPayload.ReplyToBody).toBe("same room, different case");
    });

    it("keeps another member's message under allowlist_quote visibility", async () => {
      const runtime = createPluginRuntimeMock();
      setBuzzRuntime(runtime);
      const params = { ...allowlistRoomParams(), cfg: visibilityConfig("allowlist_quote") };
      vi.mocked(params.bus.fetchMessageById).mockResolvedValue(
        createMessage({
          id: PARENT_EVENT_ID,
          senderPubkey: OTHER_PUBLIC_KEY,
          text: "quoted anyway",
        }),
      );

      await handleBuzzInbound({ ...params, message: replyMessage() });

      expect(firstDispatch(runtime).ctxPayload.ReplyToBody).toBe("quoted anyway");
    });
  });
});
