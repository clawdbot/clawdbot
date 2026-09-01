import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  bindSessionPendingInputSources,
  stageSessionPendingInput,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

describe("chat history consumption receipts", () => {
  it("projects pending input at its acceptance time", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(2_000);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:pending-display-time",
        sessionId: "pending-display-time",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const receipt = expectDefined(
        await stageSessionPendingInput(scope, {
          runId: "pending-display-run",
          assertCurrent: () => {},
          message: {
            role: "user",
            content: "Display me where I was accepted",
            timestamp: 1_000,
            idempotencyKey: "pending-display-run:user",
          },
        }),
        "pending input receipt",
      );
      try {
        let result: unknown;
        await expectDefined(
          chatHistoryHandlers["chat.history"],
          "history handler",
        )({
          params: { sessionKey: scope.sessionKey },
          context: createDirectChatContext(),
          req: { type: "req", id: "history", method: "chat.history" },
          client: null,
          isWebchatConnect: () => false,
          respond: (ok, payload, error) => {
            expect(error).toBeUndefined();
            expect(ok).toBe(true);
            result = payload;
          },
        });
        const page = expectDefined(asOptionalRecord(result), "history response");
        const pendingInputs = expectDefined(asOptionalRecord(page.pendingInputs), "pending inputs");
        const [pending] = pendingInputs.items as Array<Record<string, unknown>>;
        expect(pending).toMatchObject({
          acceptedAt: 2_000,
          message: { content: "Display me where I was accepted", timestamp: 2_000 },
        });
      } finally {
        receipt.finish("interrupted");
        now.mockRestore();
      }
    });
  });

  it.each(["chat.history", "chat.startup"] as const)(
    "%s returns only requested current-session receipts in pages and empty deltas",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:collected",
          sessionId: "collected",
        };
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        const context = createDirectChatContext();
        const handler = expectDefined(chatHistoryHandlers[method], "history handler");
        const call = async (params: Record<string, unknown> = {}) => {
          let result: unknown;
          await handler({
            params: { sessionKey: scope.sessionKey, ...params },
            context,
            req: { type: "req", id: "history", method },
            client: null,
            isWebchatConnect: () => false,
            respond: (ok, payload, error) => {
              expect(error).toBeUndefined();
              expect(ok).toBe(true);
              result = payload;
            },
          });
          return expectDefined(asOptionalRecord(result), "history response");
        };
        const sources = [];
        for (const runId of ["source-a", "source-b"]) {
          sources.push(
            expectDefined(
              await stageSessionPendingInput(scope, {
                runId,
                assertCurrent: () => {},
                message: {
                  role: "user",
                  content: runId,
                  timestamp: 1,
                  idempotencyKey: `${runId}:user`,
                },
              }),
              "source receipt",
            ),
          );
        }
        const aggregate = expectDefined(
          bindSessionPendingInputSources(sources, {
            role: "user",
            content: "Collected inputs",
            timestamp: 2,
            idempotencyKey: "collect:batch",
          }),
          "aggregate receipt",
        );
        const retained = [];
        try {
          await aggregate.run(() => appendTranscriptMessage(scope, { message: aggregate.message }));
          await appendTranscriptMessage(scope, {
            message: { role: "assistant", content: "Later reply" },
          });
          const inputRunIds = ["source-a", "missing"];
          const page = await call({ inputRunIds, limit: 1 });
          const expected = [
            { runId: "source-a", state: "consumed", consumedByEventId: aggregate.inputId },
          ];
          expect(page.inputReceipts).toEqual(expected);
          expect(page.inputConsumptions).toEqual([
            { runId: "source-a", consumedByEventId: aggregate.inputId },
          ]);
          expect(page.pendingInputs).toEqual({ items: [], total: 0 });
          expect(JSON.stringify(page.messages)).not.toContain("Collected inputs");
          const delta = await call({ inputRunIds, cursor: page.deltaCursor });
          expect(delta).toMatchObject({ kind: "delta", messages: [], inputReceipts: expected });
          for (let index = 0; index < 21; index += 1) {
            retained.push(
              expectDefined(
                await stageSessionPendingInput(scope, {
                  runId: `retained-${index}`,
                  assertCurrent: () => {},
                  message: {
                    role: "user",
                    content: `retained-${index}`,
                    timestamp: index + 3,
                    idempotencyKey: `retained-${index}:user`,
                  },
                }),
                "retained receipt",
              ),
            );
          }
          const retainedPage = await call({ inputRunIds: ["retained-0"], limit: 1 });
          expect(retainedPage.inputReceipts).toEqual([{ runId: "retained-0", state: "pending" }]);
          expect(retainedPage.inputConsumptions).toEqual([]);
          expect(retainedPage.pendingInputs).toMatchObject({
            total: 21,
            items: [{ runId: "retained-20" }],
          });
          const anchor = await call({
            inputRunIds,
            messageId: aggregate.inputId,
            sessionId: scope.sessionId,
          });
          expect(anchor.inputReceipts).toEqual([]);
          await upsertSessionEntryCore(scope, { sessionId: "replacement", updatedAt: 2 });
          expect((await call({ inputRunIds })).inputReceipts).toEqual([]);
        } finally {
          aggregate.finish("interrupted");
          for (const source of sources) {
            source.finish("interrupted");
          }
          for (const receipt of retained) {
            receipt.finish("interrupted");
          }
        }
      });
    },
  );

  it.each([
    { inputRunIds: Array.from({ length: 51 }, (_, index) => `run-${index}`) },
    { inputRunIds: ["r".repeat(257)] },
  ])("rejects oversized receipt queries before reading session state", async ({ inputRunIds }) => {
    const context = createDirectChatContext();
    const respond = vi.fn();
    await expectDefined(
      chatHistoryHandlers["chat.history"],
      "history handler",
    )({
      params: { sessionKey: "main", inputRunIds },
      context,
      respond,
      req: { type: "req", id: "bounds", method: "chat.history" },
      client: null,
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});

describe("chat history exact-entry snapshots", () => {
  it.each(["chat.history", "chat.startup"] as const)(
    "%s projects fresh owned session state without another preparation copy",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const now = Date.now();
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:history-owned",
          sessionId: "history-owned",
        };
        const childScope = { agentId: "main", sessionKey: "agent:main:subagent:history-child" };
        const toolOverrides = { mcpToolsDeny: { synthetic: ["blocked"] } };
        await upsertSessionEntryCore(scope, {
          sessionId: scope.sessionId,
          updatedAt: now,
          thinkingLevel: "high",
          toolOverrides,
        });
        await upsertSessionEntryCore(childScope, {
          sessionId: "history-child",
          updatedAt: now,
          parentSessionKey: scope.sessionKey,
          spawnedBy: scope.sessionKey,
          status: "running",
        });
        const context = createDirectChatContext();
        const handler = expectDefined(chatHistoryHandlers[method], "history handler");
        const call = async () => {
          const respond = vi.fn();
          const cloneSpy = vi.spyOn(globalThis, "structuredClone");
          try {
            const pending = handler({
              params: { sessionKey: scope.sessionKey },
              context,
              req: { type: "req", id: "owned-history", method },
              client: null,
              isWebchatConnect: () => false,
              respond,
            });
            // Count synchronous history preparation before optional startup icon work resumes.
            const preparationCopies = cloneSpy.mock.calls.filter(
              ([value]) => asOptionalRecord(value)?.sessionId === scope.sessionId,
            ).length;
            await pending;
            const [ok, payload, error] = expectDefined(respond.mock.calls[0], "history response");
            expect(error).toBeUndefined();
            expect(ok).toBe(true);
            expect(preparationCopies).toBe(0);
            return expectDefined(asOptionalRecord(payload), "history payload");
          } finally {
            cloneSpy.mockRestore();
          }
        };

        const first = await call();
        expect(first).toMatchObject({ thinkingLevel: "high", toolOverrides });
        expect(first.sessionInfo).toMatchObject({ childSessions: [childScope.sessionKey] });
        const responseTools = expectDefined(
          asOptionalRecord(first.toolOverrides),
          "tool overrides",
        );
        const deniedByServer = expectDefined(
          asOptionalRecord(responseTools.mcpToolsDeny),
          "denied tools by server",
        );
        const deniedTools = deniedByServer.synthetic;
        if (!Array.isArray(deniedTools)) {
          throw new Error("expected nested denied tool array");
        }
        deniedTools.push("response-only");
        expect(toolOverrides.mcpToolsDeny.synthetic).toEqual(["blocked"]);
        expect((await call()).toolOverrides).toEqual(toolOverrides);

        await updateSessionEntry(scope, () => ({ thinkingLevel: "low", updatedAt: now + 1 }));
        await updateSessionEntry(childScope, () => ({
          parentSessionKey: "agent:main:other-parent",
          spawnedBy: "agent:main:other-parent",
          updatedAt: now + 1,
        }));
        const fresh = await call();
        expect(fresh).toMatchObject({ thinkingLevel: "low", toolOverrides });
        expect(asOptionalRecord(fresh.sessionInfo)?.childSessions).toBeUndefined();
        expect(first.thinkingLevel).toBe("high");
      });
    },
  );
});

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
