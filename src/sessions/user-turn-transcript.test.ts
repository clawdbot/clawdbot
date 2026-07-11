// User turn transcript tests cover transcript extraction for user turns.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { castAgentMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentHarnessBeforeMessageWriteHook } from "../agents/harness/hook-helpers.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import {
  buildPersistedUserTurnMediaInputsFromFields,
  createUserTurnTranscriptRecorder,
  mergePreparedUserTurnMessageForRuntime,
  persistUserTurnTranscript,
  resolvePersistedUserTurnText,
  type UserTurnInput,
} from "./user-turn-transcript.js";

describe("user turn transcript persistence", () => {
  const tempDirs: string[] = [];
  const unusedRecorderTarget = {
    agentId: "main",
    sessionEntry: undefined,
    sessionId: "unused-session",
    sessionKey: "agent:main:unused",
    storePath: "/tmp/openclaw-unused-sessions.json",
  };

  afterEach(() => {
    resetGlobalHookRunner();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

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

  describe("buildPersistedUserTurnMediaInputsFromFields", () => {
    it("builds media inputs from structured context media fields", () => {
      expect(
        buildPersistedUserTurnMediaInputsFromFields({
          MediaPath: "/tmp/a.png",
          MediaPaths: ["/tmp/a.png", "/tmp/b.jpg"],
          MediaType: "image/png",
          MediaTypes: ["image/png", "image/jpeg"],
        }),
      ).toEqual([
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "/tmp/b.jpg", contentType: "image/jpeg" },
      ]);
    });

    it("uses url-backed media fields when no local path is present", () => {
      expect(
        buildPersistedUserTurnMediaInputsFromFields({
          MediaUrl: "media://inbound/a.png",
          MediaType: "image/png",
        }),
      ).toEqual([{ url: "media://inbound/a.png", contentType: "image/png" }]);
    });

    it("infers transcript media type from media path when explicit type is absent", () => {
      expect(
        buildPersistedUserTurnMediaInputsFromFields({
          MediaPaths: ["/tmp/a.png", "https://example.test/report.pdf"],
        }),
      ).toEqual([
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "https://example.test/report.pdf", contentType: "application/pdf" },
      ]);
    });

    it("does not reuse singular media type for later media paths", () => {
      expect(
        buildPersistedUserTurnMediaInputsFromFields({
          MediaPath: "/tmp/a.png",
          MediaPaths: ["/tmp/a.png", "/tmp/report.pdf"],
          MediaType: "image/png",
        }),
      ).toEqual([
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "/tmp/report.pdf", contentType: "application/pdf" },
      ]);
    });

    it("resolves staged relative media paths against the media workspace", () => {
      const workspaceDir = createTempDir("openclaw-user-turn-media-");

      expect(
        buildPersistedUserTurnMediaInputsFromFields({
          MediaPath: "media/inbound/a.png",
          MediaPaths: ["media/inbound/a.png", "media/inbound/b.jpg"],
          MediaType: "image/png",
          MediaTypes: ["image/png", "image/jpeg"],
          MediaWorkspaceDir: workspaceDir,
        }),
      ).toEqual([
        { path: path.join(workspaceDir, "media/inbound/a.png"), contentType: "image/png" },
        { path: path.join(workspaceDir, "media/inbound/b.jpg"), contentType: "image/jpeg" },
      ]);
    });

    it("does not rewrite absolute or URL-like media paths", () => {
      const workspaceDir = createTempDir("openclaw-user-turn-media-");
      const absolutePath = path.join(workspaceDir, "media/inbound/a.png");

      expect(
        buildPersistedUserTurnMediaInputsFromFields({
          MediaPaths: [absolutePath, "media://inbound/b.jpg", "https://example.test/c.png"],
          MediaTypes: ["image/png", "image/jpeg", "image/png"],
          MediaWorkspaceDir: workspaceDir,
        }),
      ).toEqual([
        { path: absolutePath, contentType: "image/png" },
        { path: "media://inbound/b.jpg", contentType: "image/jpeg" },
        { path: "https://example.test/c.png", contentType: "image/png" },
      ]);
    });

    it("does not infer media from absent structured fields", () => {
      expect(buildPersistedUserTurnMediaInputsFromFields(undefined)).toEqual([]);
      expect(buildPersistedUserTurnMediaInputsFromFields({})).toEqual([]);
    });

    it("preserves index alignment when an earlier attachment lacks a content type", () => {
      // Writer pads missing types with "" to keep MediaPaths/MediaTypes index-aligned.
      // The reader must NOT compact those "" holes away before indexing or a later
      // attachment's type lands on the wrong attachment.
      const result = buildPersistedUserTurnMediaInputsFromFields({
        MediaPaths: ["/media/a.bin", "/media/b.png"],
        MediaTypes: ["", "image/png"],
      });
      expect(result).toHaveLength(2);
      const [first, second] = result;
      // a.bin has no explicit type in the "" hole. Its contentType must NOT be
      // "image/png" — that belongs to b.png at index 1.
      expect(first).toMatchObject({ path: "/media/a.bin" });
      expect(first?.contentType).not.toBe("image/png");
      // b.png at index 1 must keep its own type correctly aligned.
      expect(second).toEqual({ path: "/media/b.png", contentType: "image/png" });
    });

    it("preserves index alignment when an earlier attachment lacks a url", () => {
      // Same misalignment risk for MediaUrls: a "" hole for a path-only attachment
      // must not shift a later attachment's URL to the wrong index.
      expect(
        buildPersistedUserTurnMediaInputsFromFields({
          MediaPaths: ["/media/local.bin", ""],
          MediaUrls: ["", "https://example.test/remote.png"],
          MediaTypes: ["application/octet-stream", "image/png"],
        }),
      ).toEqual([
        // local.bin has a path but no url (the "" was a placeholder, not a real url).
        { path: "/media/local.bin", contentType: "application/octet-stream" },
        // remote.png has no path (the "" was a placeholder) but does have a url.
        { url: "https://example.test/remote.png", contentType: "image/png" },
      ]);
    });
  });

  describe("mergePreparedUserTurnMessageForRuntime", () => {
    it("adds prepared transcript metadata to runtime user messages", () => {
      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: "display prompt",
          media: [{ path: "/tmp/image.png", contentType: "image/png" }],
          timestamp: 123,
        },
        target: unusedRecorderTarget,
      });

      expect(
        mergePreparedUserTurnMessageForRuntime({
          runtimeMessage: castAgentMessage({
            role: "user",
            content: "runtime prompt",
            provenance: { sourceChannel: "telegram" },
          }),
          preparedMessage: recorder.message,
        }),
      ).toMatchObject({
        role: "user",
        content: "display prompt",
        provenance: { sourceChannel: "telegram" },
        timestamp: 123,
        MediaPath: "/tmp/image.png",
        MediaType: "image/png",
      });
    });

    it("preserves runtime metadata when adding prepared sender attribution", () => {
      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: "group prompt",
          sender: { id: "user-42", name: "Ada" },
        },
        target: unusedRecorderTarget,
      });

      expect(
        mergePreparedUserTurnMessageForRuntime({
          runtimeMessage: castAgentMessage({
            role: "user",
            content: "runtime prompt",
            __openclaw: { mirrorIdentity: "run-1:prompt" },
          }),
          preparedMessage: recorder.message,
        }),
      ).toMatchObject({
        __openclaw: {
          mirrorIdentity: "run-1:prompt",
          senderId: "user-42",
          senderName: "Ada",
        },
      });
    });

    it("does not replace blocked before_agent_run user markers", () => {
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "raw prompt" },
        target: unusedRecorderTarget,
      });
      const blocked = castAgentMessage({
        role: "user",
        content: "[blocked]",
        __openclaw: { beforeAgentRunBlocked: true },
      });

      expect(
        mergePreparedUserTurnMessageForRuntime({
          runtimeMessage: blocked,
          preparedMessage: recorder.message,
        }),
      ).toBe(blocked);
    });

    it("preserves runtime multimodal content while merging prepared metadata", () => {
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "canonical image caption", timestamp: 123 },
        target: unusedRecorderTarget,
      });
      const runtimeContent = [
        { type: "text", text: "canonical image caption" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ];

      expect(
        mergePreparedUserTurnMessageForRuntime({
          runtimeMessage: castAgentMessage({
            role: "user",
            content: runtimeContent,
          }),
          preparedMessage: recorder.message,
        }),
      ).toMatchObject({
        role: "user",
        content: runtimeContent,
        timestamp: 123,
      });
    });

    it("does not apply prepared user metadata to assistant messages", () => {
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "display prompt" },
        target: unusedRecorderTarget,
      });
      const assistant = castAgentMessage({ role: "assistant", content: "hello" });

      expect(
        mergePreparedUserTurnMessageForRuntime({
          runtimeMessage: assistant,
          preparedMessage: recorder.message,
        }),
      ).toBe(assistant);
    });
  });

  describe("resolvePersistedUserTurnText", () => {
    it("normalizes the selected clean user-turn transcript text", () => {
      expect(resolvePersistedUserTurnText("  What is in this image?  ", { hasMedia: true })).toBe(
        "What is in this image?",
      );
    });

    it("ignores exact channel media placeholders only when structured media is present", () => {
      expect(resolvePersistedUserTurnText("<media:image> (2 images)", { hasMedia: true })).toBe(
        undefined,
      );
      expect(resolvePersistedUserTurnText("<media:image> (2 images)", { hasMedia: false })).toBe(
        "<media:image> (2 images)",
      );
    });
  });

  describe("persistUserTurnTranscript", () => {
    it("appends a structured user turn through the shared transcript writer", async () => {
      const dir = createTempDir("openclaw-user-turn-append-");
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

      expect(appended?.message).toMatchObject({
        role: "user",
        content: "What is in this image?",
        MediaPath: "/tmp/image.png",
      });
      await expect(readTranscriptMessages(target)).resolves.toEqual([
        expect.objectContaining({
          role: "user",
          content: "What is in this image?",
          MediaPath: "/tmp/image.png",
          __openclaw: { senderIsOwner: true },
          provenance,
          MediaType: "image/png",
        }),
      ]);
    });

    it("persists sender metadata as __openclaw envelope", async () => {
      const dir = createTempDir("openclaw-user-turn-append-sender-");
      const target = createSqliteTranscriptTarget({ dir });

      const appended = await persistUserTurnTranscript({
        ...target,
        input: {
          text: "hello from group",
          sender: {
            id: "8489979671",
            name: "Ram Shenoy",
            username: "ram_s",
          },
        },
        updateMode: "none",
      });

      expect(appended?.message).toMatchObject({
        role: "user",
        content: "hello from group",
        __openclaw: {
          senderId: "8489979671",
          senderName: "Ram Shenoy",
          senderUsername: "ram_s",
        },
      });
      await expect(readTranscriptMessages(target)).resolves.toEqual([
        expect.objectContaining({
          role: "user",
          content: "hello from group",
          __openclaw: {
            senderId: "8489979671",
            senderName: "Ram Shenoy",
            senderUsername: "ram_s",
          },
        }),
      ]);
    });

    it("omits __openclaw when no sender metadata is provided", async () => {
      const dir = createTempDir("openclaw-user-turn-append-nosender-");
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
      const dir = createTempDir("openclaw-user-turn-append-inline-");
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

    it("returns the existing user turn when the idempotency key was already persisted", async () => {
      const dir = createTempDir("openclaw-user-turn-append-idempotent-");
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
            handler: () => {
              hookCalls += 1;
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
      const dir = createTempDir("openclaw-user-turn-redacted-idempotent-");
      const target = createSqliteTranscriptTarget({ dir });

      await persistUserTurnTranscript({
        ...target,
        input: {
          text: "secret prompt",
          idempotencyKey: "chat-run-1:user",
          senderIsOwner: true,
          provenance,
          sender: { id: "user-42", name: "Ada" },
        },
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      });
      await persistUserTurnTranscript({
        ...target,
        input: {
          text: "secret prompt",
          idempotencyKey: "chat-run-1:user",
          senderIsOwner: true,
          provenance,
          sender: { id: "user-42", name: "Ada" },
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
            senderIsOwner: true,
          },
        }),
      ]);
      expect(hookCalls).toBe(1);
    });
  });

  describe("persistUserTurnTranscript", () => {
    it("resolves the session file and persists the user turn", async () => {
      const dir = createTempDir("openclaw-user-turn-persist-");
      const target = createSqliteTranscriptTarget({ dir });
      const sessionStore = {
        [target.sessionKey]: {
          sessionId: target.sessionId,
          sessionFile: target.sqliteMarker,
          updatedAt: 1,
        },
      };

      const persisted = await persistUserTurnTranscript({
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionEntry: sessionStore[target.sessionKey],
        sessionStore,
        storePath: target.storePath,
        agentId: target.agentId,
        cwd: dir,
        input: {
          text: "hello",
          timestamp: 123,
        },
        updateMode: "none",
      });

      expect(persisted?.sessionFile).toBe(target.sqliteMarker);
      await expect(readTranscriptMessages(target)).resolves.toEqual([
        expect.objectContaining({
          role: "user",
          content: "hello",
        }),
      ]);
    });
  });

  describe("createUserTurnTranscriptRecorder", () => {
    it("persists fallback user turns only once", async () => {
      const dir = createTempDir("openclaw-user-turn-recorder-fallback-");
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

      const [first, second] = await Promise.all([
        recorder.persistFallback(),
        recorder.persistFallback(),
      ]);

      expect(first?.messageId).toBeTruthy();
      expect(second?.messageId).toBe(first?.messageId);
      await expect(readTranscriptMessages(target)).resolves.toEqual([
        expect.objectContaining({
          role: "user",
          content: "hello from fallback",
          idempotencyKey: "chat-run-1:user",
        }),
      ]);
    });

    it("notifies once after fallback user-turn persistence", async () => {
      const dir = createTempDir("openclaw-user-turn-recorder-notify-");
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
      const dir = createTempDir("openclaw-user-turn-recorder-lazy-media-");
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
        MediaPath: path.join(dir, "image.png"),
        MediaType: "image/png",
      });
      await expect(readTranscriptMessages(target)).resolves.toEqual([
        expect.objectContaining({
          role: "user",
          content: "describe this",
          MediaPath: path.join(dir, "image.png"),
          MediaType: "image/png",
        }),
      ]);
    });

    it("appends #99495 media that resolves after the admitted turn reached the provider", async () => {
      const dir = createTempDir("openclaw-user-turn-recorder-late-media-");
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
        target: {
          ...target,
        },
      });
      const persistence = recorder.persistFallback();
      await resolverStarted;
      await persistUserTurnTranscript({
        ...target,
        input: admittedInput,
      });
      recorder.markRuntimePersisted(recorder.message);
      recorder.markSentToProvider?.();
      resolveMedia({
        ...admittedInput,
        media: [{ path: path.join(dir, "image.png"), contentType: "image/png" }],
      });

      await persistence;

      await expect(readTranscriptMessages(target)).resolves.toEqual([
        expect.objectContaining({
          content: "describe this",
          idempotencyKey: "chat-run-late:user",
        }),
        expect.objectContaining({
          content: `[media attached: ${path.join(dir, "image.png")}]`,
          idempotencyKey: "chat-run-late:user:late-media",
          MediaPath: path.join(dir, "image.png"),
        }),
      ]);
    });

    it("keeps #99495 media inline when it resolves before first serialization", async () => {
      const dir = createTempDir("openclaw-user-turn-recorder-early-media-");
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
          MediaPath: path.join(dir, "image.png"),
        }),
      ]);
    });

    it("falls back to the admitted text message when lazy media resolution fails", async () => {
      const dir = createTempDir("openclaw-user-turn-recorder-lazy-failed-");
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
      const dir = createTempDir("openclaw-user-turn-recorder-runtime-");
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
      const dir = createTempDir("openclaw-user-turn-recorder-runtime-approved-");
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
      const dir = createTempDir("openclaw-user-turn-recorder-runtime-canonical-");
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
      const dir = createTempDir("openclaw-user-turn-recorder-blocked-");
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
      const dir = createTempDir("openclaw-user-turn-recorder-target-");
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

      expect(persisted?.sessionFile).toBe(admittedTarget.sqliteMarker);
      await expect(readTranscriptMessages(staleTarget)).resolves.toEqual([]);
      await expect(readTranscriptMessages(admittedTarget)).resolves.toEqual([
        expect.objectContaining({
          role: "user",
          content: "persist me in the admitted session",
        }),
      ]);
    });

    it("waits for runtime persistence before deciding fallback ownership", async () => {
      const dir = createTempDir("openclaw-user-turn-recorder-pending-");
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
      const dir = createTempDir("openclaw-user-turn-recorder-pending-failed-");
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
});
