import { describe, expect, it } from "vitest";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { withSessionTranscriptWriteLock } from "../plugin-sdk/session-transcript-runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";

async function appendImportedMessage(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}) {
  await withSessionTranscriptWriteLock(
    {
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    async (transcript) => {
      await transcript.appendMessage({
        message: { role: "user", content: "Imported snapshot", timestamp: 1 },
      });
    },
  );
}

describe("atomic Gateway session initialization", () => {
  it("publishes a usable session only after its transcript initializer succeeds", async () => {
    await withOpenClawTestState({ label: "atomic-session-success" }, async () => {
      let transcriptScope:
        | { agentId: string; sessionId: string; sessionKey: string; storePath: string }
        | undefined;
      const created = await createGatewaySession({
        cfg: {},
        key: "agent:main:atomic-success",
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
        atomicInitialization: true,
        afterCreate: async (entry) => {
          expect(entry.entry.initializationPending).toBe(true);
          transcriptScope = {
            agentId: entry.agentId,
            sessionId: entry.entry.sessionId,
            sessionKey: entry.key,
            storePath: entry.storePath,
          };
          await appendImportedMessage(transcriptScope);
        },
      });

      expect(created).toMatchObject({
        ok: true,
        entry: { initializationPending: undefined },
        postCommit: { status: "completed" },
      });
      if (!created.ok) {
        throw new Error(created.error.message);
      }
      expect(loadSessionEntryReadOnly({ sessionKey: created.key })?.initializationPending).toBe(
        undefined,
      );
      expect(transcriptScope).toBeDefined();
      expect(JSON.stringify(await loadTranscriptEvents(transcriptScope!))).toContain(
        "Imported snapshot",
      );
    });
  });

  it("removes the new session and transcript when initialization fails", async () => {
    await withOpenClawTestState({ label: "atomic-session-failure" }, async () => {
      const sessionKey = "agent:main:atomic-failure";
      const created = await createGatewaySession({
        cfg: {},
        key: sessionKey,
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
        atomicInitialization: true,
        afterCreate: async (entry) => {
          await appendImportedMessage({
            agentId: entry.agentId,
            sessionId: entry.entry.sessionId,
            sessionKey: entry.key,
            storePath: entry.storePath,
          });
          throw new Error("snapshot changed");
        },
      });

      expect(created).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: "session initialization failed: snapshot changed" },
      });
      expect(loadSessionEntryReadOnly({ sessionKey })).toBeUndefined();
    });
  });

  it("preserves the existing post-commit contract for ordinary session creation", async () => {
    await withOpenClawTestState({ label: "ordinary-session-initializer" }, async () => {
      const sessionKey = "agent:main:ordinary-initializer";
      const created = await createGatewaySession({
        cfg: {},
        key: sessionKey,
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
        afterCreate: async () => {
          throw new Error("initial turn failed");
        },
      });

      expect(created).toMatchObject({
        ok: true,
        postCommit: { status: "failed", error: expect.any(Error) },
      });
      expect(loadSessionEntryReadOnly({ sessionKey })?.initializationPending).toBeUndefined();
    });
  });
});
