// Fork-regression coverage split from session-manager.test.ts (max-lines).
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { SessionManager, type SessionMessageEntry } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SessionManager stale-parent rebase", () => {
  it("rebases a stale active append onto the out-of-band transcript tail", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const target = {
      agentId: "main",
      sessionId: "stale-active-parent",
      sessionKey: "agent:main:stale-active-parent",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const base = await appendTranscriptMessage(target, {
      eventId: "base",
      message: { role: "user", content: "base", timestamp: 1 },
      now: 1,
    });
    const manager = SessionManager.open(target, dir);
    const outOfBand = await appendTranscriptMessage(target, {
      eventId: "out-of-band",
      message: { role: "assistant", content: [{ type: "text", text: "late" }], timestamp: 2 },
      now: 2,
    });

    const appendedId = manager.appendMessage({ role: "user", content: "next", timestamp: 3 });

    const messages = (
      (await loadTranscriptEvents(target)) as Array<SessionMessageEntry & { type?: string }>
    ).filter((entry) => entry.type === "message");
    expect(messages.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
      { id: base.messageId, parentId: null },
      { id: outOfBand.messageId, parentId: base.messageId },
      { id: appendedId, parentId: outOfBand.messageId },
    ]);
    expect(manager.getEntry(appendedId)?.parentId).toBe(outOfBand.messageId);
    expect(manager.getBranch().map((entry) => entry.id)).toEqual([
      base.messageId,
      outOfBand.messageId,
      appendedId,
    ]);
    const replayed = await appendTranscriptMessage(target, {
      appendIntent: "active-branch",
      eventId: appendedId,
      message: { role: "user", content: "next", timestamp: 3 },
      parentId: base.messageId,
    });
    expect(replayed).toMatchObject({
      appended: false,
      effectiveParentId: outOfBand.messageId,
      messageId: appendedId,
    });
  });

  it("preserves a deliberate manager branch from an ancestor", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const target = {
      agentId: "main",
      sessionId: "deliberate-manager-branch",
      sessionKey: "agent:main:deliberate-manager-branch",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const base = await appendTranscriptMessage(target, {
      eventId: "branch-base",
      message: { role: "user", content: "base", timestamp: 1 },
      now: 1,
    });
    const oldTail = await appendTranscriptMessage(target, {
      eventId: "old-tail",
      message: { role: "assistant", content: [{ type: "text", text: "old" }], timestamp: 2 },
      now: 2,
    });
    const manager = SessionManager.open(target, dir);

    manager.branch(base.messageId);
    const branchId = manager.appendMessage({ role: "user", content: "retry", timestamp: 3 });

    expect(manager.getEntry(branchId)?.parentId).toBe(base.messageId);
    expect(manager.getChildren(base.messageId).map((entry) => entry.id)).toEqual([
      oldTail.messageId,
      branchId,
    ]);
  });

  it("honors an explicit active parent when the tail is not its descendant", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const target = {
      agentId: "main",
      sessionId: "unrelated-explicit-parent",
      sessionKey: "agent:main:unrelated-explicit-parent",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const firstRoot = await appendTranscriptMessage(target, {
      eventId: "first-root",
      message: { role: "user", content: "first", timestamp: 1 },
      now: 1,
    });
    const firstTail = await appendTranscriptMessage(target, {
      eventId: "first-tail",
      message: { role: "assistant", content: [{ type: "text", text: "first" }], timestamp: 2 },
      now: 2,
    });
    await appendTranscriptMessage(target, {
      eventId: "second-root",
      message: { role: "user", content: "second", timestamp: 3 },
      now: 3,
      parentId: null,
    });

    const branched = await appendTranscriptMessage(target, {
      appendIntent: "active-branch",
      eventId: "preserved-branch",
      message: { role: "user", content: "branch", timestamp: 4 },
      now: 4,
      parentId: firstTail.messageId,
    });

    expect(branched.effectiveParentId).toBe(firstTail.messageId);
    const branchEntry = (
      (await loadTranscriptEvents(target)) as Array<{ type?: string; id?: string }>
    ).find((entry) => entry.type === "message" && entry.id === branched.messageId);
    expect(branchEntry).toMatchObject({ parentId: firstTail.messageId });
    expect(firstRoot.messageId).not.toBe(firstTail.messageId);
  });
});
