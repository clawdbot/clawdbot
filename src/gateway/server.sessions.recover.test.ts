import { expect, test } from "vitest";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  seedSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

test("sessions.recover rolls over one tombstone and returns its continuation outcome", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.sessionConfig = { dmScope: "main", scope: "per-sender" };
  const sourceKey = "agent:main:dashboard:tombstoned";
  const sourceSessionId = "tombstoned-session";
  await writeSessionStore({
    entries: {
      [sourceKey]: sessionStoreEntry(sourceSessionId, {
        status: "failed",
        abortedLastRun: true,
        agentHarnessId: "codex",
        agentRuntimeOverride: "codex",
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
        modelSelectionLocked: true,
        pinnedAt: 1,
        spawnedCwd: "/tmp/recovered-worktree",
        mainRestartRecovery: {
          cycleId: "cycle-tombstoned",
          revision: 4,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
      }),
    },
  });
  await seedSessionTranscript({
    agentId: "main",
    sessionId: sourceSessionId,
    sessionKey: sourceKey,
    storePath,
    messages: [
      { role: "user", content: "finish the interrupted implementation" },
      { role: "assistant", content: [{ type: "text", text: "I reached the final check." }] },
    ],
  });
  const sourceTranscriptBefore = await loadTranscriptEvents({
    agentId: "main",
    sessionId: sourceSessionId,
    sessionKey: sourceKey,
    storePath,
  });

  type RecoveryPayload = {
    key: string;
    sessionId: string;
    continuation: { status: string; runId?: string };
  };
  const [recovered, concurrentRetry] = await Promise.all([
    directSessionReq<RecoveryPayload>("sessions.recover", { agentId: "main", key: sourceKey }),
    directSessionReq<RecoveryPayload>("sessions.recover", { agentId: "main", key: sourceKey }),
  ]);

  expect(recovered.ok, JSON.stringify(recovered.error)).toBe(true);
  expect(recovered.payload).toMatchObject({
    key: expect.stringMatching(/^agent:main:dashboard:/),
    sessionId: expect.any(String),
    continuation: { status: "started", runId: expect.any(String) },
  });
  const successorKey = recovered.payload?.key ?? "";
  const successorSessionId = recovered.payload?.sessionId ?? "";
  expect(concurrentRetry).toMatchObject({
    ok: true,
    payload: {
      key: successorKey,
      sessionId: successorSessionId,
      continuation: { status: "started" },
    },
  });
  expect(loadSessionEntry({ agentId: "main", sessionKey: successorKey, storePath })).toMatchObject({
    agentHarnessId: "codex",
    agentRuntimeOverride: "codex",
    modelSelectionLocked: true,
    modelOverride: "gpt-5.6-sol",
    previousSessionId: sourceSessionId,
    providerOverride: "openai",
    spawnedCwd: "/tmp/recovered-worktree",
  });
  const archivedSource = loadSessionEntry({ agentId: "main", sessionKey: sourceKey, storePath });
  expect(archivedSource).toMatchObject({
    archivedAt: expect.any(Number),
    mainRestartRecovery: {
      revision: 5,
      tombstone: {
        recoveredSessionId: successorSessionId,
        recoveredSessionKey: successorKey,
      },
    },
  });
  expect(archivedSource).not.toHaveProperty("pinnedAt");
  await expect(
    loadTranscriptEvents({
      agentId: "main",
      sessionId: sourceSessionId,
      sessionKey: sourceKey,
      storePath,
    }),
  ).resolves.toEqual(sourceTranscriptBefore);
  expect(
    JSON.stringify(
      await loadTranscriptEvents({
        agentId: "main",
        sessionId: successorSessionId,
        sessionKey: successorKey,
        storePath,
      }),
    ),
  ).toContain("finish the interrupted implementation");

  const repeated = await directSessionReq<typeof recovered.payload>("sessions.recover", {
    agentId: "main",
    key: sourceKey,
  });
  expect(repeated).toMatchObject({
    ok: true,
    payload: {
      key: successorKey,
      sessionId: successorSessionId,
      continuation: { status: "started" },
    },
  });
});

test("sessions.recover rejects a healthy session", async () => {
  await createSessionStoreDir();
  const key = "agent:main:dashboard:healthy";
  await writeSessionStore({ entries: { [key]: sessionStoreEntry("healthy-session") } });
  const recovered = await directSessionReq("sessions.recover", { agentId: "main", key });
  expect(recovered).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: expect.stringContaining("tombstoned") },
  });
});

test("sessions.recover rejects continuation launch after runtime authority closes", async () => {
  const { storePath } = await createSessionStoreDir();
  const sourceKey = "agent:main:dashboard:authority-race";
  const sourceSessionId = "authority-race-source";
  await writeSessionStore({
    entries: {
      [sourceKey]: sessionStoreEntry(sourceSessionId, {
        status: "failed",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: "cycle-authority-race",
          revision: 1,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
      }),
    },
  });
  await seedSessionTranscript({
    agentId: "main",
    sessionId: sourceSessionId,
    sessionKey: sourceKey,
    storePath,
    messages: [{ role: "user", content: "continue after recovery" }],
  });
  let validations = 0;

  const recovered = await directSessionReq<{
    key: string;
    continuation: { status: string; error?: { message?: string } };
  }>(
    "sessions.recover",
    { agentId: "main", key: sourceKey },
    {
      context: {
        validateAgentRuntimeApprovalAuthority: () => ++validations < 2,
      },
      client: {
        connect: { scopes: ["operator.write"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: sourceKey,
          },
        },
      } as never,
    },
  );

  expect(recovered).toMatchObject({
    ok: true,
    payload: {
      continuation: {
        status: "rejected",
        error: { message: "agent runtime authority is no longer active" },
      },
    },
  });
  expect(validations).toBe(2);
  expect(
    loadSessionEntry({
      agentId: "main",
      sessionKey: recovered.payload?.key ?? "",
      storePath,
    }),
  ).toBeDefined();
});
