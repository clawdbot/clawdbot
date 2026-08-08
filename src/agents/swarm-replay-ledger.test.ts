import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  buildTestFactoryNativeAuthority,
  buildTestFactoryNativeAuthorityProof,
} from "./factory-authority-profile.test-helpers.js";
import type {
  SubagentRunRecord,
  SwarmLaunchAuthority,
  SwarmTerminalEvidence,
} from "./subagent-registry.types.js";
import {
  buildSwarmLaunchIdentityDigest,
  buildSwarmReplayRunId,
  hashSwarmEvidenceBytes,
  readSwarmReplayLaunch,
  reserveSwarmReplayLaunch,
  SWARM_REPLAY_RESULT_RETENTION_HORIZON_MS,
  syncSwarmReplayRunInTransaction,
} from "./swarm-replay-ledger.js";

const REQUESTER_KEY = "agent:main:main";
const REQUESTER_ID = "requester-session-1";
const REQUESTER_REVISION = "requester-revision-1";
const CHILD_KEY = "agent:worker:subagent:child-1";
const REPLAY_KEY = "factory:project:issue:attempt-1";
const FINGERPRINT = `sha256:${"a".repeat(64)}` as const;

function testOptions(stateDir: string): OpenClawStateDatabaseOptions {
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function authority(stateDir: string): SwarmLaunchAuthority {
  return buildTestFactoryNativeAuthority(stateDir);
}

function launchFixture(stateDir: string) {
  const launchAuthority = authority(stateDir);
  const runId = buildSwarmReplayRunId(REQUESTER_KEY, REPLAY_KEY);
  const launchIdentityDigest = buildSwarmLaunchIdentityDigest({
    runId,
    sessionKey: CHILD_KEY,
    agentId: "worker",
    requesterSessionKey: REQUESTER_KEY,
    requesterSessionId: REQUESTER_ID,
    requesterLifecycleRevision: REQUESTER_REVISION,
    replayKey: REPLAY_KEY,
    requestFingerprint: FINGERPRINT,
    authority: launchAuthority,
  });
  const schemaCanonicalJson = '{"required":["answer"],"type":"object"}';
  const resultCanonicalJson = '{"answer":"yes"}';
  const evidence: SwarmTerminalEvidence = {
    evidenceContractVersion: 1,
    launchIdentityDigest,
    runId,
    sessionKey: CHILD_KEY,
    agentId: "worker",
    requesterSessionKey: REQUESTER_KEY,
    requesterSessionId: REQUESTER_ID,
    requesterLifecycleRevision: REQUESTER_REVISION,
    taskId: "task-1",
    replayKey: REPLAY_KEY,
    requestFingerprint: FINGERPRINT,
    authority: launchAuthority,
    schemaContractVersion: "openclaw/agent-structured-result/v1",
    schemaCanonicalJson,
    schemaHash: hashSwarmEvidenceBytes(schemaCanonicalJson),
    result: {
      canonicalJson: resultCanonicalJson,
      contentHash: hashSwarmEvidenceBytes(resultCanonicalJson),
    },
    outcome: { status: "done" },
    endedAt: 2_000,
    frozenAt: 2_001,
    runtime: {
      openClawVersion: "test",
      openClawBuildIdentity: "git:test",
      harness: "codex",
      model: "openai/gpt-test",
      thinking: "high",
      authorityProof: buildTestFactoryNativeAuthorityProof({
        authority: launchAuthority,
        launchIdentityDigest,
      }),
    },
  };
  const run = {
    runId: "execution-run-1",
    swarmRunId: runId,
    childSessionKey: CHILD_KEY,
    requesterSessionKey: REQUESTER_KEY,
    swarmRequesterSessionKey: REQUESTER_KEY,
    swarmRequesterSessionId: REQUESTER_ID,
    swarmRequesterLifecycleRevision: REQUESTER_REVISION,
    requesterDisplayKey: "main",
    task: "collect",
    taskRunId: "task-1",
    cleanup: "keep",
    createdAt: 1_000,
    collect: true,
    swarmLaunchReplayKey: REPLAY_KEY,
    swarmLaunchRequestFingerprint: FINGERPRINT,
    swarmLaunchIdentityDigest: launchIdentityDigest,
    swarmLaunchAuthority: launchAuthority,
    execution: { status: "terminal", endedAt: evidence.endedAt },
    collectorCompletion: { status: "done", structured: { answer: "yes" } },
    swarmTerminalEvidence: evidence,
    archiveAtMs: 10_000,
  } as SubagentRunRecord;
  return { launchAuthority, runId, launchIdentityDigest, evidence, run };
}

function reserveFixture(stateDir: string, now = 1_000) {
  const fixture = launchFixture(stateDir);
  const result = reserveSwarmReplayLaunch(
    {
      requesterSessionKey: REQUESTER_KEY,
      requesterSessionId: REQUESTER_ID,
      requesterLifecycleRevision: REQUESTER_REVISION,
      replayKey: REPLAY_KEY,
      requestFingerprint: FINGERPRINT,
      publicRunId: fixture.runId,
      authority: fixture.launchAuthority,
    },
    { ...testOptions(stateDir), now },
  );
  return { ...fixture, result };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("swarm replay ledger", () => {
  it("atomically gives one identical contender ownership and makes the other join", async () => {
    await withTempDir({ prefix: "openclaw-swarm-replay-race-" }, async (stateDir) => {
      const fixture = launchFixture(stateDir);
      const input = {
        requesterSessionKey: REQUESTER_KEY,
        requesterSessionId: REQUESTER_ID,
        requesterLifecycleRevision: REQUESTER_REVISION,
        replayKey: REPLAY_KEY,
        requestFingerprint: FINGERPRINT,
        publicRunId: fixture.runId,
        authority: fixture.launchAuthority,
      };
      const [first, second] = await Promise.all([
        Promise.resolve().then(() =>
          reserveSwarmReplayLaunch(input, { ...testOptions(stateDir), now: 1_000 }),
        ),
        Promise.resolve().then(() =>
          reserveSwarmReplayLaunch(input, { ...testOptions(stateDir), now: 1_000 }),
        ),
      ]);

      expect([first.status, second.status].sort()).toEqual(["owner", "pending"]);
      expect(first.status === "owner" || second.status === "owner").toBe(true);
    });
  });

  it("persists one immutable terminal evidence record across restart", async () => {
    await withTempDir({ prefix: "openclaw-swarm-replay-restart-" }, async (stateDir) => {
      const fixture = reserveFixture(stateDir);
      expect(fixture.result.status).toBe("owner");
      runOpenClawStateWriteTransaction(
        (database) => syncSwarmReplayRunInTransaction(database, fixture.run),
        testOptions(stateDir),
        { operationLabel: "test.swarm.terminal" },
      );

      const before = readSwarmReplayLaunch(REQUESTER_KEY, REPLAY_KEY, {
        ...testOptions(stateDir),
        now: 2_100,
      });
      expect(before).toMatchObject({
        status: "terminal",
        terminalEvidence: fixture.evidence,
      });

      closeOpenClawStateDatabaseForTest();
      const after = readSwarmReplayLaunch(REQUESTER_KEY, REPLAY_KEY, {
        ...testOptions(stateDir),
        now: 2_100,
      });
      expect(after).toEqual(before);
    });
  });

  it("rejects mutation after completion and preserves the original bytes", async () => {
    await withTempDir({ prefix: "openclaw-swarm-replay-immutable-" }, async (stateDir) => {
      const fixture = reserveFixture(stateDir);
      runOpenClawStateWriteTransaction(
        (database) => syncSwarmReplayRunInTransaction(database, fixture.run),
        testOptions(stateDir),
      );
      const mutated = {
        ...fixture.run,
        swarmTerminalEvidence: {
          ...fixture.evidence,
          outcome: { status: "failed" as const, schemaError: "mutated" },
        },
      };

      expect(() =>
        runOpenClawStateWriteTransaction(
          (database) => syncSwarmReplayRunInTransaction(database, mutated),
          testOptions(stateDir),
        ),
      ).toThrow("terminal evidence is immutable");
      expect(
        readSwarmReplayLaunch(REQUESTER_KEY, REPLAY_KEY, {
          ...testOptions(stateDir),
          now: 2_100,
        })?.terminalEvidence,
      ).toEqual(fixture.evidence);
    });
  });

  it("compacts expired evidence into a permanent replay tombstone", async () => {
    await withTempDir({ prefix: "openclaw-swarm-replay-tombstone-" }, async (stateDir) => {
      const fixture = reserveFixture(stateDir);
      runOpenClawStateWriteTransaction(
        (database) => syncSwarmReplayRunInTransaction(database, fixture.run),
        testOptions(stateDir),
      );
      const expiresAt =
        (fixture.run.archiveAtMs as number) + SWARM_REPLAY_RESULT_RETENTION_HORIZON_MS;

      const expired = readSwarmReplayLaunch(REQUESTER_KEY, REPLAY_KEY, {
        ...testOptions(stateDir),
        now: expiresAt,
      });
      expect(expired).toMatchObject({
        status: "expired",
        expiresAt,
        identity: {
          runId: fixture.runId,
          launchIdentityDigest: fixture.launchIdentityDigest,
        },
      });
      expect(expired).not.toHaveProperty("terminalEvidence");

      closeOpenClawStateDatabaseForTest();
      expect(reserveFixture(stateDir, expiresAt + 1).result).toEqual({
        status: "expired",
        runId: fixture.runId,
      });

      expect(
        reserveSwarmReplayLaunch(
          {
            requesterSessionKey: REQUESTER_KEY,
            requesterSessionId: REQUESTER_ID,
            requesterLifecycleRevision: REQUESTER_REVISION,
            replayKey: REPLAY_KEY,
            requestFingerprint: `sha256:${"b".repeat(64)}`,
            publicRunId: fixture.runId,
            authority: fixture.launchAuthority,
          },
          { ...testOptions(stateDir), now: expiresAt + 1 },
        ),
      ).toMatchObject({ status: "conflict" });
    });
  });
});
