import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

describe("chat metadata ownership", () => {
  it("reads the persisted session profile without contaminating neutral agent metadata", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:locked";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "locked",
          updatedAt: 1,
          authProfileOverride: "test:locked",
          authProfileOverrideSource: "user",
        },
      );
      const readChatMetadata = vi.fn(async () => ({ commands: [], models: [] }));
      const respond = vi.fn();
      const handler = expectDefined(chatHistoryHandlers["chat.metadata"], "metadata handler");
      const context = {
        getRuntimeConfig: () => ({}),
        readChatMetadata,
      } as unknown as GatewayRequestContext;
      for (const params of [{ agentId: "main", sessionKey }, { agentId: "main" }]) {
        await handler({
          params,
          context,
          respond,
          req: {} as never,
          client: null,
          isWebchatConnect: () => false,
        });
      }
      expect(readChatMetadata.mock.calls).toEqual([
        [
          {
            agentId: "main",
            sessionEntry: expect.objectContaining({
              authProfileOverride: "test:locked",
              authProfileOverrideSource: "user",
            }),
          },
        ],
        [{ agentId: "main" }],
      ]);
      expect(respond).toHaveBeenCalledTimes(2);
      readChatMetadata.mockClear();
      await handler({
        params: { agentId: "other", sessionKey },
        context,
        respond,
        req: {} as never,
        client: null,
        isWebchatConnect: () => false,
      });
      expect(readChatMetadata).not.toHaveBeenCalled();
      expect(respond).toHaveBeenLastCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    });
  });

  it("returns a typed selection error for an ownerless explicit fleet", async () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
      },
    };
    const respond = vi.fn();
    const readChatMetadata = vi.fn();

    await expectDefined(
      chatHistoryHandlers["chat.metadata"],
      'chatHistoryHandlers["chat.metadata"] test invariant',
    )({
      params: {},
      respond: respond as unknown as RespondFn,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => config,
        readChatMetadata,
      } as unknown as GatewayRequestContext,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("has no explicit owner"),
      }),
    );
    expect(readChatMetadata).not.toHaveBeenCalled();
  });
});
