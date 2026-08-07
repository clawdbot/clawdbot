// Split out of session-manager.test.ts to stay under the repo's max-lines cap;
// covers the redacted-identity boundaries for the transcript-append refusal path.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { redactIdentifier } from "../../logging/redact-identifier.js";
import { resolveCompactionFailureReason } from "../embedded-agent-runner/compact-reasons.js";
import { SessionManager } from "./session-manager.js";

const tempPaths: string[] = [];

function openMarker(marker: string, sessionKey: string, cwd: string): SessionManager {
  const target = parseSqliteSessionFileMarker(marker);
  if (!target) {
    throw new Error("expected SQLite transcript marker fixture");
  }
  return SessionManager.open({ ...target, sessionKey }, cwd);
}

function buildAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "messages" as const,
    provider: "anthropic" as const,
    model: "sonnet-4.6" as const,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-manager-redaction-"));
  tempPaths.push(dir);
  return dir;
}

describe("SessionManager.open redaction", () => {
  afterEach(async () => {
    await Promise.all(
      tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("renders equal hashes when a sessionId lands in the sessionKey field", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    // Simulates the bug this redaction is meant to stay diagnosable for: a
    // sessionId value substituted into the sessionKey field.
    const collidingIdentity = "agent:main:whatsapp:direct:+15559990000";
    const sessionId = collidingIdentity;
    const sessionKey = collidingIdentity;
    const marker = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionFile: marker, sessionId, updatedAt: 10 });
    // The legacy sqlite marker format can't carry a colon-bearing sessionId
    // (its codec splits on `:`), so open directly with the intended scope
    // instead of round-tripping it through parseSqliteSessionFileMarker.
    const sessionManager = SessionManager.open(
      { agentId: "main", sessionId, storePath, sessionKey },
      dir,
    );
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionId: "replacement-session", updatedAt: 20 },
    );

    let thrown: unknown;
    try {
      sessionManager.appendModelChange("openai", "gpt-5.5");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;

    expect(message).not.toContain(collidingIdentity);

    // sessionKey and sessionId were the same raw value here, which is the exact
    // case this redaction must keep diagnosable: the two rendered hashes match.
    const keyHash = message.match(/sessionKeyHash=(\S+)/)?.[1];
    const idHash = message.match(/sessionIdHash=(\S+)/)?.[1];
    expect(keyHash).toBe(redactIdentifier(sessionKey));
    expect(idHash).toBe(redactIdentifier(sessionId));
    expect(keyHash).toBe(idHash);
  });

  it("redacts newlines, ANSI escapes and oversized identifiers to a fixed-width single-line hash", () => {
    const withNewlineAndAnsi = "agent:main:whatsapp:direct:+1555\n\x1b[31mHIJACK\x1b[0m9990000";
    const oversized = `agent:main:whatsapp:direct:+1555${"9".repeat(10_000)}`;

    for (const raw of [withNewlineAndAnsi, oversized]) {
      const redacted = redactIdentifier(raw);
      expect(redacted).not.toContain(raw);
      expect(redacted).not.toContain("\n");
      expect(redacted).not.toContain("\x1b");
      expect(redacted).toMatch(/^sha256:[0-9a-f]{12}$/);
    }
  });

  it("keeps the operator-facing compaction failure reason single-line and hash-only for a hostile sessionKey", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "hostile-sessionkey-target";
    // A canonical sessionKey can carry a channel peer id, and nothing upstream
    // guarantees it is a single clean line before it reaches this refusal path.
    const sessionKey = "agent:main:whatsapp:direct:+1555\n\x1b[31mHIJACK\x1b[0m9990000";
    const marker = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionFile: marker, sessionId, updatedAt: 10 });
    const sessionManager = SessionManager.open(
      { agentId: "main", sessionId, storePath, sessionKey },
      dir,
    );
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionId: "replacement-session", updatedAt: 20 },
    );

    let thrown: unknown;
    try {
      sessionManager.appendModelChange("openai", "gpt-5.5");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);

    // `result.reason` is exactly `formatErrorMessage(thrown)` run through
    // `resolveCompactionFailureReason` (src/agents/embedded-agent-runner/
    // direct-compaction.ts): both the sessions.compact RPC payload
    // (src/gateway/server-methods/sessions-compact.ts, `reason: result.reason`)
    // and the /compact chat reply's `formatCompactionReason` default branch
    // (src/auto-reply/reply/commands-compact.ts) forward that exact string to
    // the operator unmodified for an unclassified reason such as this one.
    const operatorFacingReason = resolveCompactionFailureReason({
      reason: formatErrorMessage(thrown),
    });

    expect(operatorFacingReason).not.toContain(sessionKey);
    expect(operatorFacingReason).not.toContain(sessionId);
    expect(operatorFacingReason).not.toContain("\n");
    expect(operatorFacingReason).not.toContain("\x1b");
    expect(operatorFacingReason).toContain(`sessionKeyHash=${redactIdentifier(sessionKey)}`);
  });

  it("rejects persistence after the session target rebounds", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-prompt-release-rebound";
    // Canonical session keys can embed a channel peer id; this fixture proves
    // that value never reaches the refusal exception raw.
    const sessionKey = "agent:main:whatsapp:direct:+15551234567";
    const marker = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionFile: marker, sessionId, updatedAt: 10 });
    const user = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "rebound-user",
      message: { role: "user", content: "question", timestamp: 1 },
    });
    const assistant = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "rebound-assistant",
      message: buildAssistantMessage("answer"),
      parentId: user.messageId,
    });
    const sessionManager = openMarker(marker, sessionKey, dir);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionId: "replacement-session", updatedAt: 20 },
    );

    try {
      sessionManager.appendCompaction("late summary", assistant.messageId, 42);
      throw new Error("expected rebound compaction persistence to fail");
    } catch (error) {
      expect(error).toMatchObject({
        cause: {
          actualSessionId: "replacement-session",
          code: "session-rebound",
          expectedSessionId: sessionId,
          sessionKey,
        },
      });
    }

    const entriesBeforeRejectedAppends = sessionManager.getEntries();
    const leafBeforeRejectedAppends = sessionManager.getLeafId();
    const appendParentBeforeRejectedAppends = sessionManager.getAppendParentId();
    expect(() => sessionManager.branchWithSummary(null, "late summary")).toThrow(
      "entry was not persisted",
    );
    expect(() => sessionManager.appendModelChange("openai", "gpt-5.5")).toThrow(
      "entry was not persisted",
    );
    // The refused append must name the identity it was scoped to, but only as a
    // stable hash: this message surfaces to operators verbatim through /compact
    // and sessions.compact as result.reason, and the raw sessionKey can embed a
    // channel peer id such as a phone number.
    expect(() => sessionManager.appendModelChange("openai", "gpt-5.5")).toThrow(
      `sessionKeyHash=${redactIdentifier(sessionKey)}`,
    );
    expect(() => sessionManager.appendModelChange("openai", "gpt-5.5")).toThrow(
      `sessionIdHash=${redactIdentifier(sessionId)}`,
    );
    expect(() => sessionManager.appendModelChange("openai", "gpt-5.5")).not.toThrow(sessionKey);
    expect(() => sessionManager.appendModelChange("openai", "gpt-5.5")).not.toThrow(sessionId);
    expect(() =>
      sessionManager.appendMessage({ role: "user", content: "late message", timestamp: 1 }),
    ).toThrow("message was not persisted");
    expect(() =>
      sessionManager.appendMessage({ role: "user", content: "late message", timestamp: 1 }),
    ).toThrow(`sessionKeyHash=${redactIdentifier(sessionKey)}`);
    expect(() =>
      sessionManager.appendMessage({ role: "user", content: "late message", timestamp: 1 }),
    ).not.toThrow(sessionKey);
    expect(sessionManager.getEntries()).toEqual(entriesBeforeRejectedAppends);
    expect(sessionManager.getLeafId()).toBe(leafBeforeRejectedAppends);
    expect(sessionManager.getAppendParentId()).toBe(appendParentBeforeRejectedAppends);
  });
});
