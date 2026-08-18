// Recorder-focused user turn transcript tests, split from
// user-turn-transcript.test.ts to stay under the 1000-line lint budget.
import fs from "node:fs";
import path from "node:path";
import { castAgentMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  buildLateMediaAttachedProjection,
  createUserTurnTranscriptRecorder,
  type UserTurnInput,
} from "./user-turn-transcript.js";
import { persistUserTurnTranscript } from "./user-turn-transcript.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const unusedRecorderTarget = {
  agentId: "main",
  sessionEntry: undefined,
  sessionId: "unused-session",
  sessionKey: "agent:main:unused",
  storePath: "/tmp/openclaw-unused-sessions.json",
};

function createSqliteTranscriptTarget(params: {
  dir: string;
  sessionId?: string;
  sessionKey?: string;
}) {
  const sessionId = params.sessionId ?? "session-1";
  const sessionKey = params.sessionKey ?? "agent:main:main";
  const storePath = path.join(params.dir, "agents", "main", "sessions", "sessions.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const sqliteMarker = formatSqliteSessionFileMarker({
    agentId: "main",
    sessionId,
    storePath,
  });
  return {
    agentId: "main",
    cwd: params.dir,
    sessionEntry: undefined,
    sessionId,
    sessionKey,
    storePath,
    sqliteMarker,
  };
}

async function readTranscriptMessages(params: {
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<Array<Record<string, unknown>>> {
  return (
    await loadTranscriptEvents({
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    })
  )
    .map((entry) => (entry as { message?: unknown }).message)
    .filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" && message !== null,
    );
}

describe("createUserTurnTranscriptRecorder", () => {
  it("accepts and normalizes provider-defined persisted media kinds", () => {
    const input: UserTurnInput = {
      text: "inspect this attachment",
      media: [{ path: " /tmp/provider-media.bin ", kind: " provider/custom-media " }],
    };
    const recorder = createUserTurnTranscriptRecorder({
      input,
      target: unusedRecorderTarget,
    });

    expect(recorder.message).toMatchObject({
      __openclaw: {
        media: [
          expect.objectContaining({
            path: "/tmp/provider-media.bin",
            contentType: "provider/custom-media",
          }),
        ],
      },
    });
  });

  it("persists fallback user turns only once", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-fallback-");
    const target = createSqliteTranscriptTarget({ dir });
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "hello from fallback",
        timestamp: 123,
        idempotencyKey: "chat-run-1:user",
      },
      target: {
        ...target,
      },
      updateMode: "none",
    });
    expect(recorder.getPersistedMessage?.()).toBeUndefined();

    const [first, second] = await Promise.all([
      recorder.persistFallback(),
      recorder.persistFallback(),
    ]);

    expect(first?.messageId).toBeTruthy();
    expect(second?.messageId).toBe(first?.messageId);
    expect(recorder.getPersistedMessage?.()).toEqual(first?.message);
    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "hello from fallback",
        idempotencyKey: "chat-run-1:user",
      }),
    ]);
  });

  it("notifies once after fallback user-turn persistence", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-notify-");
    const target = createSqliteTranscriptTarget({ dir });
    const persistedMessages: unknown[] = [];
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "#35676 Keśava: No wtf",
        timestamp: 123,
        idempotencyKey: "chat-run-ambient:user",
      },
      target: {
        ...target,
      },
      updateMode: "none",
      onMessagePersisted: (message) => {
        persistedMessages.push(message);
      },
    });

    await recorder.persistFallback();
    await recorder.persistFallback();

    expect(persistedMessages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "#35676 Keśava: No wtf",
      }),
    ]);
    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "#35676 Keśava: No wtf",
      }),
    ]);
  });

  it("resolves media lazily at persistence time", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-lazy-media-");
    const target = createSqliteTranscriptTarget({ dir });
    let resolverCalled = false;
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "describe this",
        timestamp: 123,
        idempotencyKey: "chat-run-lazy:user",
      },
      resolveInput: async () => {
        resolverCalled = true;
        return {
          text: "describe this",
          timestamp: 123,
          idempotencyKey: "chat-run-lazy:user",
          media: [{ path: path.join(dir, "image.png"), contentType: "image/png" }],
        };
      },
      target: {
        ...target,
      },
      updateMode: "none",
    });

    expect(recorder.message).toEqual(
      expect.objectContaining({
        role: "user",
        content: "describe this",
        idempotencyKey: "chat-run-lazy:user",
      }),
    );
    expect(recorder.message).not.toHaveProperty("MediaPath");
    expect(resolverCalled).toBe(false);

    const persisted = await recorder.persistFallback();

    expect(resolverCalled).toBe(true);
    expect(persisted?.message).toMatchObject({
      role: "user",
      content: "describe this",
      __openclaw: {
        media: [
          expect.objectContaining({
            path: path.join(dir, "image.png"),
            contentType: "image/png",
          }),
        ],
      },
    });
    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "describe this",
        __openclaw: {
          media: [expect.objectContaining({ path: path.join(dir, "image.png") })],
        },
      }),
    ]);
  });

  it("persists managed delivery adoption metadata through transcript hooks", async () => {
    const dir = tempDirs.make("openclaw-user-turn-managed-delivery-");
    const target = createSqliteTranscriptTarget({ dir });
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "managed completion",
        sessionDeliveryAckIds: ["delivery-1", "delivery-1", "delivery-2"],
      },
      beforeMessageWrite: ({ message }) => {
        const metadata = Reflect.get(message, "__openclaw") as
          | { sessionDeliveryAckIds?: unknown[] }
          | undefined;
        const deliveryIds = metadata?.sessionDeliveryAckIds;
        deliveryIds?.splice(0);
        return castAgentMessage({
          role: "user",
          content: message.content,
          __openclaw: { hookOwned: true },
        });
      },
      target,
    });

    await recorder.persistApproved();

    expect(await readTranscriptMessages(target)).toEqual([
      expect.objectContaining({
        content: "managed completion",
        __openclaw: {
          hookOwned: true,
          sessionDeliveryAckIds: ["delivery-1", "delivery-2"],
        },
      }),
    ]);
  });

  it("replaces managed delivery receipts in a supplied recorder before persistence", async () => {
    const dir = tempDirs.make("openclaw-user-turn-managed-delivery-supplied-");
    const target = createSqliteTranscriptTarget({ dir });
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "managed completion" },
      target,
    });

    expect(recorder.replaceSessionDeliveryAckIds?.(["delivery-1", "delivery-1"])).toBe(true);
    expect(recorder.replaceSessionDeliveryAckIds?.(["delivery-2"])).toBe(true);
    await recorder.persistApproved();

    expect(recorder.getPersistedMessage?.()).toMatchObject({
      __openclaw: { sessionDeliveryAckIds: ["delivery-2"] },
    });
    expect(recorder.replaceSessionDeliveryAckIds?.(["delivery-3"])).toBe(false);
  });

  it("removes stale managed delivery receipts when the final replacement is empty", async () => {
    const dir = tempDirs.make("openclaw-user-turn-managed-delivery-empty-");
    const target = createSqliteTranscriptTarget({ dir });
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "managed completion", sessionDeliveryAckIds: ["delivery-stale"] },
      target,
    });

    expect(recorder.replaceSessionDeliveryAckIds?.([])).toBe(true);
    await recorder.persistApproved();

    expect(recorder.getPersistedMessage?.()).not.toHaveProperty("__openclaw.sessionDeliveryAckIds");
  });

  it("returns the older receipt-free row for an idempotent managed-delivery retry", async () => {
    const dir = tempDirs.make("openclaw-user-turn-managed-delivery-retry-");
    const target = createSqliteTranscriptTarget({ dir });
    const original = createUserTurnTranscriptRecorder({
      input: {
        text: "original active steer",
        idempotencyKey: "active-steer:user",
      },
      target,
    });
    await original.persistApproved();
    const retry = createUserTurnTranscriptRecorder({
      input: {
        text: "managed completion retry",
        idempotencyKey: "active-steer:user",
        sessionDeliveryAckIds: ["delivery-1"],
      },
      target,
    });

    const persisted = await retry.persistApproved();

    expect(persisted).toMatchObject({
      appended: false,
      message: {
        content: "original active steer",
        idempotencyKey: "active-steer:user",
      },
    });
    expect(retry.getPersistedMessage?.()).not.toHaveProperty("__openclaw.sessionDeliveryAckIds");
    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        content: "original active steer",
        idempotencyKey: "active-steer:user",
      }),
    ]);
  });

  it("appends #99495 media that resolves after the admitted turn reached the provider", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-late-media-");
    const target = createSqliteTranscriptTarget({ dir });
    const admittedInput = {
      text: "describe this",
      timestamp: 123,
      idempotencyKey: "chat-run-late:user",
    };
    let resolveMedia!: (input: UserTurnInput) => void;
    let markResolverStarted!: () => void;
    const resolverStarted = new Promise<void>((resolve) => {
      markResolverStarted = resolve;
    });

    const mediaInput = new Promise<UserTurnInput>((resolve) => {
      resolveMedia = resolve;
    });
    const recorder = createUserTurnTranscriptRecorder({
      input: admittedInput,
      resolveInput: async () => {
        markResolverStarted();
        return await mediaInput;
      },
      beforeMessageWrite: ({ message }) =>
        castAgentMessage({
          ...(message as unknown as Record<string, unknown>),
          __openclaw: { hookOwned: true },
        }),
      target: {
        ...target,
      },
    });
    const persistence = recorder.persistFallback();
    await resolverStarted;
    const admitted = await persistUserTurnTranscript({
      ...target,
      input: admittedInput,
    });
    expect(admitted).toBeDefined();
    recorder.markRuntimePersisted(recorder.message, admitted?.admission);
    const admissionReceipt = recorder.getAdmissionReceipt();
    recorder.markSentToProvider?.();
    resolveMedia({
      ...admittedInput,
      media: [{ path: path.join(dir, "image.png"), contentType: "image/png" }],
    });

    await persistence;

    expect(recorder.getAdmissionReceipt()).toEqual(admissionReceipt);
    expect(recorder.getPersistedMessage?.()).toMatchObject({
      content: "describe this",
      idempotencyKey: "chat-run-late:user",
    });
    const messages = await readTranscriptMessages(target);
    expect(messages).toEqual([
      expect.objectContaining({
        content: "describe this",
        idempotencyKey: "chat-run-late:user",
      }),
      expect.objectContaining({
        content: "",
        idempotencyKey: "chat-run-late:user:late-media",
        __openclaw: {
          hookOwned: true,
          lateMedia: true,
          media: [expect.objectContaining({ path: path.join(dir, "image.png") })],
        },
      }),
    ]);
    const lateProjection = buildLateMediaAttachedProjection(castAgentMessage(messages[1]));
    expect(lateProjection.text).toBe(`[media attached: ${path.join(dir, "image.png")}]`);
    expect(lateProjection.media).toEqual([
      expect.objectContaining({
        path: path.join(dir, "image.png"),
        contentType: "image/png",
        kind: "image",
      }),
    ]);
  });

  it("records the exact self-persisted admission identity", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-receipt-");
    const target = createSqliteTranscriptTarget({ dir });
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "admit exactly once",
        idempotencyKey: "receipt:user",
      },
      target,
    });

    const persisted = await recorder.persistApproved();

    expect(persisted).toBeDefined();
    expect(recorder.getAdmissionReceipt()).toBe(persisted?.admission);
    expect(recorder.getAdmissionReceipt()).toMatchObject({
      entryId: persisted?.messageId,
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      idempotencyKey: "receipt:user",
      logicalTurnId: expect.any(String),
      role: "user",
    });
  });

  it("adds confirmed steering provenance after runtime persistence", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-confirm-steer-");
    const target = createSqliteTranscriptTarget({ dir });
    const input = {
      text: "tighten the answer",
      idempotencyKey: "confirm-steer:user",
      sender: { id: "operator-1", name: "Operator" },
    };
    const recorder = createUserTurnTranscriptRecorder({ input, target });
    const persisted = await persistUserTurnTranscript({ ...target, input });
    expect(persisted).toBeDefined();
    recorder.markRuntimePersisted(persisted?.message, persisted?.admission);
    const initialGeneration = recorder.getAdmissionReceipt()?.generation;

    await recorder.confirmSteerTargetRunIdForPersistence?.("active-run");

    expect(recorder.getAdmissionReceipt()?.generation).not.toBe(initialGeneration);
    expect(recorder.getPersistedMessage?.()).toMatchObject({
      __openclaw: {
        senderId: "operator-1",
        senderName: "Operator",
        steerTargetRunId: "active-run",
      },
    });
    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        __openclaw: {
          senderId: "operator-1",
          senderName: "Operator",
          steerTargetRunId: "active-run",
        },
      }),
    ]);
  });

  it("waits for a deferred projection rebuild before returning admission identity", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-projection-");
    const target = createSqliteTranscriptTarget({ dir });
    await replaceSessionEntry(
      { storePath: target.storePath, sessionKey: target.sessionKey },
      {
        sessionId: target.sessionId,
        sessionFile: target.sqliteMarker,
        updatedAt: 1,
      },
    );
    await persistSessionTranscriptTurn(target, {
      messages: [
        { eventId: "root", parentId: null, message: { role: "user", content: "root" } },
        {
          eventId: "inactive",
          parentId: "root",
          message: { role: "assistant", content: "inactive" },
        },
        {
          eventId: "active",
          parentId: "root",
          message: { role: "assistant", content: "active" },
        },
      ],
      touchSessionEntry: false,
    });
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "admit after rebuild", idempotencyKey: "projection:user" },
      target,
    });

    const persisted = await recorder.persistApproved({ expectedSessionId: target.sessionId });

    expect(persisted).toBeDefined();
    expect(persisted?.admission).toMatchObject({
      entryId: persisted?.messageId,
      sessionId: target.sessionId,
      idempotencyKey: "projection:user",
    });
  });

  it("preserves distinct text supplied with late-resolved media", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-late-caption-");
    const target = createSqliteTranscriptTarget({ dir });
    const admittedInput = {
      text: "describe this",
      timestamp: 123,
      idempotencyKey: "chat-run-late-caption:user",
    };
    let resolveMedia!: (input: UserTurnInput) => void;
    let markResolverStarted!: () => void;
    const resolverStarted = new Promise<void>((resolve) => {
      markResolverStarted = resolve;
    });
    const recorder = createUserTurnTranscriptRecorder({
      input: admittedInput,
      resolveInput: async () => {
        markResolverStarted();
        return await new Promise<UserTurnInput>((resolve) => {
          resolveMedia = resolve;
        });
      },
      target,
    });
    const persistence = recorder.persistFallback();
    await resolverStarted;
    await persistUserTurnTranscript({ ...target, input: admittedInput });
    recorder.markRuntimePersisted(recorder.message);
    recorder.markSentToProvider?.();
    resolveMedia({
      ...admittedInput,
      text: "resolved subtitle",
      media: [{ path: path.join(dir, "image.png"), contentType: "image/png" }],
    });

    await persistence;

    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({ content: "describe this" }),
      expect.objectContaining({
        content: "resolved subtitle",
        __openclaw: {
          lateMedia: true,
          media: [{ path: path.join(dir, "image.png"), contentType: "image/png" }],
        },
      }),
    ]);
  });

  it("keeps #99495 media inline when it resolves before first serialization", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-early-media-");
    const target = createSqliteTranscriptTarget({ dir });
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "describe this",
        timestamp: 123,
        idempotencyKey: "chat-run-early:user",
      },
      resolveInput: async () => ({
        text: "describe this",
        timestamp: 123,
        idempotencyKey: "chat-run-early:user",
        media: [{ path: path.join(dir, "image.png"), contentType: "image/png" }],
      }),
      target: {
        ...target,
      },
    });

    await recorder.persistFallback();
    recorder.markSentToProvider?.();

    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        content: "describe this",
        idempotencyKey: "chat-run-early:user",
        __openclaw: {
          media: [expect.objectContaining({ path: path.join(dir, "image.png") })],
        },
      }),
    ]);
  });

  it("falls back to the admitted text message when lazy media resolution fails", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-lazy-failed-");
    const target = createSqliteTranscriptTarget({ dir });
    const errors: unknown[] = [];
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "keep the prompt",
        timestamp: 123,
        idempotencyKey: "chat-run-lazy-failed:user",
      },
      resolveInput: async () => {
        throw new Error("media staging failed");
      },
      target: {
        ...target,
      },
      updateMode: "none",
      onPersistenceError: (error) => errors.push(error),
    });

    const persisted = await recorder.persistFallback();

    expect(errors).toHaveLength(1);
    expect(persisted?.message).toMatchObject({
      role: "user",
      content: "keep the prompt",
      idempotencyKey: "chat-run-lazy-failed:user",
    });
    expect(persisted?.message).not.toHaveProperty("MediaPath");
    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "keep the prompt",
        idempotencyKey: "chat-run-lazy-failed:user",
      }),
    ]);
  });

  it("does not fallback-persist after runtime persistence is marked", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-runtime-");
    const target = createSqliteTranscriptTarget({ dir });
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "runtime-owned turn",
        timestamp: 123,
      },
      target: {
        ...target,
      },
      updateMode: "none",
    });

    recorder.markRuntimePersisted({
      role: "user",
      content: "runtime-owned turn",
      timestamp: 123,
    });

    await expect(recorder.persistFallback()).resolves.toBeUndefined();
    await expect(readTranscriptMessages(target)).resolves.toEqual([]);
  });

  it("approved persistence skips file targets after runtime persistence is marked", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-runtime-approved-");
    const target = createSqliteTranscriptTarget({ dir });
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "runtime-owned turn",
        timestamp: 123,
      },
      target: {
        ...target,
      },
      updateMode: "none",
    });

    recorder.markRuntimePersisted({
      role: "user",
      content: "runtime-owned turn",
      timestamp: 123,
    });

    await expect(recorder.persistApproved()).resolves.toBeUndefined();
    await expect(readTranscriptMessages(target)).resolves.toEqual([]);
  });

  it("approved persistence does not duplicate runtime-owned SQLite turns", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-runtime-canonical-");
    const storePath = path.join(dir, "sessions.json");
    const sessionStore = {};
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "runtime-owned turn",
        timestamp: 123,
      },
      target: {
        agentId: "main",
        sessionEntry: undefined,
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionStore,
        storePath,
      },
      updateMode: "none",
    });

    recorder.markRuntimePersisted({
      role: "user",
      content: "runtime-owned turn",
      timestamp: 123,
    });

    await expect(recorder.persistApproved()).resolves.toBeUndefined();
    await expect(
      readTranscriptMessages({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath,
      }),
    ).resolves.toEqual([]);
  });

  it("does not fallback-persist after before_agent_run blocks the turn", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-blocked-");
    const target = createSqliteTranscriptTarget({ dir });
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "raw blocked prompt",
        timestamp: 123,
      },
      target: {
        ...target,
      },
      updateMode: "none",
    });

    recorder.markBlocked();

    await expect(recorder.persistFallback()).resolves.toBeUndefined();
    await expect(readTranscriptMessages(target)).resolves.toEqual([]);
  });

  it("uses the runtime target supplied at approved persistence time", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-target-");
    const staleTarget = createSqliteTranscriptTarget({ dir, sessionId: "stale-session" });
    const admittedTarget = createSqliteTranscriptTarget({ dir, sessionId: "admitted-session" });
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "persist me in the admitted session",
        timestamp: 123,
      },
      target: {
        ...staleTarget,
      },
      updateMode: "none",
    });

    const persisted = await recorder.persistApproved({
      target: {
        ...admittedTarget,
      },
    });

    expect(persisted?.sessionFile).toBe(admittedTarget.sessionKey);
    await expect(readTranscriptMessages(staleTarget)).resolves.toEqual([]);
    await expect(readTranscriptMessages(admittedTarget)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "persist me in the admitted session",
      }),
    ]);
  });

  it("re-resolves the target after an explicitly retryable persistence miss", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-retry-");
    const admittedTarget = createSqliteTranscriptTarget({ dir, sessionId: "admitted-session" });
    let targetResolutionCount = 0;
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "persist me after the target rotates",
        timestamp: 123,
      },
      target: () => {
        targetResolutionCount += 1;
        return targetResolutionCount === 1 ? undefined : admittedTarget;
      },
      updateMode: "none",
    });

    await expect(recorder.persistApproved({ retryIfUnpersisted: true })).resolves.toBeUndefined();
    const persisted = await recorder.persistApproved({ retryIfUnpersisted: true });

    expect(targetResolutionCount).toBe(2);
    expect(persisted?.sessionFile).toBe(admittedTarget.sessionKey);
    await expect(readTranscriptMessages(admittedTarget)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "persist me after the target rotates",
      }),
    ]);
  });

  it("keeps concurrent persistence retries single-flight", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-concurrent-retry-");
    const admittedTarget = createSqliteTranscriptTarget({ dir, sessionId: "admitted-session" });
    let targetResolutionCount = 0;
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "persist me once after concurrent retries",
        timestamp: 123,
      },
      target: () => {
        targetResolutionCount += 1;
        return targetResolutionCount === 1 ? undefined : admittedTarget;
      },
      updateMode: "none",
    });

    await expect(recorder.persistApproved({ retryIfUnpersisted: true })).resolves.toBeUndefined();
    const [first, second] = await Promise.all([
      recorder.persistApproved({ retryIfUnpersisted: true }),
      recorder.persistApproved({ retryIfUnpersisted: true }),
    ]);

    expect(targetResolutionCount).toBe(2);
    expect(first?.sessionFile).toBe(admittedTarget.sessionKey);
    expect(second?.sessionFile).toBe(admittedTarget.sessionKey);
    await expect(readTranscriptMessages(admittedTarget)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "persist me once after concurrent retries",
      }),
    ]);
  });

  it("waits for runtime persistence before deciding fallback ownership", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-pending-");
    const target = createSqliteTranscriptTarget({ dir });
    let releaseRuntimePersistence!: () => void;
    const runtimePersistenceStarted = new Promise<void>((resolve) => {
      releaseRuntimePersistence = resolve;
    });
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "pending runtime turn",
        timestamp: 123,
      },
      target: {
        ...target,
      },
      updateMode: "none",
    });
    recorder.markRuntimePersistencePending(
      runtimePersistenceStarted.then(() => {
        recorder.markRuntimePersisted({
          role: "user",
          content: "pending runtime turn",
          timestamp: 123,
        });
      }),
    );

    let fallbackSettled = false;
    const fallback = recorder.persistFallback().then((result) => {
      fallbackSettled = true;
      return result;
    });

    await Promise.resolve();
    expect(fallbackSettled).toBe(false);

    releaseRuntimePersistence();

    await expect(fallback).resolves.toBeUndefined();
    await expect(readTranscriptMessages(target)).resolves.toEqual([]);
  });

  it("fallback-persists when pending runtime persistence fails", async () => {
    const dir = tempDirs.make("openclaw-user-turn-recorder-pending-failed-");
    const target = createSqliteTranscriptTarget({ dir });
    const errors: unknown[] = [];
    let rejectRuntimePersistence!: (error: unknown) => void;
    const runtimePersistence = new Promise<void>((_, reject) => {
      rejectRuntimePersistence = reject;
    });
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "pending failed turn",
        timestamp: 123,
      },
      target: {
        ...target,
      },
      updateMode: "none",
      onPersistenceError: (error) => errors.push(error),
    });
    recorder.markRuntimePersistencePending(runtimePersistence);

    const fallback = recorder.persistFallback();
    rejectRuntimePersistence(new Error("runtime append failed"));
    const persisted = await fallback;

    expect(errors).toHaveLength(1);
    expect(persisted?.message).toMatchObject({
      role: "user",
      content: "pending failed turn",
    });
    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "pending failed turn",
      }),
    ]);
  });
});
