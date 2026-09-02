import assert from "node:assert/strict";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createUserTurnTranscriptRecorder } from "./user-turn-transcript.js";
import { persistUserTurnTranscript } from "./user-turn-transcript.test-support.js";
import { resolveWorkContextMessage } from "./work-context.js";

async function createSession(state: OpenClawTestState) {
  const target = {
    agentId: "main",
    sessionId: "work-context",
    sessionKey: "agent:main:work-context",
    storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    cwd: state.workspaceDir,
  };
  const sessionEntry = await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    updatedAt: 1,
  });
  assert(sessionEntry);
  return { ...target, sessionEntry };
}

function readHiddenContext(target: Parameters<typeof SessionManager.openModelContext>[0]) {
  return SessionManager.openModelContext(target)
    .buildSessionContext()
    .messages.filter((message) => message.role === "custom")
    .filter((message) => !message.display);
}

describe("user-turn work context", () => {
  it("persists first, changed and cleared context separately, retaining the baseline on reopen", async () => {
    await withOpenClawTestState({ label: "work-context" }, async (state) => {
      const target = await createSession(state);
      const snapshots = ["selection A", "selection A", "selection B", null, undefined, null];
      for (const [index, workContext] of snapshots.entries()) {
        const input = {
          text: `user ${index}`,
          idempotencyKey: `turn-${index}:user`,
          ...(workContext === undefined ? {} : { workContext }),
        };
        const result = await persistUserTurnTranscript({ ...target, input });
        expect(result?.message.content).toBe(input.text);
        expect(result?.admission).toMatchObject({ role: "user", entryId: result?.messageId });
      }

      const context = readHiddenContext(target);
      expect(context).toHaveLength(3);
      expect(JSON.stringify(context[0]?.content)).toContain("selection A");
      expect(JSON.stringify(context[1]?.content)).toContain("selection B");
      expect(JSON.stringify(context[2]?.content)).toMatch(/clear/i);
      expect(await loadTranscriptEvents(target)).toEqual(
        expect.arrayContaining(
          context.map((message) =>
            expect.objectContaining({
              id: asOptionalRecord(message.details)?.revision,
              message: expect.objectContaining({
                details: expect.objectContaining({ revision: expect.any(String) }),
              }),
            }),
          ),
        ),
      );
      expect(
        SessionManager.openModelContext(target)
          .buildSessionContext()
          .messages.filter((message) => message.role === "user")
          .map((message) => message.content),
      ).toEqual(snapshots.map((_, index) => `user ${index}`));
    });
  });

  it("captures the queued snapshot before later mutation and does not inject on idempotent replay", async () => {
    await withOpenClawTestState({ label: "work-context-queue" }, async (state) => {
      const target = await createSession(state);
      const input = {
        text: "queued",
        workContext: "queued selection",
        idempotencyKey: "queued:user",
      };
      const recorder = createUserTurnTranscriptRecorder({ input, target });
      const pending = resolveWorkContextMessage([], recorder.message);
      expect(pending?.details).toMatchObject({ revision: expect.any(String) });
      input.workContext = "new selection";
      await recorder.persistApproved();
      const first = await loadTranscriptEvents(target);

      await persistUserTurnTranscript({ ...target, input });
      expect(await loadTranscriptEvents(target)).toEqual(first);
      const context = readHiddenContext(target);
      expect(context).toHaveLength(1);
      expect(context[0]?.details).toEqual(pending?.details);
      const unchanged = createUserTurnTranscriptRecorder({
        input: { text: "next", workContext: "queued selection" },
        target,
      });
      expect(resolveWorkContextMessage(context, unchanged.message)).toBe(context[0]);
      expect(resolveWorkContextMessage(context)).toBe(context[0]);
      expect(JSON.stringify(context[0]?.content)).toContain("queued selection");
      expect(JSON.stringify(context)).not.toContain("new selection");
    });
  });

  it("deduplicates concurrent equal snapshots in the same transcript transaction", async () => {
    await withOpenClawTestState({ label: "work-context-concurrent" }, async (state) => {
      const target = await createSession(state);
      await Promise.all(
        ["first", "second"].map((text) => {
          const input = { text, workContext: "same selection", idempotencyKey: `${text}:user` };
          return persistUserTurnTranscript({ ...target, input });
        }),
      );
      expect(readHiddenContext(target)).toHaveLength(1);
      expect(
        SessionManager.openModelContext(target)
          .buildSessionContext()
          .messages.filter((message) => message.role === "user"),
      ).toHaveLength(2);
    });
  });

  it("preserves the enqueue snapshot through deferred media and a replacing write hook", async () => {
    await withOpenClawTestState({ label: "work-context-deferred" }, async (state) => {
      const target = await createSession(state);
      const input = {
        text: "queued",
        workContext: "enqueue selection",
        idempotencyKey: "deferred:user",
      };
      const recorder = createUserTurnTranscriptRecorder({
        input,
        resolveInput: async () => ({ ...input, text: "hydrated", workContext: "late selection" }),
        target,
        beforeMessageWrite: ({ message }) => ({
          ...message,
          __openclaw: { workContext: "hook selection" },
        }),
      });
      const pending = resolveWorkContextMessage([], recorder.message);
      input.workContext = "edited selection";
      await recorder.persistApproved();
      expect(readHiddenContext(target)).toMatchObject([{ details: pending?.details }]);
      expect(pending?.details).toMatchObject({ workContext: "enqueue selection" });
      assert(recorder.getPersistedMessage);
      expect(recorder.getPersistedMessage()?.content).toBe("hydrated");
    });
  });

  it("keeps staged context out of history until the user is promoted", async () => {
    await withOpenClawTestState({ label: "work-context-pending" }, async (state) => {
      const target = await createSession(state);
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "queued", workContext: null, idempotencyKey: "staged:user" },
        target,
      });
      const pending = resolveWorkContextMessage([], recorder.message);
      expect(await recorder.stageApproved?.({ runId: "staged", assertCurrent: () => {} })).toBe(
        true,
      );
      expect(readHiddenContext(target)).toEqual([]);
      await recorder.persistApproved();
      expect(readHiddenContext(target)).toMatchObject([{ details: pending?.details }]);
      expect(pending?.details).toMatchObject({ workContext: null });
      expect(recorder.getAdmissionReceipt()).toMatchObject({ role: "user" });
    });
  });

  it.each(["reset", "compaction"] as const)(
    "reinjects an unchanged snapshot when %s removes its context marker",
    async (boundary) => {
      await withOpenClawTestState({ label: `work-context-${boundary}` }, async (state) => {
        const target = await createSession(state);
        const input = { text: "first", workContext: "selection A", idempotencyKey: "first:user" };
        await persistUserTurnTranscript({ ...target, input });
        const previous = readHiddenContext(target);
        expect(previous).toHaveLength(1);
        const session = SessionManager.open(target);
        const kept = session.appendMessage({ role: "user", content: "kept", timestamp: 2 });
        if (boundary === "reset") {
          session.appendResetBoundary("new", kept);
        } else {
          session.appendCompaction("older conversation summarized", kept, 100);
        }
        expect(readHiddenContext(target)).toHaveLength(0);

        const recorder = createUserTurnTranscriptRecorder({
          target,
          input: { ...input, text: "after boundary", idempotencyKey: "after:user" },
        });
        const pending = resolveWorkContextMessage([], recorder.message);
        expect(pending?.details).not.toEqual(previous[0]?.details);
        await recorder.persistApproved();
        expect(readHiddenContext(target)).toHaveLength(1);
        expect(readHiddenContext(target)[0]?.details).toEqual(pending?.details);
        expect(JSON.stringify(readHiddenContext(target)[0]?.content)).toContain("selection A");
      });
    },
  );

  it("does not deduplicate against a context marker on an abandoned branch", async () => {
    await withOpenClawTestState({ label: "work-context-branch" }, async (state) => {
      const target = await createSession(state);
      const root = SessionManager.open(target).appendMessage({
        role: "user",
        content: "root",
        timestamp: 1,
      });
      const input = {
        text: "first branch",
        workContext: "selection A",
        idempotencyKey: "first:user",
      };
      await persistUserTurnTranscript({ ...target, input });
      expect(readHiddenContext(target)).toHaveLength(1);
      SessionManager.open(target).branch(root);
      await persistUserTurnTranscript({
        ...target,
        input: { ...input, text: "second branch", idempotencyKey: "second:user" },
      });
      expect(readHiddenContext(target)).toHaveLength(1);
      expect(JSON.stringify(readHiddenContext(target)[0]?.content)).toContain("selection A");
    });
  });

  it("does not leave context behind when the user write hook rejects admission", async () => {
    await withOpenClawTestState({ label: "work-context-rejected" }, async (state) => {
      const target = await createSession(state);
      const input = { text: "blocked", workContext: "blocked selection" };
      await persistUserTurnTranscript({ ...target, input, beforeMessageWrite: () => null });
      expect(readHiddenContext(target)).toEqual([]);
      expect(SessionManager.openModelContext(target).buildSessionContext().messages).toEqual([]);
    });
  });
});
