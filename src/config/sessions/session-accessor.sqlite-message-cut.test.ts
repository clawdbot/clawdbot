import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  deliveryContextFromSession,
  normalizeSessionDeliveryState,
} from "../../utils/delivery-context.shared.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  forkSessionAtMessage,
  listSessionBranches,
  loadSessionEntry,
  loadTranscriptEvents,
  readSessionTranscriptMessageEventCount,
  readSessionTranscriptMessageEvents,
  rewindSessionToMessage,
  switchSessionBranch,
  upsertSessionEntry,
} from "./session-accessor.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const agentId = "main";
const sessionKey = "agent:main:message-cut";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

async function createSession(options: { activeLeafTarget?: string } = {}) {
  const stateDir = tempDirs.make("openclaw-message-cut-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const sessionId = "message-cut-source";
  const scope = { agentId, env, sessionId, sessionKey };
  await upsertSessionEntry(scope, {
    agentHarnessId: "embedded",
    claudeCliSessionId: "claude-conversation",
    cliSessionBindings: { "claude-cli": { sessionId: "claude-conversation" } },
    cliSessionIds: { "claude-cli": "claude-conversation" },
    compactionCount: 2,
    contextTokens: 100_000,
    createdVia: "operator",
    createdActor: { type: "human", id: "profile-1" },
    createdAt: 1_000,
    delivery: normalizeSessionDeliveryState({
      context: { channel: "telegram", to: "chat-123" },
    }),
    forkSource: { sessionKey: "agent:main:root", sessionId: "root-session" },
    lifecycleRevision: "source-lifecycle-revision",
    modelOverride: "gpt-5",
    modelOverrideSource: "user",
    providerOverride: "openai",
    sessionId,
    updatedAt: Date.now(),
  });
  for (const event of [
    { type: "session", id: sessionId, version: 3, timestamp: "2026-07-18T00:00:00.000Z" },
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-07-18T00:00:01.000Z",
      message: { role: "user", content: "first prompt" },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-07-18T00:00:02.000Z",
      message: { role: "assistant", content: "first answer" },
    },
    {
      type: "message",
      id: "user-2",
      parentId: "assistant-1",
      timestamp: "2026-07-18T00:00:03.000Z",
      message: { role: "user", content: [{ type: "text", text: "second prompt" }] },
    },
    {
      type: "message",
      id: "assistant-2",
      parentId: "user-2",
      timestamp: "2026-07-18T00:00:04.000Z",
      message: { role: "assistant", content: "second answer" },
    },
    {
      type: "message",
      id: "off-path-user",
      parentId: "user-1",
      timestamp: "2026-07-18T00:00:05.000Z",
      message: { role: "user", content: "inactive prompt" },
    },
    {
      type: "leaf",
      id: "active-leaf",
      parentId: "off-path-user",
      timestamp: "2026-07-18T00:00:06.000Z",
      targetId: options.activeLeafTarget ?? "assistant-2",
    },
  ]) {
    if (event.type === "message") {
      await appendTranscriptMessage(scope, {
        eventId: event.id,
        message: event.message,
        now: Date.parse(event.timestamp),
        parentId: event.parentId,
      });
    } else {
      await appendTranscriptEvent(scope, event);
    }
  }
  return { env, scope };
}

describe("SQLite session message cuts", () => {
  it("lists every DAG tip with active state, headline, count, and timestamp", async () => {
    const { env } = await createSession({ activeLeafTarget: "assistant-1" });

    await expect(listSessionBranches({ agentId, env, sessionKey })).resolves.toEqual({
      status: "ok",
      branches: [
        {
          leafEntryId: "assistant-1",
          headline: "first answer",
          messageCount: 2,
          updatedAt: "2026-07-18T00:00:02.000Z",
          active: true,
        },
        {
          leafEntryId: "off-path-user",
          headline: "inactive prompt",
          messageCount: 2,
          updatedAt: "2026-07-18T00:00:05.000Z",
          active: false,
        },
        {
          leafEntryId: "assistant-2",
          headline: "second answer",
          messageCount: 4,
          updatedAt: "2026-07-18T00:00:04.000Z",
          active: false,
        },
      ],
    });
  });

  it("switches to another tip and rebuilds the active-path projection", async () => {
    const { env } = await createSession();

    const result = await switchSessionBranch({
      agentId,
      env,
      leafEntryId: "off-path-user",
      sessionKey,
    });

    expect(result).toMatchObject({ status: "created", key: sessionKey });
    if (result.status !== "created") {
      throw new Error("expected branch switch result");
    }
    const activeEventIds = readSessionTranscriptMessageEvents({
      agentId,
      env,
      sessionId: result.entry.sessionId,
      sessionKey,
    }).map(({ event }) =>
      event && typeof event === "object" && "id" in event ? event.id : undefined,
    );
    expect(activeEventIds).toEqual(["user-1", "off-path-user"]);
    expect(result.entry).toMatchObject({
      agentHarnessId: undefined,
      claudeCliSessionId: undefined,
      cliSessionBindings: undefined,
      cliSessionIds: undefined,
    });
  });

  it.each([
    ["unknown", "missing-entry"],
    ["user-1", "not-branch-tip"],
    ["assistant-2", "already-active"],
  ])("rejects branch switch target %s with %s", async (leafEntryId, status) => {
    const { env } = await createSession();

    await expect(
      switchSessionBranch({ agentId, env, leafEntryId, sessionKey }),
    ).resolves.toMatchObject({ status });
  });

  it("rewinds by repointing the active leaf and returns the editor text", async () => {
    const { env } = await createSession();

    const result = await rewindSessionToMessage({
      agentId,
      env,
      entryId: "user-2",
      sessionKey,
    });

    expect(result).toMatchObject({
      status: "created",
      key: sessionKey,
      editorText: "second prompt",
    });
    if (result.status !== "created") {
      throw new Error("expected rewind result");
    }
    expect(
      readSessionTranscriptMessageEventCount({ agentId, env, sessionId: result.entry.sessionId }),
    ).toBe(2);
    expect(loadSessionEntry({ agentId, env, sessionKey })?.sessionId).toBe(result.entry.sessionId);
    expect(result.entry).toMatchObject({
      agentHarnessId: undefined,
      claudeCliSessionId: undefined,
      cliSessionBindings: undefined,
      cliSessionIds: undefined,
      compactionCount: undefined,
      contextTokens: undefined,
      createdVia: "operator",
      createdActor: { type: "human", id: "profile-1" },
      createdAt: 1_000,
      forkSource: { sessionKey: "agent:main:root", sessionId: "root-session" },
      previousSessionId: "message-cut-source",
    });
    expect(deliveryContextFromSession(result.entry)).toEqual({
      channel: "telegram",
      to: "chat-123",
      accountId: undefined,
    });
  });

  it("rewinds the stored row when its canonical key differs", async () => {
    const { env } = await createSession();
    const canonicalKey = "agent:main:canonical-message-cut";

    const result = await rewindSessionToMessage({
      agentId,
      env,
      entryId: "user-2",
      sessionKey: canonicalKey,
      sessionStoreKey: sessionKey,
    });

    expect(result).toMatchObject({ status: "created", key: sessionKey });
    if (result.status !== "created") {
      throw new Error("expected rewind result");
    }
    expect(loadSessionEntry({ agentId, env, sessionKey })?.sessionId).toBe(result.entry.sessionId);
    expect(loadSessionEntry({ agentId, env, sessionKey: canonicalKey })).toBeUndefined();
  });

  it("forks an exact active-path prefix without changing the source", async () => {
    const { env, scope } = await createSession();
    const canonicalSourceKey = "agent:main:canonical-message-cut-source";
    const targetKey = "agent:main:dashboard:message-cut-fork";

    const result = await forkSessionAtMessage({
      agentId,
      env,
      entryId: "user-2",
      sessionKey: canonicalSourceKey,
      sessionStoreKey: sessionKey,
      targetKey,
    });

    expect(result).toMatchObject({
      status: "created",
      key: targetKey,
      editorText: "second prompt",
    });
    if (result.status !== "created") {
      throw new Error("expected fork result");
    }
    const forkEvents = await loadTranscriptEvents({
      agentId,
      env,
      sessionId: result.entry.sessionId,
      sessionKey: targetKey,
    });
    expect(
      forkEvents.flatMap((event) =>
        event && typeof event === "object" && "id" in event ? [event.id] : [],
      ),
    ).toEqual([result.entry.sessionId, "user-1", "assistant-1"]);
    expect(loadSessionEntry(scope)?.sessionId).toBe(scope.sessionId);
    expect(result.entry.lifecycleRevision).not.toBe("source-lifecycle-revision");
    expect(result.entry.cliSessionBindings).toBeUndefined();
    expect(deliveryContextFromSession(result.entry)).toBeUndefined();
    expect(result.entry.parentSessionKey).toBe(canonicalSourceKey);
    expect(result.entry.previousSessionId).toBeUndefined();
    expect(result.entry.forkedFromParent).toBeUndefined();
    expect(result.entry.createdVia).toBeUndefined();
    expect(result.entry.createdActor).toBeUndefined();
    expect(result.entry.createdAt).toBeUndefined();
    expect(result.entry.forkSource).toEqual({
      sessionKey: canonicalSourceKey,
      sessionId: "message-cut-source",
      entryId: "user-2",
    });
    expect(result.entry).toMatchObject({
      modelOverride: "gpt-5",
      modelOverrideSource: "user",
      providerOverride: "openai",
    });
    expect(loadSessionEntry(scope)?.lifecycleRevision).toBe("source-lifecycle-revision");
  });

  it.each([
    ["unknown", "missing-entry"],
    ["assistant-1", "not-user-message"],
    ["off-path-user", "off-active-path"],
  ])("rejects %s with %s", async (entryId, status) => {
    const { env } = await createSession();

    await expect(
      rewindSessionToMessage({ agentId, env, entryId, sessionKey }),
    ).resolves.toMatchObject({ status });
  });

  it("returns a typed error for legacy JSONL transcript storage", async () => {
    const { env } = await createSession();
    await upsertSessionEntry(
      { agentId, env, sessionKey },
      {
        sessionFile: "/tmp/legacy-session.jsonl",
      },
    );

    await expect(
      rewindSessionToMessage({ agentId, env, entryId: "user-2", sessionKey }),
    ).resolves.toMatchObject({ status: "unsupported-storage" });
    await expect(listSessionBranches({ agentId, env, sessionKey })).resolves.toMatchObject({
      status: "unsupported-storage",
    });
    await expect(
      switchSessionBranch({ agentId, env, leafEntryId: "assistant-2", sessionKey }),
    ).resolves.toMatchObject({ status: "unsupported-storage" });
  });
});
