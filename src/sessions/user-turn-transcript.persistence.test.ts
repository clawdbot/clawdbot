// User turn persistence tests cover the shared transcript writer.
import fs from "node:fs";
import path from "node:path";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { castAgentMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../agents/harness/hook-helpers.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { loadTranscriptEvents, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createUserTurnTranscriptRecorder } from "./user-turn-transcript.js";
import { buildChannelUserTurnSender } from "./user-turn-transcript.metadata.js";
import { persistUserTurnTranscript } from "./user-turn-transcript.test-support.js";
import type { UserTurnOriginalInputCommit } from "./user-turn-transcript.types.js";

describe("persistUserTurnTranscript", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    resetGlobalHookRunner();
  });

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

  it("appends a structured user turn through the shared transcript writer", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-");
    const target = createSqliteTranscriptTarget({ dir });
    const provenance = {
      kind: "inter_session" as const,
      sourceSessionKey: "source-main",
      sourceTool: "sessions_send",
    };

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "What is in this image?",
        media: [{ path: "/tmp/image.png", contentType: "image/png" }],
        timestamp: 123,
        senderIsOwner: true,
        provenance,
      },
      updateMode: "none",
    });

    const expected = {
      role: "user",
      content: "What is in this image?",
      timestamp: 123,
      __openclaw: {
        senderIsOwner: false,
        media: [{ path: "/tmp/image.png", contentType: "image/png" }],
      },
      provenance,
    };
    expect(appended?.message).toEqual(expected);
    expect(JSON.stringify(appended?.message)).toBe(JSON.stringify(expected));
    const messages = await readTranscriptMessages(target);
    expect(messages).toEqual([expected]);
    expect(JSON.stringify(messages[0])).toBe(JSON.stringify(expected));
  });

  it("round-trips a multi-attachment SQLite row byte-identically", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-media-");
    const target = createSqliteTranscriptTarget({ dir });
    const expected = {
      role: "user",
      content: "Inspect both",
      timestamp: 456,
      __openclaw: {
        media: [
          { path: "/tmp/image.png", contentType: "image/png" },
          { url: "https://example.test/report.pdf", contentType: "application/pdf" },
        ],
      },
    };

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "Inspect both",
        timestamp: 456,
        media: [
          { path: "/tmp/image.png", contentType: "image/png" },
          { url: "https://example.test/report.pdf", contentType: "application/pdf" },
        ],
      },
      updateMode: "none",
    });

    expect(appended?.message).toEqual(expected);
    expect(JSON.stringify(appended?.message)).toBe(JSON.stringify(expected));
    const messages = await readTranscriptMessages(target);
    expect(messages).toEqual([expected]);
    expect(JSON.stringify(messages[0])).toBe(JSON.stringify(expected));
  });

  it("persists sender metadata as __openclaw envelope", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-sender-");
    const target = createSqliteTranscriptTarget({ dir });
    // Deliberately attach runtime-only profile fields to prove durable sender
    // attribution is a whitelist, not a copy of the inbound sender object.
    const runtimeOnlySenderFields = {
      senderProfileAvatarUrl: "/api/users/8489979671/avatar?v=1989876543210",
      profileRevision: 1_989_876_543_210,
      avatarBytes: "volatile-avatar-bytes",
      avatarHash: "volatile-avatar-hash",
    };
    const sender = {
      id: "8489979671",
      name: "Ram Shenoy",
      username: "ram_s",
      ...runtimeOnlySenderFields,
    };
    const expected = {
      role: "user",
      content: "hello from group",
      timestamp: 1_700_000_000_000,
      __openclaw: {
        senderId: "8489979671",
        senderName: "Ram Shenoy",
        senderUsername: "ram_s",
      },
    };

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello from group",
        timestamp: expected.timestamp,
        sender,
      },
      updateMode: "none",
    });

    const reloaded = await readTranscriptMessages(target);
    const durableMessages = [appended?.message, reloaded[0]];
    expect(durableMessages).toEqual([expected, expected]);
    for (const durableMessage of durableMessages) {
      const serialized = JSON.stringify(durableMessage);
      for (const [key, value] of Object.entries(runtimeOnlySenderFields)) {
        expect(serialized).not.toContain(key);
        expect(serialized).not.toContain(String(value));
      }
    }
  });

  it.each(["profile", "observation"] as const)(
    "sender provenance round-trips %s without display inference",
    async (type) => {
      const target = createSqliteTranscriptTarget({ dir: tempDirs.make("sender-provenance-") });
      const identity =
        type === "profile"
          ? { type, id: "shared-id" }
          : {
              type,
              id: "shared-id",
              pluginId: "test-channel",
              accountId: null,
              senderKind: "unknown" as const,
            };
      const sender =
        type === "profile"
          ? { id: identity.id, name: "Same label", identity }
          : buildChannelUserTurnSender({
              SenderId: "shared-id",
              SenderName: "Same label",
              Provider: "test-channel",
            });
      await persistUserTurnTranscript({ ...target, input: { text: "hello", sender } });
      const [message] = await readTranscriptMessages(target);
      expect(message?.["__openclaw"]).toMatchObject({
        senderId: "shared-id",
        senderName: "Same label",
        senderIdentity: identity,
      });
    },
  );

  it.each(["retain", "omit", "replace", "in-place", "raw-redact", "forge"] as const)(
    "sender provenance hook %s respects original producer evidence",
    async (mode) => {
      const target = createSqliteTranscriptTarget({
        dir: tempDirs.make("sender-provenance-hook-"),
      });
      const identity = { type: "profile", id: "original" };
      const recorder = createUserTurnTranscriptRecorder({
        message: {
          role: "user",
          content: "hello",
          timestamp: 1,
          __openclaw: {
            senderId: "original",
            senderName: "Original",
            senderIsOwner: true,
            ...(mode === "forge" ? {} : { senderIdentity: identity }),
          },
        },
        target,
        beforeMessageWrite: ({ message }) => {
          const metadata =
            mode === "in-place" ? message["__openclaw"]! : { ...message["__openclaw"] };
          if (mode === "omit") {
            delete metadata.senderIdentity;
          }
          if (mode === "replace" || mode === "forge") {
            metadata.senderIdentity = { type: "profile", id: "forged" };
          }
          if (mode === "in-place") {
            (metadata.senderIdentity as { id: string }).id = "forged";
          }
          if (mode === "raw-redact") {
            delete metadata.senderId;
          }
          return {
            ...message,
            __openclaw: { ...metadata, senderName: "Edited display", senderIsOwner: false },
          };
        },
      });
      await recorder.persistApproved();
      const [message] = await readTranscriptMessages(target);
      expect(message?.["__openclaw"]).toEqual({
        ...(mode === "raw-redact" ? {} : { senderId: "original" }),
        senderName: "Edited display",
        senderIsOwner: true,
        ...(mode === "retain" ? { senderIdentity: { type: "profile", id: "original" } } : {}),
      });
    },
  );

  it("omits __openclaw when no sender metadata is provided", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-nosender-");
    const target = createSqliteTranscriptTarget({ dir });

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello without sender",
        sender: { id: "", name: null },
      },
      updateMode: "none",
    });

    expect(appended?.message).not.toHaveProperty("__openclaw");
  });

  it("uses inline update mode by default", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-inline-");
    const target = createSqliteTranscriptTarget({ dir });

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello from runtime",
      },
    });

    expect(appended?.message).toMatchObject({
      role: "user",
      content: "hello from runtime",
      timestamp: expect.any(Number),
    });
    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "hello from runtime",
        timestamp: expect.any(Number),
      }),
    ]);
  });

  it("reports one original committed input, never staged custody or idempotent replay", async () => {
    const target = createSqliteTranscriptTarget({ dir: tempDirs.make("original-input-commit-") });
    const commits: UserTurnOriginalInputCommit[] = [];
    const input = {
      text: "Hello @Ada",
      timestamp: 123,
      idempotencyKey: "source-mention:user",
      mentions: [{ profileId: "ada", start: 6, end: 10 }],
    };
    const createRecorder = () =>
      createUserTurnTranscriptRecorder({
        input,
        target,
        onOriginalInputCommitted: (commit) => commits.push(commit),
      });
    const first = createRecorder();
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    await expect(
      first.stageApproved?.({ runId: "source-mention", assertCurrent: () => {} }),
    ).resolves.toBe(true);
    expect(commits).toEqual([]);
    const result = await first.persistApproved();
    await first.persistFallback();
    const replay = await createRecorder().persistApproved();
    expect(replay?.appended).toBe(false);
    expect(commits).toEqual([
      {
        anchor: expect.objectContaining({
          entryId: result?.messageId,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
        }),
        message: expect.objectContaining({
          content: input.text,
          __openclaw: { humanMentions: input.mentions },
        }),
      },
    ]);
    expect(await readTranscriptMessages(target)).toHaveLength(1);
  });

  it.each([undefined, false, true])(
    "requires explicit runtime append freshness (%s), not an admission anchor",
    async (appended) => {
      const target = createSqliteTranscriptTarget({ dir: tempDirs.make("runtime-input-commit-") });
      const commits: UserTurnOriginalInputCommit[] = [];
      const input = { text: "Hello @Ada", idempotencyKey: "runtime-mention:user" };
      const result = await persistUserTurnTranscript({ ...target, input });
      const recorder = createUserTurnTranscriptRecorder({
        input,
        target,
        onOriginalInputCommitted: (commit) => commits.push(commit),
      });
      const persistence = appended === undefined ? undefined : { appended };
      recorder.markRuntimePersisted(result?.message, result?.admission, persistence);
      recorder.markRuntimePersisted(result?.message, result?.admission, persistence);
      expect(recorder.getAdmissionReceipt()?.entryId).toBe(result?.messageId);
      expect(commits).toHaveLength(appended === true ? 1 : 0);
    },
  );

  it.each([
    "hidden",
    "internal",
    "handoff",
    "excluded",
    "blocked",
    "placeholder",
    "late-media",
  ] as const)("does not report %s rows as original human input", async (kind) => {
    const target = createSqliteTranscriptTarget({ dir: tempDirs.make("non-original-input-") });
    const commits: UserTurnOriginalInputCommit[] = [];
    const message = {
      role: "user" as const,
      content: "@Ada",
      timestamp: 1,
      ...(kind === "hidden" ? { display: false as const } : {}),
      ...(kind === "excluded" ? { excludeFromContext: true as const } : {}),
      ...(kind === "internal" ? { provenance: { kind: "internal_system" as const } } : {}),
      ...(kind === "handoff" ? { provenance: { kind: "inter_session" as const } } : {}),
      ...(kind === "placeholder" ? { __openclaw: { beforeAgentRunBlocked: true } } : {}),
      ...(kind === "late-media" ? { __openclaw: { lateMedia: true } } : {}),
    };
    const recorder = createUserTurnTranscriptRecorder({
      message,
      target,
      onOriginalInputCommitted: (commit) => commits.push(commit),
    });
    await (kind === "blocked" ? recorder.persistBlocked(message) : recorder.persistApproved());
    expect(await readTranscriptMessages(target)).toHaveLength(1);
    expect(commits).toEqual([]);
  });

  it.each([true, false])(
    "fans committed source mentions back to their own recorders only for an annotated collection (%s)",
    async (annotated) => {
      const target = createSqliteTranscriptTarget({
        dir: tempDirs.make("collected-input-commit-"),
      });
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      const commits: UserTurnOriginalInputCommit[] = [];
      const sources = ["ada", "grace"].map((profileId) =>
        createUserTurnTranscriptRecorder({
          input: {
            text: `@${profileId}`,
            idempotencyKey: `${profileId}:user`,
            mentions: [{ profileId, start: 0, end: profileId.length + 1 }],
            sender: {
              id: `sender-${profileId}`,
              identity: { type: "profile", id: `sender-${profileId}` },
            },
          },
          target,
          onOriginalInputCommitted: (commit) => commits.push(commit),
        }),
      );
      for (const [index, source] of sources.entries()) {
        await source.stageApproved?.({ runId: `source-${index}`, assertCurrent: () => {} });
      }
      const aggregate = createUserTurnTranscriptRecorder({
        input: {
          text: annotated ? "@ada\n@grace" : "Two queued messages were summarized.",
          idempotencyKey: "aggregate:user",
          ...(annotated
            ? {
                mentions: [
                  { profileId: "ada", start: 0, end: 4 },
                  { profileId: "grace", start: 5, end: 11 },
                ],
              }
            : {}),
        },
        pendingInputSources: sources,
        target,
      });
      const result = await aggregate.persistApproved();
      await aggregate.persistFallback();
      expect(result?.appended).toBe(true);
      expect(
        commits.map((commit) => ({
          text: commit.message.content,
          sender: commit.message["__openclaw"]?.senderId,
          entryId: commit.anchor.entryId,
        })),
      ).toEqual(
        annotated
          ? [
              { text: "@ada", sender: "sender-ada", entryId: result?.messageId },
              { text: "@grace", sender: "sender-grace", entryId: result?.messageId },
            ]
          : [],
      );
      expect(await readTranscriptMessages(target)).toHaveLength(1);
    },
  );

  it("does not fail or retry a committed input when notification and diagnostic callbacks throw", async () => {
    const target = createSqliteTranscriptTarget({ dir: tempDirs.make("original-input-errors-") });
    const errors: unknown[] = [];
    let attempts = 0;
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "@Ada", idempotencyKey: "notification-error:user" },
      target,
      onOriginalInputCommitted: () => {
        attempts += 1;
        throw new Error("notification failed");
      },
      onPersistenceError: (error) => {
        errors.push(error);
        throw new Error("diagnostic failed");
      },
    });
    await expect(recorder.persistApproved()).resolves.toMatchObject({ appended: true });
    await recorder.persistFallback();
    expect(attempts).toBe(1);
    expect(errors).toEqual([expect.objectContaining({ message: "notification failed" })]);
    expect(await readTranscriptMessages(target)).toHaveLength(1);
  });

  it.each(["retain", "replace-text", "mutate-spans", "forge"] as const)(
    "keeps human selections bound to their original bytes through hook %s",
    async (mode) => {
      const target = createSqliteTranscriptTarget({ dir: tempDirs.make("mention-hook-") });
      const mentions = [{ profileId: "ada", start: 6, end: 10 }];
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "Hello @Ada", ...(mode === "forge" ? {} : { mentions }) },
        target,
        beforeMessageWrite: ({ message }) => {
          if (mode === "mutate-spans") {
            message["__openclaw"]!.humanMentions![0]!.profileId = "forged";
          }
          return {
            ...message,
            content: mode === "replace-text" ? "[redacted]" : message.content,
            __openclaw: { humanMentions: [{ profileId: "forged", start: 0, end: 6 }] },
          };
        },
      });
      await recorder.persistApproved();
      const [message] = await readTranscriptMessages(target);
      expect(message).toHaveProperty(
        "content",
        mode === "replace-text" ? "[redacted]" : "Hello @Ada",
      );
      expect(
        (message?.["__openclaw"] as { humanMentions?: unknown } | undefined)?.humanMentions,
      ).toEqual(mode === "replace-text" || mode === "forge" ? undefined : mentions);
    },
  );

  it("returns the existing user turn when the idempotency key was already persisted", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-idempotent-");
    const target = createSqliteTranscriptTarget({ dir });

    const first = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello once",
        timestamp: 123,
        idempotencyKey: "chat-run-1:user",
      },
      updateMode: "none",
    });
    const second = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello once replayed",
        timestamp: 456,
        idempotencyKey: "chat-run-1:user",
      },
      updateMode: "none",
    });

    expect(second?.messageId).toBe(first?.messageId);
    expect(second?.message).toMatchObject({
      role: "user",
      content: "hello once",
      timestamp: 123,
      idempotencyKey: "chat-run-1:user",
    });
    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "hello once",
        timestamp: 123,
        idempotencyKey: "chat-run-1:user",
      }),
    ]);
  });

  it("preserves transcript metadata when before_message_write replaces a user turn", async () => {
    let hookCalls = 0;
    const provenance = {
      kind: "inter_session" as const,
      sourceSessionKey: "source-main",
      sourceTool: "sessions_send",
    };
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => {
            hookCalls += 1;
            const message = (event as { message: Record<string, unknown> }).message;
            const meta = message["__openclaw"] as {
              transport?: { conversationRef?: string; messageId?: string };
            };
            if (meta.transport) {
              meta.transport.conversationRef = "conv_tampered";
              meta.transport.messageId = "tampered-message";
            }
            return {
              message: castAgentMessage({
                role: "user",
                content: "[redacted by hook]",
                __openclaw: { hookOwned: true },
              }),
            };
          },
        },
      ]),
    );
    const dir = tempDirs.make("openclaw-user-turn-redacted-idempotent-");
    const target = createSqliteTranscriptTarget({ dir });

    await persistUserTurnTranscript({
      ...target,
      input: {
        text: "secret prompt",
        idempotencyKey: "chat-run-1:user",
        replyToId: "transcript-reply-1",
        replyToPreview: { text: "Original reply", senderLabel: "Molty" },
        senderIsOwner: true,
        provenance,
        sender: { id: "user-42", name: "Ada" },
        transport: {
          channel: "reef",
          conversationRef: "conv_0123456789abcdef0123456789abcdef",
          messageId: "inbound-1",
          replyToId: "outbound-1",
        },
      },
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    });
    await persistUserTurnTranscript({
      ...target,
      input: {
        text: "secret prompt",
        idempotencyKey: "chat-run-1:user",
        replyToId: "transcript-reply-1",
        replyToPreview: { text: "Original reply", senderLabel: "Molty" },
        senderIsOwner: true,
        provenance,
        sender: { id: "user-42", name: "Ada" },
        transport: {
          channel: "reef",
          conversationRef: "conv_0123456789abcdef0123456789abcdef",
          messageId: "inbound-1",
          replyToId: "outbound-1",
        },
      },
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    });

    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "[redacted by hook]",
        idempotencyKey: "chat-run-1:user",
        provenance,
        __openclaw: {
          hookOwned: true,
          replyToId: "transcript-reply-1",
          replyToPreview: { text: "Original reply", senderLabel: "Molty" },
          senderIsOwner: false,
          transport: {
            channel: "reef",
            conversationRef: "conv_0123456789abcdef0123456789abcdef",
            messageId: "inbound-1",
            replyToId: "outbound-1",
          },
        },
      }),
    ]);
    expect(hookCalls).toBe(1);
  });

  it.each([true, false])(
    "protects internal Goal metadata across write hooks (Goal: %s)",
    async (isGoal) => {
      const target = createSqliteTranscriptTarget({ dir: tempDirs.make("openclaw-goal-hook-") });
      const intent = {
        kind: "session-goal-resume",
        version: 1,
        goalId: "goal-1",
        operationId: "resume-1",
      };
      const recorder = createUserTurnTranscriptRecorder({
        message: {
          role: "user",
          content: "Continue pursuing the current goal.",
          timestamp: 123,
          ...(isGoal
            ? {
                display: false as const,
                provenance: { kind: "internal_system" as const },
                __openclaw: { intent },
              }
            : {}),
        },
        target,
        beforeMessageWrite: () =>
          castAgentMessage({
            role: "user",
            content: "redacted",
            timestamp: 123,
            display: true,
            provenance: { kind: "external_user" },
            __openclaw: { intent: { kind: "forged" } },
          }),
      });
      await recorder.persistApproved();
      const [message] = await readTranscriptMessages(target);
      expect((message?.["__openclaw"] as Record<string, unknown> | undefined)?.intent).toEqual(
        isGoal ? intent : undefined,
      );
      if (isGoal) {
        expect(message).toMatchObject({ display: false, provenance: { kind: "internal_system" } });
      }
    },
  );

  it.each([
    {
      name: "restores an erased producer target",
      producerTarget: "active-run",
      hookTarget: undefined,
      expectedTarget: "active-run",
    },
    {
      name: "rejects a replacement target",
      producerTarget: "active-run",
      hookTarget: "forged-run",
      expectedTarget: "active-run",
    },
    {
      name: "rejects a target forged without producer provenance",
      producerTarget: undefined,
      hookTarget: "forged-run",
      expectedTarget: undefined,
    },
  ])(
    "$name across before_message_write",
    async ({ producerTarget, hookTarget, expectedTarget }) => {
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_message_write",
            handler: (event) => {
              const message = (event as { message: Record<string, unknown> }).message;
              const metadata = {
                ...(message["__openclaw"] as Record<string, unknown> | undefined),
              };
              delete metadata.steerTargetRunId;
              return {
                message: castAgentMessage({
                  ...message,
                  __openclaw: {
                    ...metadata,
                    ...(hookTarget ? { steerTargetRunId: hookTarget } : {}),
                  },
                }),
              };
            },
          },
        ]),
      );
      const dir = tempDirs.make("openclaw-user-turn-steer-target-hook-");
      const target = createSqliteTranscriptTarget({ dir });

      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: "steer or queue",
          idempotencyKey: "chat-run-steer-target:user",
        },
        target,
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      });
      if (producerTarget) {
        await recorder.confirmSteerTargetRunIdForPersistence?.(producerTarget);
      }
      await recorder.persistApproved();

      const [message] = await readTranscriptMessages(target);
      const metadata = message?.["__openclaw"] as Record<string, unknown> | undefined;
      expect(metadata?.steerTargetRunId).toBe(expectedTarget);
    },
  );
});
