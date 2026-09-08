import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as serverConstants from "../../gateway/server-constants.js";
import { readChatHistoryMessageId } from "../../gateway/session-history-tail.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createEmbeddedCallGateway } from "./embedded-gateway-stub.js";
import { createSessionsHistoryTool } from "./sessions-history-tool.js";
import { createSessionsSearchTool } from "./sessions-search-tool.js";

const config: OpenClawConfig = {
  agents: { entries: { main: { default: true }, work: {} } },
  tools: { sessions: { visibility: "agent" } },
};
const scope = {
  agentId: "work",
  sessionKey: "agent:work:recall",
  sessionId: "recall-session",
};
const selector = { sessionKey: scope.sessionKey, sessionId: scope.sessionId, messageId: "old" };
const callGateway = createEmbeddedCallGateway();

function toolsFor(cfg = config, sandboxed = false) {
  const opts = {
    config: cfg,
    agentId: scope.agentId,
    requesterAgentIdOverride: scope.agentId,
    agentSessionKey: "agent:work:main",
    sandboxed,
    callGateway,
  };
  return { search: createSessionsSearchTool(opts), history: createSessionsHistoryTool(opts) };
}

async function history(params: Record<string, unknown>) {
  const result = await toolsFor().history.execute("recall", params);
  return result.details as { messages: unknown[] };
}

describe("embedded session history anchors", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;

  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "embedded-anchor-test-" });
    setRuntimeConfigSnapshot(config);
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
    for (const [index, id] of ["old", "middle", "newest"].entries()) {
      await appendTranscriptMessage(scope, {
        eventId: id,
        message: {
          role: index === 0 ? "user" : "assistant",
          content: `${id === "old" ? "quasar question" : id} ${"x".repeat(700)}`,
          timestamp: 1_700_000_000_000 + index,
        },
      });
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await state.cleanup();
  });

  it.each([false, true])(
    "recalls an old search hit outside the newest tail (physical selector: %s)",
    async (includeSessionId) => {
      const result = await toolsFor().search.execute("find", { query: "quasar" });
      const hits = (result.details as { results: (typeof selector)[] }).results;
      expect(hits).toHaveLength(1);
      const hit = expectDefined(hits[0], "search hit");
      expect(hit).toMatchObject(selector);
      expect(
        (await history({ sessionKey: hit.sessionKey, limit: 1 })).messages.map(
          readChatHistoryMessageId,
        ),
      ).toEqual(["newest"]);
      const recalled = await history({
        sessionKey: hit.sessionKey,
        messageId: hit.messageId,
        ...(includeSessionId ? { sessionId: hit.sessionId } : {}),
        limit: 1,
      });
      expect(recalled.messages.map(readChatHistoryMessageId)).toEqual(["old"]);
      expect(recalled).not.toHaveProperty("nextOffset");
    },
  );

  it("returns no history for a missing anchor", async () => {
    expect(await history({ ...selector, messageId: "missing", limit: 1 })).toMatchObject({
      messages: [],
    });
  });

  it("reopens a search hit after a reset of the same physical session", async () => {
    await appendTranscriptMessage(scope, {
      eventId: "old-tool",
      message: { role: "toolResult", content: "synthetic scan result" },
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset",
      parentId: "old-tool",
      timestamp: "2026-09-07T16:00:00.000Z",
      reason: "new",
    });
    await appendTranscriptMessage(scope, {
      eventId: "fresh",
      message: { role: "user", content: "fresh after reset", timestamp: 1_700_000_000_400 },
    });

    const current = await history({ sessionKey: scope.sessionKey, limit: 10 });
    expect(current.messages.map(readChatHistoryMessageId)).toEqual(["reset", "fresh"]);
    const search = await toolsFor().search.execute("find", { query: "quasar" });
    expect((search.details as { results: Array<{ messageId?: string }> }).results).toEqual([
      expect.objectContaining(selector),
    ]);
    const recalled = await history({
      ...selector,
      includeTools: true,
      limit: 10,
    });
    expect(recalled.messages.map(readChatHistoryMessageId)).toEqual([
      "old",
      "middle",
      "newest",
      "old-tool",
      "reset",
    ]);
    expect(recalled.messages.map(readChatHistoryMessageId)).not.toContain("fresh");
  });

  it.each(["missing", "wrong-key", "wrong-agent"])(
    "rejects a %s physical session binding instead of returning the tail",
    async (binding) => {
      if (binding !== "missing") {
        const other = {
          agentId: binding === "wrong-agent" ? "main" : "work",
          sessionKey: binding === "wrong-agent" ? "agent:main:recall" : "agent:work:other",
          sessionId: binding,
        };
        replaceSessionEntrySync(other, { sessionId: binding, updatedAt: Date.now() });
        await appendTranscriptMessage(other, {
          eventId: "old",
          message: { role: "user", content: "other session" },
        });
      }
      await expect(history({ ...selector, sessionId: binding, limit: 1 })).rejects.toThrow(
        "sessionId does not belong to sessionKey",
      );
    },
  );

  it("reopens an archived physical session without the replacement's start boundary", async () => {
    const archived = { ...scope, sessionId: "archived-session" };
    await appendTranscriptMessage(archived, {
      eventId: "announcement",
      message: {
        role: "user",
        provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
        content: "archived announcement",
        timestamp: 1_600_000_000_000,
      },
    });
    await appendTranscriptMessage(archived, {
      eventId: "archived-answer",
      message: { role: "assistant", content: "archived answer", timestamp: 1_600_000_000_001 },
    });
    replaceSessionEntrySync(scope, {
      sessionId: scope.sessionId,
      updatedAt: Date.now(),
      sessionStartedAt: 1_700_000_000_000,
    });
    const result = await history({
      ...selector,
      sessionId: archived.sessionId,
      messageId: "archived-answer",
      limit: 1,
    });
    expect(result.messages.map(readChatHistoryMessageId)).toEqual(["archived-answer"]);
  });

  it("preserves the anchor when the embedded transport byte cap drops neighbors", async () => {
    vi.spyOn(serverConstants, "getMaxChatHistoryMessagesBytes").mockReturnValue(1_200);
    const result = await callGateway<{ messages: unknown[] }>({
      method: "chat.history",
      params: { ...selector, limit: 3 },
    });
    expect(result.messages.map(readChatHistoryMessageId)).toEqual(["old"]);
    expect(Buffer.byteLength(JSON.stringify(result.messages))).toBeLessThanOrEqual(1_200);
  });

  it.each(["self", "sandbox", "cross-agent"])(
    "keeps %s access restrictions intact",
    async (restriction) => {
      const cfg: OpenClawConfig = {
        ...config,
        tools: {
          sessions: {
            visibility:
              restriction === "self" ? "self" : restriction === "sandbox" ? "all" : "agent",
          },
        },
      };
      const tools = toolsFor(cfg, restriction === "sandbox");
      const target =
        restriction === "cross-agent" ? { ...selector, sessionKey: "agent:main:other" } : selector;
      expect((await tools.history.execute("denied", target)).details).toMatchObject({
        status: "forbidden",
      });
      expect(
        (await tools.search.execute("hidden", { query: "quasar", sessionKey: target.sessionKey }))
          .details,
      ).toMatchObject({ status: "forbidden" });
    },
  );

  it.each([
    { offset: 0, messageId: "old", error: "offset and messageId cannot be used together" },
    { sessionId: scope.sessionId, error: "sessionId requires messageId" },
  ])("rejects incompatible history selectors: $error", async ({ error, ...params }) => {
    await expect(
      callGateway({ method: "chat.history", params: { sessionKey: scope.sessionKey, ...params } }),
    ).rejects.toThrow(error);
  });
});
