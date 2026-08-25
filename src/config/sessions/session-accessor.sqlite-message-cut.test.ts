import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
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
  readSessionTranscriptMessageEventPage,
  readSessionTranscriptMessageEvents,
  rewindSessionToMessage,
  switchSessionBranch,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import type { InternalSessionEntry } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const agentId = "main";
const sessionKey = "agent:main:message-cut";
const sourceExpectedState = {
  lifecycleRevision: "source-lifecycle-revision",
  sessionId: "message-cut-source",
};

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function trackFullTranscriptLoads(env: NodeJS.ProcessEnv): () => number {
  const database = openOpenClawAgentDatabase({ agentId, env });
  const { counts } = trackSqliteStatementExecutions(database.db, ["loads"], (sqlText) =>
    sqlText.includes('select "event_json" from "transcript_events"') &&
    sqlText.includes('order by "seq" asc')
      ? "loads"
      : null,
  );
  return () => counts.loads;
}

async function createSiblingSession(params: {
  env: NodeJS.ProcessEnv;
  headline: string;
  sessionId: string;
  sessionKey: string;
}) {
  const scope = { agentId, ...params };
  await upsertSessionEntryCore(scope, { sessionId: params.sessionId, updatedAt: Date.now() });
  await appendTranscriptEvent(scope, {
    type: "session",
    id: params.sessionId,
    version: 3,
    timestamp: "2026-07-18T01:00:00.000Z",
  });
  await appendTranscriptMessage(scope, {
    eventId: `${params.sessionId}-user`,
    message: { role: "user", content: params.headline },
    now: Date.parse("2026-07-18T01:00:01.000Z"),
    parentId: null,
  });
  return scope;
}

async function createSession(options: { activeLeafTarget?: string } = {}) {
  const stateDir = tempDirs.make("openclaw-message-cut-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const sessionId = "message-cut-source";
  const scope = { agentId, env, sessionId, sessionKey };
  const entry: InternalSessionEntry = {
    agentHarnessId: "embedded",
    claudeCliSessionId: "claude-conversation",
    cliSessionBindings: { "claude-cli": { sessionId: "claude-conversation" } },
    cliSessionIds: { "claude-cli": "claude-conversation" },
    compactionCount: 2,
    contextTokens: 100_000,
    contextTokensSource: "runtime",
    createdVia: "operator",
    createdActor: { type: "human", id: "profile-1" },
    createdAt: 1_000,
    delivery: normalizeSessionDeliveryState({
      context: { channel: "telegram", to: "chat-123" },
    }),
    forkSource: { sessionKey: "agent:main:root", sessionId: "root-session" },
    lifecycleRevision: "source-lifecycle-revision",
    lifecycleRunId: "source-run",
    lastRunId: "settled-source-run",
    modelOverride: "gpt-5",
    modelOverrideSource: "user",
    providerOverride: "openai",
    sessionId,
    updatedAt: Date.now(),
  };
  await upsertSessionEntryCore(scope, entry);
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
      message: {
        role: "user",
        content: [
          { type: "text", text: "second prompt" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
        __openclaw: {
          media: [
            { path: "/state/media/inbound/stored-image.png", contentType: "image/png" },
            { path: "/state/media/inbound/notes.txt", contentType: "text/plain" },
          ],
        },
      },
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
  it("reuses branch summaries while the transcript watermark is unchanged", async () => {
    const { env } = await createSession();
    const fullTranscriptLoads = trackFullTranscriptLoads(env);

    const first = await listSessionBranches({ agentId, env, sessionKey });
    expect(fullTranscriptLoads()).toBe(1);

    const second = await listSessionBranches({ agentId, env, sessionKey });
    expect(second).toEqual(first);
    expect(fullTranscriptLoads()).toBe(1);
    if (second.status !== "ok" || !second.branches[0]) {
      throw new Error("expected cached branch list result");
    }
    second.branches[0].headline = "caller mutation";

    await expect(listSessionBranches({ agentId, env, sessionKey })).resolves.toEqual(first);
    expect(fullTranscriptLoads()).toBe(1);
  });

  it("recomputes branch summaries after an append advances the watermark", async () => {
    const { env, scope } = await createSession();
    const fullTranscriptLoads = trackFullTranscriptLoads(env);

    const before = await listSessionBranches({ agentId, env, sessionKey });
    expect(fullTranscriptLoads()).toBe(1);
    await appendTranscriptMessage(scope, {
      eventId: "assistant-3",
      message: { role: "assistant", content: "third answer" },
      now: Date.parse("2026-07-18T00:00:07.000Z"),
      parentId: "assistant-2",
    });

    const after = await listSessionBranches({ agentId, env, sessionKey });
    expect(fullTranscriptLoads()).toBe(2);
    expect(after).not.toEqual(before);
    expect(after.status).toBe("ok");
    if (after.status !== "ok") {
      throw new Error("expected branch list result");
    }
    expect(after.branches.find((branch) => branch.active)).toMatchObject({
      leafEntryId: "assistant-3",
      headline: "third answer",
    });
  });

  it.each(["rewind", "switch", "fork"] as const)(
    "%s invalidates the source cache and lists the resulting branch",
    async (mode) => {
      const { env, scope } = await createSession();
      const aliasKey = `${sessionKey}:alias`;
      const targetKey = `${sessionKey}:fork`;
      const sourceEntry = loadSessionEntry(scope);
      if (!sourceEntry) {
        throw new Error("expected source session entry");
      }
      await upsertSessionEntryCore({ agentId, env, sessionKey: aliasKey }, sourceEntry);
      const fullTranscriptLoads = trackFullTranscriptLoads(env);
      await listSessionBranches({ agentId, env, sessionKey });

      const result =
        mode === "rewind"
          ? await rewindSessionToMessage({
              agentId,
              env,
              entryId: "user-2",
              sessionKey,
            })
          : mode === "switch"
            ? await switchSessionBranch({
                agentId,
                env,
                leafEntryId: "off-path-user",
                sessionKey,
              })
            : await forkSessionAtMessage({
                agentId,
                env,
                entryId: "user-2",
                sessionKey,
                targetKey,
              });
      expect(result.status).toBe("created");

      const loadsBeforeAliasRead = fullTranscriptLoads();
      await listSessionBranches({ agentId, env, sessionKey: aliasKey });
      expect(fullTranscriptLoads()).toBe(loadsBeforeAliasRead + 1);

      const listed = await listSessionBranches({
        agentId,
        env,
        sessionKey: mode === "fork" ? targetKey : sessionKey,
      });
      expect(listed.status).toBe("ok");
      if (listed.status !== "ok") {
        throw new Error("expected branch list result");
      }
      expect(listed.branches.find((branch) => branch.active)).toMatchObject({
        leafEntryId: mode === "switch" ? "off-path-user" : "assistant-1",
      });
    },
  );

  it.each(["rewind", "switch", "fork"] as const)(
    "rejects %s when the source lifecycle changes in the writer queue",
    async (mode) => {
      const { env, scope } = await createSession();
      let releaseOwnerChange = () => {};
      const ownerChangeGate = new Promise<void>((resolve) => {
        releaseOwnerChange = resolve;
      });
      let markOwnerChangeStarted = () => {};
      const ownerChangeStarted = new Promise<void>((resolve) => {
        markOwnerChangeStarted = resolve;
      });
      const ownerChange = updateSessionEntry(scope, async () => {
        markOwnerChangeStarted();
        await ownerChangeGate;
        return { lifecycleRevision: "replacement-lifecycle-revision" };
      });
      await ownerChangeStarted;

      const targetKey = `${sessionKey}:raced-fork`;
      const mutation =
        mode === "rewind"
          ? rewindSessionToMessage({
              agentId,
              env,
              entryId: "user-2",
              sessionKey,
            })
          : mode === "switch"
            ? switchSessionBranch({
                agentId,
                env,
                leafEntryId: "off-path-user",
                sessionKey,
              })
            : forkSessionAtMessage({
                agentId,
                env,
                entryId: "user-2",
                sessionKey,
                targetKey,
              });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      releaseOwnerChange();

      await ownerChange;
      await expect(mutation).resolves.toEqual({ status: "conflict" });
      expect(loadSessionEntry(scope)).toMatchObject({
        lifecycleRevision: "replacement-lifecycle-revision",
        sessionId: sourceExpectedState.sessionId,
      });
      expect(loadSessionEntry({ agentId, env, sessionKey: targetKey })).toBeUndefined();
      await expect(listSessionBranches({ agentId, env, sessionKey })).resolves.toMatchObject({
        status: "ok",
        branches: expect.arrayContaining([
          expect.objectContaining({ active: true, leafEntryId: "assistant-2" }),
        ]),
      });
    },
  );

  it("keeps branch summaries isolated between sessions in the same store", async () => {
    const { env } = await createSession();
    const sibling = await createSiblingSession({
      env,
      headline: "sibling prompt",
      sessionId: "message-cut-sibling",
      sessionKey: `${sessionKey}:sibling`,
    });
    const fullTranscriptLoads = trackFullTranscriptLoads(env);

    const source = await listSessionBranches({ agentId, env, sessionKey });
    const other = await listSessionBranches(sibling);
    expect(fullTranscriptLoads()).toBe(2);
    expect(source.status).toBe("ok");
    if (source.status !== "ok") {
      throw new Error("expected source branch list result");
    }
    expect(source.branches.find((branch) => branch.active)).toMatchObject({
      leafEntryId: "assistant-2",
      headline: "second answer",
    });
    expect(other).toEqual({
      status: "ok",
      branches: [
        {
          active: true,
          headline: "sibling prompt",
          leafEntryId: "message-cut-sibling-user",
          messageCount: 1,
          updatedAt: "2026-07-18T01:00:01.000Z",
        },
      ],
    });
    await expect(listSessionBranches({ agentId, env, sessionKey })).resolves.toEqual(source);
    expect(fullTranscriptLoads()).toBe(2);
  });

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
      switchSessionBranch({
        agentId,
        env,
        leafEntryId,
        sessionKey,
      }),
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
      editorAttachments: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
      editorMediaRefs: [
        { path: "/state/media/inbound/stored-image.png", contentType: "image/png" },
      ],
    });
    if (result.status !== "created") {
      throw new Error("expected rewind result");
    }
    expect(
      readSessionTranscriptMessageEventPage(
        { agentId, env, sessionId: result.entry.sessionId },
        { maxMessages: 0, offset: 0 },
      ).totalMessages,
    ).toBe(2);
    expect(loadSessionEntry({ agentId, env, sessionKey })?.sessionId).toBe(result.entry.sessionId);
    expect(result.entry).toMatchObject({
      agentHarnessId: undefined,
      claudeCliSessionId: undefined,
      cliSessionBindings: undefined,
      cliSessionIds: undefined,
      compactionCount: undefined,
      contextTokens: undefined,
      contextTokensSource: undefined,
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

  it("omits editor attachments for a text-only message", async () => {
    const { env } = await createSession();

    const result = await rewindSessionToMessage({
      agentId,
      env,
      entryId: "user-1",
      sessionKey,
    });

    expect(result).toMatchObject({ status: "created", editorText: "first prompt" });
    expect(result).not.toHaveProperty("editorAttachments");
    expect(result).not.toHaveProperty("editorMediaRefs");
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
      editorAttachments: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
      editorMediaRefs: [
        { path: "/state/media/inbound/stored-image.png", contentType: "image/png" },
      ],
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
    expect((result.entry as InternalSessionEntry).lifecycleRunId).toBeUndefined();
    expect((result.entry as InternalSessionEntry).lastRunId).toBeUndefined();
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
      rewindSessionToMessage({
        agentId,
        env,
        entryId,
        sessionKey,
      }),
    ).resolves.toMatchObject({ status });
  });
});
