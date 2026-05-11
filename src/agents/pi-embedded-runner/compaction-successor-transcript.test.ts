import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  rotateTranscriptAfterCompaction,
  rotateTranscriptFileAfterCompaction,
  shouldRotateCompactionTranscript,
} from "./compaction-successor-transcript.js";
import { hardenManualCompactionBoundary } from "./manual-compaction-boundary.js";

let tmpDir: string | undefined;

async function createTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-successor-test-"));
  return tmpDir;
}

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    tmpDir = undefined;
  }
});

function makeAssistant(text: string, timestamp: number) {
  return makeAgentAssistantMessage({
    content: [{ type: "text", text }],
    timestamp,
  });
}

function requireString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value == null) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

type TranscriptEntry = ReturnType<SessionManager["getEntries"]>[number];

function requireEntryByIdAndType<T extends TranscriptEntry["type"]>(
  entries: readonly TranscriptEntry[],
  id: string,
  type: T,
  label: string,
): Extract<TranscriptEntry, { type: T }> {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`expected ${label}`);
  }
  if (entry.type !== type) {
    throw new Error(`expected ${label} to be ${type}, got ${entry.type}`);
  }
  return entry as Extract<TranscriptEntry, { type: T }>;
}

function requireEntryByType<T extends TranscriptEntry["type"]>(
  entries: readonly TranscriptEntry[],
  type: T,
  label: string,
): Extract<TranscriptEntry, { type: T }> {
  const entry = entries.find((candidate) => candidate.type === type);
  if (!entry) {
    throw new Error(`expected ${label}`);
  }
  return entry as Extract<TranscriptEntry, { type: T }>;
}

function createCompactedSession(sessionDir: string): {
  manager: SessionManager;
  sessionFile: string;
  firstKeptId: string;
  oldUserId: string;
} {
  const manager = SessionManager.create(sessionDir, sessionDir);
  manager.appendModelChange("openai", "gpt-5.2");
  manager.appendThinkingLevelChange("medium");
  manager.appendCustomEntry("test-extension", { cursor: "before-compaction" });
  const oldUserId = manager.appendMessage({ role: "user", content: "old user", timestamp: 1 });
  manager.appendLabelChange(oldUserId, "old bookmark");
  manager.appendMessage(makeAssistant("old assistant", 2));
  const firstKeptId = manager.appendMessage({ role: "user", content: "kept user", timestamp: 3 });
  manager.appendLabelChange(firstKeptId, "kept bookmark");
  manager.appendMessage(makeAssistant("kept assistant", 4));
  manager.appendCompaction("Summary of old user and old assistant.", firstKeptId, 5000);
  manager.appendMessage({ role: "user", content: "post user", timestamp: 5 });
  manager.appendMessage(makeAssistant("post assistant", 6));
  return {
    manager,
    sessionFile: requireString(manager.getSessionFile(), "compacted session file"),
    firstKeptId,
    oldUserId,
  };
}

describe("rotateTranscriptAfterCompaction", () => {
  it("can rotate a persisted transcript without opening a manager", async () => {
    const dir = await createTmpDir();
    const { sessionFile } = createCompactedSession(dir);

    const openSpy = vi.spyOn(SessionManager, "open").mockImplementation(() => {
      throw new Error("SessionManager.open should not be used for file rotation");
    });
    const result = await rotateTranscriptFileAfterCompaction({
      sessionFile,
      now: () => new Date("2026-04-27T12:00:00.000Z"),
    });
    openSpy.mockRestore();

    expect(result.rotated).toBe(true);
    const successorFile = requireString(result.sessionFile, "successor session file");

    const successor = SessionManager.open(successorFile);
    const header = requireValue(successor.getHeader(), "successor header");
    expect(header.parentSession).toBe(sessionFile);
    expect(header.cwd).toBe(dir);
    expect(successor.buildSessionContext().messages.length).toBeGreaterThan(0);
  });

  it("creates a compacted successor transcript and leaves the archive untouched", async () => {
    const dir = await createTmpDir();
    const { manager, sessionFile, firstKeptId, oldUserId } = createCompactedSession(dir);
    const originalBytes = await fs.readFile(sessionFile, "utf8");
    const originalEntryCount = manager.getEntries().length;

    const result = await rotateTranscriptAfterCompaction({
      sessionManager: manager,
      sessionFile,
      now: () => new Date("2026-04-27T12:00:00.000Z"),
    });

    expect(result.rotated).toBe(true);
    const successorSessionId = requireString(result.sessionId, "successor session id");
    const successorFile = requireString(result.sessionFile, "successor session file");
    expect(successorFile).not.toBe(sessionFile);
    expect(await fs.readFile(sessionFile, "utf8")).toBe(originalBytes);

    const successor = SessionManager.open(successorFile);
    const header = requireValue(successor.getHeader(), "successor header");
    expect(header.id).toBe(successorSessionId);
    expect(header.parentSession).toBe(sessionFile);
    expect(header.cwd).toBe(dir);
    expect(successor.getEntries().length).toBeLessThan(originalEntryCount);
    expect(successor.getBranch()[0]?.type).toBe("model_change");
    const customBranchEntry = requireEntryByType(
      successor.getBranch(),
      "custom",
      "preserved custom branch entry",
    );
    expect(customBranchEntry.customType).toBe("test-extension");
    expect(customBranchEntry.data).toStrictEqual({ cursor: "before-compaction" });

    const context = successor.buildSessionContext();
    const contextText = JSON.stringify(context.messages);
    expect(contextText).toContain("Summary of old user and old assistant.");
    expect(contextText).toContain("kept user");
    expect(contextText).toContain("post assistant");
    expect(
      context.messages.some((message) => message.role === "user" && message.content === "old user"),
    ).toBe(false);
    expect(context.model?.provider).toBe("openai");
    expect(context.thinkingLevel).toBe("medium");
    expect(successor.getLabel(firstKeptId)).toBe("kept bookmark");
    expect(successor.getLabel(oldUserId)).toBeUndefined();
  });

  it("deduplicates stale pre-compaction session state", async () => {
    const dir = await createTmpDir();
    const manager = SessionManager.create(dir, dir);

    const staleModelId = manager.appendModelChange("anthropic", "claude-sonnet-4-5");
    const staleThinkingId = manager.appendThinkingLevelChange("low");
    const staleSessionInfoId = manager.appendSessionInfo("stale title");
    manager.appendCustomEntry("test-extension", { cursor: "preserved" });
    manager.appendMessage({ role: "user", content: "old user", timestamp: 1 });
    manager.appendMessage(makeAssistant("old assistant", 2));

    manager.appendModelChange("openai", "gpt-5.2");
    manager.appendThinkingLevelChange("high");
    manager.appendSessionInfo("current title");
    const firstKeptId = manager.appendMessage({ role: "user", content: "kept user", timestamp: 3 });
    manager.appendMessage(makeAssistant("kept assistant", 4));
    manager.appendCompaction("Summary of old user and old assistant.", firstKeptId, 5000);
    manager.appendMessage({ role: "user", content: "post user", timestamp: 5 });

    const result = await rotateTranscriptAfterCompaction({
      sessionManager: manager,
      sessionFile: requireString(manager.getSessionFile(), "source session file"),
      now: () => new Date("2026-04-27T12:05:00.000Z"),
    });

    expect(result.rotated).toBe(true);
    const successor = SessionManager.open(
      requireString(result.sessionFile, "successor session file"),
    );
    const entries = successor.getEntries();
    expect(entries.find((entry) => entry.id === staleModelId)).toBeUndefined();
    expect(entries.find((entry) => entry.id === staleThinkingId)).toBeUndefined();
    expect(entries.find((entry) => entry.id === staleSessionInfoId)).toBeUndefined();
    const countEntryType = (type: (typeof entries)[number]["type"]) =>
      entries.reduce((count, entry) => count + (entry.type === type ? 1 : 0), 0);
    expect(countEntryType("model_change")).toBe(1);
    expect(countEntryType("thinking_level_change")).toBe(1);
    expect(countEntryType("session_info")).toBe(1);
    const modelChange = requireEntryByType(entries, "model_change", "current model change");
    expect(modelChange.provider).toBe("openai");
    expect(modelChange.modelId).toBe("gpt-5.2");
    const customEntry = requireEntryByType(entries, "custom", "preserved custom entry");
    expect(customEntry.customType).toBe("test-extension");
    expect(customEntry.data).toStrictEqual({ cursor: "preserved" });

    const context = successor.buildSessionContext();
    expect(context.thinkingLevel).toBe("high");
    expect(successor.getSessionName()).toBe("current title");
  });

  it("drops duplicate user messages from the rotated active branch tail", async () => {
    const dir = await createTmpDir();
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: "old user", timestamp: 1 });
    const firstKeptId = manager.appendMessage(makeAssistant("old assistant", 2));
    manager.appendCompaction("Summary of old work.", firstKeptId, 5000);
    const firstDuplicateId = manager.appendMessage({
      role: "user",
      content: "please run the deployment status check for production",
      timestamp: 3_000,
    });
    const secondDuplicateId = manager.appendMessage({
      role: "user",
      content: " please   run the deployment status check for production ",
      timestamp: 4_000,
    });
    manager.appendMessage(makeAssistant("status checked", 5_000));

    const result = await rotateTranscriptAfterCompaction({
      sessionManager: manager,
      sessionFile: requireString(manager.getSessionFile(), "source session file"),
      now: () => new Date("2026-04-27T12:10:00.000Z"),
    });

    expect(result.rotated).toBe(true);
    const successor = SessionManager.open(
      requireString(result.sessionFile, "successor session file"),
    );
    const entries = successor.getEntries();
    requireValue(
      entries.find((entry) => entry.id === firstDuplicateId),
      "kept duplicate entry",
    );
    expect(entries.find((entry) => entry.id === secondDuplicateId)).toBeUndefined();
    const contextText = JSON.stringify(successor.buildSessionContext().messages);
    expect(contextText.match(/deployment status check/g)).toHaveLength(1);
  });

  it("skips sessions with no compaction entry", async () => {
    const dir = await createTmpDir();
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    manager.appendMessage(makeAssistant("hi", 2));

    const result = await rotateTranscriptAfterCompaction({
      sessionManager: manager,
      sessionFile: requireString(manager.getSessionFile(), "source session file"),
    });

    expect(result.rotated).toBe(false);
    expect(result.reason).toBe("no compaction entry");
  });

  it("uses a refreshed manager after manual boundary hardening", async () => {
    const dir = await createTmpDir();
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: "old question", timestamp: 1 });
    manager.appendMessage(makeAssistant("old answer", 2));
    const recentTailId = manager.appendMessage({
      role: "user",
      content: "recent question",
      timestamp: 3,
    });
    manager.appendMessage(makeAssistant("detailed recent answer", 4));
    const compactionId = manager.appendCompaction("fresh manual summary", recentTailId, 200);
    const sessionFile = requireString(manager.getSessionFile(), "manual compaction session file");
    const staleManager = SessionManager.open(sessionFile);

    const hardened = await hardenManualCompactionBoundary({ sessionFile });
    expect(hardened.applied).toBe(true);
    const staleLeaf = staleManager.getLeafEntry();
    expect(staleLeaf?.type).toBe("compaction");
    if (!staleLeaf || staleLeaf.type !== "compaction") {
      throw new Error("expected stale leaf to be a compaction entry");
    }
    expect(staleLeaf.firstKeptEntryId).toBe(recentTailId);

    const result = await rotateTranscriptAfterCompaction({
      sessionManager: SessionManager.open(sessionFile),
      sessionFile,
      now: () => new Date("2026-04-27T12:30:00.000Z"),
    });

    expect(result.rotated).toBe(true);
    const successor = SessionManager.open(
      requireString(result.sessionFile, "successor session file"),
    );
    const successorText = JSON.stringify(successor.buildSessionContext().messages);
    expect(successorText).toContain("fresh manual summary");
    expect(successorText).not.toContain("recent question");
    expect(successorText).not.toContain("detailed recent answer");
    const successorCompaction = successor
      .getEntries()
      .find((entry) => entry.type === "compaction" && entry.id === compactionId);
    if (!successorCompaction || successorCompaction.type !== "compaction") {
      throw new Error("expected successor compaction entry");
    }
    expect(successorCompaction.firstKeptEntryId).toBe(compactionId);
  });

  it("preserves unsummarized sibling branches and branch summaries", async () => {
    const dir = await createTmpDir();
    const manager = SessionManager.create(dir, dir);

    manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    const branchFromId = manager.appendMessage(makeAssistant("hi there", 2));

    const branchSummaryId = manager.branchWithSummary(
      branchFromId,
      "Summary of the abandoned branch.",
    );
    const siblingMsgId = manager.appendMessage({
      role: "user",
      content: "do task B instead",
      timestamp: 3,
    });
    manager.appendMessage(makeAssistant("done B", 4));

    manager.branch(branchFromId);
    manager.appendMessage({ role: "user", content: "do task A", timestamp: 5 });
    const firstKeptId = manager.appendMessage(makeAssistant("done A", 6));
    manager.appendCompaction("Summary of main branch.", firstKeptId, 5000);
    manager.appendMessage({ role: "user", content: "next", timestamp: 7 });

    const sessionFile = requireString(manager.getSessionFile(), "source session file");
    const result = await rotateTranscriptAfterCompaction({
      sessionManager: manager,
      sessionFile,
      now: () => new Date("2026-04-27T12:45:00.000Z"),
    });

    expect(result.rotated).toBe(true);
    const successor = SessionManager.open(
      requireString(result.sessionFile, "successor session file"),
    );
    const allEntries = successor.getEntries();
    const branchSummary = requireEntryByIdAndType(
      allEntries,
      branchSummaryId,
      "branch_summary",
      "preserved branch summary",
    );
    expect(branchSummary.summary).toBe("Summary of the abandoned branch.");
    const siblingMessage = requireEntryByIdAndType(
      allEntries,
      siblingMsgId,
      "message",
      "preserved sibling message",
    );
    if (!("content" in siblingMessage.message)) {
      throw new Error("expected sibling message content");
    }
    expect(siblingMessage.message.content).toBe("do task B instead");

    const activeContextText = JSON.stringify(successor.buildSessionContext().messages);
    expect(activeContextText).toContain("Summary of main branch.");
    expect(activeContextText).toContain("next");
    expect(activeContextText).not.toContain("do task B instead");
  });

  it("orders preserved sibling branches after their surviving parents", async () => {
    const dir = await createTmpDir();
    const manager = SessionManager.create(dir, dir);

    manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    const branchFromId = manager.appendMessage(makeAssistant("hi there", 2));

    const branchSummaryId = manager.branchWithSummary(
      branchFromId,
      "Summary of the inactive branch.",
    );
    const inactiveMsgId = manager.appendMessage({
      role: "user",
      content: "inactive branch",
      timestamp: 3,
    });
    manager.appendMessage(makeAssistant("inactive done", 4));

    manager.branch(branchFromId);
    manager.appendMessage({ role: "user", content: "active branch", timestamp: 5 });
    manager.appendMessage(makeAssistant("active done", 6));
    manager.appendCompaction("Summary of active work.", branchFromId, 5000);
    const activeLeafId = manager.appendMessage({
      role: "user",
      content: "next active",
      timestamp: 7,
    });

    const result = await rotateTranscriptAfterCompaction({
      sessionManager: manager,
      sessionFile: requireString(manager.getSessionFile(), "source session file"),
      now: () => new Date("2026-04-27T13:00:00.000Z"),
    });

    expect(result.rotated).toBe(true);
    const successor = SessionManager.open(
      requireString(result.sessionFile, "successor session file"),
    );
    const entries = successor.getEntries();
    const indexById = new Map(entries.map((entry, index) => [entry.id, index]));
    expect(indexById.get(branchFromId)).toBeLessThan(indexById.get(branchSummaryId)!);
    expect(indexById.get(branchSummaryId)).toBeLessThan(indexById.get(inactiveMsgId)!);
    expect(entries.at(-1)?.id).toBe(activeLeafId);
    expect(successor.getLeafId()).toBe(activeLeafId);

    const activeContextText = JSON.stringify(successor.buildSessionContext().messages);
    expect(activeContextText).toContain("Summary of active work.");
    expect(activeContextText).toContain("next active");
    expect(activeContextText).not.toContain("inactive branch");
  });
});

describe("shouldRotateCompactionTranscript", () => {
  it("keeps transcript rotation opt-in behind the existing config key", () => {
    expect(shouldRotateCompactionTranscript()).toBe(false);
    expect(
      shouldRotateCompactionTranscript({
        agents: { defaults: { compaction: { truncateAfterCompaction: true } } },
      }),
    ).toBe(true);
  });
});
