import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { MAX_AGENT_HOOK_HISTORY_MESSAGES } from "../harness/hook-history.js";
import { SessionManager } from "../sessions/session-manager.js";
import { cliBackendLog } from "./log.js";
import {
  buildCliSessionHistoryPrompt,
  hasCliSessionTranscript,
  loadCliSessionContextEngineMessages,
  loadCliSessionHistoryMessages,
  loadCliSessionReseedMessages,
  resolveAutoCliSessionReseedHistoryChars,
} from "./session-history.js";

const MAX_CLI_SESSION_HISTORY_MESSAGES = MAX_AGENT_HOOK_HISTORY_MESSAGES;
const MAX_CLI_SESSION_RESEED_HISTORY_CHARS = 12 * 1024;
const MAX_AUTO_CLI_SESSION_RESEED_HISTORY_CHARS = 256 * 1024;
const RESEED_CURRENCY_GUIDANCE =
  "[Recovered history may be stale; verify current and time-sensitive facts before acting.]";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function withReseedGuidanceBudget(historyChars: number): number {
  return RESEED_CURRENCY_GUIDANCE.length + "\n".length + historyChars;
}

function extractReseedHistory(prompt: string | undefined): string {
  return prompt?.match(/<conversation_history>\n([\s\S]*?)\n<\/conversation_history>/)?.[1] ?? "";
}

async function withCliSessionState<T>(stateDir: string, run: () => Promise<T>): Promise<T> {
  return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, run);
}

async function createSession(messages: string[] = [], agentId = "main") {
  const dir = tempDirs.make("openclaw-cli-history-");
  const target = {
    agentId,
    sessionId: "history-session",
    sessionKey: `agent:${agentId}:history`,
    storePath: path.join(dir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  for (const [index, content] of messages.entries()) {
    await appendTranscriptMessage(target, {
      cwd: dir,
      eventId: `msg-${index}`,
      now: index + 1,
      message: { role: "user", content, timestamp: 0 },
    });
  }
  return { target, manager: SessionManager.open(target, dir), params: { sessionTarget: target } };
}

it("recovers SQLite-only compacted history across every CLI reader", async () => {
  const stateDir = tempDirs.make("openclaw-cli-sqlite-");
  await withCliSessionState(stateDir, async () => {
    const target = {
      agentId: "audit",
      sessionId: "sqlite-only",
      sessionKey: "agent:audit:main",
      storePath: path.join(stateDir, "agents", "audit", "sessions", "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(target, stateDir);
    const kept = manager.appendMessage({
      role: "user",
      content: "CANONICAL_HISTORY",
      timestamp: 1,
    });
    manager.appendCompaction("CANONICAL_SUMMARY", kept, 1000);
    manager.appendMessage({ role: "user", content: "CANONICAL_TAIL", timestamp: 3 });
    manager.flushPendingPersistence();
    expect(loadTranscriptEventsSync(target)).toHaveLength(4);
    expect(SessionManager.open(target).buildSessionContext().messages).toMatchObject([
      { role: "compactionSummary", summary: "CANONICAL_SUMMARY" },
      { role: "user", content: "CANONICAL_HISTORY" },
      { role: "user", content: "CANONICAL_TAIL" },
    ]);
    const params = { ...target, sessionTarget: target, sessionFile: target.sessionKey, config: {} };
    const history = await loadCliSessionHistoryMessages(params);
    const reseed = await loadCliSessionReseedMessages(params);
    const context = await loadCliSessionContextEngineMessages(params);
    const present = await hasCliSessionTranscript(params);
    const prompt = buildCliSessionHistoryPrompt({ messages: reseed, prompt: "next" });
    expect.soft(history).toMatchObject([
      { role: "user", content: "CANONICAL_HISTORY" },
      { role: "user", content: "CANONICAL_TAIL" },
    ]);
    for (const messages of [reseed, context]) {
      expect.soft(messages).toMatchObject([
        { role: "compactionSummary", summary: "CANONICAL_SUMMARY" },
        { role: "user", content: "CANONICAL_HISTORY" },
        { role: "user", content: "CANONICAL_TAIL" },
      ]);
    }
    expect.soft(present).toBe(true);
    expect.soft(prompt).toContain("CANONICAL_SUMMARY");
    expect.soft(prompt).toContain("CANONICAL_HISTORY");
    expect.soft(prompt).toContain("CANONICAL_TAIL");
  });
});

describe("canonical CLI history", () => {
  it("isolates explicit agent, session, and custom database targets", async () => {
    const first = await createSession(["first history"]);
    const second = await createSession(["second history"], "other");
    expect(resolveSessionTranscriptDatabasePath(first.target)).not.toBe(
      resolveSessionTranscriptDatabasePath(second.target),
    );
    await expect(loadCliSessionHistoryMessages(first.params)).resolves.toMatchObject([
      { content: "first history" },
    ]);
    await expect(loadCliSessionHistoryMessages(second.params)).resolves.toMatchObject([
      { content: "second history" },
    ]);
    await expect(
      loadCliSessionHistoryMessages({
        sessionTarget: { ...first.target, sessionId: "missing", sessionKey: "agent:main:missing" },
      }),
    ).resolves.toEqual([]);
    await expect(
      hasCliSessionTranscript({
        sessionTarget: { ...first.target, sessionId: "missing", sessionKey: "agent:main:missing" },
      }),
    ).resolves.toBe(false);
  });

  it("distinguishes a session row from a persisted transcript and allows ephemeral runs", async () => {
    const { params, manager } = await createSession();
    await expect(hasCliSessionTranscript(params)).resolves.toBe(false);
    manager.appendCustomEntry("state", {});
    await expect(hasCliSessionTranscript(params)).resolves.toBe(true);
    await expect(loadCliSessionHistoryMessages(params)).resolves.toEqual([]);
    const ephemeral = { sessionTarget: undefined };
    await expect(hasCliSessionTranscript(ephemeral)).resolves.toBe(false);
    await expect(loadCliSessionHistoryMessages(ephemeral)).resolves.toEqual([]);
    await expect(loadCliSessionReseedMessages(ephemeral)).resolves.toEqual([]);
    await expect(loadCliSessionContextEngineMessages(ephemeral)).resolves.toEqual([]);
  });

  it("bounds hooks and raw reseeding while preserving complete bounded context and row timestamps", async () => {
    const { params } = await createSession(
      Array.from({ length: MAX_CLI_SESSION_HISTORY_MESSAGES + 25 }, (_, i) => `msg-${i}`),
    );
    const history = await loadCliSessionHistoryMessages(params);
    expect(history).toHaveLength(MAX_CLI_SESSION_HISTORY_MESSAGES);
    expect(history[0]).toMatchObject({ content: "msg-25" });
    expect(history.at(-1)).toMatchObject({
      content: `msg-${MAX_CLI_SESSION_HISTORY_MESSAGES + 24}`,
    });
    const context = await loadCliSessionContextEngineMessages(params);
    expect(context).toHaveLength(MAX_CLI_SESSION_HISTORY_MESSAGES + 25);
    expect(context[0]).toMatchObject({ content: "msg-0" });
    const reseed = await loadCliSessionReseedMessages({
      ...params,
      allowRawTranscriptReseed: true,
      rawTranscriptReseedReason: "missing-transcript",
    });
    expect(reseed).toHaveLength(MAX_CLI_SESSION_HISTORY_MESSAGES);
    expect(reseed[0]).toMatchObject({ content: "msg-25", timestamp: "1970-01-01T00:00:00.026Z" });
    const prompt = buildCliSessionHistoryPrompt({ messages: reseed, prompt: "next" });
    expect(prompt).toContain("[1970-01-01T00:00:00.026Z] User: msg-25");
    expect(prompt).toContain(RESEED_CURRENCY_GUIDANCE);
  });

  it("keeps active-branch history after a durable branch switch", async () => {
    const { params, manager } = await createSession(["active root", "abandoned"]);
    manager.branch("msg-0");
    manager.appendMessage({ role: "user", content: "active tail", timestamp: 3 });
    for (const load of [loadCliSessionHistoryMessages, loadCliSessionContextEngineMessages]) {
      await expect(load(params)).resolves.toMatchObject([
        { content: "active root" },
        { content: "active tail" },
      ]);
    }
  });

  it("uses retained prefixes for compaction and reset without reviving older context", async () => {
    const { params, manager } = await createSession(["summarized", "retained"]);
    manager.appendCompaction("summary", "msg-1", 1000);
    const tail = manager.appendMessage({ role: "user", content: "tail", timestamp: 3 });
    await expect(loadCliSessionContextEngineMessages(params)).resolves.toMatchObject([
      { role: "compactionSummary", summary: "summary", firstKeptEntryId: "msg-1" },
      { content: "retained" },
      { content: "tail" },
    ]);
    await expect(loadCliSessionHistoryMessages(params)).resolves.toMatchObject([
      { content: "summarized" },
      { content: "retained" },
      { content: "tail" },
    ]);
    manager.appendResetBoundary("reset", tail);
    manager.appendMessage({ role: "user", content: "after reset", timestamp: 4 });
    for (const load of [loadCliSessionHistoryMessages, loadCliSessionContextEngineMessages]) {
      await expect(load(params)).resolves.toMatchObject([
        { content: "tail" },
        { content: "after reset" },
      ]);
    }
    await expect(loadCliSessionReseedMessages(params)).resolves.toEqual([]);
  });

  it("preserves custom and branch context and compaction metadata", async () => {
    const { params, target } = await createSession(["retained"]);
    await appendTranscriptEvent(target, {
      type: "compaction",
      id: "compact",
      parentId: "msg-0",
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "summary",
      firstKeptEntryId: "msg-0",
      tokensBefore: 100,
      tokensAfter: 10,
      details: { source: "test" },
    });
    await appendTranscriptEvent(target, {
      type: "custom_message",
      id: "custom",
      parentId: "compact",
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "runtime-note",
      content: "custom context",
      display: false,
    });
    await appendTranscriptEvent(target, {
      type: "branch_summary",
      id: "branch",
      parentId: "custom",
      fromId: "msg-0",
      timestamp: "2026-01-01T00:00:02.000Z",
      summary: "branch context",
    });
    await expect(loadCliSessionContextEngineMessages(params)).resolves.toMatchObject([
      {
        role: "compactionSummary",
        summary: "summary",
        timestamp: "2026-01-01T00:00:00.000Z",
        tokensBefore: 100,
        tokensAfter: 10,
        firstKeptEntryId: "msg-0",
        details: { source: "test" },
      },
      { content: "retained" },
      { role: "custom", content: "custom context", display: false },
      { role: "branchSummary", summary: "branch context" },
    ]);
    const reseed = await loadCliSessionReseedMessages(params);
    expect(reseed).toMatchObject([
      { role: "compactionSummary", timestamp: "2026-01-01T00:00:00.000Z" },
      { content: "retained", timestamp: "1970-01-01T00:00:00.001Z" },
    ]);
  });

  it("bounds SQLite payload hydration and announces discarded history", async () => {
    const { params } = await createSession(["x".repeat(5 * 1024 * 1024), "tail history"]);
    const warn = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => {});
    try {
      for (const load of [loadCliSessionHistoryMessages, loadCliSessionContextEngineMessages]) {
        await expect(load(params)).resolves.toMatchObject([{ content: "tail history" }]);
      }
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("cli session history truncated"));
    } finally {
      warn.mockRestore();
    }
  });

  it.each(["auth-profile", "auth-epoch"] as const)(
    "does not raw-reseed %s invalidations even when opted in",
    async (reason) => {
      const { params } = await createSession(["previous account context"]);
      await expect(
        loadCliSessionReseedMessages({
          ...params,
          allowRawTranscriptReseed: true,
          rawTranscriptReseedReason: reason,
        }),
      ).resolves.toEqual([]);
    },
  );

  it.each([
    "missing-transcript",
    "orphaned-tool-use",
    "message-policy",
    "system-prompt",
    "cwd",
    "mcp",
    "session-expired",
  ] as const)("raw-reseeds consecutive user rows for %s only with opt-in", async (reason) => {
    const { params } = await createSession(["first ambient", "second ambient", "current ask"]);
    await expect(
      loadCliSessionReseedMessages({ ...params, rawTranscriptReseedReason: reason }),
    ).resolves.toEqual([]);
    await expect(
      loadCliSessionReseedMessages({ ...params, allowRawTranscriptReseed: true }),
    ).resolves.toEqual([]);
    await expect(
      loadCliSessionReseedMessages({
        ...params,
        allowRawTranscriptReseed: true,
        rawTranscriptReseedReason: reason,
      }),
    ).resolves.toMatchObject([
      { content: "first ambient" },
      { content: "second ambient" },
      { content: "current ask" },
    ]);
  });
});

describe("buildCliSessionHistoryPrompt", () => {
  it("renders OpenClaw transcript history around the next user message", () => {
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "user", content: "old ask" },
        { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      ],
      prompt: "new ask",
    });

    expect(prompt).toContain("User: old ask");
    expect(prompt).toContain("Assistant: old answer");
    expect(prompt).toContain("<next_user_message>\nnew ask\n</next_user_message>");
  });

  it("renders canonical saved timestamps and omits invalid or noncanonical timestamps", () => {
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "user", content: "dated ask", timestamp: "2026-06-17T16:00:00.000Z" },
        { role: "assistant", content: "zero date answer", timestamp: "0" },
        { role: "user", content: "year-only ask", timestamp: "2026" },
        { role: "assistant", content: "invalid date answer", timestamp: "not-a-date" },
        { role: "user", content: "offset date ask", timestamp: "2026-06-17T12:00:00-04:00" },
        { role: "assistant", content: "undated answer" },
      ],
      prompt: "new ask",
    });

    expect(prompt).toContain("[2026-06-17T16:00:00.000Z] User: dated ask");
    expect(prompt).toMatch(
      /Assistant: zero date answer[\s\S]*User: year-only ask[\s\S]*Assistant: invalid date answer[\s\S]*User: offset date ask[\s\S]*Assistant: undated answer/u,
    );
    expect(prompt).not.toMatch(
      /\[(?:2000-01-01T00:00:00\.000Z|2026-01-01T00:00:00\.000Z|not-a-date|2026-06-17T12:00:00-04:00)\]/u,
    );
    expect(prompt).toContain(RESEED_CURRENCY_GUIDANCE);
  });

  it("skips reseed text when the transcript has no renderable conversation", () => {
    expect(
      buildCliSessionHistoryPrompt({
        messages: [{ role: "tool", content: "ignored" }],
        prompt: "new ask",
      }),
    ).toBeUndefined();
  });

  it("caps rendered reseed history before adding the next user message", () => {
    const maxHistoryChars = withReseedGuidanceBudget(80);
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "user", content: "x".repeat(100) },
        { role: "assistant", content: "y".repeat(100) },
      ],
      prompt: "current ask must survive",
      maxHistoryChars,
    });

    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    expect(prompt).toContain("<next_user_message>\ncurrent ask must survive\n</next_user_message>");
    // Older 100-char prefix must be dropped by the tail slice; the
    // post-cap rendered tail is shorter than the dropped prefix.
    expect(prompt).not.toContain("x".repeat(80));
    expect(extractReseedHistory(prompt).length).toBeLessThanOrEqual(maxHistoryChars);
  });

  it("keeps a whole code point when the retained history tail starts inside an emoji", () => {
    const prompt = buildCliSessionHistoryPrompt({
      messages: [{ role: "user", content: "prefix😀tail" }],
      prompt: "next",
      maxHistoryChars: withReseedGuidanceBudget(5),
    });

    expect(prompt).toContain(
      `<conversation_history>\n${RESEED_CURRENCY_GUIDANCE}\ntail\n</conversation_history>`,
    );
  });

  it("scales automatic reseed history caps from Claude context tiers", () => {
    expect(resolveAutoCliSessionReseedHistoryChars(0)).toBe(MAX_CLI_SESSION_RESEED_HISTORY_CHARS);
    expect(resolveAutoCliSessionReseedHistoryChars(32_000)).toBe(
      MAX_CLI_SESSION_RESEED_HISTORY_CHARS,
    );
    expect(resolveAutoCliSessionReseedHistoryChars(200_000)).toBe(64_000);
    expect(resolveAutoCliSessionReseedHistoryChars(1_048_576)).toBe(
      MAX_AUTO_CLI_SESSION_RESEED_HISTORY_CHARS,
    );
  });

  it("keeps the most recent turns when rendered history exceeds the cap", () => {
    // Older turns plus a final marker turn whose content is exactly what a
    // head-slice would drop first. Asserting the marker survives in the
    // rendered prompt locks in tail-slice semantics: a session-recovery
    // feature must keep the latest context, not the oldest.
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "user", content: "x".repeat(8000) },
        { role: "assistant", content: "y".repeat(8000) },
        { role: "user", content: "FINAL_USER_MARKER" },
        { role: "assistant", content: "FINAL_ASSISTANT_MARKER" },
      ],
      prompt: "next ask",
    });

    expect(prompt).toBeDefined();
    expect(prompt).toContain("FINAL_USER_MARKER");
    expect(prompt).toContain("FINAL_ASSISTANT_MARKER");
    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    // The oldest 8000-char block must have been dropped — a head-slice
    // would have kept it instead of the recent tail.
    expect(prompt).not.toContain("x".repeat(8000));
    expect(prompt).toContain("<next_user_message>\nnext ask\n</next_user_message>");
  });

  it("preserves the compaction summary when the post-summary transcript exceeds the cap", () => {
    // loadCliSessionReseedMessages places a compactionSummary entry first
    // so the compacted prior context survives reseed. A blind tail slice
    // of the joined history would drop that summary whenever the
    // post-summary tail alone exceeds the cap. The structure-aware
    // truncation pins the summary as a prefix and caps only the tail.
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "compactionSummary", summary: "COMPACTION_SUMMARY_MARKER pinned context" },
        { role: "user", content: "z".repeat(8000) },
        { role: "assistant", content: "w".repeat(8000) },
        { role: "user", content: "POST_SUMMARY_FINAL_USER" },
        { role: "assistant", content: "POST_SUMMARY_FINAL_ASSISTANT" },
      ],
      prompt: "next ask",
    });

    expect(prompt).toBeDefined();
    // Compaction summary must be pinned as a prefix, not sliced away.
    expect(prompt).toContain("Compaction summary: COMPACTION_SUMMARY_MARKER pinned context");
    // Recent tail still preserved within the post-summary budget.
    expect(prompt).toContain("POST_SUMMARY_FINAL_USER");
    expect(prompt).toContain("POST_SUMMARY_FINAL_ASSISTANT");
    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    // Head of post-summary tail (oldest 8000-char `z` block) must be
    // dropped so the cap is honored.
    expect(prompt).not.toContain("z".repeat(8000));
    expect(prompt).toContain("<next_user_message>\nnext ask\n</next_user_message>");
    expect(extractReseedHistory(prompt).length).toBeLessThanOrEqual(
      MAX_CLI_SESSION_RESEED_HISTORY_CHARS,
    );
  });

  it("caps oversize compaction summary while preserving recent post-summary tail", () => {
    // Two regressions covered here:
    // 1. `tailRaw.slice(-0)` would return the entire tail (JS quirk:
    //    `String.prototype.slice(-0) === slice(0)`), defeating the cap when
    //    the summary block consumes the budget.
    // 2. Pinning the full summary as-is when the summary itself exceeds
    //    `maxHistoryChars` would blow past the cap that prevents
    //    reseeding fresh CLI sessions with unexpectedly huge prompts.
    //    The summary must itself be truncated to fit the budget while still
    //    preserving the recent post-summary exact turns.
    const summaryText = "OVERSIZE_SUMMARY_MARKER ".repeat(50).trim();
    const historyBudget = 200;
    const maxHistoryChars = withReseedGuidanceBudget(historyBudget);
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "compactionSummary", summary: summaryText },
        { role: "user", content: "POST_SUMMARY_USER_DROPPED" },
        { role: "assistant", content: "POST_SUMMARY_ASSISTANT_DROPPED" },
      ],
      prompt: "next ask",
      // Cap well below the rendered summary block so the summary itself
      // must be truncated and the tail budget would naively be 0.
      maxHistoryChars,
    });

    expect(prompt).toBeDefined();
    // The truncated summary still leads with recognizable load-bearing
    // text — head-slicing preserves the orientation/intro of the summary.
    expect(prompt).toContain("OVERSIZE_SUMMARY_MARKER");
    expect(prompt).toContain("Compaction summary:");
    // The leading truncation marker is present so the prompt announces
    // what was discarded.
    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    // The cap is honored: the rendered <conversation_history> block
    // must not blow past `maxHistoryChars` plus a small wrapper allowance.
    const historyMatch = prompt?.match(
      /<conversation_history>\n([\s\S]*?)\n<\/conversation_history>/,
    );
    expect(historyMatch).not.toBeNull();
    const renderedHistory = historyMatch?.[1] ?? "";
    expect(renderedHistory.length).toBeLessThanOrEqual(maxHistoryChars);
    // The full untruncated summary must NOT appear — that would defeat
    // the cap.
    expect(prompt).not.toContain(summaryText);
    // Post-summary exact turns are newer than the summary and must still
    // survive inside the reserved tail budget.
    expect(prompt).toContain("POST_SUMMARY_USER_DROPPED");
    expect(prompt).toContain("POST_SUMMARY_ASSISTANT_DROPPED");
    expect(prompt).toContain("<next_user_message>\nnext ask\n</next_user_message>");
  });

  it("keeps a whole code point at an oversize compaction-summary boundary", () => {
    const prompt = buildCliSessionHistoryPrompt({
      messages: [{ role: "compactionSummary", summary: `aa😀${"z".repeat(100)}` }],
      prompt: "next",
      maxHistoryChars: withReseedGuidanceBudget(80),
    });

    expect(prompt).toContain(
      `<conversation_history>\n${RESEED_CURRENCY_GUIDANCE}\n[OpenClaw reseed history truncated; older turns dropped]\nCompaction summary: aa\n</conversation_history>`,
    );
  });

  it("honors the cap when the summary block plus marker crosses it", () => {
    // Edge case: the summary fits but leaves too little room for the
    // truncation marker plus a useful exact tail. Rebalance the summary and
    // tail instead of exceeding the cap or silently dropping the marker.
    const historyBudget = 200;
    const maxHistoryChars = withReseedGuidanceBudget(historyBudget);
    const remainingBudget = 10;
    const summaryPrefix = "Compaction summary: ";
    const summaryText = "S".repeat(
      historyBudget - remainingBudget - "\n\n".length - summaryPrefix.length,
    );
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "compactionSummary", summary: summaryText },
        { role: "user", content: "POST_SUMMARY_TAIL_USER" },
        { role: "assistant", content: "POST_SUMMARY_TAIL_ASSISTANT" },
      ],
      prompt: "next ask",
      maxHistoryChars,
    });

    expect(prompt).toBeDefined();
    const historyMatch = prompt?.match(
      /<conversation_history>\n([\s\S]*?)\n<\/conversation_history>/,
    );
    expect(historyMatch).not.toBeNull();
    const renderedHistory = historyMatch?.[1] ?? "";
    expect(renderedHistory.length).toBeLessThanOrEqual(maxHistoryChars);
    // Marker is still present so the prompt announces what was discarded.
    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    // Near-cap summaries still reserve room for the newest exact turns.
    expect(prompt).toContain("POST_SUMMARY_TAIL_USER");
    expect(prompt).toContain("POST_SUMMARY_TAIL_ASSISTANT");
  });

  it("keeps fitting post-summary history without a false truncation marker", () => {
    const historyBudget = 200;
    const remainingBudget = 10;
    const summaryPrefix = "Compaction summary: ";
    const summaryText = "S".repeat(
      historyBudget - remainingBudget - "\n\n".length - summaryPrefix.length,
    );
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "compactionSummary", summary: summaryText },
        { role: "user", content: "tail" },
      ],
      prompt: "next ask",
      maxHistoryChars: withReseedGuidanceBudget(historyBudget),
    });

    expect(prompt).toContain(`Compaction summary: ${summaryText}`);
    expect(prompt).toContain("User: tail");
    expect(prompt).not.toContain("[OpenClaw reseed history truncated; older turns dropped]");
  });
});
