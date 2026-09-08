import { describe, expect, it } from "vitest";
import {
  mergeSessionEntry,
  resolveSessionResetPolicy,
  type InternalSessionEntry as SessionEntry,
} from "../../config/sessions.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildAgentSessionPatch } from "../server-methods/agent-session-patch.js";
import { prepareAgentSession } from "../server-methods/agent-session-prepare.js";

type PatchParams = Parameters<typeof buildAgentSessionPatch>[0];
const now = 120_001;
const expiredEntry: SessionEntry = {
  sessionId: "original",
  updatedAt: 1,
  sessionStartedAt: 1,
  lastInteractionAt: 1,
};
const freshEntry: SessionEntry = { ...expiredEntry, lastInteractionAt: now - 1 };
const resetPolicy = resolveSessionResetPolicy({
  sessionCfg: { reset: { mode: "idle", idleMinutes: 1 } },
  resetType: "direct",
});

function buildReusePatch(input: Partial<PatchParams>) {
  return buildAgentSessionPatch({
    freshEntry: expiredEntry,
    initialEntry: expiredEntry,
    cfg: {},
    sessionAgentId: "main",
    canonicalSessionKey: "agent:main:reuse-proof",
    storePath: "/synthetic/session-reuse.sqlite",
    normalizedSpawned: {},
    requestDeliveryHint: undefined,
    hasRestoredCronContinuation: false,
    resetPolicy,
    now,
    isSystemGatewayRun: false,
    visibleRequest: true,
    fallbackSessionId: "replacement",
    touchInteraction: true,
    failedSessionTranscriptMissing: () => false,
    ...input,
  });
}

describe("agent session reuse at mutation", () => {
  it.each([
    { name: "expired ordinary turn", input: {}, sessionId: "replacement", isNew: true },
    { name: "fresh ordinary turn", input: { freshEntry }, sessionId: "original", isNew: false },
    {
      name: "expected existing identity",
      input: { expectedExistingSessionId: "original" },
      sessionId: "original",
      isNew: false,
    },
    {
      name: "restored cron continuation",
      input: { hasRestoredCronContinuation: true },
      sessionId: "original",
      isNew: false,
    },
    {
      name: "model-locked identity",
      input: { freshEntry: { ...expiredEntry, modelSelectionLocked: true } },
      sessionId: "original",
      isNew: false,
    },
    {
      name: "visible terminal recovery",
      input: { freshEntry: { ...expiredEntry, status: "failed" } },
      sessionId: "original",
      isNew: false,
    },
    {
      name: "background terminal expiry",
      input: { freshEntry: { ...expiredEntry, status: "failed" }, visibleRequest: false },
      sessionId: "replacement",
      isNew: true,
    },
    {
      name: "missing failed transcript",
      input: {
        freshEntry: { ...freshEntry, status: "failed" },
        failedSessionTranscriptMissing: () => true,
      },
      sessionId: "replacement",
      isNew: true,
    },
    {
      name: "requested identity for an expired row",
      input: { requestedSessionId: "requested" },
      sessionId: "replacement",
      isNew: true,
    },
    {
      name: "requested identity for a fresh row",
      input: { freshEntry, requestedSessionId: "requested" },
      sessionId: "requested",
      isNew: true,
    },
    {
      name: "requested identity for a missing row",
      input: { freshEntry: undefined, initialEntry: undefined, requestedSessionId: "requested" },
      sessionId: "requested",
      isNew: true,
    },
  ] satisfies Array<{
    name: string;
    input: Partial<PatchParams>;
    sessionId: string;
    isNew: boolean;
  }>)("preserves $name", ({ input, sessionId, isNew }) => {
    const result = buildReusePatch(input);
    expect(result.patch.sessionId).toBe(sessionId);
    expect(result.isNewSession).toBe(isNew);
  });

  it("keeps a concurrent replacement after preparing a rotation from the stored row", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { session: { reset: { mode: "idle" as const, idleMinutes: 1 } } };
      await state.writeConfig(cfg);
      const sessionKey = "agent:main:reuse-proof";
      const scope = {
        agentId: "main",
        sessionKey,
        storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
      };
      await upsertSessionEntryCore(scope, expiredEntry);
      const prepared = prepareAgentSession({
        cfg,
        requestedSessionKey: sessionKey,
        request: { message: "continue", idempotencyKey: "reuse-proof" },
        canUseCronRunContinuation: false,
        lifecycleGeneration: "reuse-proof",
        respond: () => {
          throw new Error("Unexpected preparation rejection");
        },
      });
      if (!prepared) {
        throw new Error("Session preparation did not return a candidate");
      }
      expect(prepared.isNewSession).toBe(true);
      expect(prepared.sessionId).not.toBe("original");
      const concurrent: SessionEntry = {
        ...freshEntry,
        sessionId: "concurrent",
        sessionStartedAt: prepared.now,
        lastInteractionAt: prepared.now,
        status: "done",
        lifecycleRunId: "concurrent-run",
        cliSessionIds: { "claude-cli": "native-concurrent" },
      };
      await upsertSessionEntryCore(scope, concurrent);
      const latest = loadSessionEntry(scope);
      const updated = buildReusePatch({
        initialEntry: prepared.entry,
        freshEntry: latest,
        cfg: prepared.cfg,
        canonicalSessionKey: prepared.canonicalKey,
        storePath: prepared.storePath,
        resetPolicy: prepared.resetPolicy,
        now: prepared.now,
        requestedSessionId: "original",
        fallbackSessionId: prepared.sessionId,
      });
      expect(mergeSessionEntry(latest, updated.patch)).toMatchObject({
        sessionId: "concurrent",
        sessionStartedAt: prepared.now,
        status: "done",
        lifecycleRunId: "concurrent-run",
        cliSessionIds: { "claude-cli": "native-concurrent" },
      });
    });
  });
});
