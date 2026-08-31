import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resetClientVoiceConfirmationStateForTest } from "./client-voice-confirmation.test-support.js";
import {
  appendClientVoiceTranscript,
  appendRelayVoiceTranscript,
  closeClientVoiceSession,
  createOrResumeClientVoiceSession,
  ensureClientVoiceAgentSessionEntry,
  resolveClientVoiceAgentSessionId,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

describe("client voice session startup", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-startup-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  });

  afterEach(async () => {
    clientVoiceSessionTesting.reset();
    resetClientVoiceConfirmationStateForTest();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each([false, true])("stamps Talk creation once (required=%s)", async (required) => {
    const target = { agentId: "main", sessionKey: "agent:main:talk:new" };
    const actor = required
      ? { type: "human" as const, source: "profile" as const, id: "profile-required" }
      : { type: "human" as const, source: "unknown" as const };
    const creation = required ? { actor, sandbox: "required" as const } : undefined;
    const sessionId = await ensureClientVoiceAgentSessionEntry({ ...target, creation });

    const original = loadSessionEntry(target);
    expect(original).toMatchObject({
      sessionId,
      createdVia: "talk",
      createdActor: actor,
      createdAt: expect.any(Number),
      ...(required ? { sandbox: "required" } : {}),
    });

    await ensureClientVoiceAgentSessionEntry({
      ...target,
      creation: {
        actor: { type: "human", source: "profile", id: "another-profile" },
        sandbox: "required",
      },
    });
    expect(loadSessionEntry(target)).toEqual(original);
  });

  it("reads an existing agent session without creating a missing row", async () => {
    const existingKey = "agent:main:talk:existing";
    await replaceSessionEntry(
      { agentId: "main", sessionKey: existingKey },
      { sessionId: "session-existing", updatedAt: 1 },
    );

    expect(resolveClientVoiceAgentSessionId({ agentId: "main", sessionKey: existingKey })).toBe(
      "session-existing",
    );
    expect(
      resolveClientVoiceAgentSessionId({
        agentId: "main",
        sessionKey: "agent:main:talk:missing",
      }),
    ).toBeUndefined();
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: "agent:main:talk:missing" }),
    ).toBeUndefined();
  });

  it.each([
    { origin: "client" as const, canonicalKey: "agent:main:work" },
    { origin: "relay" as const, canonicalKey: "global" },
  ])(
    "writes $origin transcripts to $canonicalKey without changing voice identity",
    async ({ origin, canonicalKey }) => {
      const sessionTarget = {
        sessionKey: canonicalKey,
        storePath: path.join(tempDir, "configured", "sessions.sqlite"),
      };
      const storage = { agentId: "main", ...sessionTarget };
      const sessionId = await ensureClientVoiceAgentSessionEntry(storage);
      expect(resolveClientVoiceAgentSessionId(storage)).toBe(sessionId);
      const voiceTarget = { agentId: "main", sessionKey: "main" };
      const voiceSessionId = createOrResumeClientVoiceSession({ ...voiceTarget, origin });
      const append = origin === "client" ? appendClientVoiceTranscript : appendRelayVoiceTranscript;
      await append({
        ...voiceTarget,
        sessionTarget,
        voiceSessionId,
        entryId: "canonical-transcript",
        role: "user",
        text: "Stored in the prepared session",
      });
      expect(readSessionTranscriptMessageEvents({ ...storage, sessionId })).toEqual([
        expect.objectContaining({
          event: expect.objectContaining({
            message: expect.objectContaining({
              content: [{ type: "text", text: "Stored in the prepared session" }],
            }),
          }),
        }),
      ]);
      expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
        sessionKey: "main",
        origin,
      });
      await expect(
        closeClientVoiceSession({
          agentId: "main",
          sessionKey: canonicalKey,
          voiceSessionId,
          config: {},
        }),
      ).rejects.toThrow("does not belong");
      await closeClientVoiceSession({ ...voiceTarget, voiceSessionId, config: {} });
      await closeClientVoiceSession({ ...voiceTarget, voiceSessionId, config: {} });
      expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("closed");
    },
  );

  it("does not create an agent session after a browser-session deadline", async () => {
    const sessionKey = "agent:main:talk:expired";

    await expect(
      ensureClientVoiceAgentSessionEntry({
        agentId: "main",
        sessionKey,
        deadlineAt: Date.now() - 1,
      }),
    ).rejects.toThrow("Realtime browser session expired during startup");
    expect(loadSessionEntry({ agentId: "main", sessionKey })).toBeUndefined();
  });

  it("repairs an incomplete existing row without claiming its creation actor", async () => {
    const sessionKey = "agent:main:talk:incomplete";
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { sessionId: "", updatedAt: 1, createdVia: "internal", createdAt: 1 },
    );

    await ensureClientVoiceAgentSessionEntry({ agentId: "main", sessionKey });

    const repaired = loadSessionEntry({ agentId: "main", sessionKey });
    expect(repaired?.sessionId).toBeTruthy();
    expect(repaired).toMatchObject({ createdVia: "internal", createdAt: 1 });
    expect(repaired?.createdActor).toBeUndefined();
  });

  it("does not create a chat when browser startup closes while its write is queued", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const blocker = patchSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:voice-write-blocker" },
      async () => {
        entered.resolve();
        await release.promise;
        return null;
      },
      { fallbackEntry: { sessionId: "voice-write-blocker", updatedAt: 1 } },
    );
    await entered.promise;
    const target = { agentId: "main", sessionKey: "agent:main:voice-write-cancelled" };
    const controller = new AbortController();
    const creating = ensureClientVoiceAgentSessionEntry({
      ...target,
      assertCommitAllowed: () => controller.signal.throwIfAborted(),
    });
    controller.abort(new Error("browser disconnected"));
    const rejected = expect(creating).rejects.toThrow("browser disconnected");
    release.resolve();
    await blocker;
    await rejected;
    expect(loadSessionEntry(target)).toBeUndefined();
  });
});
