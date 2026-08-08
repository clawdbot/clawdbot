import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentResultGet } from "../../agents/agent-result-get.js";
import {
  buildTestFactoryNativeAuthority,
  buildTestFactoryNativeAuthorityProof,
} from "../../agents/factory-authority-profile.test-helpers.js";
import type {
  SwarmLaunchAuthority,
  SwarmTerminalEvidence,
} from "../../agents/subagent-registry.types.js";
import type { SwarmReplayLaunchRecord } from "../../agents/swarm-replay-ledger.js";
import { agentResultGetHandler } from "./agent-result-get.js";

const { readSwarmReplayLaunch } = vi.hoisted(() => ({
  readSwarmReplayLaunch: vi.fn(),
}));

vi.mock("../../agents/swarm-replay-ledger.js", () => ({
  readSwarmReplayLaunch: (...args: unknown[]) => readSwarmReplayLaunch(...args),
}));

const FINGERPRINT = `sha256:${"a".repeat(64)}` as const;
const LAUNCH_DIGEST = `sha256:${"b".repeat(64)}` as const;
const FACTORY_CREDENTIAL = "factory-controller-test-credential-000001";

const authority: SwarmLaunchAuthority = buildTestFactoryNativeAuthority("/tmp/factory-result-test");

const terminalEvidence: SwarmTerminalEvidence = {
  evidenceContractVersion: 1,
  launchIdentityDigest: LAUNCH_DIGEST,
  runId: "swarm-public-1",
  sessionKey: "agent:worker:subagent:child",
  agentId: "worker",
  requesterSessionKey: "agent:main:main",
  requesterSessionId: "requester-session-1",
  requesterLifecycleRevision: "requester-revision-1",
  taskId: "task-1",
  replayKey: "replay-1",
  requestFingerprint: FINGERPRINT,
  authority,
  schemaContractVersion: "openclaw/agent-structured-result/v1",
  schemaCanonicalJson: '{"type":"object"}',
  schemaHash: `sha256:${"c".repeat(64)}`,
  result: {
    canonicalJson: '{"answer":"factory-sentinel"}',
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
    authorityProof: buildTestFactoryNativeAuthorityProof({
      authority,
      launchIdentityDigest: LAUNCH_DIGEST,
    }),
  },
  usage: { inputTokens: 10, outputTokens: 2 },
};

function launch(overrides: Partial<SwarmReplayLaunchRecord> = {}): SwarmReplayLaunchRecord {
  return {
    status: "terminal",
    identity: {
      requesterSessionKey: terminalEvidence.requesterSessionKey,
      requesterSessionId: terminalEvidence.requesterSessionId,
      requesterLifecycleRevision: terminalEvidence.requesterLifecycleRevision,
      replayKey: terminalEvidence.replayKey,
      requestFingerprint: FINGERPRINT,
      runId: terminalEvidence.runId,
      sessionKey: terminalEvidence.sessionKey,
      agentId: terminalEvidence.agentId,
      launchIdentityDigest: LAUNCH_DIGEST,
      authority,
    },
    terminalEvidence,
    expiresAt: 1_800_000_000_000,
    ...overrides,
  };
}

function request(overrides: Partial<Parameters<typeof resolveAgentResultGet>[0]> = {}) {
  return resolveAgentResultGet({
    runId: terminalEvidence.runId,
    sessionKey: terminalEvidence.sessionKey,
    agentId: terminalEvidence.agentId,
    requesterSessionKey: terminalEvidence.requesterSessionKey,
    requesterSessionId: terminalEvidence.requesterSessionId,
    requesterLifecycleRevision: terminalEvidence.requesterLifecycleRevision,
    replayKey: terminalEvidence.replayKey,
    requestFingerprint: FINGERPRINT,
    launchIdentityDigest: LAUNCH_DIGEST,
    authorityProfileId: authority.authorityProfileId,
    worktreeFenceToken: authority.worktreeFenceToken,
    worktreeOwnershipGeneration: authority.worktreeOwnershipGeneration,
    taskId: terminalEvidence.taskId,
    now: 1_700_000_000_200,
    ...overrides,
  });
}

describe("agent.result.get frozen receipt resolver", () => {
  beforeEach(() => {
    vi.stubEnv(
      "OPENCLAW_FACTORY_CONTROLLER_CREDENTIAL_SHA256",
      `sha256:${createHash("sha256").update(FACTORY_CREDENTIAL).digest("hex")}`,
    );
    readSwarmReplayLaunch.mockReset().mockReturnValue(launch());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns only producer-frozen evidence and its exact authority receipt", async () => {
    await expect(request()).resolves.toEqual({
      status: "ok",
      runId: terminalEvidence.runId,
      sessionKey: terminalEvidence.sessionKey,
      agentId: terminalEvidence.agentId,
      requesterSessionKey: terminalEvidence.requesterSessionKey,
      requesterSessionId: terminalEvidence.requesterSessionId,
      requesterLifecycleRevision: terminalEvidence.requesterLifecycleRevision,
      taskId: terminalEvidence.taskId,
      replayKey: terminalEvidence.replayKey,
      requestFingerprint: FINGERPRINT,
      launchIdentityDigest: LAUNCH_DIGEST,
      authorityProfileId: authority.authorityProfileId,
      worktreeFenceToken: authority.worktreeFenceToken,
      worktreeOwnershipGeneration: authority.worktreeOwnershipGeneration,
      authority,
      evidenceContractVersion: 1,
      schemaContractVersion: terminalEvidence.schemaContractVersion,
      schemaHash: terminalEvidence.schemaHash,
      structured: { answer: "factory-sentinel" },
      contentHash: terminalEvidence.result?.contentHash,
      endedAt: terminalEvidence.endedAt,
      frozenAt: terminalEvidence.frozenAt,
      runtime: terminalEvidence.runtime,
      outcome: terminalEvidence.outcome,
      usage: terminalEvidence.usage,
    });
  });

  it("returns not_terminal while the durable launch is accepted", async () => {
    readSwarmReplayLaunch.mockReturnValue(
      launch({ status: "accepted", terminalEvidence: undefined }),
    );
    await expect(request()).resolves.toMatchObject({ status: "not_terminal" });
  });

  it("returns result_missing without reconstructing mutable output", async () => {
    const evidence = { ...terminalEvidence, result: undefined };
    readSwarmReplayLaunch.mockReturnValue(launch({ terminalEvidence: evidence }));
    await expect(request()).resolves.toMatchObject({
      status: "result_missing",
      endedAt: evidence.endedAt,
      outcome: evidence.outcome,
    });
  });

  const mismatchedReceipts: Array<[string, Partial<Parameters<typeof resolveAgentResultGet>[0]>]> =
    [
      ["run", { runId: "other" }],
      ["session", { sessionKey: "agent:worker:subagent:other" }],
      ["agent", { agentId: "other" }],
      ["requester key", { requesterSessionKey: "agent:main:other" }],
      ["requester session", { requesterSessionId: "other" }],
      ["requester revision", { requesterLifecycleRevision: "other" }],
      ["replay", { replayKey: "other" }],
      ["fingerprint", { requestFingerprint: `sha256:${"e".repeat(64)}` }],
      ["launch digest", { launchIdentityDigest: `sha256:${"e".repeat(64)}` }],
      ["authority profile", { authorityProfileId: "other" }],
      ["worktree fence", { worktreeFenceToken: "other" }],
      ["ownership generation", { worktreeOwnershipGeneration: 8 }],
      ["task", { taskId: "other" }],
    ];

  it.each(mismatchedReceipts)(
    "fails closed for a mismatched %s receipt field",
    async (_name, overrides) => {
      await expect(request(overrides)).resolves.toMatchObject({ status: "not_found" });
    },
  );

  it("returns expired from a compact tombstone", async () => {
    readSwarmReplayLaunch.mockReturnValue(
      launch({ status: "expired", terminalEvidence: undefined, expiresAt: 100 }),
    );
    await expect(request({ now: 100 })).resolves.toMatchObject({ status: "expired" });
  });

  it("reads an exact immutable receipt without consulting a deleted requester session", async () => {
    const respond = vi.fn();
    await agentResultGetHandler({
      params: {
        factoryCredential: FACTORY_CREDENTIAL,
        runId: terminalEvidence.runId,
        sessionKey: terminalEvidence.sessionKey,
        agentId: terminalEvidence.agentId,
        requesterSessionKey: terminalEvidence.requesterSessionKey,
        requesterSessionId: terminalEvidence.requesterSessionId,
        requesterLifecycleRevision: terminalEvidence.requesterLifecycleRevision,
        replayKey: terminalEvidence.replayKey,
        requestFingerprint: FINGERPRINT,
        launchIdentityDigest: LAUNCH_DIGEST,
        authorityProfileId: authority.authorityProfileId,
        worktreeFenceToken: authority.worktreeFenceToken,
        worktreeOwnershipGeneration: authority.worktreeOwnershipGeneration,
        taskId: terminalEvidence.taskId,
      },
      client: {
        transportRemoteIp: "127.0.0.1",
        usesSharedGatewayAuth: true,
        connect: {
          role: "operator",
          scopes: ["operator.read"],
          client: { id: "cli", version: "1", platform: "test", mode: "cli" },
          minProtocol: 4,
          maxProtocol: 4,
        },
      },
      respond,
    } as unknown as Parameters<typeof agentResultGetHandler>[0]);

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ status: "ok" }));
  });

  it.each([
    ["remote transport", { transportRemoteIp: "192.0.2.10", usesSharedGatewayAuth: true }],
    ["auth-none loopback", { transportRemoteIp: "127.0.0.1", usesSharedGatewayAuth: false }],
  ])("rejects %s before reading the ledger", async (_name, clientOverrides) => {
    const respond = vi.fn();
    await agentResultGetHandler({
      params: {
        factoryCredential: FACTORY_CREDENTIAL,
        runId: terminalEvidence.runId,
        sessionKey: terminalEvidence.sessionKey,
        agentId: terminalEvidence.agentId,
        requesterSessionKey: terminalEvidence.requesterSessionKey,
        requesterSessionId: terminalEvidence.requesterSessionId,
        requesterLifecycleRevision: terminalEvidence.requesterLifecycleRevision,
        replayKey: terminalEvidence.replayKey,
        requestFingerprint: FINGERPRINT,
        launchIdentityDigest: LAUNCH_DIGEST,
        authorityProfileId: authority.authorityProfileId,
        worktreeFenceToken: authority.worktreeFenceToken,
        worktreeOwnershipGeneration: authority.worktreeOwnershipGeneration,
      },
      client: {
        ...clientOverrides,
        connect: {
          role: "operator",
          scopes: ["operator.read"],
          client: { id: "cli", version: "1", platform: "test", mode: "cli" },
          minProtocol: 4,
          maxProtocol: 4,
        },
      },
      respond,
    } as unknown as Parameters<typeof agentResultGetHandler>[0]);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(readSwarmReplayLaunch).not.toHaveBeenCalled();
  });

  it("rejects generic Gateway auth when the dedicated factory credential is forged", async () => {
    const respond = vi.fn();
    await agentResultGetHandler({
      params: {
        factoryCredential: "forged-factory-controller-credential-0001",
        runId: terminalEvidence.runId,
        sessionKey: terminalEvidence.sessionKey,
        agentId: terminalEvidence.agentId,
        requesterSessionKey: terminalEvidence.requesterSessionKey,
        requesterSessionId: terminalEvidence.requesterSessionId,
        requesterLifecycleRevision: terminalEvidence.requesterLifecycleRevision,
        replayKey: terminalEvidence.replayKey,
        requestFingerprint: FINGERPRINT,
        launchIdentityDigest: LAUNCH_DIGEST,
        authorityProfileId: authority.authorityProfileId,
        worktreeFenceToken: authority.worktreeFenceToken,
        worktreeOwnershipGeneration: authority.worktreeOwnershipGeneration,
      },
      client: {
        transportRemoteIp: "127.0.0.1",
        usesSharedGatewayAuth: true,
        connect: {
          role: "operator",
          scopes: ["operator.read"],
          client: { id: "cli", version: "1", platform: "test", mode: "cli" },
          minProtocol: 4,
          maxProtocol: 4,
        },
      },
      respond,
    } as unknown as Parameters<typeof agentResultGetHandler>[0]);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(readSwarmReplayLaunch).not.toHaveBeenCalled();
  });
});
