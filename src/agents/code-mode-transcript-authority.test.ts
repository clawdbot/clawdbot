import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  appendTranscriptMessageSync,
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  bindCodeModeTranscriptAuthority,
  CodeModeTranscriptAuthority,
  resolveCodeModeTranscriptAuthority,
} from "./code-mode-transcript-authority.js";
import { resetCodeModeTestState, testing } from "./code-mode.test-support.js";
import type { AgentMessage } from "./runtime/index.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { SessionManager } from "./sessions/session-manager.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  resetCodeModeTestState();
});

function target(state: OpenClawTestState) {
  const scope = {
    agentId: "main",
    env: state.env,
    expectedWriterRunId: "writer",
    sessionId: "authority-session",
    sessionKey: "agent:main:authority",
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  replaceSessionEntrySync(scope, {
    activeWriterRunId: scope.expectedWriterRunId,
    sessionId: scope.sessionId,
    updatedAt: 1,
  });
  return scope;
}

const prefix = {
  entries: [
    {
      eventId: "provider-event",
      identity: "provider:event",
      message: { role: "user" as const, content: "source" },
    },
  ],
};

function appendUnkeyedBase(scope: ReturnType<typeof target>) {
  const result = appendTranscriptMessageSync(scope, {
    eventId: "base-event",
    message: { role: "user" as const, content: "base" },
  });
  if (!result.ok || !result.value?.anchor) {
    throw new Error("failed to append transcript test base");
  }
  return result.value.anchor;
}

function readRawTranscriptState(scope: ReturnType<typeof target>) {
  const database = openOpenClawAgentDatabase(
    toDatabaseOptions(resolveSqliteTranscriptScope(scope)),
  );
  return {
    database,
    identities: database.db
      .prepare(
        `SELECT event_id, parent_id, message_idempotency_key, seq
         FROM transcript_event_identities
         WHERE session_id = ?
         ORDER BY seq`,
      )
      .all(scope.sessionId),
    rows: database.db
      .prepare(
        `SELECT event_json, seq
         FROM transcript_events
         WHERE session_id = ?
         ORDER BY seq`,
      )
      .all(scope.sessionId),
  };
}

function commitWaitingClaim(
  authority: CodeModeTranscriptAuthority,
  params: {
    assistantTurnId?: string;
    runId: string;
    toolCallId: string;
    toolName: string;
  },
): void {
  authority.captureWaiting(params);
  const reservation = authority.reserve({
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    content: [{ type: "text", text: "waiting" }],
    isError: false,
  });
  if (!reservation) {
    throw new Error("waiting claim was not reserved");
  }
  reservation.commit();
}

it("commits a rewritten source once and replays it without rerunning the hook", async () => {
  await withOpenClawTestState({ label: "authority-replay" }, async (state) => {
    const authority = new CodeModeTranscriptAuthority(target(state));
    const prepare = vi.fn(() => ({ role: "user" as const, content: "rewritten" }));
    await expect(authority.commitPrefix(prefix, prepare)).resolves.toMatchObject({
      kind: "committed",
    });
    expect(prepare).toHaveBeenCalledOnce();
    const replayPrepare = vi.fn(() => ({ role: "user" as const, content: "wrong" }));
    const replay = await authority.commitPrefix(prefix, replayPrepare);
    expect(replay).toMatchObject({ kind: "replayed" });
    expect(replayPrepare).not.toHaveBeenCalled();
    expect(replay.results).toHaveLength(1);
    expect(replay.results[0]?.identity).toBe("provider:event");
    expect(replay.results[0]?.message).toMatchObject({
      content: "rewritten",
      idempotencyKey: "provider:event",
      __openclaw: { providerSourceFingerprint: expect.stringMatching(/^[a-f0-9]{32}$/u) },
    });
    const emptyPrepare = vi.fn();
    await expect(authority.commitPrefix({ entries: [] }, emptyPrepare)).resolves.toMatchObject({
      kind: "replayed",
      results: [],
    });
    expect(emptyPrepare).not.toHaveBeenCalled();
  });
});

it("replays from raw topology after a cold reopen without repairing a dirty projection", async () => {
  await withOpenClawTestState({ label: "authority-dirty-replay" }, async (state) => {
    const scope = target(state);
    const authority = new CodeModeTranscriptAuthority(scope);
    await expect(
      authority.commitPrefix(prefix, () => ({ role: "user", content: "rewritten" })),
    ).resolves.toMatchObject({ kind: "committed" });
    const before = readRawTranscriptState(scope);
    before.database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);
    const rows = before.rows;
    const identities = before.identities;
    closeOpenClawAgentDatabasesForTest();

    const prepare = vi.fn(() => ({ role: "user" as const, content: "wrong" }));
    await expect(
      new CodeModeTranscriptAuthority(scope).commitPrefix(prefix, prepare),
    ).resolves.toMatchObject({
      kind: "replayed",
    });
    expect(prepare).not.toHaveBeenCalled();

    const after = readRawTranscriptState(scope);
    expect(after.rows).toEqual(rows);
    expect(after.identities).toEqual(identities);
    expect(
      after.database.db
        .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
        .get(scope.sessionId),
    ).toEqual({ needs_rebuild: 1 });
  });
});

it("rejects a malformed SQLite message instead of replaying it", async () => {
  await withOpenClawTestState({ label: "authority-malformed-replay" }, async (state) => {
    const scope = target(state);
    const proof = "0".repeat(32);
    appendTranscriptMessageSync(scope, {
      eventId: "malformed-event",
      message: {
        role: "user",
        idempotencyKey: "provider:malformed",
        __openclaw: { providerSourceFingerprint: proof },
      } as never,
    });
    const authority = new CodeModeTranscriptAuthority(scope);
    await expect(
      authority.commitPrefix(
        {
          entries: [
            {
              eventId: "malformed-event",
              identity: "provider:malformed",
              message: { role: "user", content: "source" },
              sourceFingerprint: proof,
            },
          ],
        },
        vi.fn(),
      ),
    ).resolves.toEqual({ kind: "conflict", reason: "prefix-mismatch" });
  });
});

it("validates every unkeyed base anchor field for empty commits", async () => {
  await withOpenClawTestState({ label: "authority-base-anchor" }, async (state) => {
    const scope = target(state);
    const authority = new CodeModeTranscriptAuthority(scope);
    const baseAnchor = appendUnkeyedBase(scope);
    expect(baseAnchor.idempotencyKey).toBeUndefined();
    await expect(
      authority.commitPrefix({ baseAnchor, entries: [] }, vi.fn()),
    ).resolves.toMatchObject({ kind: "replayed", results: [] });
    await expect(
      authority.commitPrefix(
        { baseAnchor: { ...baseAnchor, generation: "stale-generation" }, entries: [] },
        vi.fn(),
      ),
    ).resolves.toEqual({ kind: "conflict", reason: "base-anchor-mismatch" });
    await expect(
      authority.commitPrefix(
        { baseAnchor: { ...baseAnchor, rawSeq: baseAnchor.rawSeq + 1 }, entries: [] },
        vi.fn(),
      ),
    ).resolves.toEqual({ kind: "conflict", reason: "base-anchor-mismatch" });
  });
});

it("rejects a concurrent branch change inside the canonical write transaction", async () => {
  await withOpenClawTestState({ label: "authority-race" }, async (state) => {
    const scope = target(state);
    const authority = new CodeModeTranscriptAuthority(scope);
    const baseAnchor = appendUnkeyedBase(scope);
    const result = await authority.commitPrefix(
      { baseAnchor, entries: prefix.entries },
      (message) => {
        appendTranscriptMessageSync(scope, {
          eventId: "racing-event",
          message: { role: "user", content: "racing write" },
        });
        return message;
      },
    );
    expect(result).toEqual({ kind: "conflict", reason: "transaction-drift" });
    const messages = loadTranscriptEventsSync(scope).flatMap((event) =>
      event.type === "message" ? [event.message] : [],
    );
    expect(messages).toEqual([
      expect.objectContaining({ content: "base" }),
      expect.objectContaining({ content: "racing write" }),
    ]);
  });
});

it("rolls back when close revokes authority after hook preparation", async () => {
  await withOpenClawTestState({ label: "authority-close" }, async (state) => {
    const scope = target(state);
    const authority = new CodeModeTranscriptAuthority(scope);
    await expect(
      authority.commitPrefix(prefix, (message) => {
        authority.close();
        return message;
      }),
    ).rejects.toThrow("authority is closed");
    expect(loadTranscriptEventsSync(scope).filter((event) => event.type === "message")).toEqual([]);
  });
});

it("admits a committed wait after canonical pending-collector renewal", () => {
  const now = 10_000;
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    testing.activeRuns.set("cm-renew-pending", {
      replayId: "replay-pending",
      expiresAt: now - 1,
      agentWaitRetainUntil: now + 120_000,
      config: { snapshotTtlSeconds: 60 },
      pending: [
        {
          id: "bridge:agentWait:pending",
          method: "agentWait",
          args: ["collector"],
          promise: new Promise(() => {}),
        },
      ],
      owner: { close: vi.fn() },
    } as never);
    const authority = new CodeModeTranscriptAuthority({} as never);

    commitWaitingClaim(authority, {
      assistantTurnId: "turn-pending",
      runId: "cm-renew-pending",
      toolCallId: "call-pending",
      toolName: "wait",
    });

    expect(testing.activeRuns.get("cm-renew-pending")?.expiresAt).toBe(now + 60_000);
    expect(authority.verifyWaiting("cm-renew-pending")).toBe(true);
  } finally {
    nowSpy.mockRestore();
  }
});

it("uses lifecycle settlement renewal instead of the captured expiry", () => {
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
  try {
    testing.activeRuns.set("cm-renew-settled", {
      replayId: "replay-settled",
      expiresAt: 10_100,
      config: { snapshotTtlSeconds: 60 },
      pending: [],
      owner: { close: vi.fn() },
    } as never);
    const authority = new CodeModeTranscriptAuthority({} as never);
    commitWaitingClaim(authority, {
      assistantTurnId: "turn-settled",
      runId: "cm-renew-settled",
      toolCallId: "call-settled",
      toolName: "wait",
    });

    testing.activeRuns.get("cm-renew-settled")!.expiresAt = 70_000;
    nowSpy.mockReturnValue(10_200);

    expect(authority.verifyWaiting("cm-renew-settled")).toBe(true);
  } finally {
    nowSpy.mockRestore();
  }
});

it("rejects an evicted, replay-mismatched, or concurrently resuming wait", () => {
  const close = vi.fn();
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
  try {
    testing.activeRuns.set("cm-admission-fence", {
      replayId: "replay-original",
      expiresAt: 10_500,
      config: { snapshotTtlSeconds: 60 },
      pending: [],
      owner: { close },
    } as never);
    const authority = new CodeModeTranscriptAuthority({} as never);
    commitWaitingClaim(authority, {
      assistantTurnId: "turn-fenced",
      runId: "cm-admission-fence",
      toolCallId: "call-fenced",
      toolName: "wait",
    });

    testing.activeRuns.get("cm-admission-fence")!.replayId = "replay-replaced";
    expect(authority.verifyWaiting("cm-admission-fence")).toBe(false);

    testing.activeRuns.get("cm-admission-fence")!.replayId = "replay-original";
    testing.resumingRunIds.add("cm-admission-fence");
    expect(authority.verifyWaiting("cm-admission-fence")).toBe(false);
    expect(() =>
      authority.captureWaiting({
        assistantTurnId: "turn-concurrent",
        runId: "cm-admission-fence",
        toolCallId: "call-concurrent",
        toolName: "wait",
      }),
    ).toThrow("unavailable or expired");
    testing.resumingRunIds.delete("cm-admission-fence");

    nowSpy.mockReturnValue(10_501);
    expect(authority.verifyWaiting("cm-admission-fence")).toBe(false);
    expect(testing.activeRuns.has("cm-admission-fence")).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    nowSpy.mockRestore();
  }
});

it("keys repeated exec and wait results by their local assistant turn", async () => {
  await withOpenClawTestState({ label: "authority-session-manager" }, async (state) => {
    const scope = target(state);
    const authority = new CodeModeTranscriptAuthority(scope);
    const attempt = {};
    bindCodeModeTranscriptAuthority(attempt, authority);
    const unguarded = SessionManager.open(scope, state.workspaceDir);
    const attemptAuthority = resolveCodeModeTranscriptAuthority(attempt);
    if (!attemptAuthority) {
      throw new Error("attempt did not expose its transcript authority");
    }
    bindCodeModeTranscriptAuthority(unguarded, attemptAuthority);
    const manager = guardSessionManager(unguarded, {
      runId: "cm-test",
      allowedToolNames: ["exec", "wait"],
    });
    const reserve = authority.reserve.bind(authority);
    const certificationChecks: string[] = [];
    const reserveSpy = vi.spyOn(authority, "reserve").mockImplementation((message) => {
      const reservation = reserve(message);
      if (!reservation) {
        return undefined;
      }
      const identity = reservation.identity;
      if (!identity) {
        throw new Error("test reservation lacks a local identity");
      }
      return {
        ...reservation,
        commit: () => {
          const durable = loadTranscriptEventsSync(scope).find(
            (event) =>
              event.type === "message" &&
              event.message.role === "toolResult" &&
              event.message.idempotencyKey === identity,
          );
          expect(durable).toBeDefined();
          certificationChecks.push(identity);
          reservation.commit();
        },
      };
    });
    const identities: string[] = [];
    const entryIds: string[] = [];
    const waits = [
      { assistantTurnId: "turn-exec", toolName: "exec", text: "exec waiting" },
      { assistantTurnId: "turn-wait-1", toolName: "wait", text: "first wait" },
      { assistantTurnId: "turn-wait-2", toolName: "wait", text: "second wait" },
    ] as const;
    testing.activeRuns.set("cm-test", {
      expiresAt: Date.now() + 60_000,
      parentToolCallId: "call-test",
      replayId: "replay-stable",
    } as never);
    for (const waiting of waits) {
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call-test", name: waiting.toolName, arguments: {} }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1,
      });
      const message = {
        role: "toolResult" as const,
        toolCallId: "call-test",
        toolName: waiting.toolName,
        content: [{ type: "text" as const, text: waiting.text }],
        isError: false,
      };
      authority.captureWaiting({
        assistantTurnId: waiting.assistantTurnId,
        runId: "cm-test",
        toolCallId: "call-test",
        toolName: waiting.toolName,
      });
      entryIds.push(manager.appendMessage(message));
      expect(authority.verifyWaiting("cm-test")).toBe(true);
      identities.push(certificationChecks.at(-1)!);
    }
    authority.captureWaiting({
      assistantTurnId: waits[2].assistantTurnId,
      runId: "cm-test",
      toolCallId: "call-test",
      toolName: waits[2].toolName,
    });
    const beforeReplay = readRawTranscriptState(scope);
    const beforeCursor = manager.getAppendParentId();
    expect(
      manager.appendMessage({
        role: "toolResult",
        toolCallId: "call-test",
        toolName: waits[2].toolName,
        content: [{ type: "text", text: waits[2].text }],
        isError: false,
      }),
    ).toBe(entryIds[2]);
    const afterReplay = readRawTranscriptState(scope);
    expect(afterReplay.rows).toEqual(beforeReplay.rows);
    expect(afterReplay.identities).toEqual(beforeReplay.identities);
    expect(manager.getAppendParentId()).toBe(beforeCursor);
    expect(manager.getLeafId()).toBe(entryIds[2]);
    expect(authority.verifyWaiting("cm-test")).toBe(true);
    expect(reserveSpy).toHaveBeenCalledTimes(4);
    expect(certificationChecks).toEqual([...identities, identities[2]]);
    expect(identities).toEqual([
      expect.stringMatching(/^code-mode-result:[a-f0-9]{32}$/u),
      expect.stringMatching(/^code-mode-result:[a-f0-9]{32}$/u),
      expect.stringMatching(/^code-mode-result:[a-f0-9]{32}$/u),
    ]);
    expect(identities[1]).not.toBe(identities[0]);
    expect(identities[2]).not.toBe(identities[1]);
    closeOpenClawAgentDatabasesForTest();
    expect(
      SessionManager.open(scope, state.workspaceDir)
        .buildSessionContext()
        .messages.filter((message) => message.role === "toolResult"),
    ).toMatchObject([
      { toolCallId: "call-test", toolName: "exec", content: [{ text: "exec waiting" }] },
      { toolCallId: "call-test", toolName: "wait", content: [{ text: "first wait" }] },
      { toolCallId: "call-test", toolName: "wait", content: [{ text: "second wait" }] },
    ]);
  });
});

it.each(["throw", "reenter"] as const)(
  "certifies the exact waiting result before a persistence callback can %s",
  async (action) => {
    await withOpenClawTestState({ label: `authority-callback-${action}` }, async (state) => {
      const scope = target(state);
      const authority = new CodeModeTranscriptAuthority(scope);
      const raw = SessionManager.open(scope, state.workspaceDir);
      bindCodeModeTranscriptAuthority(raw, authority);
      const claim = {
        assistantTurnId: "callback-turn",
        runId: "cm-callback",
        toolCallId: "callback-call",
        toolName: "wait",
      };
      const callback = vi.fn((message: AgentMessage) => {
        if (message.role !== "toolResult") {
          return;
        }
        expect(authority.verifyWaiting(claim.runId)).toBe(true);
        if (action === "throw") {
          throw new Error("callback failed after certification");
        }
        manager.appendMessage(
          makeAgentAssistantMessage({
            content: [{ type: "toolCall", id: claim.toolCallId, name: "wait", arguments: {} }],
            stopReason: "toolUse",
          }),
        );
        authority.captureWaiting({ ...claim, assistantTurnId: "later-turn" });
      });
      const manager = guardSessionManager(raw, {
        allowedToolNames: ["wait"],
        onMessagePersisted: callback,
      });
      manager.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: claim.toolCallId, name: "wait", arguments: {} }],
          stopReason: "toolUse",
        }),
      );
      callback.mockClear();
      testing.activeRuns.set(claim.runId, {
        expiresAt: Date.now() + 60_000,
        replayId: "callback-replay",
      } as never);
      authority.captureWaiting(claim);
      const append = () =>
        manager.appendMessage({
          role: "toolResult",
          toolCallId: claim.toolCallId,
          toolName: claim.toolName,
          content: [{ type: "text", text: "waiting" }],
          isError: false,
        });
      if (action === "throw") {
        expect(append).toThrow("callback failed after certification");
        expect(callback).toHaveBeenCalledOnce();
      } else {
        append();
        expect(callback).toHaveBeenCalledTimes(2);
      }
      expect(authority.verifyWaiting(claim.runId)).toBe(action === "throw");
      expect(
        loadTranscriptEventsSync(scope).filter(
          (event) => event.type === "message" && event.message.role === "toolResult",
        ),
      ).toHaveLength(1);
    });
  },
);

it.each(["append", "identity", "inactive"] as const)(
  "does not certify a waiting result after %s rejection",
  async (failure) => {
    await withOpenClawTestState({ label: `authority-reject-${failure}` }, async (state) => {
      const scope = target(state);
      const authority = new CodeModeTranscriptAuthority(scope);
      const raw = SessionManager.open(scope, state.workspaceDir);
      bindCodeModeTranscriptAuthority(raw, authority);
      const append = raw.appendMessageWithTranscriptAnchor.bind(raw);
      if (failure === "append") {
        vi.spyOn(raw, "appendMessageWithTranscriptAnchor").mockImplementation(
          (message, options) => {
            if (message.role === "toolResult") {
              throw new Error("failed raw append");
            }
            return append(message, options);
          },
        );
      }
      const manager = raw;
      installSessionToolResultGuard(manager, {
        allowedToolNames: ["wait"],
        beforeMessageWriteHook:
          failure === "identity"
            ? ({ message }) =>
                message.role === "toolResult"
                  ? { message: { ...message, toolName: "changed" } }
                  : undefined
            : undefined,
      });
      const assistant = manager.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: "reject-call", name: "wait", arguments: {} }],
          stopReason: "toolUse",
        }),
      );
      const claim = {
        assistantTurnId: "reject-turn",
        runId: "cm-reject",
        toolCallId: "reject-call",
        toolName: "wait",
      };
      const message = {
        role: "toolResult" as const,
        toolCallId: claim.toolCallId,
        toolName: claim.toolName,
        content: [{ type: "text" as const, text: "waiting" }],
        isError: false,
      };
      testing.activeRuns.set(claim.runId, {
        expiresAt: Date.now() + 60_000,
        replayId: "reject-replay",
      } as never);
      authority.captureWaiting(claim);
      if (failure === "inactive") {
        manager.appendMessage(message);
        manager.branch(assistant);
        manager.appendMessage({ role: "user", content: "new branch", timestamp: 2 });
        authority.captureWaiting(claim);
      }
      const before = readRawTranscriptState(scope);
      expect(() => manager.appendMessage(message)).toThrow(
        failure === "append"
          ? "failed raw append"
          : failure === "identity"
            ? "identity changed before commit"
            : "Session transcript anchor was not returned",
      );
      expect(authority.verifyWaiting(claim.runId)).toBe(false);
      const after = readRawTranscriptState(scope);
      expect(after.rows).toEqual(before.rows);
      expect(after.identities).toEqual(before.identities);
    });
  },
);

it("requires local turn identity for SessionManager but accepts a provider prefix identity", async () => {
  await withOpenClawTestState({ label: "authority-provider-identity" }, async (state) => {
    const scope = target(state);
    const authority = new CodeModeTranscriptAuthority(scope);
    const unguarded = SessionManager.open(scope, state.workspaceDir);
    bindCodeModeTranscriptAuthority(unguarded, authority);
    const manager = guardSessionManager(unguarded, {
      runId: "cm-provider",
      allowedToolNames: ["wait"],
    });
    testing.activeRuns.set("cm-provider", {
      expiresAt: Date.now() + 60_000,
      parentToolCallId: "call-provider",
      replayId: "replay-provider",
    } as never);
    const message = {
      role: "toolResult" as const,
      toolCallId: "call-provider",
      toolName: "wait",
      content: [{ type: "text" as const, text: "waiting" }],
      isError: false,
    };
    authority.captureWaiting({
      runId: "cm-provider",
      toolCallId: "call-provider",
      toolName: "wait",
    });
    expect(() => manager.appendMessage(message)).toThrow(
      "code mode waiting result lacks an authoritative turn identity",
    );
    expect(loadTranscriptEventsSync(scope).filter((event) => event.type === "message")).toEqual([]);

    await expect(
      authority.commitPrefix(
        {
          entries: [
            {
              eventId: "provider-tool-result",
              identity: "provider:tool-result",
              message,
            },
          ],
        },
        (candidate) => candidate,
      ),
    ).resolves.toMatchObject({ kind: "committed" });
    expect(authority.verifyWaiting("cm-provider")).toBe(true);
    expect(
      loadTranscriptEventsSync(scope).find(
        (event) =>
          event.type === "message" &&
          event.message.role === "toolResult" &&
          event.message.idempotencyKey === "provider:tool-result",
      ),
    ).toBeDefined();
  });
});
