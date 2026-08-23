import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { deliverClientVoiceMutationDigest } from "./client-voice-mutation-digest-owner.js";
import {
  type ClientVoiceSessionRecord,
  VOICE_SESSION_RECORD_VERSION,
  writeVoiceSessionRecordInTransaction,
} from "./client-voice-session-store.js";
import {
  appendClientVoiceTranscript,
  assertClientVoiceSessionOpen,
  createOrResumeClientVoiceSession,
  resolveOpenClientVoiceSessionId,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

type AppendTranscriptMessage =
  (typeof import("../config/sessions/session-accessor.js"))["appendTranscriptMessage"];

const sessionAccessorMocks = vi.hoisted(() => ({
  actualAppendTranscriptMessage: undefined as AppendTranscriptMessage | undefined,
  appendTranscriptMessage: vi.fn<AppendTranscriptMessage>(),
}));
const { sendDurableMessageBatch } = vi.hoisted(() => ({
  sendDurableMessageBatch: vi.fn(async () => ({ status: "sent" })),
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return { ...actual, appendTranscriptMessage: sessionAccessorMocks.appendTranscriptMessage };
});
vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: sendDurableMessageBatch,
}));

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let tempDir: string;

const aliasedAgentSessionCases = [
  {
    label: "global scope",
    config: {
      session: { scope: "global" },
      agents: { entries: { main: { default: true } } },
    } satisfies OpenClawConfig,
    agentSessionKey: "global",
  },
  {
    label: "a custom main alias",
    config: {
      session: { mainKey: "work" },
      agents: { entries: { main: { default: true } } },
    } satisfies OpenClawConfig,
    agentSessionKey: "agent:main:work",
  },
] as const;

async function seedAgentSession(agentSessionKey: string, withDelivery = false): Promise<string> {
  const sessionId = `session-${agentSessionKey.replaceAll(":", "-")}`;
  await replaceSessionEntry(
    { agentId: "main", sessionKey: agentSessionKey },
    {
      sessionId,
      updatedAt: Date.now(),
      delivery: normalizeSessionDeliveryState({
        context: withDelivery ? { channel: "discord", to: "channel:voice-updates" } : undefined,
      }),
    },
  );
  return sessionId;
}

function mutationDigestRecord(agentSessionKey?: string): ClientVoiceSessionRecord {
  return {
    version: VOICE_SESSION_RECORD_VERSION,
    voiceSessionId: "voice-raw-main",
    agentId: "main",
    sessionKey: "main",
    ...(agentSessionKey ? { agentSessionKey } : {}),
    origin: "client",
    status: "closed",
    createdAt: 1,
    updatedAt: 2,
    closedAt: 2,
    consultRunIds: ["run-voice-raw-main"],
    effects: [
      {
        runId: "run-voice-raw-main",
        toolName: "message",
        startedAt: 1,
        finishedAt: 2,
        status: "succeeded",
      },
    ],
    transcriptFailureKeys: [],
  };
}

describe("client voice agent-session routing", () => {
  beforeEach(async () => {
    tempDir = tempDirs.make("openclaw-voice-routing-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    sendDurableMessageBatch.mockReset().mockResolvedValue({ status: "sent" });
    sessionAccessorMocks.appendTranscriptMessage.mockReset();
    const { appendTranscriptMessage } = await vi.importActual<
      typeof import("../config/sessions/session-accessor.js")
    >("../config/sessions/session-accessor.js");
    sessionAccessorMocks.actualAppendTranscriptMessage = appendTranscriptMessage;
    sessionAccessorMocks.appendTranscriptMessage.mockImplementation(appendTranscriptMessage);
  });

  afterEach(async () => {
    clientVoiceSessionTesting.reset();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
  });

  it.each(aliasedAgentSessionCases)(
    "keeps the raw voice key while $label transcripts use the canonical agent session",
    async ({ config, agentSessionKey }) => {
      const sessionId = await seedAgentSession(agentSessionKey);
      const voiceSessionId = createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "main",
        agentSessionKey,
        origin: "client",
      });

      await appendClientVoiceTranscript({
        agentId: "main",
        sessionKey: "main",
        voiceSessionId,
        entryId: "raw-main-final",
        role: "user",
        text: "persist this",
        config,
      });

      expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
        sessionKey: "main",
      });
      expect(sessionAccessorMocks.appendTranscriptMessage).toHaveBeenCalledWith(
        { agentId: "main", sessionId, sessionKey: agentSessionKey },
        expect.objectContaining({ eventId: `voice:${voiceSessionId}:raw-main-final` }),
      );
    },
  );

  it("keeps transcript persistence on the canonical target pinned at call creation", async () => {
    const agentSessionKey = "agent:main:main";
    const sessionId = await seedAgentSession(agentSessionKey);
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "main",
      agentSessionKey,
      origin: "client",
    });

    await appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "main",
      voiceSessionId,
      entryId: "config-drift-final",
      role: "user",
      text: "persist on the original target",
      config: {
        session: { mainKey: "work" },
        agents: { entries: { main: { default: true } } },
      },
    });

    expect(sessionAccessorMocks.appendTranscriptMessage).toHaveBeenCalledWith(
      { agentId: "main", sessionId, sessionKey: agentSessionKey },
      expect.objectContaining({ eventId: `voice:${voiceSessionId}:config-drift-final` }),
    );
  });

  it("rejects an old pinned target and resolves a fresh call after configured drift", () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "main",
      agentSessionKey: "agent:main:main",
      origin: "client",
      voiceSessionId: "voice-pinned-target",
    });
    const originalRecord = clientVoiceSessionTesting.readRecord("main", voiceSessionId);

    expect(() =>
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "main",
        agentSessionKey: "agent:main:work",
        origin: "client",
        voiceSessionId,
      }),
    ).toThrow("canonical target does not match");
    expect(() =>
      assertClientVoiceSessionOpen({
        agentId: "main",
        sessionKey: "main",
        agentSessionKey: "agent:main:work",
        voiceSessionId,
      }),
    ).toThrow("canonical target does not match");

    expect(
      resolveOpenClientVoiceSessionId({
        agentId: "main",
        sessionKey: "main",
        agentSessionKey: "agent:main:work",
      }),
    ).toBeUndefined();
    expect(originalRecord).toMatchObject({
      status: "open",
      agentSessionKey: "agent:main:main",
    });

    const freshVoiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "main",
      agentSessionKey: "agent:main:work",
      origin: "client",
      voiceSessionId: "voice-after-config-drift",
      now: 8,
    });
    expect(
      resolveOpenClientVoiceSessionId({
        agentId: "main",
        sessionKey: "main",
        agentSessionKey: "agent:main:work",
      }),
    ).toBe(freshVoiceSessionId);
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toEqual(originalRecord);
  });

  it("preserves an unpinned row and allows a fresh call after config drift", () => {
    runOpenClawAgentWriteTransaction(
      (database) => {
        writeVoiceSessionRecordInTransaction(database, {
          version: VOICE_SESSION_RECORD_VERSION,
          voiceSessionId: "voice-legacy-target",
          agentId: "main",
          sessionKey: "main",
          origin: "client",
          status: "open",
          createdAt: 7,
          updatedAt: 7,
          consultRunIds: [],
          effects: [],
          transcriptFailureKeys: [],
        });
      },
      { agentId: "main" },
    );

    expect(
      resolveOpenClientVoiceSessionId({
        agentId: "main",
        sessionKey: "main",
        agentSessionKey: "agent:main:work",
      }),
    ).toBeUndefined();
    expect(() =>
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "main",
        agentSessionKey: "agent:main:work",
        origin: "client",
        voiceSessionId: "voice-legacy-target",
        now: 8,
      }),
    ).toThrow("has no pinned agent-session target");
    expect(clientVoiceSessionTesting.readRecord("main", "voice-legacy-target")).toMatchObject({
      status: "open",
      updatedAt: 7,
    });
    expect(
      clientVoiceSessionTesting.readRecord("main", "voice-legacy-target")?.agentSessionKey,
    ).toBeUndefined();

    const freshVoiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "main",
      agentSessionKey: "agent:main:work",
      origin: "client",
      voiceSessionId: "voice-after-config-drift",
      now: 8,
    });
    expect(
      resolveOpenClientVoiceSessionId({
        agentId: "main",
        sessionKey: "main",
        agentSessionKey: "agent:main:work",
      }),
    ).toBe(freshVoiceSessionId);
    expect(clientVoiceSessionTesting.readRecord("main", freshVoiceSessionId)).toMatchObject({
      agentSessionKey: "agent:main:work",
    });
  });

  it.each(aliasedAgentSessionCases)(
    "routes $label mutation digests through the canonical agent session",
    async ({ config, agentSessionKey }) => {
      await seedAgentSession(agentSessionKey, true);
      const record = mutationDigestRecord(agentSessionKey);
      runOpenClawAgentWriteTransaction(
        (database) => writeVoiceSessionRecordInTransaction(database, record),
        { agentId: record.agentId },
      );

      await deliverClientVoiceMutationDigest(record, config, new AbortController().signal);

      expect(record.sessionKey).toBe("main");
      expect(clientVoiceSessionTesting.readRecord("main", record.voiceSessionId)).toMatchObject({
        agentSessionKey,
      });
      expect(sendDurableMessageBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "discord",
          to: "channel:voice-updates",
          session: {
            key: agentSessionKey,
            policyKey: agentSessionKey,
            agentId: "main",
          },
        }),
      );
    },
  );

  it("does not infer an unpinned digest target from changed configuration", async () => {
    await seedAgentSession("agent:main:work", true);
    const record = mutationDigestRecord();
    runOpenClawAgentWriteTransaction(
      (database) => writeVoiceSessionRecordInTransaction(database, record),
      { agentId: record.agentId },
    );

    await expect(
      deliverClientVoiceMutationDigest(
        record,
        {
          session: { mainKey: "work" },
          agents: { entries: { main: { default: true } } },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("has no pinned agent-session target");

    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
    expect(clientVoiceSessionTesting.readRecord("main", record.voiceSessionId)).toMatchObject({
      status: "closed",
    });
    expect(
      clientVoiceSessionTesting.readRecord("main", record.voiceSessionId)?.digestDeliveredAt,
    ).toBeUndefined();
    expect(
      clientVoiceSessionTesting.readRecord("main", record.voiceSessionId)?.agentSessionKey,
    ).toBeUndefined();
  });
});
