import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  appendTranscriptEvent,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { SessionManager } from "./session-manager.js";

it.each(["whole", "reset", "compaction", "reset-compaction", "leaf", "opaque"])(
  "acquires detached %s context without native payloads or changing stored evidence",
  async (scenario) => {
    await withOpenClawTestState({ label: "model-context" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "model-view",
        sessionKey: "agent:main:model-view",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = SessionManager.open(scope);
      const marker = "synthetic-native-memory:";
      const metadata = {
        upstreamUserText: marker + "x".repeat(256 * 1024),
        mirrorIdentity: "synthetic-identity",
        mirrorOrigin: "synthetic-origin",
        turnTainted: true,
        sender: { id: "synthetic-sender" },
        media: { type: "synthetic" },
      };
      source.appendThinkingLevelChange("high");
      source.appendModelChange("openai", "gpt-5.6-luna");
      const old = source.appendMessage({
        role: "user",
        content: "old",
        timestamp: 1,
        __openclaw: metadata,
      } as Parameters<SessionManager["appendMessage"]>[0]);
      const excluded = source.appendMessage({
        role: "custom",
        customType: "display",
        content: marker + "d".repeat(256 * 1024),
        display: true,
        excludeFromContext: true,
        timestamp: 1,
      });
      const kept = source.appendMessage({
        role: "user",
        content: "kept",
        timestamp: 2,
        __openclaw: metadata,
      } as Parameters<SessionManager["appendMessage"]>[0]);
      source.appendMessage(
        makeAgentAssistantMessage({
          model: "gpt-5.6-luna",
          providerReplay: {
            v: 1,
            type: "openai-responses-compaction",
            data: "synthetic-checkpoint",
            provider: "openai",
            api: "openai-responses",
            model: "gpt-5.6-luna",
            baseUrlHash: "synthetic",
          },
          content: [
            {
              type: "toolCall",
              id: "paired",
              name: "read",
              arguments: { nested: { path: "synthetic.txt" } },
            },
          ],
          stopReason: "toolUse",
        }),
      );
      const result = source.appendMessage({
        role: "toolResult",
        toolName: "read",
        toolCallId: "paired",
        isError: false,
        timestamp: 3,
        content: [{ type: "text", text: "tool output" }],
      });
      source.appendCustomMessageEntry("synthetic-context", "custom context", true, {
        source: "synthetic",
      });
      source.branchWithSummary(source.getLeafId(), "branch summary");
      if (scenario === "reset" || scenario === "reset-compaction") {
        source.appendResetBoundary("new", kept);
      }
      if (scenario === "compaction" || scenario === "reset-compaction") {
        source.appendCompaction("summary", scenario === "compaction" ? excluded : kept, 100);
      }
      if (scenario === "leaf") {
        source.branch(old);
        const inactive = source.appendMessage({
          role: "user",
          content: marker + "abandoned".repeat(4096),
          timestamp: 4,
        });
        source.appendLeafControl({
          targetId: result,
          appendParentId: inactive,
          appendMode: "side",
        });
      }
      if (scenario === "opaque") {
        await appendTranscriptEvent(scope, {
          type: "opaque-synthetic",
          id: "opaque",
          parentId: result,
          data: marker + "o".repeat(256 * 1024),
        });
        source.reloadPersistedTranscript();
      }
      source.appendMessage({ role: "user", content: "latest", timestamp: 5 });
      const expected = source.buildSessionContext();
      const visible = (messages: typeof expected.messages) =>
        messages.map((message) => ({
          role: message.role,
          content: "content" in message ? message.content : undefined,
          summary: "summary" in message ? message.summary : undefined,
        }));
      const database = openOpenClawAgentDatabase({ agentId: scope.agentId, path: scope.storePath });
      const fingerprint = () => {
        const hash = createHash("sha256");
        for (const row of database.db
          .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
          .iterate(scope.sessionId)) {
          hash.update(String(row.event_json));
        }
        return hash.digest("hex");
      };
      const before = fingerprint();
      const originalParse = JSON.parse;
      let privateBytes = 0;
      const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        if (typeof text === "string" && text.includes(marker)) {
          privateBytes += text.length;
        }
        return originalParse(text, reviver);
      });
      let detached: SessionManager;
      try {
        detached = SessionManager.openModelContext(scope);
      } finally {
        parseSpy.mockRestore();
      }
      expect(privateBytes).toBe(0);
      expect(detached.isPersisted()).toBe(false);
      expect(detached.getHeader()?.id).toBe(scope.sessionId);
      expect(detached.migrated).toBe(false);
      expect(detached.getBoundaryCount()).toBe(source.getBoundaryCount());
      const context = detached.buildSessionContext();
      expect(visible(context.messages)).toEqual(visible(expected.messages));
      expect(context.model).toEqual(expected.model);
      expect(
        context.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.providerReplay),
      ).toEqual(
        expected.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.providerReplay),
      );
      expect(context.thinkingLevel).toBe("high");
      const retainedUser = context.messages.find(
        (message) => message.role === "user" && message.content === "kept",
      );
      expect(retainedUser).toMatchObject({
        __openclaw: {
          mirrorIdentity: "synthetic-identity",
          mirrorOrigin: "synthetic-origin",
          turnTainted: true,
          sender: metadata.sender,
          media: metadata.media,
        },
      });
      expect(
        Object.hasOwn(
          (retainedUser as unknown as { __openclaw: object })["__openclaw"],
          "upstreamUserText",
        ),
      ).toBe(false);
      if (scenario === "reset") {
        expect(
          (retainedUser as unknown as Record<symbol, unknown>)[
            Symbol.for("openclaw.sessionHistoryPrelude")
          ],
        ).toBe(true);
      }
      detached.appendMessage({ role: "user", content: "review only", timestamp: 6 });
      expect(fingerprint()).toBe(before);
      source.branch(source.getLeafId()!);
      await waitForSessionTranscriptProjection(scope);
      const admitted = source.appendMessageWithTranscriptAnchor({
        role: "user",
        content: "current turn",
        timestamp: 7,
      });
      if (!admitted.anchor) {
        throw new Error("missing admission");
      }
      const admission = {
        ...admitted.anchor,
        role: "user" as const,
        logicalTurnId: "synthetic-turn",
      };
      const earlier = runWithSessionTranscriptReadFence(admission, () =>
        SessionManager.openModelContext(scope).buildSessionContext(),
      );
      if (scenario === "whole") {
        for (const patch of [
          { generation: "wrong-generation" },
          { rawSeq: admission.rawSeq + 1 },
          { effectiveParentId: "wrong-parent" },
          { activeMessagePosition: admission.activeMessagePosition + 1 },
          { role: "assistant" },
          { sessionKey: "agent:main:wrong" },
          { storePath: path.join(state.agentDir("main"), "wrong.sqlite") },
        ]) {
          expect(() =>
            SessionManager.openModelContext(scope, {
              admission: { ...admission, ...patch } as typeof admission,
            }),
          ).toThrow(/Current-turn transcript admission/);
        }
      }
      source.appendResetBoundary("new");
      source.appendCompaction("later summary", admitted.entryId, 100);
      expect(
        runWithSessionTranscriptReadFence(admission, () =>
          SessionManager.openModelContext(scope).buildSessionContext(),
        ),
      ).toEqual(earlier);
    });
  },
);

it.each(
  ["reset", "compaction", "whole"].flatMap((boundary) =>
    (["user", "assistant", "toolResult"] as const).map((role) => ({ boundary, role })),
  ),
)("preserves excluded $role payload selection across $boundary", async ({ boundary, role }) => {
  await withOpenClawTestState({ label: "model-excluded-retention" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "excluded-retention",
      sessionKey: "agent:main:excluded-retention",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const source = SessionManager.open(scope);
    const pairedCall =
      role === "toolResult"
        ? source.appendMessage(
            makeAgentAssistantMessage({
              content: [{ type: "toolCall", id: "paired", name: "read", arguments: {} }],
            }),
          )
        : undefined;
    const content = [{ type: "text" as const, text: "synthetic retained text" }];
    const message = {
      ...(role === "assistant"
        ? makeAgentAssistantMessage({ content })
        : role === "user"
          ? { role, content: "synthetic retained text", timestamp: 1 }
          : {
              role,
              content,
              toolCallId: "paired",
              toolName: "read",
              isError: false,
              timestamp: 1,
            }),
      excludeFromContext: true,
      __openclaw: { upstreamUserText: "private-retained:" + "x".repeat(256 * 1024) },
    };
    const retained = source.appendMessage(message);
    if (boundary === "reset") {
      source.appendResetBoundary("new", pairedCall ?? retained);
    } else if (boundary === "compaction") {
      source.appendCompaction("summary", pairedCall ?? retained, 100);
    }
    const ordinaryExcluded = {
      role: "user" as const,
      content: "ordinary-excluded:" + "x".repeat(256 * 1024),
      timestamp: 2,
      excludeFromContext: true,
    };
    source.appendMessage(ordinaryExcluded);
    source.appendMessage({ role: "user", content: "synthetic current text", timestamp: 3 });
    const expected = source.buildSessionContext();
    expect(
      expected.messages.some(
        (entry) => "excludeFromContext" in entry && entry.excludeFromContext === true,
      ),
    ).toBe(boundary === "reset");
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, path: scope.storePath });
    const fingerprint = () => {
      const hash = createHash("sha256");
      for (const row of database.db
        .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .iterate(scope.sessionId)) {
        hash.update(String(row.event_json));
      }
      return hash.digest("hex");
    };
    const before = fingerprint();
    const originalParse = JSON.parse;
    let excludedBytes = 0;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (
        typeof text === "string" &&
        (text.includes("private-retained:") || text.includes("ordinary-excluded:"))
      ) {
        excludedBytes += text.length;
      }
      return originalParse(text, reviver);
    });
    let actual: typeof expected;
    try {
      actual = SessionManager.openModelContext(scope).buildSessionContext();
    } finally {
      spy.mockRestore();
    }
    expect(excludedBytes).toBe(0);
    expect(fingerprint()).toBe(before);
    expect(actual.model).toEqual(expected.model);
    expect(
      actual.messages.map((entry) => ("content" in entry ? entry.content : undefined)),
    ).toEqual(expected.messages.map((entry) => ("content" in entry ? entry.content : undefined)));
  });
});

it.each([false, true])("keeps model reads non-persisting (incognito=%s)", async (incognito) => {
  await withOpenClawTestState({ label: "model-readonly" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "readonly",
      sessionKey: incognito ? "agent:main:dashboard:incognito-readonly" : "agent:main:readonly",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    expect(SessionManager.openModelContext(scope).buildSessionContext().messages).toEqual([]);
    expect(fs.existsSync(scope.storePath)).toBe(false);
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      ...(incognito ? { incognito: true } : {}),
    });
    const source = SessionManager.open(scope);
    source.appendMessage({ role: "user", content: "visible", timestamp: 1 });
    const view = SessionManager.openModelContext(scope);
    expect(view.buildSessionContext()).toEqual(source.buildSessionContext());
    expect(view.isPersisted()).toBe(false);
    if (incognito) {
      expect(fs.existsSync(scope.storePath)).toBe(false);
    } else {
      const database = openOpenClawAgentDatabase({ agentId: "main", path: scope.storePath });
      // A transient reader reconstructs navigation from its own read snapshot, not a stale cache.
      database.db
        .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
        .run(scope.sessionId);
      expect(SessionManager.openModelContext(scope).buildSessionContext()).toEqual(
        source.buildSessionContext(),
      );
      database.db
        .prepare("DELETE FROM session_transcript_index_state WHERE session_id = ?")
        .run(scope.sessionId);
      expect(SessionManager.openModelContext(scope).buildSessionContext()).toEqual(
        source.buildSessionContext(),
      );
      expect(
        database.db
          .prepare("SELECT COUNT(*) AS n FROM session_transcript_index_state WHERE session_id = ?")
          .get(scope.sessionId)?.n,
      ).toBe(0);
      const parse = JSON.parse;
      const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        if (typeof text === "string" && text.includes('"role":"user"')) {
          throw new Error("synthetic decode failure");
        }
        return parse(text, reviver);
      });
      try {
        expect(() => SessionManager.openModelContext(scope)).toThrow("synthetic decode failure");
      } finally {
        parseSpy.mockRestore();
      }
      expect(database.db.isTransaction).toBe(false);
      expect(SessionManager.openModelContext(scope).buildSessionContext()).toEqual(
        source.buildSessionContext(),
      );
    }
  });
});

it("keeps the real result when reset retention replaces a synthetic missing result", async () => {
  await withOpenClawTestState({ label: "model-pairing" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "pairing",
      sessionKey: "agent:main:pairing",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const source = SessionManager.open(scope);
    const firstKept = source.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "repeat", name: "read", arguments: {} }],
      }),
    );
    source.appendMessage({
      role: "toolResult",
      toolCallId: "repeat",
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "missing" }],
      details: { openclawSyntheticMissingToolResult: true },
      timestamp: 1,
    });
    source.appendMessage({
      role: "toolResult",
      toolCallId: "repeat",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "real output" }],
      timestamp: 2,
    });
    source.appendMessage({
      role: "toolResult",
      toolCallId: "orphan",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "orphan-body:" + "x".repeat(512 * 1024) }],
      timestamp: 3,
    });
    source.appendResetBoundary("new", firstKept);
    const originalParse = JSON.parse;
    let orphanBytes = 0;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (typeof text === "string" && text.includes("orphan-body:")) {
        orphanBytes += text.length;
      }
      return originalParse(text, reviver);
    });
    let messages: ReturnType<SessionManager["buildSessionContext"]>["messages"];
    try {
      messages = SessionManager.openModelContext(scope).buildSessionContext().messages;
    } finally {
      spy.mockRestore();
    }
    expect(orphanBytes).toBe(0);
    expect(
      messages.filter((message) => message.role === "toolResult").map((message) => message.content),
    ).toEqual([[{ type: "text", text: "real output" }]]);
  });
});

it.each(["reset", "compaction"])(
  "does not acquire checkpoints invalidated by %s",
  async (boundary) => {
    await withOpenClawTestState({ label: "model-checkpoint" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "checkpoint",
        sessionKey: "agent:main:checkpoint",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = SessionManager.open(scope);
      const kept = source.appendMessage({ role: "user", content: "visible", timestamp: 1 });
      const marker = "synthetic-obsolete-checkpoint-";
      const checkpoint = {
        v: 1 as const,
        type: "openai-responses-compaction",
        data: marker + "x".repeat(1024 * 1024),
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.6-luna",
        baseUrlHash: "synthetic",
      };
      source.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "kept answer" }],
          model: "gpt-5.6-luna",
          providerReplay: checkpoint,
        }),
      );
      if (boundary === "reset") {
        source.appendResetBoundary("new", kept);
      } else {
        source.appendCompaction("summary", kept, 100);
      }
      const valid = { ...checkpoint, data: "valid-post-boundary-checkpoint" };
      source.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "new answer" }],
          model: "gpt-5.6-luna",
          providerReplay: valid,
        }),
      );
      const parse = JSON.parse;
      let obsoleteBytes = 0;
      const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        if (typeof text === "string" && text.includes(marker)) {
          obsoleteBytes += text.length;
        }
        return parse(text, reviver);
      });
      let context: ReturnType<SessionManager["buildSessionContext"]>;
      try {
        context = SessionManager.openModelContext(scope).buildSessionContext();
      } finally {
        spy.mockRestore();
      }
      expect(obsoleteBytes).toBe(0);
      expect(context).toEqual(source.buildSessionContext());
      expect(context.messages.at(-1)).toMatchObject({ providerReplay: valid });
    });
  },
);
