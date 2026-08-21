import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FACTORY_AUTHORITY_PROFILE_ID } from "../../agents/factory-authority-profile.js";
import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import { listCoreGatewayMethodMetadata } from "../methods/core-descriptors.js";
import {
  agentCollectorSpawnHandler,
  buildAgentCollectorSpawnRequestFingerprint,
} from "./agent-collector-spawn.js";

const spawnSubagentDirect = vi.fn();
const getSubagentRunsByRunIds = vi.fn();
const loadSessionEntryReadOnly = vi.fn();
const replayLedger = vi.hoisted(() => ({
  reserve: vi.fn(),
  read: vi.fn(),
  wait: vi.fn(),
  fail: vi.fn(),
}));

vi.mock("../../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirect(...args),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  getSubagentRunsByRunIds: (...args: unknown[]) => getSubagentRunsByRunIds(...args),
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntryReadOnly: (...args: unknown[]) => loadSessionEntryReadOnly(...args),
}));

vi.mock("../../agents/swarm-replay-ledger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/swarm-replay-ledger.js")>();
  return {
    ...actual,
    reserveSwarmReplayLaunch: (...args: unknown[]) => replayLedger.reserve(...args),
    readSwarmReplayLaunch: (...args: unknown[]) => replayLedger.read(...args),
    waitForSwarmReplayLaunch: (...args: unknown[]) => replayLedger.wait(...args),
    failSwarmReplayLaunch: (...args: unknown[]) => replayLedger.fail(...args),
  };
});

const REQUESTER_SESSION_KEY = "agent:main:subagent:factory-owner";
const REQUESTER_SESSION_ID = "factory-owner-session";
const PUBLIC_RUN_ID = "swarm-public-1";
const CHILD_SESSION_KEY = "agent:worker:subagent:child-1";
const FACTORY_CREDENTIAL = "factory-controller-test-credential-000001";
const NATIVE_READ_ROOTS = ["/Library/Developer/CommandLineTools", "/opt/homebrew"].toSorted();
const NATIVE_PATH_ENTRIES = ["/usr/bin"];

describe.runIf(process.platform === "darwin")("agent.collector.spawn", () => {
  let tempDir: string;
  let worktreeDir: string;
  let gitMetadataRoot: string;
  let lastReservation: Record<string, unknown> | undefined;

  function acceptedIdentity() {
    if (!lastReservation) {
      throw new Error("test reservation was not captured");
    }
    return {
      requesterSessionKey: REQUESTER_SESSION_KEY,
      requesterSessionId: REQUESTER_SESSION_ID,
      replayKey: "factory:attempt-1:collector-1",
      requestFingerprint: lastReservation.requestFingerprint,
      runId: PUBLIC_RUN_ID,
      sessionKey: CHILD_SESSION_KEY,
      agentId: "worker",
      launchIdentityDigest: `sha256:${"b".repeat(64)}`,
      authority: lastReservation.authority,
    };
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-collector-spawn-"));
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv(
      "OPENCLAW_FACTORY_CONTROLLER_CREDENTIAL_SHA256",
      `sha256:${createHash("sha256").update(FACTORY_CREDENTIAL).digest("hex")}`,
    );
    worktreeDir = path.join(tempDir, "worktree");
    await fs.mkdir(worktreeDir);
    worktreeDir = await fs.realpath(worktreeDir);
    await fs.mkdir(path.join(worktreeDir, ".git"));
    gitMetadataRoot = await fs.realpath(path.join(worktreeDir, ".git"));
    lastReservation = undefined;
    replayLedger.reserve.mockReset().mockImplementation((input: Record<string, unknown>) => {
      lastReservation = input;
      return { status: "owner", runId: input.publicRunId };
    });
    replayLedger.read.mockReset().mockImplementation(() => ({
      status: "accepted",
      identity: acceptedIdentity(),
    }));
    replayLedger.wait.mockReset();
    replayLedger.fail.mockReset();
    spawnSubagentDirect.mockReset().mockResolvedValue({
      status: "accepted",
      runId: PUBLIC_RUN_ID,
      childSessionKey: CHILD_SESSION_KEY,
    });
    getSubagentRunsByRunIds.mockReset().mockReturnValue({
      entries: new Map([
        [
          PUBLIC_RUN_ID,
          {
            runId: "gateway-run-1",
            swarmRunId: PUBLIC_RUN_ID,
            childSessionKey: CHILD_SESSION_KEY,
            collect: true,
          } as SubagentRunRecord,
        ],
      ]),
    });
    loadSessionEntryReadOnly.mockReset().mockReturnValue({
      sessionId: REQUESTER_SESSION_ID,
      spawnedCwd: worktreeDir,
      spawnedWorkspaceDir: worktreeDir,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function params(overrides: Record<string, unknown> = {}) {
    const normalized = {
      requesterSessionKey: REQUESTER_SESSION_KEY,
      task: "implement the scoped change",
      groupId: "factory:attempt-1",
      cwd: worktreeDir,
      gitMetadataRoot,
      nativeReadRoots: NATIVE_READ_ROOTS,
      nativePathEntries: NATIVE_PATH_ENTRIES,
      nativeEnvironment: {},
      agentId: "worker",
      label: "factory-builder",
      outputSchema: {
        type: "object",
        properties: { verdict: { type: "string" } },
        required: ["verdict"],
      },
      authorityProfileId: FACTORY_AUTHORITY_PROFILE_ID,
      worktreeFenceToken: "fence-1",
      worktreeOwnershipGeneration: 1,
    };
    const merged = { ...normalized, ...overrides };
    return {
      factoryCredential: FACTORY_CREDENTIAL,
      ...merged,
      replayKey: "factory:attempt-1:collector-1",
      requestFingerprint: buildAgentCollectorSpawnRequestFingerprint(merged),
    };
  }

  async function invoke(options?: {
    params?: Record<string, unknown>;
    transportRemoteIp?: string;
  }) {
    const respond = vi.fn();
    const assertCurrent = vi.fn();
    await agentCollectorSpawnHandler({
      params: options?.params ?? params(),
      client: {
        transportRemoteIp: options?.transportRemoteIp ?? "127.0.0.1",
        usesSharedGatewayAuth: true,
        connect: {
          role: "operator",
          scopes: ["operator.write"],
          client: { id: "cli", version: "1", platform: "test", mode: "cli" },
          minProtocol: 4,
          maxProtocol: 4,
        },
      },
      respond,
      sessionMutationAuthorization: { assertCurrent, assertTargetCurrent: vi.fn() },
      context: {
        getRuntimeConfig: () => ({
          agents: {
            list: [
              { id: "main", default: true },
              { id: "worker", workspace: worktreeDir },
            ],
          },
        }),
      },
    } as unknown as Parameters<typeof agentCollectorSpawnHandler>[0]);
    return { respond, assertCurrent };
  }

  it("is classified as an authenticated write-scoped Gateway method", () => {
    expect(
      listCoreGatewayMethodMetadata().find((method) => method.name === "agent.collector.spawn"),
    ).toEqual({ name: "agent.collector.spawn", scope: "operator.write", since: "2026.7" });
  });

  it("launches inside the exact authorized session worktree and verifies registration", async () => {
    const { respond, assertCurrent } = await invoke();

    expect(loadSessionEntryReadOnly).toHaveBeenCalledWith({
      sessionKey: REQUESTER_SESSION_KEY,
      agentId: "main",
    });
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(spawnSubagentDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "implement the scoped change",
        collect: true,
        mode: "run",
        cleanup: "keep",
        groupId: "factory:attempt-1",
        cwd: worktreeDir,
        swarmLaunchReplayKey: "factory:attempt-1:collector-1",
        swarmLaunchRequestFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        agentId: "worker",
      }),
      expect.objectContaining({
        agentSessionKey: REQUESTER_SESSION_KEY,
        completionOwnerKey: REQUESTER_SESSION_KEY,
        requesterAgentIdOverride: "main",
        workspaceDir: worktreeDir,
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        status: "accepted",
        runId: PUBLIC_RUN_ID,
        childSessionKey: CHILD_SESSION_KEY,
        sessionKey: CHILD_SESSION_KEY,
        agentId: "worker",
        authorityProfileId: FACTORY_AUTHORITY_PROFILE_ID,
        replayed: false,
      }),
    );
  });

  it("surfaces a replayed durable collector identity without changing it", async () => {
    replayLedger.reserve.mockImplementationOnce((input: Record<string, unknown>) => {
      lastReservation = input;
      return {
        status: "accepted",
        identity: acceptedIdentity(),
      };
    });

    const { respond } = await invoke();

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId: PUBLIC_RUN_ID, replayed: true }),
    );
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("rejects non-loopback transport peers before touching session state", async () => {
    const { respond } = await invoke({ transportRemoteIp: "192.0.2.20" });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(loadSessionEntryReadOnly).not.toHaveBeenCalled();
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("rejects auth-none loopback connections even when they request write scope", async () => {
    const respond = vi.fn();
    await agentCollectorSpawnHandler({
      params: params(),
      client: {
        transportRemoteIp: "127.0.0.1",
        usesSharedGatewayAuth: false,
        connect: {
          role: "operator",
          scopes: ["operator.write"],
          client: { id: "cli", version: "1", platform: "test", mode: "cli" },
          minProtocol: 4,
          maxProtocol: 4,
        },
      },
      respond,
    } as unknown as Parameters<typeof agentCollectorSpawnHandler>[0]);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(loadSessionEntryReadOnly).not.toHaveBeenCalled();
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("rejects generic Gateway auth when the dedicated factory credential is forged", async () => {
    const request = params();
    request.factoryCredential = "forged-factory-controller-credential-0001";
    const { respond } = await invoke({ params: request });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(loadSessionEntryReadOnly).not.toHaveBeenCalled();
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("rejects a request fingerprint that does not match the normalized launch", async () => {
    const request = params();
    request.task = "different task";
    const { respond } = await invoke({ params: request });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("rejects cwd paths outside the requester session worktree", async () => {
    const outside = path.join(tempDir, "outside");
    await fs.mkdir(outside);
    const { respond } = await invoke({ params: params({ cwd: outside }) });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("fails closed when the accepted collector registration identity cannot be verified", async () => {
    getSubagentRunsByRunIds.mockReturnValueOnce({ entries: new Map() });

    const { respond } = await invoke();

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    );
  });
});
