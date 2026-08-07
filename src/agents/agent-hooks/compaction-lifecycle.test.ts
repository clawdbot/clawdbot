/**
 * End-to-end proof for the compaction summary-loss defect: the real
 * session_before_compact handler produces the stored artifact, the artifact is
 * written to a session transcript, and the real session loader rebuilds it into
 * the next run's first message.
 *
 * Kept out of compaction-safeguard.test.ts because it spans the agent hook and
 * the CLI session loader, and that file is already grandfathered as oversized.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionAPI, ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  clearCompactionProviders,
  registerCompactionProvider,
} from "../../plugins/compaction-provider.js";
import { SessionManager } from "../sessions/session-manager.js";
import { setCompactionSafeguardRuntime } from "./compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "./compaction-safeguard.js";
import { testing } from "./compaction-safeguard.test-support.js";

const BODY_MARKER = "BODY-MARKER-decisions-that-must-survive";
const SUMMARY_BODY = `## Decisions\n${BODY_MARKER}\n## Exact identifiers\nN823JB`;

function stubSessionManager(): ExtensionContext["sessionManager"] {
  return {
    getCwd: () => "/stub",
    getSessionId: () => "stub-id",
    getSessionTarget: () => undefined,
    getLeafId: () => null,
    getAppendParentId: () => null,
    getAppendMode: () => undefined,
    getLeafEntry: () => undefined,
    getEntry: () => undefined,
    getLabel: () => undefined,
    getBranch: () => [],
    getHeader: () => null,
    getEntries: () => [],
    getTree: () => [],
    getSessionName: () => undefined,
  } as ExtensionContext["sessionManager"];
}

function modelFixture(): Model {
  return {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    provider: "anthropic",
    api: "anthropic" as const,
    baseUrl: "https://api.anthropic.com",
    contextWindow: 200000,
    maxTokens: 4096,
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
  };
}

type CompactionHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

function createCompactionHandler(): CompactionHandler {
  let handler: CompactionHandler | undefined;
  const mockApi = {
    on: vi.fn((event: string, registered: CompactionHandler) => {
      if (event === "session_before_compact") {
        handler = registered;
      }
    }),
  } as unknown as ExtensionAPI;
  compactionSafeguardExtension(mockApi);
  if (!handler) {
    throw new Error("Expected compaction safeguard to register a handler.");
  }
  return handler;
}

/**
 * A long split turn is the shape that produces the defect. The split-turn
 * prefix grows with the turn, and compaction fires precisely on long turns.
 */
function longSplitTurn(): AgentMessage[] {
  return Array.from({ length: 60 }, (_unused, i) => ({
    role: "toolResult",
    toolName: "bash",
    // Two blocks, so the rendered message spans lines the way real tool output
    // does. extractMessageText joins content blocks with a newline.
    content: [
      { type: "text", text: `step-${i} stdout` },
      { type: "text", text: `detail-${i} ${"d".repeat(500)}` },
    ],
    timestamp: i + 1,
  })) as AgentMessage[];
}

function preservedTurns(): AgentMessage[] {
  return [
    {
      role: "assistant",
      // Two blocks rather than an embedded newline: extractMessageText joins
      // blocks with a newline, so this is how a multiline turn actually
      // reaches the formatter. A bare toolResult would be dropped here, since
      // repairToolUseResultPairing removes results with no matching call.
      content: [
        { type: "text", text: "PRESERVED line one" },
        { type: "text", text: "PRESERVED line two" },
      ],
      timestamp: 900,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "closing assistant turn" }],
      timestamp: 901,
    },
  ] as AgentMessage[];
}

describe("compaction artifact lifecycle", () => {
  const tmpDirs: string[] = [];

  beforeEach(() => {
    testing.setSummarizeInStagesForTest(
      vi.fn(async () => ({ kind: "summary" as const, text: SUMMARY_BODY })),
    );
    // The split-turn prefix reaches the artifact RAW on the compaction-provider
    // path, and on origin/main that section has no bound of its own. That is
    // the shape that drives the suffix past MAX_COMPACTION_SUMMARY_CHARS.
    registerCompactionProvider({
      id: "lifecycle-provider",
      label: "Lifecycle Provider",
      summarize: async () => SUMMARY_BODY,
    });
  });

  afterEach(() => {
    testing.setSummarizeInStagesForTest();
    clearCompactionProviders();
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function runHandler(): Promise<string> {
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      provider: "lifecycle-provider",
      model: modelFixture(),
      maxHistoryShare: 0.5,
      recentTurnsPreserve: 2,
    });

    const handler = createCompactionHandler();
    const ctx = {
      model: undefined,
      sessionManager,
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key" })),
      },
    } as unknown as Partial<ExtensionContext>;

    const result = (await handler(
      {
        preparation: {
          messagesToSummarize: [
            ...Array.from({ length: 6 }, (_unused, i) => ({
              role: "user",
              content: `history-${i} ${"h".repeat(400)}`,
              timestamp: i + 1,
            })),
            ...preservedTurns(),
          ] as AgentMessage[],
          turnPrefixMessages: longSplitTurn(),
          firstKeptEntryId: "entry-1",
          tokensBefore: 400_000,
          fileOps: { read: ["a.ts"], edited: ["b.ts"], written: [] },
          settings: { reserveTokens: 4000 },
          previousSummary: undefined,
          isSplitTurn: true,
        },
        customInstructions: "",
        signal: new AbortController().signal,
      },
      ctx,
    )) as { cancel?: boolean; compaction?: { summary?: string } };

    expect(result.cancel).not.toBe(true);
    const summary = result.compaction?.summary;
    expect(typeof summary).toBe("string");
    return summary as string;
  }

  it("keeps the summary body in the stored artifact when the suffix is oversized", async () => {
    const stored = await runHandler();

    // The defect: once the appended suffix reached the cap, the stored artifact
    // was the suffix tail alone and carried none of the generated summary.
    expect(stored).toContain(BODY_MARKER);
    expect(stored.length).toBeLessThanOrEqual(testing.MAX_COMPACTION_SUMMARY_CHARS);
    // Every suffix contributor is present, so the body is surviving alongside a
    // real suffix rather than because the suffix was empty. This fixture no
    // longer reaches the cap at all, which is the fix: on origin/main the same
    // split turn is unbounded. The discriminating evidence is the negative
    // proof against origin/main, not an assertion available on this branch.
    expect(stored).toContain("## Recent turns preserved verbatim");
    expect(stored).toContain("<modified-files>");
  });

  it("rebuilds the summary body into the next run's context through the real writer", async () => {
    // Nothing here is hand-written. The transcript is produced by the same
    // SessionManager.appendCompaction the runtime calls
    // (agent-session-compaction.ts), and the next run's messages come from the
    // same buildSessionContext the runtime assigns to agent.state.messages.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-lifecycle-"));
    tmpDirs.push(dir);
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "lifecycle-session";
    const sessionKey = "agent:main:lifecycle";
    const marker = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });

    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      { sessionFile: marker, sessionId, updatedAt: 10 },
    );
    await appendTranscriptMessage(
      { agentId: "main", sessionId, sessionKey, storePath },
      { cwd: dir, message: { role: "user", content: "before compaction" } },
    );

    const target = parseSqliteSessionFileMarker(marker);
    if (!target) {
      throw new Error("expected SQLite transcript marker fixture");
    }
    const sessionManager = SessionManager.open({ ...target, sessionKey }, dir);
    const firstKeptEntryId = sessionManager.appendMessage({
      role: "user",
      content: "after compaction",
      timestamp: 1_000,
    });

    const stored = await runHandler();

    // The real writer, with fromHook=true as the safeguard path passes it.
    sessionManager.appendCompaction(stored, firstKeptEntryId, 400_000, undefined, true);

    // The real next-run context builder.
    const nextRunMessages = sessionManager.buildSessionContext().messages as {
      role?: string;
      summary?: string;
    }[];

    const head = nextRunMessages.find((message) => message.role === "compactionSummary");
    expect(head, "expected a compactionSummary message in the rebuilt context").toBeDefined();
    // This is the assertion the whole PR exists for: what the next run actually
    // reads still contains the summary, not just the appended context.
    expect(head?.summary).toContain(BODY_MARKER);
    // And the verbatim preserved turn keeps its own line structure.
    expect(head?.summary).toContain("PRESERVED line one\nPRESERVED line two");
    // The artifact really did round-trip through storage rather than being
    // read back out of the object we passed in.
    const persisted = SessionManager.open({ ...target, sessionKey }, dir);
    const reloaded = persisted.getEntries().find((entry) => entry.type === "compaction") as
      | { summary?: string }
      | undefined;
    expect(reloaded?.summary).toContain(BODY_MARKER);
  });
});
