// User turn transcript tests cover transcript extraction for user turns.
import fs from "node:fs";
import path from "node:path";
import { castAgentMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import {
  createUserTurnTranscriptRecorder,
  mergePreparedUserTurnMessageForRuntime,
  resolvePersistedUserTurnText,
} from "./user-turn-transcript.js";
import { persistUserTurnTranscript } from "./user-turn-transcript.test-support.js";

describe("user turn transcript persistence", () => {
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

  describe("trusted human transcript ownership", () => {
    it.each([
      [undefined, undefined, undefined],
      [undefined, "external_user", undefined],
      [undefined, "inter_session", undefined],
      [undefined, "internal_system", undefined],
      [false, undefined, false],
      [false, "external_user", false],
      [false, "inter_session", false],
      [false, "internal_system", false],
      [true, undefined, true],
      [true, "external_user", true],
      [true, "inter_session", false],
      [true, "internal_system", false],
    ] as const)("normalizes owner %s for %s input", (senderIsOwner, kind, expected) => {
      const provenance = kind ? { kind, sourceTool: "test" } : undefined;
      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: "remember",
          senderIsOwner,
          sender: { id: "author", identity: { type: "profile", id: "author" } },
          ...(provenance ? { provenance } : {}),
        },
        target: unusedRecorderTarget,
      });
      const message = recorder.message as
        | {
            __openclaw?: { senderIsOwner?: boolean; senderIdentity?: unknown };
            provenance?: unknown;
          }
        | undefined;
      expect(message?.["__openclaw"]?.senderIsOwner).toBe(expected);
      expect(message?.["__openclaw"]?.senderIdentity).toEqual(
        !kind || kind === "external_user" ? { type: "profile", id: "author" } : undefined,
      );
      expect(message?.provenance).toEqual(provenance);
    });

    it("normalizes synthetic owner facts after asynchronous input resolution", async () => {
      const provenance = { kind: "inter_session" as const, sourceTool: "sessions_send" };
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "owner prompt", senderIsOwner: true },
        resolveInput: async () => ({ text: "synthetic handoff", senderIsOwner: true, provenance }),
        target: unusedRecorderTarget,
      });
      expect(recorder.message).toMatchObject({ __openclaw: { senderIsOwner: true } });
      await expect(recorder.resolveMessage()).resolves.toMatchObject({
        provenance,
        __openclaw: { senderIsOwner: false },
      });
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
        __openclaw: {
          media: [expect.objectContaining({ path: "/tmp/image.png", contentType: "image/png" })],
        },
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
      expect(resolvePersistedUserTurnText("  What is in this image?  ")).toBe(
        "What is in this image?",
      );
    });

    it("preserves historical placeholder-like text as ordinary transcript content", () => {
      expect(resolvePersistedUserTurnText("<media:image> (2 images)")).toBe(
        "<media:image> (2 images)",
      );
    });
  });

  describe("persistUserTurnTranscript", () => {
    it("resolves the session file and persists the user turn", async () => {
      const dir = tempDirs.make("openclaw-user-turn-persist-");
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

      expect(persisted?.sessionFile).toBe(target.sessionKey);
      await expect(readTranscriptMessages(target)).resolves.toEqual([
        expect.objectContaining({
          role: "user",
          content: "hello",
        }),
      ]);
    });
  });
});
