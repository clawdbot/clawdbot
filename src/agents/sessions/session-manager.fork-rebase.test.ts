// Fork-regression coverage split from session-manager.test.ts (max-lines).
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  replaceTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import type { AppendPersistenceOptions } from "./session-manager-types.js";
import { SessionManager, type SessionEntry, type SessionMessageEntry } from "./session-manager.js";

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
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
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

  it("retries a stale control append with the refreshed transcript fence", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const target = {
      agentId: "main",
      sessionId: "stale-control-fence",
      sessionKey: "agent:main:stale-control-fence",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const base = await appendTranscriptMessage(target, {
      eventId: "base",
      message: { role: "user", content: "base", timestamp: 1 },
      now: 1,
    });
    const manager = SessionManager.open(target, dir);
    await appendTranscriptMessage(target, {
      eventId: "out-of-band",
      message: { role: "assistant", content: [{ type: "text", text: "late" }], timestamp: 2 },
      now: 2,
    });

    const modelChangeId = manager.appendModelChange("openai", "gpt-5.6");

    expect(manager.getEntry(modelChangeId)?.parentId).toBe("out-of-band");
    expect(manager.getBranch().map((entry) => entry.id)).toEqual([
      base.messageId,
      "out-of-band",
      modelChangeId,
    ]);
    await expect(loadTranscriptEvents(target)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: modelChangeId,
          parentId: "out-of-band",
          type: "model_change",
        }),
      ]),
    );
  });

  it("reloads a stale control append after an unchanged-parent prefix rewrite", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const target = {
      agentId: "main",
      sessionId: "stale-control-prefix",
      sessionKey: "agent:main:stale-control-prefix",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const base = await appendTranscriptMessage(target, {
      eventId: "base",
      message: { role: "user", content: "old", timestamp: 1 },
      now: 1,
    });
    const manager = SessionManager.open(target, dir);
    const persisted = (await loadTranscriptEvents(target)) as SessionEntry[];
    expect(
      replaceTranscriptEventsSync(
        target,
        persisted.map((entry) =>
          entry.type === "message" && entry.id === base.messageId
            ? Object.assign({}, entry, {
                message: { role: "user" as const, content: "rewritten", timestamp: 2 },
              })
            : entry,
        ),
      ),
    ).toBe(true);

    const modelChangeId = manager.appendModelChange("openai", "gpt-5.6");

    expect(manager.getBranch().map((entry) => entry.id)).toEqual([base.messageId, modelChangeId]);
    const reloadedBase = manager.getEntry(base.messageId);
    expect(reloadedBase?.type).toBe("message");
    expect(
      reloadedBase?.type === "message" && reloadedBase.message.role === "user"
        ? reloadedBase.message.content
        : undefined,
    ).toBe("rewritten");
  });

  it("rejects a stale prepared assistant after a newer user turn", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const target = {
      agentId: "main",
      sessionId: "stale-assistant-new-user",
      sessionKey: "agent:main:stale-assistant-new-user",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    await appendTranscriptMessage(target, {
      eventId: "base-user",
      message: { role: "user", content: "base", timestamp: 1 },
      now: 1,
    });
    const manager = SessionManager.open(target, dir);
    await appendTranscriptMessage(target, {
      appendIntent: "active-branch",
      eventId: "new-user",
      message: { role: "user", content: "new", timestamp: 2 },
      now: 2,
    });

    expect(() =>
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "stale reply" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.5",
        usage: createZeroUsageFixture(),
        stopReason: "stop",
        timestamp: 3,
      }),
    ).toThrow("SQLite transcript changed while preparing rewrite");
  });

  it("fences a prepared assistant retry to the snapshot that passed validation", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const target = {
      agentId: "main",
      sessionId: "stale-assistant-validation-race",
      sessionKey: "agent:main:stale-assistant-validation-race",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const base = await appendTranscriptMessage(target, {
      eventId: "base-user",
      message: { role: "user", content: "base", timestamp: 1 },
      now: 1,
    });
    const manager = SessionManager.open(target, dir);
    await appendTranscriptMessage(target, {
      eventId: "intermediate-assistant",
      message: { role: "assistant", content: [{ type: "text", text: "late" }], timestamp: 2 },
      now: 2,
    });
    const branchBeforeRetry = manager.getBranch().map((entry) => entry.id);
    const persistencePrototype = SessionManager.prototype as unknown as {
      persist(
        entry: SessionEntry,
        options?: AppendPersistenceOptions & { expectedMutationAt?: number | null },
      ): unknown;
    };
    // Preserve the unbound implementation so the spy can forward each concurrent manager receiver.
    // oxlint-disable-next-line typescript/unbound-method
    const originalPersist = persistencePrototype.persist;
    let persistCalls = 0;
    vi.spyOn(persistencePrototype, "persist").mockImplementation(
      function (this: SessionManager, entry, options) {
        persistCalls += 1;
        if (persistCalls === 1) {
          const concurrent = appendTranscriptMessageSync(target, {
            appendIntent: "active-branch",
            eventId: "new-user",
            message: { role: "user", content: "new", timestamp: 3 },
            now: 3,
          });
          expect(concurrent.ok).toBe(true);
        }
        return originalPersist.call(this, entry, options);
      },
    );

    expect(() =>
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "stale reply" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.5",
        usage: createZeroUsageFixture(),
        stopReason: "stop",
        timestamp: 4,
      }),
    ).toThrow("SQLite transcript changed while preparing rewrite");
    expect(manager.getBranch().map((entry) => entry.id)).toEqual(branchBeforeRetry);
    const messages = (
      (await loadTranscriptEvents(target)) as Array<SessionMessageEntry & { type?: string }>
    ).filter((entry) => entry.type === "message");
    expect(messages.map((entry) => entry.id)).toEqual([
      base.messageId,
      "intermediate-assistant",
      "new-user",
    ]);
  });

  it("rejects a newer user outside the restored active ancestry", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const target = {
      agentId: "main",
      sessionId: "stale-assistant-side-user",
      sessionKey: "agent:main:stale-assistant-side-user",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const source = SessionManager.open(target, dir);
    const baseId = source.appendMessage({ role: "user", content: "base", timestamp: 1 });
    const preparedParentId = source.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ready" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
      usage: createZeroUsageFixture(),
      stopReason: "stop",
      timestamp: 2,
    });
    const stale = SessionManager.open(target, dir);
    source.branch(baseId);
    source.appendMessage({ role: "user", content: "side user", timestamp: 3 });
    source.branch(preparedParentId);

    expect(() =>
      stale.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "stale reply" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.5",
        usage: createZeroUsageFixture(),
        stopReason: "stop",
        timestamp: 4,
      }),
    ).toThrow("SQLite transcript changed while preparing rewrite");
  });

  it("preserves a deliberate manager branch from an ancestor", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const target = {
      agentId: "main",
      sessionId: "deliberate-manager-branch",
      sessionKey: "agent:main:deliberate-manager-branch",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
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

  it("preserves a stale manager branch when the concurrent tail is unrelated", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const target = {
      agentId: "main",
      sessionId: "stale-unrelated-parent",
      sessionKey: "agent:main:stale-unrelated-parent",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
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
    const manager = SessionManager.open(target, dir);
    await appendTranscriptMessage(target, {
      eventId: "second-root",
      message: { role: "user", content: "second", timestamp: 3 },
      now: 3,
      parentId: null,
    });

    const branchId = manager.appendMessage({ role: "user", content: "branch", timestamp: 4 });

    expect(manager.getEntry(branchId)?.parentId).toBe(firstTail.messageId);
    expect(manager.getBranch().map((entry) => entry.id)).toEqual([
      firstRoot.messageId,
      firstTail.messageId,
      branchId,
    ]);
    const persisted = (
      (await loadTranscriptEvents(target)) as Array<SessionMessageEntry & { type?: string }>
    ).find((entry) => entry.type === "message" && entry.id === branchId);
    expect(persisted).toMatchObject({ parentId: firstTail.messageId });
  });

  it("retries a stale side append against its unchanged explicit parent", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const target = {
      agentId: "main",
      sessionId: "stale-side-append",
      sessionKey: "agent:main:stale-side-append",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const base = await appendTranscriptMessage(target, {
      eventId: "side-base",
      message: { role: "user", content: "base", timestamp: 1 },
      now: 1,
    });
    const manager = SessionManager.open(target, dir);
    manager.appendLeafControl({
      targetId: base.messageId,
      appendParentId: base.messageId,
      appendMode: "side",
    });
    await appendTranscriptMessage(target, {
      eventId: "concurrent-tail",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "concurrent" }],
        timestamp: 2,
      },
      now: 2,
      parentId: base.messageId,
    });

    const sideId = manager.appendMessage({ role: "user", content: "side", timestamp: 3 });

    const events = (await loadTranscriptEvents(target)) as Array<
      SessionMessageEntry & { type?: string }
    >;
    const persisted = events.find((entry) => entry.type === "message" && entry.id === sideId);
    expect(persisted).toMatchObject({ parentId: base.messageId });
    expect(manager.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "concurrent-tail" }),
        expect.objectContaining({ id: sideId }),
      ]),
    );
    expect(() => manager.prepareTranscriptRewrite()).not.toThrow();
  });

  it("retries a stale deliberate branch against an unchanged explicit parent", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const target = {
      agentId: "main",
      sessionId: "stale-deliberate-branch",
      sessionKey: "agent:main:stale-deliberate-branch",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const base = await appendTranscriptMessage(target, {
      eventId: "deliberate-base",
      message: { role: "user", content: "base", timestamp: 1 },
      now: 1,
    });
    const manager = SessionManager.open(target, dir);
    manager.branch(base.messageId);
    await appendTranscriptMessage(target, {
      eventId: "concurrent-tail",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "concurrent" }],
        timestamp: 2,
      },
      now: 2,
      parentId: base.messageId,
    });

    const branchId = manager.appendMessage({ role: "user", content: "branch", timestamp: 3 });

    const persisted = (
      (await loadTranscriptEvents(target)) as Array<SessionMessageEntry & { type?: string }>
    ).find((entry) => entry.type === "message" && entry.id === branchId);
    expect(persisted).toMatchObject({ parentId: base.messageId });
  });

  it("honors an explicit active parent when the tail is not its descendant", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const target = {
      agentId: "main",
      sessionId: "unrelated-explicit-parent",
      sessionKey: "agent:main:unrelated-explicit-parent",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
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
