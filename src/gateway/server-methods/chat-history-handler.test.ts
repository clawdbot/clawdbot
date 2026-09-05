import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  appendTranscriptMessage,
  bindSessionPendingInputSources,
  stageSessionPendingInput,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  clearUserProfileAuthLink,
  listUserProfileAuthLinks,
  readUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { connectChatMetadataAccount } from "./chat-metadata-runtime.test-support.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

function createPersonalMetadataFixture() {
  const owner = ensureProfileForEmail("metadata-owner@example.test");
  const authProfileId = connectChatMetadataAccount(owner.id);
  const client: NonNullable<GatewayRequestHandlerOptions["client"]> & { connId: string } = {
    connId: "metadata-owner-connection",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read"],
    },
    authenticatedUserProfile: {
      profileId: owner.id,
      displayName: owner.displayName,
      hasAvatar: false,
      updatedAt: owner.updatedAt,
    },
  };
  const config = {
    gateway: {
      roles: {
        default: "reader",
        definitions: {
          reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "none" } },
        },
      },
    },
  } satisfies OpenClawConfig;
  const clients = new Set([client]);
  const metadata = { models: [], swarmEnabled: false };
  const readChatMetadata = vi.fn<GatewayRequestContext["readChatMetadata"]>(async () => metadata);
  const context = createDirectChatContext({
    getRuntimeConfig: () => config,
    readChatMetadata,
    getClientConnIds: (filter) =>
      new Set(
        [...clients]
          .filter((current) => !filter || filter(current))
          .map((current) => current.connId),
      ),
  });
  const request = async (
    params: Record<string, unknown>,
    overrides: Partial<Pick<GatewayRequestHandlerOptions, "client" | "signal">> = {},
  ) => {
    const respond = vi.fn<RespondFn>();
    await expectDefined(
      chatHistoryHandlers["chat.metadata"],
      "metadata handler",
    )({
      params,
      context,
      client,
      respond,
      req: { type: "req", id: "draft-preview", method: "chat.metadata" },
      isWebchatConnect: () => false,
      ...overrides,
    });
    return respond;
  };
  return { owner, authProfileId, client, clients, config, metadata, readChatMetadata, request };
}

describe("chat history model selection defaults", () => {
  it("keeps a stored literal global conversation separate from main in per-sender scope", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        session: { scope: "per-sender" },
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      for (const agentId of ["ops", "research"]) {
        await upsertSessionEntryCore(
          { agentId, sessionKey: "global" },
          { sessionId: `global-${agentId}`, updatedAt: 1 },
        );
      }
      await upsertSessionEntryCore(
        { agentId: "research", sessionKey: "agent:research:main" },
        { sessionId: "main-research", updatedAt: 1 },
      );
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const client = identifiedClient("literal-global-operator");
      client.connect.scopes = ["operator.admin"];
      for (const [sessionKey, sessionId] of [
        ["global", "global-research"],
        ["agent:research:main", "main-research"],
      ]) {
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          chatHistoryHandlers["chat.history"],
          "history handler",
        )({
          params: { sessionKey, agentId: "research" },
          context,
          req: { type: "req", id: "literal-global", method: "chat.history" },
          client,
          isWebchatConnect: () => false,
          respond,
        });
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ sessionKey, sessionId }),
        );
      }
    });
  });

  it.each(["chat.history", "chat.startup"] as const)(
    "%s projects the non-primary agent's resolved selection target",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = {
          agents: {
            defaults: { model: "openai/gpt-5.6-sol" },
            ownership: "explicit",
            entries: {
              main: {},
              work: { model: "anthropic/claude-sonnet-4-6" },
            },
          },
        } satisfies OpenClawConfig;
        await state.writeConfig(cfg);
        const scope = {
          agentId: "work",
          sessionKey: "agent:work:main",
          sessionId: "work-main",
        };
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        let result: unknown;

        await expectDefined(
          chatHistoryHandlers[method],
          "history handler",
        )({
          params: { agentId: scope.agentId, sessionKey: scope.sessionKey },
          context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
          req: { type: "req", id: "model-target", method },
          client: { connect: { scopes: ["operator.admin"] } } as never,
          isWebchatConnect: () => false,
          respond: (ok, payload, error) => {
            expect(error).toBeUndefined();
            expect(ok).toBe(true);
            result = payload;
          },
        });

        const response = expectDefined(asOptionalRecord(result), "history response");
        expect(response.defaults).toMatchObject({ modelSelectionTarget: "agent" });
      });
    },
  );
});

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
        const skillsSnapshot = { prompt: "history unused saved prompt", skills: [] };
        await upsertSessionEntryCore(scope, {
          sessionId: scope.sessionId,
          updatedAt: now,
          thinkingLevel: "high",
          toolOverrides,
          skillsSnapshot,
        });
        await upsertSessionEntryCore(childScope, {
          sessionId: "history-child",
          updatedAt: now,
          parentSessionKey: scope.sessionKey,
          spawnedBy: scope.sessionKey,
          status: "running",
          skillsSnapshot,
        });
        const context = createDirectChatContext();
        const handler = expectDefined(chatHistoryHandlers[method], "history handler");
        const call = async () => {
          const respond = vi.fn();
          const cloneSpy = vi.spyOn(globalThis, "structuredClone");
          const parseSpy = vi.spyOn(JSON, "parse");
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
            expect(
              parseSpy.mock.calls.some(([value]) => value.includes(skillsSnapshot.prompt)),
            ).toBe(false);
            await pending;
            const [ok, payload, error] = expectDefined(respond.mock.calls[0], "history response");
            expect(error).toBeUndefined();
            expect(ok).toBe(true);
            expect(preparationCopies).toBe(0);
            return expectDefined(asOptionalRecord(payload), "history payload");
          } finally {
            cloneSpy.mockRestore();
            parseSpy.mockRestore();
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
  it("previews a retained personal account with read scope without changing its cleared default", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const { owner, authProfileId, metadata, readChatMetadata, request } =
        createPersonalMetadataFixture();
      clearUserProfileAuthLink({ profileId: owner.id, provider: "openai" });
      const before = readUserModelAuthProfile(authProfileId);

      const respond = await request({ agentId: "main", authProfileId });

      expect(respond).toHaveBeenCalledWith(true, metadata);
      expect(readChatMetadata).toHaveBeenCalledWith({
        agentId: "main",
        requesterProfileId: owner.id,
        draftAccountSelection: expect.objectContaining({
          owner: owner.id,
          authProfileId,
          assertCurrent: expect.any(Function),
        }),
      });
      expect(listUserProfileAuthLinks(owner.id)).toEqual([]);
      expect(readUserModelAuthProfile(authProfileId)).toEqual(before);
    });
  });

  it.each([
    "foreign admin",
    "unidentified admin",
    "anonymous",
    "synthetic owner",
    "forged locator",
  ] as const)(
    "rejects a personal draft preview from %s before projecting credentials",
    async (caller) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const { owner, client, authProfileId, readChatMetadata, request } =
          createPersonalMetadataFixture();
        client.connect.scopes = ["operator.admin"];
        let requestedProfile = authProfileId;
        if (caller === "foreign admin") {
          const other = ensureProfileForEmail("metadata-other@example.test");
          client.authenticatedUserProfile = {
            profileId: other.id,
            displayName: other.displayName,
            hasAvatar: false,
            updatedAt: other.updatedAt,
          };
        } else if (caller === "unidentified admin") {
          delete client.authenticatedUserProfile;
        } else if (caller === "synthetic owner") {
          client.internal = { syntheticClient: true };
        } else if (caller === "forged locator") {
          requestedProfile = `personal:${owner.id}:${randomUUID()}`;
        }

        const respond = await request(
          { agentId: "main", authProfileId: requestedProfile },
          caller === "anonymous" ? { client: null } : {},
        );

        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN" }),
        );
        expect(readChatMetadata).not.toHaveBeenCalled();
      });
    },
  );

  it("rejects combining a personal draft preview with a persisted session selector", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const { authProfileId, readChatMetadata, request } = createPersonalMetadataFixture();
      const respond = await request({
        agentId: "main",
        sessionKey: "agent:main:existing",
        authProfileId,
      });

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(readChatMetadata).not.toHaveBeenCalled();
    });
  });

  it.each(["disconnect", "role loss", "abort"] as const)(
    "rejects a personal draft preview after %s during the metadata read",
    async (loss) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const { client, clients, authProfileId, config, metadata, readChatMetadata, request } =
          createPersonalMetadataFixture();
        const entered = createDeferred();
        const release = createDeferred();
        const abort = new AbortController();
        readChatMetadata.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return metadata;
        });
        const pending = request({ agentId: "main", authProfileId }, { signal: abort.signal });
        try {
          await Promise.race([entered.promise, pending]);
          expect(readChatMetadata).toHaveBeenCalledOnce();
          if (loss === "disconnect") {
            clients.delete(client);
          } else if (loss === "role loss") {
            config.gateway.roles.definitions.reader.scopes = [];
          } else {
            abort.abort();
          }
        } finally {
          release.resolve();
          await pending;
        }
        const respond = await pending;
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN" }),
        );
      });
    },
  );

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
            sessionKey,
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
