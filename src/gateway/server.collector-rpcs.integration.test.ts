import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FACTORY_AUTHORITY_PROFILE_ID } from "../agents/factory-authority-profile.js";
import type { SubagentRunRecord } from "../agents/subagent-registry.types.js";
import { upsertSessionEntry } from "../config/sessions/session-accessor.js";
import { buildAgentCollectorSpawnRequestFingerprint } from "./server-methods/agent-collector-spawn.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
  testState,
} from "./test-helpers.js";

const mocks = vi.hoisted(() => ({
  spawnSubagentDirect: vi.fn(),
  getSubagentRunsByRunIds: vi.fn(),
  reserveSwarmReplayLaunch: vi.fn(),
  readSwarmReplayLaunch: vi.fn(),
  waitForSwarmReplayLaunch: vi.fn(),
  failSwarmReplayLaunch: vi.fn(),
  replayState: {
    reservation: undefined as Record<string, unknown> | undefined,
    terminal: false,
  },
}));

vi.mock("../agents/subagent-spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/subagent-spawn.js")>();
  return { ...actual, spawnSubagentDirect: mocks.spawnSubagentDirect };
});

vi.mock("../agents/subagent-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/subagent-registry.js")>();
  return { ...actual, getSubagentRunsByRunIds: mocks.getSubagentRunsByRunIds };
});

vi.mock("../agents/swarm-replay-ledger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/swarm-replay-ledger.js")>();
  return {
    ...actual,
    reserveSwarmReplayLaunch: (...args: unknown[]) => mocks.reserveSwarmReplayLaunch(...args),
    readSwarmReplayLaunch: (...args: unknown[]) => mocks.readSwarmReplayLaunch(...args),
    waitForSwarmReplayLaunch: (...args: unknown[]) => mocks.waitForSwarmReplayLaunch(...args),
    failSwarmReplayLaunch: (...args: unknown[]) => mocks.failSwarmReplayLaunch(...args),
  };
});

installGatewayTestHooks({ scope: "suite" });

const TOKEN = "collector-rpc-websocket-canary-token";
const REQUESTER_SESSION_KEY = "agent:main:subagent:factory-owner";
const CHILD_SESSION_KEY = "agent:worker:subagent:collector-child";
const PUBLIC_RUN_ID = "swarm-public-canary";
const FACTORY_CREDENTIAL = "factory-controller-test-credential-000001";
const REQUEST_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const LAUNCH_IDENTITY_DIGEST = `sha256:${"b".repeat(64)}` as const;

function replayIdentity() {
  const reservation = mocks.replayState.reservation;
  if (!reservation) {
    throw new Error("test replay reservation is missing");
  }
  return {
    requesterSessionKey: REQUESTER_SESSION_KEY,
    requesterSessionId: "factory-owner-session",
    replayKey: "factory:canary-attempt:collector-1",
    requestFingerprint: reservation.requestFingerprint,
    runId: PUBLIC_RUN_ID,
    sessionKey: CHILD_SESSION_KEY,
    agentId: "worker",
    launchIdentityDigest: LAUNCH_IDENTITY_DIGEST,
    authority: reservation.authority,
  };
}

describe.runIf(process.platform === "darwin")("factory collector Gateway RPC boundary", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    mocks.spawnSubagentDirect.mockReset();
    mocks.getSubagentRunsByRunIds.mockReset();
    mocks.reserveSwarmReplayLaunch.mockReset();
    mocks.readSwarmReplayLaunch.mockReset();
    mocks.waitForSwarmReplayLaunch.mockReset();
    mocks.failSwarmReplayLaunch.mockReset();
    mocks.replayState.reservation = undefined;
    mocks.replayState.terminal = false;
    testState.agentsConfig = undefined;
    testState.gatewayAuth = undefined;
    vi.unstubAllEnvs();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("spawns, replays, and retrieves an exact structured result over authenticated WebSocket RPC", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-collector-rpc-canary-"));
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv(
      "OPENCLAW_FACTORY_CONTROLLER_CREDENTIAL_SHA256",
      `sha256:${createHash("sha256").update(FACTORY_CREDENTIAL).digest("hex")}`,
    );
    const worktree = path.join(tempDir, "worktree");
    await fs.mkdir(worktree);
    const canonicalWorktree = await fs.realpath(worktree);
    await fs.mkdir(path.join(canonicalWorktree, ".git"));
    const gitMetadataRoot = await fs.realpath(path.join(canonicalWorktree, ".git"));

    testState.gatewayAuth = { mode: "token", token: TOKEN };
    testState.agentsConfig = {
      list: [
        { id: "main", default: true },
        { id: "worker", workspace: canonicalWorktree },
      ],
    };
    await upsertSessionEntry(
      { agentId: "main", sessionKey: REQUESTER_SESSION_KEY },
      {
        sessionId: "factory-owner-session",
        updatedAt: Date.now(),
        spawnedCwd: canonicalWorktree,
        spawnedWorkspaceDir: canonicalWorktree,
      },
    );
    await upsertSessionEntry(
      { agentId: "worker", sessionKey: CHILD_SESSION_KEY },
      {
        sessionId: "collector-child-session",
        updatedAt: Date.now(),
        agentHarnessId: "codex",
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        thinkingLevel: "high",
        status: "done",
        endedAt: 1_700_000_000_100,
      },
    );

    const collector: SubagentRunRecord = {
      runId: "gateway-run-canary",
      swarmRunId: PUBLIC_RUN_ID,
      childSessionKey: CHILD_SESSION_KEY,
      requesterSessionKey: REQUESTER_SESSION_KEY,
      requesterDisplayKey: "factory-owner",
      task: "return a disposable structured canary",
      taskRunId: "factory-task-canary",
      cleanup: "keep",
      createdAt: 1_700_000_000_000,
      collect: true,
      outputSchema: {
        type: "object",
        properties: { sentinel: { type: "string" } },
        required: ["sentinel"],
        additionalProperties: false,
      },
      execution: { status: "terminal", endedAt: 1_700_000_000_100 },
      collectorCompletion: {
        status: "done",
        structured: { sentinel: "collector-rpc-canary" },
      },
    };
    mocks.getSubagentRunsByRunIds.mockReturnValue({
      entries: new Map([[PUBLIC_RUN_ID, collector]]),
    });
    mocks.reserveSwarmReplayLaunch.mockImplementation((input: Record<string, unknown>) => {
      if (!mocks.replayState.reservation) {
        mocks.replayState.reservation = input;
        return { status: "owner", runId: input.publicRunId };
      }
      return { status: "accepted", identity: replayIdentity() };
    });
    mocks.readSwarmReplayLaunch.mockImplementation(() => {
      const identity = replayIdentity();
      if (!mocks.replayState.terminal) {
        return { status: "accepted", identity };
      }
      return {
        status: "terminal",
        identity,
        expiresAt: Date.now() + 60_000,
        terminalEvidence: {
          evidenceContractVersion: 1,
          launchIdentityDigest: LAUNCH_IDENTITY_DIGEST,
          runId: PUBLIC_RUN_ID,
          sessionKey: CHILD_SESSION_KEY,
          agentId: "worker",
          requesterSessionKey: REQUESTER_SESSION_KEY,
          requesterSessionId: "factory-owner-session",
          taskId: "factory-task-canary",
          replayKey: identity.replayKey,
          requestFingerprint: identity.requestFingerprint,
          authority: identity.authority,
          schemaContractVersion: "openclaw/agent-structured-result/v1",
          schemaCanonicalJson: '{"type":"object"}',
          schemaHash: `sha256:${"c".repeat(64)}`,
          result: {
            canonicalJson: '{"sentinel":"collector-rpc-canary"}',
            contentHash: `sha256:${"d".repeat(64)}`,
          },
          outcome: { status: "done" },
          endedAt: 1_700_000_000_100,
          frozenAt: 1_700_000_000_101,
          runtime: {
            openClawVersion: "test",
            openClawBuildIdentity: "git:test",
            harness: "codex",
            model: "openai/gpt-5.6-sol",
            thinking: "high",
          },
        },
      };
    });
    mocks.spawnSubagentDirect
      .mockResolvedValueOnce({
        status: "accepted",
        runId: PUBLIC_RUN_ID,
        childSessionKey: CHILD_SESSION_KEY,
      })
      .mockResolvedValueOnce({
        status: "accepted",
        runId: PUBLIC_RUN_ID,
        childSessionKey: CHILD_SESSION_KEY,
        replayed: true,
      });

    const launch = {
      requesterSessionKey: REQUESTER_SESSION_KEY,
      task: "return a disposable structured canary",
      groupId: "factory:canary-attempt",
      cwd: canonicalWorktree,
      gitMetadataRoot,
      nativeReadRoots: ["/Library/Developer/CommandLineTools", "/opt/homebrew"].toSorted(),
      nativePathEntries: ["/usr/bin"],
      nativeEnvironment: {},
      agentId: "worker",
      outputSchema: collector.outputSchema,
      authorityProfileId: FACTORY_AUTHORITY_PROFILE_ID,
      worktreeFenceToken: "factory-canary-fence-1",
      worktreeOwnershipGeneration: 1,
    };
    const spawnParams = {
      factoryCredential: FACTORY_CREDENTIAL,
      ...launch,
      replayKey: "factory:canary-attempt:collector-1",
      requestFingerprint: buildAgentCollectorSpawnRequestFingerprint(launch),
    };

    const gateway = await createGatewaySuiteHarness({
      serverOptions: { auth: { mode: "token", token: TOKEN } },
    });
    const socket = await gateway.openWs();
    try {
      await connectOk(socket, {
        token: TOKEN,
        role: "operator",
        scopes: ["operator.read", "operator.write"],
      });

      const first = await rpcReq(socket, "agent.collector.spawn", spawnParams);
      expect(first, JSON.stringify(first)).toMatchObject({
        ok: true,
        payload: {
          status: "accepted",
          runId: PUBLIC_RUN_ID,
          childSessionKey: CHILD_SESSION_KEY,
          sessionKey: CHILD_SESSION_KEY,
          agentId: "worker",
          requesterSessionId: "factory-owner-session",
          requestFingerprint: expect.stringMatching(REQUEST_FINGERPRINT_PATTERN),
          launchIdentityDigest: LAUNCH_IDENTITY_DIGEST,
          authorityProfileId: FACTORY_AUTHORITY_PROFILE_ID,
          replayed: false,
        },
      });

      const replay = await rpcReq(socket, "agent.collector.spawn", spawnParams);
      expect(replay).toMatchObject({
        ok: true,
        payload: {
          status: "accepted",
          runId: PUBLIC_RUN_ID,
          childSessionKey: CHILD_SESSION_KEY,
          replayed: true,
        },
      });

      const receipt = first.payload as {
        requesterSessionId: string;
        replayKey: string;
        requestFingerprint: string;
        launchIdentityDigest: string;
        authorityProfileId: string;
        worktreeFenceToken: string;
        worktreeOwnershipGeneration: number;
      };
      mocks.replayState.terminal = true;
      const result = await rpcReq(socket, "agent.result.get", {
        factoryCredential: FACTORY_CREDENTIAL,
        requesterSessionKey: REQUESTER_SESSION_KEY,
        requesterSessionId: receipt.requesterSessionId,
        runId: PUBLIC_RUN_ID,
        sessionKey: CHILD_SESSION_KEY,
        agentId: "worker",
        taskId: "factory-task-canary",
        replayKey: receipt.replayKey,
        requestFingerprint: receipt.requestFingerprint,
        launchIdentityDigest: receipt.launchIdentityDigest,
        authorityProfileId: receipt.authorityProfileId,
        worktreeFenceToken: receipt.worktreeFenceToken,
        worktreeOwnershipGeneration: receipt.worktreeOwnershipGeneration,
      });
      expect(result).toMatchObject({
        ok: true,
        payload: {
          status: "ok",
          runId: PUBLIC_RUN_ID,
          sessionKey: CHILD_SESSION_KEY,
          agentId: "worker",
          requesterSessionKey: REQUESTER_SESSION_KEY,
          taskId: "factory-task-canary",
          structured: { sentinel: "collector-rpc-canary" },
          outcome: { status: "done" },
        },
      });
    } finally {
      socket.close();
      await gateway.close();
    }
  });
});
