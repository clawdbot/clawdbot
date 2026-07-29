/** Gateway session-search validation and agent-scoping tests. */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const searchSessionTranscriptsMock = vi.fn();
const listSessionEntriesMock = vi.fn();
const resolveExistingAgentSessionStoreTargetsSyncMock = vi.fn();

vi.mock("../../config/sessions/session-transcript-search.js", () => ({
  searchSessionTranscripts: (...args: unknown[]) => searchSessionTranscriptsMock(...args),
}));
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  listSessionEntries: (...args: unknown[]) => listSessionEntriesMock(...args),
  listSessionEntriesReadOnly: (...args: unknown[]) => listSessionEntriesMock(...args),
}));
vi.mock("../../config/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions.js")>()),
  resolveExistingAgentSessionStoreTargetsSync: (...args: unknown[]) =>
    resolveExistingAgentSessionStoreTargetsSyncMock(...args),
}));

import { sessionsHandlers } from "./sessions.js";

let cfg: Record<string, unknown> = {
  agents: { list: [{ id: "main", default: true }, { id: "work" }] },
};

async function callSearch(
  params: Record<string, unknown>,
  scopes?: string[],
  profileId?: string,
): Promise<ReturnType<typeof vi.fn>> {
  const respond = vi.fn();
  await expectDefined(
    sessionsHandlers["sessions.search"],
    'sessionsHandlers["sessions.search"] test invariant',
  )({
    req: { id: "req-search" } as never,
    params,
    respond: respond as unknown as RespondFn,
    context: { getRuntimeConfig: () => cfg } as unknown as GatewayRequestContext,
    client: scopes
      ? ({
          connect: { scopes },
          ...(profileId
            ? {
                authenticatedUserProfile: {
                  profileId,
                  displayName: null,
                  hasAvatar: false,
                  updatedAt: 1,
                },
              }
            : {}),
        } as never)
      : null,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("sessions.search gateway method", () => {
  beforeEach(() => {
    cfg = { agents: { list: [{ id: "main", default: true }, { id: "work" }] } };
    searchSessionTranscriptsMock.mockReset();
    searchSessionTranscriptsMock.mockReturnValue({ hits: [], indexing: false });
    listSessionEntriesMock.mockReset();
    listSessionEntriesMock.mockReturnValue([]);
    resolveExistingAgentSessionStoreTargetsSyncMock.mockReset();
    resolveExistingAgentSessionStoreTargetsSyncMock.mockReturnValue([]);
  });

  it("validates params and rejects whitespace-only queries", async () => {
    const invalidLimit = await callSearch({ query: "needle", limit: 26 });
    expect(invalidLimit).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );

    const emptyQuery = await callSearch({ query: "   " });
    expect(emptyQuery).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "query must not be empty" }),
    );
    expect(searchSessionTranscriptsMock).not.toHaveBeenCalled();
  });

  it("derives one agent and canonical filters from sessionKeys", async () => {
    searchSessionTranscriptsMock.mockReturnValue({
      hits: [
        {
          sessionKey: "agent:work:main",
          sessionId: "session-work",
          messageId: "message-1",
          role: "assistant",
          timestamp: 123,
          snippet: "needle",
          score: 1,
        },
      ],
      indexing: true,
      truncated: true,
    });

    const respond = await callSearch({
      query: " needle ",
      sessionKeys: ["agent:work:main", "agent:work:other"],
      limit: 5,
    });

    expect(searchSessionTranscriptsMock).toHaveBeenCalledWith({
      agentId: "work",
      query: "needle",
      limit: 5,
      sessionKeys: ["agent:work:main", "agent:work:other"],
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        indexing: true,
        truncated: true,
        results: [expect.objectContaining({ score: 1 })],
      }),
    );
  });

  it("filters incognito candidates before applying a non-admin result limit", async () => {
    const incognitoKey = "agent:main:dashboard:incognito-newer";
    const durableKey = "agent:main:dashboard:durable";
    const incognitoHit = {
      sessionKey: incognitoKey,
      sessionId: "session-incognito",
      messageId: "message-incognito",
      role: "user",
      timestamp: 200,
      snippet: "needle private",
      score: 10,
    };
    const durableHit = {
      sessionKey: durableKey,
      sessionId: "session-durable",
      messageId: "message-durable",
      role: "user",
      timestamp: 100,
      snippet: "needle durable",
      score: 1,
    };
    searchSessionTranscriptsMock.mockImplementation(
      (params: { limit?: number; sessionKeys?: string[] }) => {
        const candidates = [incognitoHit, durableHit].filter((hit) =>
          params.sessionKeys?.includes(hit.sessionKey),
        );
        return {
          hits: candidates.slice(0, params.limit),
          indexing: false,
          truncated: candidates.length > (params.limit ?? candidates.length),
        };
      },
    );
    listSessionEntriesMock.mockReturnValue([
      { sessionKey: incognitoKey, entry: { incognito: true } },
      { sessionKey: durableKey, entry: {} },
    ]);

    const respond = await callSearch(
      { query: "needle", limit: 1 },
      ["operator.read"],
      "viewer@example.com",
    );

    expect(searchSessionTranscriptsMock).toHaveBeenCalledWith({
      agentId: "main",
      query: "needle",
      limit: 1,
      sessionKeys: [durableKey],
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        results: [expect.objectContaining({ sessionKey: durableKey })],
      }),
    );
  });

  it("rejects filters spanning multiple agent stores", async () => {
    const respond = await callSearch({
      query: "needle",
      sessionKeys: ["agent:main:main", "agent:work:main"],
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("one agent per call"),
      }),
    );
    expect(searchSessionTranscriptsMock).not.toHaveBeenCalled();
  });

  it("uses agentId to disambiguate an unscoped store key", async () => {
    await callSearch({ agentId: "work", query: "needle", sessionKeys: ["main", "global"] });

    expect(searchSessionTranscriptsMock).toHaveBeenCalledWith({
      agentId: "work",
      query: "needle",
      limit: undefined,
      sessionKeys: ["agent:work:main", "global"],
    });
  });

  it("uses the configured default agent without a session filter", async () => {
    await callSearch({ query: "needle" });
    expect(searchSessionTranscriptsMock).toHaveBeenCalledWith({
      agentId: "main",
      query: "needle",
      limit: undefined,
    });
  });

  it("does not allow agentId to widen an unfiltered search", async () => {
    const respond = await callSearch({ agentId: "work", query: "needle" });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST", message: "agentId requires sessionKeys" }),
    );
    expect(searchSessionTranscriptsMock).not.toHaveBeenCalled();
  });

  it("searches only scoped keys in existing retired stores and deduplicates migrated hits", async () => {
    resolveExistingAgentSessionStoreTargetsSyncMock.mockReturnValue([
      { agentId: "retired", storePath: "/stores/retired-a/sessions.json" },
      { agentId: "retired", storePath: "/stores/retired-b/sessions.json" },
    ]);
    const duplicate = {
      sessionKey: "agent:retired:main",
      sessionId: "session-retired",
      messageId: "message-1",
      role: "user",
      timestamp: 20,
      snippet: "needle",
      score: 3,
    };
    searchSessionTranscriptsMock
      .mockReturnValueOnce({
        hits: [duplicate, { ...duplicate, messageId: "message-2", score: 1 }],
        indexing: false,
      })
      .mockReturnValueOnce({
        hits: [{ ...duplicate }, { ...duplicate, messageId: "message-3", score: 2 }],
        indexing: false,
      });

    const respond = await callSearch({
      agentId: "retired",
      query: "needle",
      sessionKeys: ["main"],
      limit: 3,
    });

    expect(searchSessionTranscriptsMock).toHaveBeenCalledTimes(2);
    expect(searchSessionTranscriptsMock).toHaveBeenNthCalledWith(1, {
      agentId: "retired",
      query: "needle",
      limit: 25,
      sessionKeys: ["agent:retired:main"],
      storePath: "/stores/retired-a/sessions.json",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        results: [
          expect.objectContaining({ messageId: "message-1" }),
          expect.objectContaining({ messageId: "message-3" }),
          expect.objectContaining({ messageId: "message-2" }),
        ],
      }),
    );
  });

  it("scopes omitted filters to the requested agent in a fixed store", async () => {
    cfg = {
      agents: { list: [{ id: "main", default: true }] },
      session: { store: "/stores/shared/sessions.json" },
    };
    resolveExistingAgentSessionStoreTargetsSyncMock.mockReturnValue([
      { agentId: "retired", storePath: "/stores/shared/sessions.json" },
    ]);
    listSessionEntriesMock.mockReturnValue([
      { sessionKey: "agent:retired:mine", entry: {} },
      { sessionKey: "agent:other:secret", entry: {} },
    ]);

    await callSearch({ agentId: "retired", query: "needle" });

    expect(searchSessionTranscriptsMock).toHaveBeenCalledWith({
      agentId: "retired",
      query: "needle",
      limit: 25,
      sessionKeys: ["agent:retired:mine"],
      storePath: "/stores/shared/sessions.json",
    });
  });
});
