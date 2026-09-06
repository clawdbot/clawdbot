import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionEventSubscriberRegistry } from "../server-chat-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createTranscriptUpdateBroadcastHandler } from "../server-session-events.js";
import {
  roleClient,
  rolePolicyConfig,
  sharingPolicyClient,
} from "../session-sharing.test-utils.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import type { RespondFn } from "./types.js";

describe("chat.startup short references", () => {
  it.each([true, false])(
    "establishes observation before reading only for a live connection (%s)",
    async (live) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const key = "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001";
        const scope = { agentId: "main", sessionKey: key, sessionId: "observation-startup" };
        await upsertSessionEntryCore(scope, {
          sessionId: scope.sessionId,
          updatedAt: 1,
          visibility: "shared",
        });
        await appendTranscriptMessage(scope, {
          message: { role: "user", content: "Snapshot history", timestamp: 1 },
        });
        const client = {
          ...sharingPolicyClient({ scopes: ["operator.read"] }),
          connId: "short-startup-observer",
        };
        const subscribers = createSessionEventSubscriberRegistry(() => live);
        const broadcastToConnIds = vi.fn();
        const emit = createTranscriptUpdateBroadcastHandler({
          broadcastToConnIds,
          sessionEventSubscribers: subscribers,
          sessionMessageSubscribers: { get: () => new Set() },
          chatAbortControllers: new Map(),
        });
        const lateMessage = { role: "assistant", content: "Arrived during startup", timestamp: 2 };
        const readChatStartupProjection = vi.fn(async () => {
          await appendTranscriptMessage(scope, { message: lateMessage });
          await emit({
            sessionKey: key,
            message: lateMessage,
            messageId: "late-message",
            messageSeq: 2,
          });
          return undefined;
        });
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          chatHistoryHandlers["chat.startup"],
          "startup handler",
        )({
          params: { shortId: "12345678", agentId: "main" },
          context: createDirectChatContext({
            subscribeSessionEvents: subscribers.subscribe,
            getSessionEventSubscriberConnIds: subscribers.getAll,
            readChatStartupProjection,
          }),
          req: { type: "req", id: "observer", method: "chat.startup" },
          client,
          isWebchatConnect: () => false,
          respond,
        });
        if (live) {
          expect(broadcastToConnIds).toHaveBeenCalledWith(
            "session.message",
            expect.objectContaining({
              sessionKey: key,
              message: expect.objectContaining({ content: lateMessage.content }),
            }),
            new Set([client.connId]),
          );
          expect(broadcastToConnIds.mock.invocationCallOrder[0]).toBeLessThan(
            respond.mock.invocationCallOrder[0]!,
          );
          expect(respond.mock.calls[0]?.[1]).toMatchObject({
            messages: [expect.objectContaining({ content: "Snapshot history" })],
          });
        } else {
          expect(subscribers.getAll().size).toBe(0);
          expect(readChatStartupProjection).not.toHaveBeenCalled();
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: "UNAVAILABLE" }),
          );
        }
      });
    },
  );
  it.each(["draft", "incognito", "foreign"] as const)(
    "does not disclose %s sessions through short references",
    async (visibility) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = rolePolicyConfig();
        await state.writeConfig(cfg);
        const client = roleClient(visibility === "foreign" ? "none" : "view");
        await upsertSessionEntryCore(
          {
            agentId: "main",
            sessionKey: "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001",
          },
          {
            sessionId: "hidden-short-startup",
            updatedAt: 1,
            visibility: visibility === "draft" ? "draft" : "shared",
            ...(visibility === "incognito" ? { incognito: true } : {}),
          },
        );
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          chatHistoryHandlers["chat.startup"],
          "startup handler",
        )({
          params: { shortId: "12345678", agentId: "main" },
          context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
          req: { type: "req", id: "hidden", method: "chat.startup" },
          client,
          isWebchatConnect: () => false,
          respond,
        });
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, { resolution: { ok: false } });
      });
    },
  );
  it("returns canonical history and bounded ambiguity through the existing resolver", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const key = "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001";
      const scope = { agentId: "main", sessionKey: key, sessionId: "short-startup" };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        displayName: "Selected conversation",
      });
      await appendTranscriptMessage(scope, {
        message: { role: "user", content: "The selected history", timestamp: 1 },
      });
      const handler = expectDefined(chatHistoryHandlers["chat.startup"], "startup handler");
      const context = createDirectChatContext();
      const call = async (shortId: string) => {
        const respond = vi.fn<RespondFn>();
        await handler({
          params: { shortId, agentId: "main", limit: 80 },
          context,
          req: { type: "req", id: "short", method: "chat.startup" },
          client: null,
          isWebchatConnect: () => false,
          respond,
        });
        return respond;
      };
      expect(await call("12345678")).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          sessionKey: key,
          resolution: { ok: true, key, agentId: "main", displayName: "Selected conversation" },
          messages: expect.arrayContaining([
            expect.objectContaining({ content: "The selected history" }),
          ]),
        }),
        undefined,
        undefined,
      );
      expect(await call("aaaaaaaa")).toHaveBeenCalledWith(true, { resolution: { ok: false } });
      await upsertSessionEntryCore(
        {
          agentId: "main",
          sessionKey: "agent:main:dashboard:12345678-0bbb-4000-8000-000000000002",
        },
        { sessionId: "other", updatedAt: 2 },
      );
      expect(await call("12345678")).toHaveBeenCalledWith(true, {
        resolution: expect.objectContaining({
          ok: false,
          candidates: expect.arrayContaining([expect.objectContaining({ key })]),
        }),
      });
    });
  });
});
