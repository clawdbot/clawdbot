import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
  readActiveTranscriptEntryAnchor,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  bindSessionPendingInputSources,
  listSessionPendingInputReceipts,
  listSessionPendingInputs,
  readSessionPendingInput,
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { copySessionNodeArtifactsForRepair } from "./session-accessor.sqlite-node-artifacts.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { waitForSessionTranscriptProjection } from "./session-transcript-reconcile.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("accepted input custody", () => {
  const fixture = useTempSessionsFixture("openclaw-pending-inputs-");
  const sessionKey = "agent:main:pending-inputs";
  const sessionId = "pending-session";
  const receipts: SessionPendingInputReceipt[] = [];
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
  const database = () => openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())));
  const message = (runId: string, content = "Continue the task"): PersistedUserTurnMessage => ({
    role: "user",
    content,
    timestamp: 100,
    idempotencyKey: `${runId}:user`,
  });
  const stage = async (
    runId: string,
    options: Partial<Parameters<typeof stageSessionPendingInput>[1]> = {},
  ) => {
    const receipt = await stageSessionPendingInput(scope(), {
      runId,
      message: message(runId),
      assertCurrent: () => {},
      ...options,
    });
    if (receipt) {
      receipts.push(receipt);
    }
    return receipt!;
  };
  const promote = (receipt: SessionPendingInputReceipt) =>
    receipt.run(() => appendTranscriptMessage(scope(), { message: receipt.message }));

  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
  });
  afterEach(() => {
    for (const receipt of receipts.splice(0)) {
      receipt.finish("interrupted");
    }
    closeOpenClawAgentDatabasesForTest();
  });

  it("keeps accepted input outside the active transcript and applies its hook once across replay and promotion", async () => {
    await appendTranscriptMessage(scope(), { message: message("active", "First task") });
    const before = await loadTranscriptEvents(scope());
    const prepare = vi.fn((input: PersistedUserTurnMessage) => ({
      ...input,
      content: typeof input.content === "string" ? `${input.content} (approved)` : input.content,
    }));
    const receipt = await stage("queued", { prepareMessageAfterIdempotencyCheck: prepare });
    await expect(
      stage("queued", {
        message: { ...message("queued"), timestamp: 200 },
        prepareMessageAfterIdempotencyCheck: prepare,
      }),
    ).rejects.toThrow("already admitted");
    expect(prepare).toHaveBeenCalledOnce();
    expect(await loadTranscriptEvents(scope())).toEqual(before);
    expect(listSessionPendingInputs(scope())).toMatchObject({
      total: 1,
      items: [{ id: receipt.inputId, state: "queued", message: receipt.message }],
    });
    await expect(stage("queued", { message: message("queued", "Changed input") })).rejects.toThrow(
      "conflicts",
    );
    await expect(appendTranscriptMessage(scope(), { message: receipt.message })).rejects.toThrow(
      "outside its admitted turn",
    );
    const secondHook = vi.fn(() => undefined);
    const appended = await receipt.run(() =>
      appendTranscriptMessage(scope(), {
        message: receipt.message,
        prepareMessageAfterIdempotencyCheck: secondHook,
      }),
    );
    expect(secondHook).not.toHaveBeenCalled();
    expect(appended).toMatchObject({
      appended: true,
      messageId: receipt.inputId,
      message: receipt.message,
    });
    expect(listSessionPendingInputs(scope())).toEqual({ total: 0, items: [] });
    const committedReplay = await stage("queued", { prepareMessageAfterIdempotencyCheck: prepare });
    expect(committedReplay.message).toEqual(receipt.message);
    expect(prepare).toHaveBeenCalledOnce();
    receipt.finish("interrupted");
    expect(() => receipt.run(() => {})).toThrow("ownership ended");
  });

  it("rolls transcript promotion and custody consumption back together", async () => {
    const receipt = await stage("atomic");
    const before = await loadTranscriptEvents(scope());
    database().db.exec(
      "CREATE TRIGGER reject_pending_consume BEFORE DELETE ON session_pending_inputs BEGIN SELECT RAISE(ABORT, 'consume failed'); END",
    );
    await expect(promote(receipt)).rejects.toThrow("consume failed");
    expect(await loadTranscriptEvents(scope())).toEqual(before);
    expect(readSessionPendingInput(scope(), receipt.inputId)?.state).toBe("queued");
    database().db.exec("DROP TRIGGER reject_pending_consume");
    expect(await promote(receipt)).toMatchObject({ appended: true, messageId: receipt.inputId });
    expect(readSessionPendingInput(scope(), receipt.inputId)).toBeUndefined();
  });

  it("promotes a queued input with its own custody after another receipt releases the writer", async () => {
    const first = await stage("writer-first");
    const second = await stage("writer-second");
    const gate = createDeferred();
    const held = first.run(() =>
      runExclusiveSqliteSessionWrite(resolveSqliteScope(scope()), async () => gate.promise),
    );
    const queued = promote(second);
    gate.resolve();
    await held;
    expect(await queued).toMatchObject({ appended: true, messageId: second.inputId });
    expect(listSessionPendingInputs(scope()).items.map((input) => input.id)).toEqual([
      first.inputId,
    ]);
  });

  it("commits one collected message and retains exact source receipts across rewrite and restart", async () => {
    const first = await stage("collect-a", {
      message: message("collect-a", "First approved input"),
    });
    const second = await stage("collect-b", {
      message: message("collect-b", "Second approved input"),
    });
    const aggregate = bindSessionPendingInputSources(
      [first, second],
      message("collect-c", "First approved input\nSecond approved input"),
    )!;
    receipts.push(aggregate);
    expect(listSessionPendingInputs(scope()).total).toBe(2);
    const appended = await promote(aggregate);
    expect(appended).toMatchObject({ appended: true, messageId: aggregate.inputId });
    expect(listSessionPendingInputs(scope())).toEqual({ items: [], total: 0 });
    expect(readSessionPendingInput(scope(), first.inputId)).toBeUndefined();
    expect(
      listSessionPendingInputReceipts(scope(), {
        runIds: ["collect-a", "collect-b", "unknown"],
      }),
    ).toEqual([
      { runId: "collect-a", state: "consumed", consumedByEventId: aggregate.inputId },
      { runId: "collect-b", state: "consumed", consumedByEventId: aggregate.inputId },
    ]);
    aggregate.finish("cancelled");
    await replaceTranscriptEvents(scope(), []);
    rotateAgentEventLifecycleGeneration();
    closeOpenClawAgentDatabasesForTest();
    const duplicate = await stage("collect-a", {
      message: { ...message("collect-a", "First approved input"), timestamp: 200 },
    });
    expect(duplicate).toMatchObject({
      state: "consumed",
      inputId: first.inputId,
      message: first.message,
    });
    expect(() => promote(duplicate)).toThrow("already been consumed");
    await expect(
      stage("collect-a", { message: message("collect-a", "Changed input") }),
    ).rejects.toThrow("conflicts");
    expect(await loadTranscriptEvents(scope())).toEqual([]);
    expect(listSessionPendingInputs(scope())).toEqual({ items: [], total: 0 });
    expect(
      database()
        .db.prepare(
          "SELECT input_id, message_json, consumed_event_id FROM session_pending_inputs ORDER BY seq",
        )
        .all(),
    ).toEqual([
      {
        input_id: first.inputId,
        message_json: JSON.stringify(first.message),
        consumed_event_id: aggregate.inputId,
      },
      {
        input_id: second.inputId,
        message_json: JSON.stringify(second.message),
        consumed_event_id: aggregate.inputId,
      },
    ]);
    expect(
      listSessionPendingInputReceipts(
        { ...scope(), sessionId: "other" },
        { runIds: ["collect-a"] },
      ),
    ).toEqual([]);
    await deleteSessionEntryLifecycle({
      archiveTranscript: false,
      storePath: fixture.storePath(),
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    expect(database().db.prepare("SELECT count(*) AS n FROM session_pending_inputs").get()).toEqual(
      { n: 0 },
    );
  });

  it("rolls aggregate append and every source consumption back as one transaction", async () => {
    const first = await stage("atomic-a");
    const second = await stage("atomic-b");
    const aggregate = bindSessionPendingInputSources([first, second], message("atomic-c"))!;
    receipts.push(aggregate);
    const before = await loadTranscriptEvents(scope());
    database().db.exec(
      "CREATE TRIGGER reject_collect_consume BEFORE UPDATE OF consumed_event_id ON session_pending_inputs WHEN OLD.run_id = 'atomic-b' BEGIN SELECT RAISE(ABORT, 'collect consume failed'); END",
    );
    await expect(promote(aggregate)).rejects.toThrow("collect consume failed");
    expect(await loadTranscriptEvents(scope())).toEqual(before);
    expect(listSessionPendingInputs(scope()).total).toBe(2);
    expect(listSessionPendingInputReceipts(scope(), { runIds: ["atomic-a", "atomic-b"] })).toEqual([
      { runId: "atomic-a", state: "pending" },
      { runId: "atomic-b", state: "pending" },
    ]);
    database().db.exec("DROP TRIGGER reject_collect_consume");
    expect(await promote(aggregate)).toMatchObject({
      appended: true,
      messageId: aggregate.inputId,
    });
    expect(listSessionPendingInputs(scope()).total).toBe(0);
  });

  it("revalidates every collected source after an await and rejects copied receipt fields", async () => {
    const first = await stage("fence-a");
    const second = await stage("fence-b");
    const aggregate = bindSessionPendingInputSources([first, second], message("fence-c"))!;
    receipts.push(aggregate);
    expect(bindSessionPendingInputSources([{ ...first }], message("forged-c"))).toBeUndefined();
    await expect(
      aggregate.run(async () => {
        await Promise.resolve();
        first.finish("cancelled");
        return appendTranscriptMessage(scope(), { message: aggregate.message });
      }),
    ).rejects.toThrow("custody ended");
    expect(await loadTranscriptEvents(scope())).toEqual([]);
    expect(listSessionPendingInputs(scope()).items.map((input) => input.state)).toEqual([
      "cancelled",
      "queued",
    ]);
  });

  it("binds lazy recorder collection to approved sources and reports consumed source retry without execution", async () => {
    const target = { ...scope(), sessionEntry: undefined };
    const hook = vi.fn(({ message: input }: { message: PersistedUserTurnMessage }) => ({
      ...input,
      content: "Approved source",
    }));
    const source = createUserTurnTranscriptRecorder({
      target,
      message: message("recorder-source", "Original source"),
      beforeMessageWrite: hook,
    });
    expect(
      await source.stageApproved?.({ runId: "recorder-source", assertCurrent: () => {} }),
    ).toBe(true);
    const aggregate = createUserTurnTranscriptRecorder({
      target,
      input: { text: "Unresolved collection" },
      resolveInput: async () => {
        const content = (await source.resolveMessage())?.content;
        if (typeof content !== "string") {
          throw new Error("Expected approved text input");
        }
        return {
          text: `Collected: ${content}`,
          idempotencyKey: "recorder-aggregate:user",
          timestamp: 100,
        };
      },
      pendingInputSources: [source],
      beforeMessageWrite: hook,
    });
    try {
      const unstaged = createUserTurnTranscriptRecorder({
        target,
        message: message("unstaged-source"),
      });
      const mixed = createUserTurnTranscriptRecorder({
        target,
        message: message("mixed-aggregate"),
        pendingInputSources: [source, unstaged],
        onPersistenceError: () => {},
      });
      await expect(mixed.persistApproved()).rejects.toThrow("cannot mix staged and unstaged");
      expect(await loadTranscriptEvents(scope())).toEqual([]);
      expect(listSessionPendingInputs(scope()).total).toBe(1);
      const appended = await aggregate.persistApproved();
      expect(appended).toMatchObject({
        appended: true,
        message: { content: "Collected: Approved source" },
      });
      expect(hook).toHaveBeenCalledOnce();
      expect(listSessionPendingInputs(scope()).total).toBe(0);
      const duplicate = createUserTurnTranscriptRecorder({
        target,
        message: message("recorder-source", "Original source"),
      });
      expect(
        await duplicate.stageApproved?.({ runId: "recorder-source", assertCurrent: () => {} }),
      ).toBe(false);
      expect(duplicate.isPendingInputConsumed?.()).toBe(true);
      expect(() =>
        duplicate.withPendingInput?.(() => {
          throw new Error("must not execute");
        }),
      ).toThrow("already been consumed");
    } finally {
      aggregate.finishPendingInput?.("interrupted");
    }
  });

  it.each(["cancelled", "interrupted"] as const)(
    "retains %s input visibly without permitting the old run to execute",
    async (disposition) => {
      const receipt = await stage("closed");
      receipt.finish(disposition);
      expect(readSessionPendingInput(scope(), receipt.inputId)?.state).toBe(disposition);
      expect(() => promote(receipt)).toThrow("ownership ended");
      await expect(stage("closed")).rejects.toThrow("submit a new turn");
      await expect(appendTranscriptMessage(scope(), { message: receipt.message })).rejects.toThrow(
        "outside its admitted turn",
      );
      expect(await promote(await stage("new-authorized-run"))).toMatchObject({ appended: true });
    },
  );

  it("fences authority loss after an await without overriding the owner's terminal disposition", async () => {
    let current = true;
    const receipt = await stage("authority", {
      assertCurrent: () => {
        if (!current) {
          throw new Error("run authority closed");
        }
      },
    });
    await expect(
      receipt.run(async () => {
        await Promise.resolve();
        current = false;
        return appendTranscriptMessage(scope(), { message: receipt.message });
      }),
    ).rejects.toThrow("run authority closed");
    await expect(stage("authority")).rejects.toThrow("already admitted");
    expect(listSessionPendingInputs(scope()).items[0]?.state).toBe("queued");
    receipt.finish("cancelled");
    expect(listSessionPendingInputs(scope()).items[0]?.state).toBe("cancelled");
    expect(database().db.prepare("SELECT state FROM session_pending_inputs").get()).toEqual({
      state: "cancelled",
    });
  });

  it("retires current-process custody on lifecycle rotation and never replays it after reopening", async () => {
    const receipt = await stage("restart");
    rotateAgentEventLifecycleGeneration();
    closeOpenClawAgentDatabasesForTest();
    expect(readSessionPendingInput(scope(), receipt.inputId)?.state).toBe("interrupted");
    expect(await loadTranscriptEvents(scope())).toEqual([]);
    expect(() => promote(receipt)).toThrow("ownership ended");
  });

  it("allows terminal mirroring to read a promoted user after cancellation without a new append", async () => {
    const receipt = await stage("terminal-mirror");
    await receipt.run(async () => {
      await appendTranscriptMessage(scope(), { message: receipt.message });
      const before = await loadTranscriptEvents(scope());
      receipt.finish("cancelled");
      expect(await appendTranscriptMessage(scope(), { message: receipt.message })).toMatchObject({
        appended: false,
      });
      expect(await loadTranscriptEvents(scope())).toEqual(before);
    });
  });

  it.each([false, true])(
    "permits only exact committed persistence after custody closes (collected: %s)",
    async (collected) => {
      const source = await stage("closed-persistence");
      const receipt = collected
        ? bindSessionPendingInputSources([source], message("closed-aggregate"))!
        : source;
      if (collected) {
        receipts.push(receipt);
      }
      await promote(receipt);
      receipt.finish("cancelled");
      expect(() => receipt.run(() => {})).toThrow("ownership ended");
      const before = await loadTranscriptEvents(scope());
      expect(
        await withSessionPendingInputPersistence(receipt, () =>
          appendTranscriptMessage(scope(), { message: receipt.message }),
        ),
      ).toMatchObject({ appended: false, messageId: receipt.inputId });
      expect(await loadTranscriptEvents(scope())).toEqual(before);
      await replaceTranscriptEvents(scope(), []);
      await expect(
        withSessionPendingInputPersistence(receipt, () =>
          appendTranscriptMessage(scope(), { message: receipt.message }),
        ),
      ).rejects.toThrow("custody ended");
      expect(await loadTranscriptEvents(scope())).toEqual([]);
    },
  );

  it.each(["deleted", "rebound", "replaced"] as const)(
    "rejects terminal mirroring after the promoted transcript is %s",
    async (change) => {
      const receipt = await stage(`terminal-${change}`);
      await receipt.run(async () => {
        await appendTranscriptMessage(scope(), { message: receipt.message });
        if (change === "deleted") {
          await replaceTranscriptEvents(scope(), []);
        } else if (change === "rebound") {
          await upsertSessionEntryCore(scope(), { sessionId: "replacement-session", updatedAt: 2 });
        } else {
          await replaceTranscriptEvents(scope(), [
            {
              type: "message",
              id: "rewritten-user",
              parentId: null,
              timestamp: new Date(100).toISOString(),
              message: receipt.message,
            },
          ]);
          expect(
            readActiveTranscriptEntryAnchor({ ...scope(), entryId: "rewritten-user" }),
          ).toMatchObject({ entryId: "rewritten-user" });
        }
        receipt.finish("cancelled");
        const before = await loadTranscriptEvents(scope());
        await expect(
          appendTranscriptMessage(scope(), { message: receipt.message }),
        ).rejects.toThrow(
          change === "deleted"
            ? "custody ended"
            : change === "rebound"
              ? "session changed"
              : "conflicts",
        );
        expect(await loadTranscriptEvents(scope())).toEqual(before);
      });
    },
  );

  it.each([false, true])(
    "rejects retained custody on an inactive branch with context exclusion %s",
    async (excludeFromContext) => {
      const receipt = await stage("terminal-off-path", {
        message: {
          ...message("terminal-off-path"),
          ...(excludeFromContext ? { excludeFromContext: true } : {}),
        },
      });
      let replacementId: string;
      await receipt.run(async () => {
        await appendTranscriptMessage(scope(), { message: receipt.message });
        const replacement = await appendTranscriptMessage(scope(), {
          message: message("replacement"),
          parentId: null,
        });
        replacementId = replacement.messageId;
        expect(replacement.effectiveParentId).toBeNull();
        expect(
          readActiveTranscriptEntryAnchor({ ...scope(), entryId: receipt.inputId }),
        ).toBeUndefined();
        expect(
          readActiveTranscriptEntryAnchor({ ...scope(), entryId: replacementId }),
        ).toBeUndefined();
        receipt.finish("cancelled");
        await expect(
          appendTranscriptMessage(scope(), { message: receipt.message }),
        ).rejects.toThrow("no longer active");
      });
      await waitForSessionTranscriptProjection(scope());
      expect(
        readActiveTranscriptEntryAnchor({ ...scope(), entryId: receipt.inputId }),
      ).toBeUndefined();
      expect(
        readActiveTranscriptEntryAnchor({ ...scope(), entryId: replacementId! }),
      ).toMatchObject({
        entryId: replacementId!,
      });
      expect(await appendTranscriptMessage(scope(), { message: receipt.message })).toMatchObject({
        appended: false,
      });
    },
  );

  it("retains repaired pending input as interrupted and never transfers live custody", async () => {
    const receipt = await stage("repair");
    const canonical = "agent:main:repaired-pending";
    await upsertSessionEntryCore(
      { ...scope(), sessionKey: canonical },
      { sessionId, updatedAt: 2 },
    );
    const current = database();
    copySessionNodeArtifactsForRepair(current, current, [sessionKey], canonical);
    expect(listSessionPendingInputs({ ...scope(), sessionKey: canonical })).toMatchObject({
      total: 1,
      items: [{ id: receipt.inputId, state: "interrupted", message: receipt.message }],
    });
    await expect(
      receipt.run(() =>
        appendTranscriptMessage(
          { ...scope(), sessionKey: canonical },
          { message: receipt.message },
        ),
      ),
    ).rejects.toThrow("outside its admitted turn");
  });

  it.each([false, true])(
    "copies accepted input across agent stores without reviving custody (consumed: %s)",
    async (consumed) => {
      const receipt = await stage("cross-agent");
      let aggregate: SessionPendingInputReceipt | undefined;
      if (consumed) {
        aggregate = bindSessionPendingInputSources([receipt], message("cross-agent-aggregate"))!;
        receipts.push(aggregate);
        await promote(aggregate);
      }
      const source = database();
      const destinationScope = {
        agentId: "other",
        sessionKey: "agent:other:repaired-pending",
        sessionId,
        storePath: path.join(path.dirname(source.path), "other-agent.sqlite"),
      };
      await upsertSessionEntryCore(destinationScope, { sessionId, updatedAt: 2 });
      const destinationOptions = toDatabaseOptions(resolveSqliteScope(destinationScope));
      runOpenClawAgentWriteTransaction((destination) => {
        copySessionNodeArtifactsForRepair(
          source,
          destination,
          [sessionKey],
          destinationScope.sessionKey,
        );
        copySessionNodeArtifactsForRepair(
          source,
          destination,
          [sessionKey],
          destinationScope.sessionKey,
        );
      }, destinationOptions);
      expect(listSessionPendingInputs(destinationScope)).toMatchObject(
        consumed
          ? { total: 0, items: [] }
          : {
              total: 1,
              items: [{ state: "interrupted", message: receipt.message }],
            },
      );
      if (consumed) {
        const duplicate = await stageSessionPendingInput(destinationScope, {
          runId: "cross-agent",
          message: message("cross-agent"),
          assertCurrent: () => {},
        });
        expect(duplicate?.state).toBe("consumed");
        expect(
          listSessionPendingInputReceipts(destinationScope, { runIds: ["cross-agent"] }),
        ).toEqual([
          {
            runId: "cross-agent",
            state: "consumed",
            consumedByEventId: aggregate!.inputId,
          },
        ]);
      }
      await expect(
        receipt.run(() => appendTranscriptMessage(destinationScope, { message: receipt.message })),
      ).rejects.toThrow("outside its admitted turn");
    },
  );

  it("rejects a reset target and removes custody on logical deletion that retains transcript windows", async () => {
    const receipt = await stage("reset");
    const second = await stage("reset-second");
    expect(listSessionPendingInputs(scope()).items.map((input) => input.state)).toEqual([
      "queued",
      "queued",
    ]);
    await upsertSessionEntryCore(scope(), { sessionId: "replacement-session", updatedAt: 2 });
    await expect(promote(receipt)).rejects.toThrow("session changed");
    expect(listSessionPendingInputs(scope()).items).toMatchObject([
      { id: receipt.inputId, state: "interrupted" },
      { id: second.inputId, state: "interrupted" },
    ]);
    await deleteSessionEntryLifecycle({
      archiveTranscript: false,
      storePath: fixture.storePath(),
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    expect(listSessionPendingInputs(scope())).toEqual({ items: [], total: 0 });
    expect(
      database().db.prepare("SELECT count(*) AS total FROM session_pending_inputs").get(),
    ).toEqual({ total: 0 });
  });

  it("paginates retained inputs with stable cursors while another input is promoted", async () => {
    const first = await stage("first");
    const second = await stage("second");
    const third = await stage("third");
    const page = listSessionPendingInputs(scope(), { limit: 2 });
    expect(page.items.map((input) => input.id)).toEqual([second.inputId, third.inputId]);
    expect(page.total).toBe(3);
    expect(page.nextBefore).toBeDefined();
    await promote(third);
    const older = listSessionPendingInputs(scope(), { limit: 2, before: page.nextBefore });
    expect(older.items.map((input) => input.id)).toEqual([first.inputId]);
    expect(
      readSessionPendingInput({ ...scope(), sessionId: "other-session" }, first.inputId),
    ).toBeUndefined();
  });

  it("bounds materialized pending pages by bytes without truncating input or skipping its cursor", async () => {
    const content = "x".repeat(Math.floor(MAX_PAYLOAD_BYTES / 2));
    const first = await stage("large-first", { message: message("large-first", content) });
    const second = await stage("large-second", { message: message("large-second", content) });
    const page = listSessionPendingInputs(scope());
    expect(page.items.map((input) => input.id)).toEqual([second.inputId]);
    expect(page.items[0]?.message.content === content).toBe(true);
    expect(page.total).toBe(2);
    expect(page.nextBefore).toBeDefined();
    const older = listSessionPendingInputs(scope(), { before: page.nextBefore });
    expect(older.items.map((input) => input.id)).toEqual([first.inputId]);
    expect(older.items[0]?.message.content === content).toBe(true);
    expect(older.nextBefore).toBeUndefined();
  });
});
