import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  persistSessionTranscriptTurn,
  replaceTranscriptEvents,
  type SessionTranscriptMessageEvent,
} from "../config/sessions/session-accessor.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  readSessionMessagesAsync,
  type SessionTranscriptReadScope,
} from "./session-transcript-readers.js";
import {
  readSessionTitleFieldsFromTranscript,
  readSessionTitleFieldsFromTranscriptBatch,
} from "./session-transcript-title-reader.js";

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    readSessionTranscriptMessageEventPage: vi.fn(actual.readSessionTranscriptMessageEventPage),
    readSessionTranscriptMessageEvents: vi.fn(actual.readSessionTranscriptMessageEvents),
    readSessionTranscriptTitleProbeBatch: vi.fn(actual.readSessionTranscriptTitleProbeBatch),
    readSessionTranscriptWatermark: vi.fn(actual.readSessionTranscriptWatermark),
    readSessionTranscriptWatermarkBatch: vi.fn(actual.readSessionTranscriptWatermarkBatch),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let tempDir: string;
let storePath: string;
let envSnapshot: ReturnType<typeof captureEnv>;

beforeEach(() => {
  vi.clearAllMocks();
  envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  tempDir = tempDirs.make("openclaw-transcript-titles-");
  storePath = path.join(tempDir, "sessions.json");
  setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  envSnapshot.restore();
});

async function writeTranscript(
  sessionId: string,
  events: unknown[],
): Promise<SessionTranscriptReadScope> {
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath,
  };
  await replaceTranscriptEvents(scope, events);
  return scope;
}

async function writeSqliteMessages(
  sessionId: string,
  messages: Array<{ content: unknown; provenance?: unknown; role: string }>,
): Promise<SessionTranscriptReadScope> {
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath,
  };
  await persistSessionTranscriptTurn(scope, {
    messages: messages.map((message) => ({ message })),
    touchSessionEntry: false,
  });
  return scope;
}

function markProjectionNeedsRebuild(sessionId: string): void {
  openOpenClawAgentDatabase({
    agentId: "main",
    path: path.join(tempDir, "openclaw-agent.sqlite"),
  })
    .db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
    .run(sessionId);
}

function extractReferenceText(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((entry) =>
      entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string"
        ? (entry as { text: string }).text
        : "",
    )
    .filter((part) => part.trim())
    .join("\n")
    .trim();
  return text || null;
}

async function readFullScanTitleFields(scope: SessionTranscriptReadScope) {
  const messages = await readSessionMessagesAsync(scope, {
    mode: "full",
    reason: "title probe parity reference",
  });
  const firstUser = messages.find(
    (message) =>
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      (message as { role?: unknown }).role === "user" &&
      (message as { provenance?: { kind?: unknown } }).provenance?.kind !== "inter_session",
  );
  return {
    firstUserMessage: firstUser ? extractReferenceText(firstUser) : null,
    lastMessagePreview: messages.toReversed().map(extractReferenceText).find(Boolean) ?? null,
  };
}

function boundedTitleEventReadCount(): number {
  const batchEvents = vi
    .mocked(sessionAccessor.readSessionTranscriptTitleProbeBatch)
    .mock.results.reduce(
      (total, result) =>
        total +
        (result.type === "return"
          ? result.value.reduce(
              (count, probe) => count + (probe ? probe.head.length + probe.tail.length : 0),
              0,
            )
          : 0),
      0,
    );
  return (
    batchEvents +
    vi
      .mocked(sessionAccessor.readSessionTranscriptMessageEventPage)
      .mock.results.reduce(
        (total, result) => total + (result.type === "return" ? result.value.events.length : 0),
        0,
      )
  );
}

describe("session transcript title hydration", () => {
  test("keeps bounded title fields at full-scan parity", async () => {
    const scope = await writeSqliteMessages(
      "reader-title-parity",
      Array.from({ length: 105 }, (_, index) => {
        if (index === 60) {
          return { role: "user", content: "late prompt" };
        }
        if (index === 102) {
          return { role: "assistant", content: "last visible" };
        }
        return { role: "assistant", content: index > 102 ? " " : `reply ${String(index)}` };
      }),
    );
    const reference = await readFullScanTitleFields(scope);
    expect(reference).toEqual({
      firstUserMessage: "late prompt",
      lastMessagePreview: "last visible",
    });
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual(reference);
    expect(sessionAccessor.readSessionTranscriptMessageEvents).not.toHaveBeenCalled();
  });

  test("keeps inter-session title variants independent through cache reuse and append", async () => {
    const scope = await writeSqliteMessages("reader-title-provenance-variants", [
      { role: "user", content: "Routed work", provenance: { kind: "inter_session" } },
      { role: "user", content: "Human question" },
      { role: "assistant", content: "**Initial** answer" },
    ]);
    const readVariants = () => {
      for (const includeInterSession of [false, true, false, true]) {
        const fields = readSessionTitleFieldsFromTranscriptBatch([scope], {
          includeInterSession,
        })[0];
        expect(fields?.firstUserMessage).toBe(
          includeInterSession ? "Routed work" : "Human question",
        );
      }
    };
    readVariants();
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId: scope.sessionId, sessionKey: scope.sessionKey, storePath },
      {
        messages: [{ message: { role: "assistant", content: "**Latest** answer" } }],
        touchSessionEntry: false,
      },
    );
    readVariants();
    expect(readSessionTitleFieldsFromTranscript(scope).lastMessagePreview).toBe("Latest answer");
  });

  test("falls back to the canonical visible window for reset transcripts", async () => {
    const sessionId = "reader-title-reset-window";
    const scope = await writeTranscript(sessionId, [
      { type: "session", version: 3, id: sessionId },
      {
        type: "message",
        id: "old",
        parentId: null,
        message: { role: "user", content: "hidden old prompt" },
      },
      {
        type: "message",
        id: "kept-user",
        parentId: "old",
        message: { role: "user", content: "kept prompt" },
      },
      {
        type: "message",
        id: "kept-assistant",
        parentId: "kept-user",
        message: { role: "assistant", content: "kept answer" },
      },
      {
        type: "reset",
        id: "reset-boundary",
        parentId: "kept-assistant",
        firstKeptEntryId: "kept-user",
      },
      {
        type: "message",
        id: "post-reset",
        parentId: "reset-boundary",
        message: { role: "assistant", content: "newest answer" },
      },
    ]);
    expect(readSessionTitleFieldsFromTranscriptBatch([scope])).toEqual([
      { firstUserMessage: "kept prompt", lastMessagePreview: "newest answer" },
    ]);
  });

  test.each(["stale", "unclassified"] as const)(
    "degrades single title reads for a %s projection",
    async (projection) => {
      const scope = await writeSqliteMessages("reader-title-single-rebuilding", [
        { role: "user", content: "single prompt" },
        { role: "assistant", content: "single reply" },
      ]);
      if (projection === "stale") {
        markProjectionNeedsRebuild(scope.sessionId);
      } else {
        openOpenClawAgentDatabase({
          agentId: "main",
          path: path.join(tempDir, "openclaw-agent.sqlite"),
        })
          .db.prepare(
            "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
          )
          .run(scope.sessionId);
      }

      let fields: ReturnType<typeof readSessionTitleFieldsFromTranscript> | undefined;
      try {
        fields = readSessionTitleFieldsFromTranscript(scope);
      } finally {
        await waitForSessionTranscriptIndexReconcile({
          agentId: "main",
          path: path.join(tempDir, "openclaw-agent.sqlite"),
        });
      }
      expect(fields).toEqual({
        firstUserMessage: null,
        lastMessagePreview: null,
      });
    },
  );

  test("isolates a rebuilding projection to one title row and heals on refresh", async () => {
    const scopes: SessionTranscriptReadScope[] = [];
    for (const label of ["first", "rebuilding", "last"]) {
      scopes.push(
        await writeSqliteMessages(`reader-title-${label}`, [
          { role: "user", content: `${label} prompt` },
          { role: "assistant", content: `${label} reply` },
        ]),
      );
    }
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");
    markProjectionNeedsRebuild("reader-title-rebuilding");

    expect(readSessionTitleFieldsFromTranscriptBatch(scopes)).toEqual([
      { firstUserMessage: "first prompt", lastMessagePreview: "first reply" },
      { firstUserMessage: null, lastMessagePreview: null },
      { firstUserMessage: "last prompt", lastMessagePreview: "last reply" },
    ]);

    await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: databasePath });
    expect(readSessionTitleFieldsFromTranscriptBatch(scopes)).toEqual([
      { firstUserMessage: "first prompt", lastMessagePreview: "first reply" },
      { firstUserMessage: "rebuilding prompt", lastMessagePreview: "rebuilding reply" },
      { firstUserMessage: "last prompt", lastMessagePreview: "last reply" },
    ]);
  });

  test.each(["watermarkBatch", "titleProbeBatch", "watermark", "messageEventPage"] as const)(
    "degrades only the unavailable scope when %s throws",
    async (faultSource) => {
      const actual = await vi.importActual<typeof import("../config/sessions/session-accessor.js")>(
        "../config/sessions/session-accessor.js",
      );
      const brokenSessionId = `reader-title-${faultSource}-broken`;
      const scopes: SessionTranscriptReadScope[] = [];
      for (const label of ["first", "broken", "last"]) {
        scopes.push(
          await writeSqliteMessages(`reader-title-${faultSource}-${label}`, [
            { role: "user", content: `${label} prompt` },
            { role: "assistant", content: `${label} reply` },
          ]),
        );
      }
      if (faultSource === "watermarkBatch") {
        readSessionTitleFieldsFromTranscriptBatch(scopes);
      }

      const watermarkBatch = vi.mocked(sessionAccessor.readSessionTranscriptWatermarkBatch);
      const titleProbeBatch = vi.mocked(sessionAccessor.readSessionTranscriptTitleProbeBatch);
      const watermark = vi.mocked(sessionAccessor.readSessionTranscriptWatermark);
      const messageEventPage = vi.mocked(sessionAccessor.readSessionTranscriptMessageEventPage);
      const unavailable = () =>
        new sessionAccessor.SessionTranscriptProjectionUnavailableError(brokenSessionId);
      try {
        if (faultSource === "watermarkBatch") {
          watermarkBatch.mockImplementation((readScopes) => {
            if (readScopes.some((scope) => scope.sessionId === brokenSessionId)) {
              throw unavailable();
            }
            return actual.readSessionTranscriptWatermarkBatch(readScopes);
          });
          watermark.mockImplementation((scope) => {
            if (scope.sessionId === brokenSessionId) {
              throw unavailable();
            }
            return actual.readSessionTranscriptWatermark(scope);
          });
        } else if (faultSource === "titleProbeBatch") {
          titleProbeBatch.mockImplementation((readScopes) => {
            if (readScopes.some((scope) => scope.sessionId === brokenSessionId)) {
              throw unavailable();
            }
            return actual.readSessionTranscriptTitleProbeBatch(readScopes);
          });
          messageEventPage.mockImplementation((scope, options) => {
            if (scope.sessionId === brokenSessionId) {
              throw unavailable();
            }
            return actual.readSessionTranscriptMessageEventPage(scope, options);
          });
        } else {
          titleProbeBatch.mockImplementation((readScopes) =>
            actual
              .readSessionTranscriptTitleProbeBatch(readScopes)
              .map((probe, index) =>
                readScopes[index]?.sessionId === brokenSessionId ? undefined : probe,
              ),
          );
          if (faultSource === "watermark") {
            watermark.mockImplementation((scope) => {
              if (scope.sessionId === brokenSessionId) {
                throw unavailable();
              }
              return actual.readSessionTranscriptWatermark(scope);
            });
          } else {
            messageEventPage.mockImplementation((scope, options) => {
              if (scope.sessionId === brokenSessionId) {
                throw unavailable();
              }
              return actual.readSessionTranscriptMessageEventPage(scope, options);
            });
          }
        }

        expect(readSessionTitleFieldsFromTranscriptBatch(scopes)).toEqual([
          { firstUserMessage: "first prompt", lastMessagePreview: "first reply" },
          { firstUserMessage: null, lastMessagePreview: null },
          { firstUserMessage: "last prompt", lastMessagePreview: "last reply" },
        ]);
      } finally {
        watermarkBatch.mockImplementation(actual.readSessionTranscriptWatermarkBatch);
        titleProbeBatch.mockImplementation(actual.readSessionTranscriptTitleProbeBatch);
        watermark.mockImplementation(actual.readSessionTranscriptWatermark);
        messageEventPage.mockImplementation(actual.readSessionTranscriptMessageEventPage);
      }
    },
  );

  test("isolates a batch failure when separate scopes share a session id", async () => {
    const actual = await vi.importActual<typeof import("../config/sessions/session-accessor.js")>(
      "../config/sessions/session-accessor.js",
    );
    const sessionId = "reader-title-duplicate-session-id";
    const scopes = [
      { agentId: "main", sessionId, sessionKey: "agent:main:duplicate-title" },
      { agentId: "work", sessionId, sessionKey: "agent:work:duplicate-title" },
    ];
    for (const [index, scope] of scopes.entries()) {
      await persistSessionTranscriptTurn(scope, {
        messages: [
          { message: { role: "user", content: `prompt ${index}` } },
          { message: { role: "assistant", content: `reply ${index}` } },
        ],
        touchSessionEntry: false,
      });
    }
    const titleProbeBatch = vi.mocked(sessionAccessor.readSessionTranscriptTitleProbeBatch);
    const messageEventPage = vi.mocked(sessionAccessor.readSessionTranscriptMessageEventPage);
    try {
      titleProbeBatch.mockImplementation(() => {
        throw new sessionAccessor.SessionTranscriptProjectionUnavailableError(sessionId);
      });
      messageEventPage.mockImplementation((scope, options) => {
        if (scope.agentId === "work") {
          throw new sessionAccessor.SessionTranscriptProjectionUnavailableError(sessionId);
        }
        return actual.readSessionTranscriptMessageEventPage(scope, options);
      });

      expect(readSessionTitleFieldsFromTranscriptBatch(scopes)).toEqual([
        { firstUserMessage: "prompt 0", lastMessagePreview: "reply 0" },
        { firstUserMessage: null, lastMessagePreview: null },
      ]);
    } finally {
      titleProbeBatch.mockImplementation(actual.readSessionTranscriptTitleProbeBatch);
      messageEventPage.mockImplementation(actual.readSessionTranscriptMessageEventPage);
    }
  });

  test.each(["single", "batch"] as const)(
    "bounds %s title probes without rereading their initial window",
    async (mode) => {
      const probeReadCount = async (sessionId: string, messageCount: number) => {
        const scope = await writeSqliteMessages(
          sessionId,
          Array.from({ length: messageCount }, () => ({ role: "assistant", content: " " })),
        );
        vi.clearAllMocks();

        const fields =
          mode === "single"
            ? readSessionTitleFieldsFromTranscript(scope)
            : readSessionTitleFieldsFromTranscriptBatch([scope])[0];
        expect(fields).toEqual({ firstUserMessage: null, lastMessagePreview: null });
        expect(sessionAccessor.readSessionTranscriptMessageEvents).not.toHaveBeenCalled();
        return boundedTitleEventReadCount();
      };

      await expect(probeReadCount("reader-title-bounded-101", 101)).resolves.toBe(200);
      await expect(probeReadCount("reader-title-bounded-201", 201)).resolves.toBe(200);
    },
  );

  test("reuses cached SQLite title fields while the transcript watermark is unchanged", async () => {
    const scope = await writeSqliteMessages("reader-title-cache-warm", [
      { role: "user", content: "cached prompt" },
      { role: "assistant", content: "cached reply" },
    ]);
    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: "cached prompt",
      lastMessagePreview: "cached reply",
    });
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: "cached prompt",
      lastMessagePreview: "cached reply",
    });
    expect(sessionAccessor.readSessionTranscriptMessageEventPage).not.toHaveBeenCalled();
  });

  test("skips batch title probes while every cached transcript watermark is unchanged", async () => {
    const scope = await writeSqliteMessages("reader-title-batch-cache-warm", [
      { role: "user", content: "cached batch prompt" },
      { role: "assistant", content: "cached batch reply" },
    ]);
    expect(readSessionTitleFieldsFromTranscriptBatch([scope])).toEqual([
      { firstUserMessage: "cached batch prompt", lastMessagePreview: "cached batch reply" },
    ]);
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscriptBatch([scope])).toEqual([
      { firstUserMessage: "cached batch prompt", lastMessagePreview: "cached batch reply" },
    ]);
    expect(sessionAccessor.readSessionTranscriptWatermarkBatch).toHaveBeenCalledOnce();
    expect(sessionAccessor.readSessionTranscriptWatermark).not.toHaveBeenCalled();
    expect(sessionAccessor.readSessionTranscriptTitleProbeBatch).not.toHaveBeenCalled();
    expect(sessionAccessor.readSessionTranscriptMessageEventPage).not.toHaveBeenCalled();
  });

  test("resolves SQLite store ownership once for a multi-row transcript batch", async () => {
    const scopes: SessionTranscriptReadScope[] = [];
    for (let index = 0; index < 30; index += 1) {
      scopes.push(
        await writeSqliteMessages(`reader-title-target-batch-${index}`, [
          { role: "user", content: `prompt ${index}` },
          { role: "assistant", content: `reply ${index}` },
        ]),
      );
    }
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare");
    try {
      for (const readBatch of [
        sessionAccessor.readSessionTranscriptTitleProbeBatch,
        sessionAccessor.readSessionTranscriptWatermarkBatch,
      ]) {
        prepareSpy.mockClear();
        expect(readBatch(scopes.slice(0, 1))).toHaveLength(1);
        const singleSessionSchemaReads = prepareSpy.mock.calls.filter(([sql]) =>
          sql.toLowerCase().includes("pragma user_version"),
        ).length;

        prepareSpy.mockClear();
        expect(readBatch(scopes)).toHaveLength(scopes.length);
        const batchSchemaReads = prepareSpy.mock.calls.filter(([sql]) =>
          sql.toLowerCase().includes("pragma user_version"),
        ).length;
        expect(batchSchemaReads).toBe(singleSessionSchemaReads);
        expect(batchSchemaReads).toBeGreaterThan(0);
      }
    } finally {
      prepareSpy.mockRestore();
    }
  });

  test("reprobes cached batch title fields after an append advances max seq", async () => {
    const sessionId = "reader-title-batch-cache-append";
    const scope = await writeSqliteMessages(sessionId, [
      { role: "user", content: "batch append prompt" },
      { role: "assistant", content: "first batch reply" },
    ]);
    expect(readSessionTitleFieldsFromTranscriptBatch([scope])[0]?.lastMessagePreview).toBe(
      "first batch reply",
    );
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey: `agent:main:${sessionId}`, storePath },
      {
        messages: [{ message: { role: "assistant", content: "appended batch reply" } }],
        touchSessionEntry: false,
      },
    );
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscriptBatch([scope])[0]?.lastMessagePreview).toBe(
      "appended batch reply",
    );
    expect(sessionAccessor.readSessionTranscriptWatermarkBatch).toHaveBeenCalledOnce();
    expect(sessionAccessor.readSessionTranscriptWatermark).not.toHaveBeenCalled();
    expect(sessionAccessor.readSessionTranscriptTitleProbeBatch).toHaveBeenCalledOnce();
    expect(sessionAccessor.readSessionTranscriptMessageEventPage).not.toHaveBeenCalled();
  });

  test("invalidates cached SQLite title fields after an append advances max seq", async () => {
    const sessionId = "reader-title-cache-append";
    const scope = await writeSqliteMessages(sessionId, [
      { role: "user", content: "append prompt" },
      { role: "assistant", content: "first reply" },
    ]);
    expect(readSessionTitleFieldsFromTranscript(scope).lastMessagePreview).toBe("first reply");
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey: `agent:main:${sessionId}`, storePath },
      {
        messages: [{ message: { role: "assistant", content: "appended reply" } }],
        touchSessionEntry: false,
      },
    );
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscript(scope).lastMessagePreview).toBe("appended reply");
    expect(sessionAccessor.readSessionTranscriptMessageEventPage).toHaveBeenCalled();
  });

  test("invalidates cached SQLite title fields after the rewrite generation changes", async () => {
    const sessionId = "reader-title-cache-generation";
    const scope = await writeSqliteMessages(sessionId, [
      { role: "user", content: "generation prompt" },
      { role: "assistant", content: "generation reply" },
    ]);
    expect(readSessionTitleFieldsFromTranscript(scope).firstUserMessage).toBe("generation prompt");
    openOpenClawAgentDatabase({
      agentId: "main",
      path: path.join(tempDir, "openclaw-agent.sqlite"),
    })
      .db.prepare("UPDATE transcript_rewrite_watermarks SET generation = ? WHERE session_id = ?")
      .run("f".repeat(32), sessionId);
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: "generation prompt",
      lastMessagePreview: "generation reply",
    });
    expect(sessionAccessor.readSessionTranscriptMessageEventPage).toHaveBeenCalled();
  });

  test("returns missing title fields when the bounded head and tail caps miss", async () => {
    const scope = await writeSqliteMessages(
      "reader-title-cap-miss",
      Array.from({ length: 201 }, (_, index) =>
        index === 100
          ? { role: "user", content: "outside both probes" }
          : { role: "assistant", content: " " },
      ),
    );
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: null,
      lastMessagePreview: null,
    });
    expect(sessionAccessor.readSessionTranscriptMessageEvents).not.toHaveBeenCalled();
    expect(boundedTitleEventReadCount()).toBe(200);
  });
});

describe("session transcript Markdown title previews", () => {
  test.each(["single", "batch"] as const)(
    "flattens last-message Markdown in the %s title reader",
    async (mode) => {
      const scope = await writeSqliteMessages(`reader-title-markdown-${mode}`, [
        { role: "user", content: "Keep **title Markdown** unchanged" },
        {
          role: "assistant",
          content:
            "# Done\n\nLanded [PR #124879](https://github.com/openclaw/openclaw/pull/124879) with **green** CI. Use foo_bar_baz from ~/.openclaw.",
        },
      ]);
      const fields =
        mode === "single"
          ? readSessionTitleFieldsFromTranscript(scope)
          : readSessionTitleFieldsFromTranscriptBatch([scope])[0];

      expect(fields).toEqual({
        firstUserMessage: "Keep **title Markdown** unchanged",
        lastMessagePreview:
          "Done Landed PR #124879 with green CI. Use foo_bar_baz from ~/.openclaw.",
      });
    },
  );

  test.each(["single", "batch"] as const)(
    "returns no %s title preview when Markdown flattens to empty",
    async (mode) => {
      const scope = await writeSqliteMessages(`reader-title-empty-markdown-${mode}`, [
        { role: "assistant", content: "```ts\nconst hidden = true;\n```" },
      ]);
      const fields =
        mode === "single"
          ? readSessionTitleFieldsFromTranscript(scope)
          : readSessionTitleFieldsFromTranscriptBatch([scope])[0];

      expect(fields?.lastMessagePreview).toBeNull();
    },
  );

  test.each([
    { mode: "single", widen: false },
    { mode: "batch", widen: false },
    { mode: "single", widen: true },
    { mode: "batch", widen: true },
  ] as const)(
    "stops reading older content after the newest visible $mode preview (widen=$widen)",
    async ({ mode, widen }) => {
      const hiddenMessages = [
        { role: "toolResult", content: "tool output" },
        { role: "system", content: "system event" },
        { role: "assistant", content: [{ type: "thinking", thinking: "private thought" }] },
        { role: "assistant", content: "NO_REPLY" },
        { role: "assistant", content: "ANNOUNCE_SKIP" },
        { role: "assistant", content: "REPLY_SKIP" },
        { role: "assistant", content: [{ type: "text", text: "" }] },
        { role: "assistant", content: "```ts\nconst hidden = true;\n```" },
      ];
      const olderText = "Earlier **reply**";
      // Keep the observed row outside the first-user head probe, including after widening.
      const prefix = [
        { role: "user", content: "Keep **title Markdown** unchanged" },
        ...Array.from({ length: 100 }, () => ({ role: "toolResult", content: "tool output" })),
      ];
      const olderSeq = prefix.length + 1;
      const scope = await writeSqliteMessages(`reader-title-short-circuit-${mode}-${widen}`, [
        ...prefix,
        { role: "assistant", content: [{ type: "text", text: olderText }] },
        { role: "assistant", content: "# Latest\n\nRead the [guide](https://example.com)." },
        ...(widen ? Array.from({ length: 3 }, () => hiddenMessages).flat() : []),
      ]);
      const actual = await vi.importActual<typeof import("../config/sessions/session-accessor.js")>(
        "../config/sessions/session-accessor.js",
      );
      const readOlderText = vi.fn(() => olderText);
      let observedRows = 0;
      const observeOlderContent = (
        entries: Pick<SessionTranscriptMessageEvent, "event" | "seq">[],
      ) => {
        for (const entry of entries) {
          if (entry.seq !== olderSeq) {
            continue;
          }
          observedRows += 1;
          entry.event = {
            ...asOptionalRecord(entry.event),
            message: {
              role: "assistant",
              // Nested text survives transcript metadata normalization; only projection reads it.
              content: [
                {
                  type: "text",
                  get text() {
                    return readOlderText();
                  },
                },
              ],
            },
          };
        }
      };
      const pageReader = vi.mocked(sessionAccessor.readSessionTranscriptMessageEventPage);
      const batchReader = vi.mocked(sessionAccessor.readSessionTranscriptTitleProbeBatch);
      try {
        pageReader.mockImplementation((readScope, options) => {
          const page = actual.readSessionTranscriptMessageEventPage(readScope, options);
          observeOlderContent(page.events);
          return page;
        });
        batchReader.mockImplementation((readScopes) => {
          const probes = actual.readSessionTranscriptTitleProbeBatch(readScopes);
          for (const probe of probes) {
            if (probe) {
              observeOlderContent(probe.tail);
            }
          }
          return probes;
        });

        const fields =
          mode === "single"
            ? readSessionTitleFieldsFromTranscript(scope)
            : readSessionTitleFieldsFromTranscriptBatch([scope])[0];

        expect(fields).toEqual({
          firstUserMessage: "Keep **title Markdown** unchanged",
          lastMessagePreview: "Latest Read the guide.",
        });
        expect(observedRows).toBe(1);
        expect(readOlderText).not.toHaveBeenCalled();
      } finally {
        pageReader.mockImplementation(actual.readSessionTranscriptMessageEventPage);
        batchReader.mockImplementation(actual.readSessionTranscriptTitleProbeBatch);
      }
    },
  );
});

test("resolves placeholder store paths before batched title reads", async () => {
  const sessionId = "reader-placeholder-batched-title";
  const sessionKey = `agent:main:${sessionId}`;
  const defaultStorePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  await persistSessionTranscriptTurn(
    { agentId: "main", sessionId, sessionKey, storePath: defaultStorePath },
    {
      messages: [
        { message: { role: "user", content: "real prompt" } },
        { message: { role: "assistant", content: "real reply" } },
      ],
      touchSessionEntry: false,
    },
  );

  expect(
    readSessionTitleFieldsFromTranscriptBatch([
      { agentId: "main", sessionId, sessionKey, storePath: "(multiple)" },
    ]),
  ).toEqual([{ firstUserMessage: "real prompt", lastMessagePreview: "real reply" }]);
});
