/** Gateway session-search validation and agent-scoping tests. */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const searchSessionTranscriptsMock = vi.fn();

vi.mock("../../config/sessions/session-transcript-search.js", () => ({
  searchSessionTranscripts: (...args: unknown[]) => searchSessionTranscriptsMock(...args),
}));

import { sessionsHandlers } from "./sessions.js";

const cfg = {
  agents: { list: [{ id: "main", default: true }, { id: "work" }] },
};

async function callSearch(params: Record<string, unknown>): Promise<ReturnType<typeof vi.fn>> {
  const respond = vi.fn();
  await expectDefined(
    sessionsHandlers["sessions.search"],
    'sessionsHandlers["sessions.search"] test invariant',
  )({
    req: { id: "req-search" } as never,
    params,
    respond: respond as unknown as RespondFn,
    context: { getRuntimeConfig: () => cfg } as unknown as GatewayRequestContext,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("sessions.search gateway method", () => {
  beforeEach(() => {
    searchSessionTranscriptsMock.mockReset();
    searchSessionTranscriptsMock.mockReturnValue({ hits: [], indexing: false });
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
});
