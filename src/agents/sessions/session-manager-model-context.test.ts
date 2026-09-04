import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  appendTranscriptEvent,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";

it("acquires a long sparse context with bounded queries and preserved message order", async () => {
  await withOpenClawTestState({ label: "model-context-batch" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "batched-context",
      sessionKey: "agent:main:batched-context",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const messages = Array.from({ length: 1_200 }, (_, index) => ({
      type: "message",
      id: `message-${index}`,
      parentId: index === 0 ? null : `message-${index - 1}`,
      timestamp: new Date(index).toISOString(),
      message: {
        role: "user",
        content: `message ${index}`,
        timestamp: index,
        excludeFromContext: index % 17 === 0,
      },
    }));
    await replaceTranscriptEvents(scope, [
      { type: "session", version: CURRENT_SESSION_VERSION, id: scope.sessionId, cwd: "/synthetic" },
      ...messages,
    ]);
    const database = openOpenClawAgentDatabase({ agentId: "main", path: scope.storePath });
    const prototype = Object.getPrototypeOf(database.db.prepare("SELECT 1")) as StatementSync;
    const spy = vi.spyOn(prototype, "iterate");
    try {
      const context = SessionManager.openModelContext(scope).buildSessionContext();
      expect(context.messages.map((message) => "content" in message && message.content)).toEqual(
        messages
          .filter((entry) => !entry.message.excludeFromContext)
          .map((entry) => entry.message.content),
      );
      // Protect acquisition cost independently of the exact chunk size or query implementation.
      expect(spy.mock.calls.length).toBeLessThan(20);
      expect((await SessionManager.openModelContextAsync(scope)).buildSessionContext()).toEqual(
        context,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

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
      expect((await SessionManager.openModelContextAsync(scope)).buildSessionContext()).toEqual(
        SessionManager.openModelContext(scope).buildSessionContext(),
      );
      expect(SessionManager.readSessionContext(scope, (messages) => Array.from(messages))).toEqual(
        expected.messages,
      );
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
      expect(
        (
          await runWithSessionTranscriptReadFence(admission, () =>
            SessionManager.openModelContextAsync(scope),
          )
        ).buildSessionContext(),
      ).toEqual(earlier);
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
          await expect(
            SessionManager.openModelContextAsync(scope, {
              admission: { ...admission, ...patch } as typeof admission,
            }),
          ).rejects.toThrow(/Current-turn transcript admission/);
          expect(() =>
            SessionManager.readSessionContext(scope, () => [], {
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
    expect(
      (await SessionManager.openModelContextAsync(scope)).buildSessionContext().messages,
    ).toEqual([]);
    expect(SessionManager.readSessionContext(scope, (messages) => Array.from(messages))).toEqual(
      [],
    );
    expect(fs.existsSync(scope.storePath)).toBe(false);
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      ...(incognito ? { incognito: true } : {}),
    });
    const source = SessionManager.open(scope);
    source.appendMessage({ role: "user", content: "visible", timestamp: 1 });
    const view = SessionManager.openModelContext(scope);
    expect((await SessionManager.openModelContextAsync(scope)).buildSessionContext()).toEqual(
      view.buildSessionContext(),
    );
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

it.each([false, true])(
  "releases aborted context reads before the next read (incognito=%s)",
  async (incognito) => {
    await withOpenClawTestState({ label: "context-worker-lifecycle" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "worker-lifecycle",
        sessionKey: incognito
          ? "agent:main:dashboard:incognito-worker-lifecycle"
          : "agent:main:worker-lifecycle",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = SessionManager.open(scope);
      source.appendMessage({ role: "user", content: "visible", timestamp: 1 });
      expect((await SessionManager.openModelContextAsync(scope)).buildSessionContext()).toEqual(
        source.buildSessionContext(),
      );
      for (const alreadyAborted of [true, false]) {
        const controller = new AbortController();
        const reason = new Error("cancel context read");
        if (alreadyAborted) {
          controller.abort(reason);
        }
        const pending = SessionManager.openModelContextAsync(scope, { signal: controller.signal });
        if (!alreadyAborted) {
          controller.abort(reason);
        }
        await expect(pending).rejects.toBe(reason);
      }
      expect((await SessionManager.openModelContextAsync(scope)).buildSessionContext()).toEqual(
        source.buildSessionContext(),
      );
    });
  },
);

it.each(
  [false, true].flatMap((incognito) =>
    (["rewrite", "append"] as const).map((mutation) => ({ incognito, mutation })),
  ),
)(
  "validates admission before accepting context (incognito=$incognito mutation=$mutation)",
  async ({ incognito, mutation }) => {
    await withOpenClawTestState({ label: "context-worker-fence" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: incognito ? "incognito-worker-fence" : "worker-fence",
        sessionKey: incognito
          ? "agent:main:dashboard:incognito-worker-fence"
          : "agent:main:worker-fence",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = SessionManager.open(scope);
      source.appendMessage({ role: "user", content: "previous", timestamp: 1 });
      await waitForSessionTranscriptProjection(scope);
      const admitted = source.appendMessageWithTranscriptAnchor({
        role: "user",
        content: "current",
        timestamp: 2,
      });
      if (!admitted.anchor) {
        throw new Error("missing admission");
      }
      const admission = {
        ...admitted.anchor,
        role: "user" as const,
        logicalTurnId: "worker-fence",
      };
      const expected = SessionManager.openModelContext(scope, { admission }).buildSessionContext();
      const mutate = () => {
        if (mutation === "rewrite") {
          expect(
            source.removeTrailingEntries(
              (entry) =>
                entry.type === "message" &&
                entry.message.role === "user" &&
                entry.message.content === "current",
            ),
          ).toBe(1);
        }
        source.appendMessage({ role: "user", content: "replacement", timestamp: 3 });
      };
      const spy = incognito
        ? undefined
        : vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementationOnce(async function (
            this: WorkerTaskPool<unknown, unknown>,
            ...args
          ) {
            spy!.mockRestore();
            const result = await this.run(...args);
            mutate();
            return result;
          });
      try {
        const pending = SessionManager.openModelContextAsync(scope, { admission });
        if (incognito) {
          mutate();
        }
        if (mutation === "rewrite") {
          await expect(pending).rejects.toThrow("Current-turn transcript admission");
        } else {
          expect((await pending).buildSessionContext()).toEqual(expected);
        }
      } finally {
        spy?.mockRestore();
      }
    });
  },
);

it.each(
  [false, true].flatMap((incognito) =>
    (["append", "rewrite", "other-session"] as const).map((mutation) => ({ incognito, mutation })),
  ),
)(
  "validates unadmitted context before acceptance (incognito=$incognito mutation=$mutation)",
  async ({ incognito, mutation }) => {
    await withOpenClawTestState({ label: "unadmitted-context-fence" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "unadmitted-context",
        sessionKey: incognito
          ? "agent:main:dashboard:incognito-unadmitted-context"
          : "agent:main:unadmitted-context",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = SessionManager.open(scope);
      source.appendMessage({ role: "user", content: "before", timestamp: 1 });
      const expected = source.buildSessionContext();
      let mutationSource = source;
      if (mutation === "other-session") {
        const otherScope = {
          ...scope,
          sessionId: "other-context",
          sessionKey: `${scope.sessionKey}-other`,
        };
        await upsertSessionEntryCore(otherScope, {
          sessionId: otherScope.sessionId,
          updatedAt: 1,
        });
        mutationSource = SessionManager.open(otherScope);
      }
      const mutate = () => {
        if (mutation === "rewrite") {
          expect(
            source.removeTrailingEntries(
              (entry) =>
                entry.type === "message" &&
                entry.message.role === "user" &&
                entry.message.content === "before",
            ),
          ).toBe(1);
        }
        mutationSource.appendMessage({ role: "user", content: "after", timestamp: 2 });
      };
      const spy = incognito
        ? undefined
        : vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementationOnce(async function (
            this: WorkerTaskPool<unknown, unknown>,
            ...args
          ) {
            spy!.mockRestore();
            const result = await this.run(...args);
            mutate();
            return result;
          });
      try {
        const pending = SessionManager.openModelContextAsync(scope);
        if (incognito) {
          mutate();
        }
        if (mutation === "other-session") {
          expect((await pending).buildSessionContext()).toEqual(expected);
        } else {
          await expect(pending).rejects.toThrow("Session transcript changed during context read");
        }
      } finally {
        spy?.mockRestore();
      }
    });
  },
);

it.each([false, true])(
  "closes lazy context without acquiring unread payloads (rejected=%s)",
  async (rejected) => {
    await withOpenClawTestState({ label: "context-reader-lifetime" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "lazy-context",
        sessionKey: "agent:main:lazy-context",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = SessionManager.open(scope);
      source.appendMessage({ role: "user", content: "first", timestamp: 1 });
      const marker = "synthetic-unread-context:";
      source.appendMessage({
        role: "user",
        content: marker + "x".repeat(256 * 1024),
        timestamp: 2,
      });
      let retained: Iterator<unknown> | undefined;
      let unreadPayloads = 0;
      const parse = JSON.parse;
      const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        if (typeof text === "string" && text.includes(marker)) {
          unreadPayloads += 1;
        }
        return parse(text, reviver);
      });
      try {
        const read = () =>
          SessionManager.readSessionContext(scope, (messages) => {
            retained = messages[Symbol.iterator]();
            expect(retained.next().value).toMatchObject({ role: "user", content: "first" });
            if (rejected) {
              throw new Error("synthetic projection rejection");
            }
          });
        if (rejected) {
          expect(read).toThrow("synthetic projection rejection");
        } else {
          read();
        }
        expect(retained?.next()).toEqual({ done: true, value: undefined });
        expect(unreadPayloads).toBe(0);
      } finally {
        spy.mockRestore();
      }
      expect(SessionManager.readSessionContext(scope, (messages) => Array.from(messages))).toEqual(
        source.buildSessionContext().messages,
      );
    });
  },
);

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
