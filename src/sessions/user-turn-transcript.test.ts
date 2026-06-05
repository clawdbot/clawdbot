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
import {
  appendUserTurnTranscriptMessage,
  buildPersistedUserTurnMediaInputsFromFields,
  createUserTurnTranscriptRecorder,
  mergePreparedUserTurnMessageForRuntime,
  persistUserTurnTranscript,
  resolvePersistedUserTurnText,
} from "./user-turn-transcript.js";

describe("user turn transcript persistence", () => {
  const tempDirs: string[] = [];

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

  function readTranscriptMessages(transcriptPath: string): Array<Record<string, unknown>> {
    return fs
      .readFileSync(transcriptPath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { message?: unknown })
      .map((entry) => entry.message)
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
  });

  describe("mergePreparedUserTurnMessageForRuntime", () => {
    it("adds prepared transcript metadata to runtime user messages", () => {
      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: "display prompt",
          media: [{ path: "/tmp/image.png", contentType: "image/png" }],
          timestamp: 123,
        },
        target: { transcriptPath: "/tmp/session.jsonl" },
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

    it("does not replace blocked before_agent_run user markers", () => {
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "raw prompt" },
        target: { transcriptPath: "/tmp/session.jsonl" },
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

    it("does not apply prepared user metadata to assistant messages", () => {
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "display prompt" },
        target: { transcriptPath: "/tmp/session.jsonl" },
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

  describe("appendUserTurnTranscriptMessage", () => {
    it("appends a structured user turn through the shared transcript writer", async () => {
      const dir = createTempDir("openclaw-user-turn-append-");
      const transcriptPath = path.join(dir, "session.jsonl");
      const provenance = {
        kind: "inter_session" as const,
        sourceSessionKey: "source-main",
        sourceTool: "sessions_send",
      };

      const appended = await appendUserTurnTranscriptMessage({
        transcriptPath,
        sessionId: "session-1",
        sessionKey: "main",
        cwd: dir,
        input: {
          text: "What is in this image?",
          media: [{ path: "/tmp/image.png", contentType: "image/png" }],
          timestamp: 123,
          provenance,
        },
        updateMode: "none",
      });

      expect(appended?.message).toMatchObject({
        role: "user",
        content: "What is in this image?",
        MediaPath: "/tmp/image.png",
      });
      expect(readTranscriptMessages(transcriptPath)).toEqual([
        expect.objectContaining({
          role: "user",
          content: "What is in this image?",
          MediaPath: "/tmp/image.png",
          provenance,
          MediaType: "image/png",
        }),
      ]);
    });

    it("uses inline update mode by default", async () => {
      const dir = createTempDir("openclaw-user-turn-append-inline-");
      const transcriptPath = path.join(dir, "session.jsonl");

      const appended = await appendUserTurnTranscriptMessage({
        transcriptPath,
        sessionId: "session-1",
        sessionKey: "main",
        cwd: dir,
        input: {
          text: "hello from runtime",
        },
      });

      expect(appended?.message).toMatchObject({
        role: "user",
        content: "hello from runtime",
        timestamp: expect.any(Number),
      });
      expect(readTranscriptMessages(transcriptPath)).toEqual([
        expect.objectContaining({
          role: "user",
          content: "hello from runtime",
          timestamp: expect.any(Number),
        }),
      ]);
    });

    it("returns the existing user turn when the idempotency key was already persisted", async () => {
      const dir = createTempDir("openclaw-user-turn-append-idempotent-");
      const transcriptPath = path.join(dir, "session.jsonl");

      const first = await appendUserTurnTranscriptMessage({
        transcriptPath,
        sessionId: "session-1",
        sessionKey: "main",
        cwd: dir,
        input: {
          text: "hello once",
          timestamp: 123,
          idempotencyKey: "chat-run-1:user",
        },
        updateMode: "none",
      });
      const second = await appendUserTurnTranscriptMessage({
        transcriptPath,
        sessionId: "session-1",
        sessionKey: "main",
        cwd: dir,
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
      expect(readTranscriptMessages(transcriptPath)).toEqual([
        expect.objectContaining({
          role: "user",
          content: "hello once",
          timestamp: 123,
          idempotencyKey: "chat-run-1:user",
        }),
      ]);
    });

    it("preserves idempotency keys when before_message_write replaces a user turn", async () => {
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
                }),
              };
            },
          },
        ]),
      );
      const dir = createTempDir("openclaw-user-turn-redacted-idempotent-");
      const transcriptPath = path.join(dir, "session.jsonl");

      await appendUserTurnTranscriptMessage({
        transcriptPath,
        input: {
          text: "secret prompt",
          idempotencyKey: "chat-run-1:user",
          provenance,
        },
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      });
      await appendUserTurnTranscriptMessage({
        transcriptPath,
        input: {
          text: "secret prompt",
          idempotencyKey: "chat-run-1:user",
          provenance,
        },
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      });

      expect(readTranscriptMessages(transcriptPath)).toEqual([
        expect.objectContaining({
          role: "user",
          content: "[redacted by hook]",
          idempotencyKey: "chat-run-1:user",
          provenance,
        }),
      ]);
      expect(hookCalls).toBe(1);
    });
  });

  describe("persistUserTurnTranscript", () => {
    it("resolves the session file and persists the user turn", async () => {
      const dir = createTempDir("openclaw-user-turn-persist-");
      const transcriptPath = path.join(dir, "session.jsonl");
      const sessionStore = {
        main: {
          sessionId: "session-1",
          sessionFile: transcriptPath,
          updatedAt: 1,
        },
      };

      const persisted = await persistUserTurnTranscript({
        sessionId: "session-1",
        sessionKey: "main",
        sessionEntry: sessionStore.main,
        sessionStore,
        storePath: path.join(dir, "sessions.json"),
        agentId: "agent",
        cwd: dir,
        input: {
          text: "hello",
          timestamp: 123,
        },
        updateMode: "none",
      });

      expect(persisted?.sessionFile).toBeTruthy();
      expect(fs.existsSync(persisted?.sessionFile ?? "")).toBe(true);
      expect(readTranscriptMessages(persisted?.sessionFile ?? "")).toEqual([
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
      const transcriptPath = path.join(dir, "session.jsonl");
      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: "hello from fallback",
          timestamp: 123,
          idempotencyKey: "chat-run-1:user",
        },
        target: {
          transcriptPath,
          sessionId: "session-1",
          sessionKey: "main",
          cwd: dir,
        },
        updateMode: "none",
      });

      const [first, second] = await Promise.all([
        recorder.persistFallback(),
        recorder.persistFallback(),
      ]);

      expect(first?.messageId).toBeTruthy();
      expect(second?.messageId).toBe(first?.messageId);
      expect(readTranscriptMessages(transcriptPath)).toEqual([
        expect.objectContaining({
          role: "user",
          content: "hello from fallback",
          idempotencyKey: "chat-run-1:user",
        }),
      ]);
    });

    it("resolves media lazily at persistence time", async () => {
      const dir = createTempDir("openclaw-user-turn-recorder-lazy-media-");
      const transcriptPath = path.join(dir, "session.jsonl");
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
          transcriptPath,
          sessionId: "session-1",
          sessionKey: "main",
          cwd: dir,
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
      expect(readTranscriptMessages(transcriptPath)).toEqual([
        expect.objectContaining({
          role: "user",
          content: "describe this",
          MediaPath: path.join(dir, "image.png"),
          MediaType: "image/png",
        }),
      ]);
    });

    it("falls back to the admitted text message when lazy media resolution fails", async () => {
      const dir = createTempDir("openclaw-user-turn-recorder-lazy-failed-");
      const transcriptPath = path.join(dir, "session.jsonl");
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
          transcriptPath,
          sessionId: "session-1",
          sessionKey: "main",
          cwd: dir,
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
      expect(readTranscriptMessages(transcriptPath)).toEqual([
        expect.objectContaining({
          role: "user",
          content: "keep the prompt",
          idempotencyKey: "chat-run-lazy-failed:user",
        }),
      ]);
    });

    it("does not fallback-persist after runtime persistence is marked", async () => {
      const dir = createTempDir("openclaw-user-turn-recorder-runtime-");
      const transcriptPath = path.join(dir, "session.jsonl");
      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: "runtime-owned turn",
          timestamp: 123,
        },
        target: {
          transcriptPath,
          sessionId: "session-1",
          sessionKey: "main",
          cwd: dir,
        },
        updateMode: "none",
      });

      recorder.markRuntimePersisted({
        role: "user",
        content: "runtime-owned turn",
        timestamp: 123,
      });

      await expect(recorder.persistFallback()).resolves.toBeUndefined();
      expect(fs.existsSync(transcriptPath)).toBe(false);
    });

    it("does not fallback-persist after before_agent_run blocks the turn", async () => {
      const dir = createTempDir("openclaw-user-turn-recorder-blocked-");
      const transcriptPath = path.join(dir, "session.jsonl");
      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: "raw blocked prompt",
          timestamp: 123,
        },
        target: {
          transcriptPath,
          sessionId: "session-1",
          sessionKey: "main",
          cwd: dir,
        },
        updateMode: "none",
      });

      recorder.markBlocked();

      await expect(recorder.persistFallback()).resolves.toBeUndefined();
      expect(fs.existsSync(transcriptPath)).toBe(false);
    });

    it("uses the runtime target supplied at approved persistence time", async () => {
      const dir = createTempDir("openclaw-user-turn-recorder-target-");
      const staleTranscriptPath = path.join(dir, "stale.jsonl");
      const admittedTranscriptPath = path.join(dir, "admitted.jsonl");
      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: "persist me in the admitted session",
          timestamp: 123,
        },
        target: {
          transcriptPath: staleTranscriptPath,
          sessionId: "stale-session",
          sessionKey: "main",
          cwd: dir,
        },
        updateMode: "none",
      });

      const persisted = await recorder.persistApproved({
        target: {
          transcriptPath: admittedTranscriptPath,
          sessionId: "admitted-session",
          sessionKey: "main",
          cwd: dir,
        },
      });

      expect(persisted?.sessionFile).toBe(admittedTranscriptPath);
      expect(fs.existsSync(staleTranscriptPath)).toBe(false);
      expect(readTranscriptMessages(admittedTranscriptPath)).toEqual([
        expect.objectContaining({
          role: "user",
          content: "persist me in the admitted session",
        }),
      ]);
    });

    it("waits for runtime persistence before deciding fallback ownership", async () => {
      const dir = createTempDir("openclaw-user-turn-recorder-pending-");
      const transcriptPath = path.join(dir, "session.jsonl");
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
          transcriptPath,
          sessionId: "session-1",
          sessionKey: "main",
          cwd: dir,
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
      expect(fs.existsSync(transcriptPath)).toBe(false);
    });

    it("fallback-persists when pending runtime persistence fails", async () => {
      const dir = createTempDir("openclaw-user-turn-recorder-pending-failed-");
      const transcriptPath = path.join(dir, "session.jsonl");
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
          transcriptPath,
          sessionId: "session-1",
          sessionKey: "main",
          cwd: dir,
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
      expect(readTranscriptMessages(transcriptPath)).toEqual([
        expect.objectContaining({
          role: "user",
          content: "pending failed turn",
        }),
      ]);
    });
  });
});
