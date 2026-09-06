import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, vi, type Mock } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { tryBeginGatewayRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { bindWorkerTurnOwner } from "./placement-turn-claim-events.js";
import { createWorkerSessionToolExecutor } from "./worker-session-tool-executor.js";

const sharedMocks = vi.hoisted(() => ({
  sessionEntries: new Map<string, SessionEntry>(),
  delivered: vi.fn(),
  gatewayRequest: vi.fn(),
  gatewayCreate: vi.fn(),
  gatewayRuntimeIdentity: vi.fn(),
  dispatchChild: vi.fn(),
  spawnCallerIdentity: vi.fn(),
  spawnArgs: vi.fn(),
  scopedSessionAccess: vi.fn(async (params: { run: () => Promise<unknown> }) => await params.run()),
}));

export function workerSessionToolTestMocks() {
  return sharedMocks;
}

vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadGatewaySessionEntryReadOnly: (sessionKey: string) => ({
      agentId: parseAgentSessionKey(sessionKey)?.agentId,
      canonicalKey: sessionKey,
      entry: structuredClone(sharedMocks.sessionEntries.get(sessionKey)),
    }),
  };
});

vi.mock("../../agents/tools/sessions-send-tool.js", () => ({
  createSessionsSendTool: (options: unknown) => ({
    execute: async (toolCallId: string, args: unknown) => {
      await sharedMocks.delivered({ args, options, toolCallId });
      return {
        content: [{ type: "text", text: "sent" }],
        details: { status: "ok" },
      };
    },
  }),
}));

vi.mock("../../agents/tools/sessions-spawn-tool.js", async () => {
  const { getGatewayToolCallerIdentity } =
    await import("../../agents/tools/gateway-caller-context.js");
  return {
    createSessionsSpawnTool: (options: {
      agentSessionKey: string;
      callGateway: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    }) => ({
      execute: async (_toolCallId: string, args: { task: string; worktree?: boolean }) => {
        sharedMocks.spawnCallerIdentity(getGatewayToolCallerIdentity());
        sharedMocks.spawnArgs(args);
        const details = await options.callGateway("sessions.create", {
          parentSessionKey: options.agentSessionKey,
          task: args.task,
          ...(args.worktree ? { worktree: true } : {}),
        });
        return {
          content: [{ type: "text", text: "spawned" }],
          details,
        };
      },
    }),
  };
});

vi.mock("../../agents/tools/scoped-session-access.js", () => ({
  runWithScopedSessionAccess: (params: unknown) => sharedMocks.scopedSessionAccess(params as never),
}));

vi.mock("../../agents/tools/in-process-gateway.js", () => ({
  callAgentToolGatewayRequest: (request: unknown) => sharedMocks.gatewayRequest(request),
  callInProcessGatewayTool: (method: string, params: Record<string, unknown>) =>
    sharedMocks.gatewayRequest({ method, params }),
  callInProcessGatewayToolWithCreation: (
    method: string,
    params: Record<string, unknown>,
    creation: unknown,
    options: unknown,
  ) => sharedMocks.gatewayCreate({ creation, method, options, params }),
  withAgentToolGatewayRuntimeIdentity: (request: unknown, identity: unknown) => {
    sharedMocks.gatewayRuntimeIdentity(request, identity);
    return request;
  },
}));

export const SOURCE = {
  agentId: "main",
  sessionId: "source-session",
  sessionKey: "agent:main:dashboard:source",
  environmentId: "source-environment",
  ownerEpoch: 3,
};
export const TARGET = {
  agentId: "main",
  sessionId: "target-session",
  sessionKey: "agent:main:dashboard:target",
  environmentId: "target-environment",
  ownerEpoch: 4,
};
export const PARENT = {
  sessionId: "parent-session",
  sessionKey: "agent:main:dashboard:parent",
};
export const CHILD = {
  agentId: "main",
  sessionId: "spawned-child-session",
  environmentId: "spawned-child-environment",
  ownerEpoch: 5,
};
export const GRANDCHILD = {
  agentId: "main",
  sessionId: "spawned-grandchild-session",
  environmentId: "spawned-grandchild-environment",
  ownerEpoch: 6,
};
export const PARENT_EXECUTION_IDENTITY_TOKEN = {
  tokenVersion: 1,
  contextId: "parent-context",
  executionId: "parent-execution",
  runId: "source-run",
  createdAt: 1,
} satisfies ExecutionIdentityAdmissionToken;

export const resolveGatewayContext = () => undefined;

type WorkerSessionToolTestMocks = {
  sessionEntries: Map<string, SessionEntry>;
  delivered: Mock;
  gatewayRequest: Mock;
  gatewayCreate: Mock;
  gatewayRuntimeIdentity: Mock;
  dispatchChild: Mock;
  spawnCallerIdentity: Mock;
  spawnArgs: Mock;
  scopedSessionAccess: Mock<(params: { run: () => Promise<unknown> }) => Promise<unknown>>;
};

type WorkerSessionToolTestOptions = { collectExecutionIdentity?: boolean };

async function createWorkerSessionToolTestFixture(
  mocks: WorkerSessionToolTestMocks,
  options: WorkerSessionToolTestOptions,
) {
  const {
    sessionEntries,
    delivered,
    gatewayRequest,
    gatewayCreate,
    gatewayRuntimeIdentity,
    dispatchChild,
    spawnCallerIdentity,
    spawnArgs,
    scopedSessionAccess,
  } = mocks;
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-tools-"),
  );
  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  const placements = createWorkerSessionPlacementStore({ database });
  activate(SOURCE);
  activate(TARGET);
  const sourceClaim = placements.claimTurn({
    sessionId: SOURCE.sessionId,
    agentId: SOURCE.agentId,
    sessionKey: SOURCE.sessionKey,
    claimId: "source-claim",
    runId: "source-run",
    owner: {
      kind: "worker",
      environmentId: SOURCE.environmentId,
      ownerEpoch: SOURCE.ownerEpoch,
    },
  });
  placements.authorizeWorkerTurnTools(sourceClaim, ["sessions_send", "sessions_spawn"]);
  const delegatedAuthorities: AgentRunDelegatedAuthority[] = [];
  const sourceOperationalRun = createOperationalRunInstanceRef(sourceClaim.runId);
  delegatedAuthorities.push(claimAgentRunDelegatedAuthority(sourceOperationalRun));
  let sourceRunActive = true;
  const rootAdmission = tryBeginGatewayRootWorkAdmission();
  if (!rootAdmission) {
    throw new Error("Worker fixture could not admit its parent turn");
  }
  await rootAdmission.run(async () => {
    bindWorkerTurnOwner(
      placements,
      sourceClaim,
      options.collectExecutionIdentity !== false ? PARENT_EXECUTION_IDENTITY_TOKEN : undefined,
      sourceOperationalRun,
      { agentId: SOURCE.agentId, sessionKey: SOURCE.sessionKey },
      () => {
        if (!sourceRunActive) {
          throw new Error("source worker run ended");
        }
      },
    );
  });
  const identity: WorkerConnectionIdentity = {
    environmentId: SOURCE.environmentId,
    credentialHash: "credential-hash",
    bundleHash: "a".repeat(64),
    sessionId: SOURCE.sessionId,
    runId: sourceClaim.runId,
    turnClaim: sourceClaim,
    ownerEpoch: SOURCE.ownerEpoch,
    rpcSetVersion: 1,
    protocolFeatures: ["worker-session-tools-v1"],
    credentialExpiresAtMs: Date.now() + 60_000,
  };
  sessionEntries.clear();
  delivered.mockReset();
  gatewayRequest.mockReset();
  gatewayCreate.mockReset();
  gatewayRuntimeIdentity.mockReset();
  dispatchChild.mockReset();
  spawnCallerIdentity.mockReset();
  spawnArgs.mockReset();
  // Shared mocks must discard unused once overrides before the next fixture starts.
  scopedSessionAccess.mockReset();
  scopedSessionAccess.mockImplementation(async (params) => await params.run());
  const spawnState: { childSessionKey: string | undefined; order: string[] } = {
    childSessionKey: undefined,
    order: [],
  };
  gatewayCreate.mockImplementation(
    async (request: { method: string; params: Record<string, unknown> }) => {
      spawnState.order.push("create");
      spawnState.childSessionKey = String(request.params.key);
      setEntry(spawnState.childSessionKey, CHILD.sessionId, {
        sessionKey: SOURCE.sessionKey,
        sessionId: SOURCE.sessionId,
      });
      return { ok: true, key: spawnState.childSessionKey, sessionId: CHILD.sessionId };
    },
  );
  dispatchChild.mockImplementation(async (request: { sessionKey: string }) => {
    spawnState.order.push("dispatch");
    expect(placements.get(CHILD.sessionId)).toBeUndefined();
    activate({
      ...CHILD,
      sessionKey: request.sessionKey,
    });
    return placements.get(CHILD.sessionId);
  });
  gatewayRequest.mockImplementation(
    async (request: { method: string; params: Record<string, unknown> }) => {
      if (request.method === "agent") {
        spawnState.order.push("send");
        expect(placements.get(CHILD.sessionId)?.state).toBe("active");
        return { runId: "spawned-child-run", status: "accepted" };
      }
      throw new Error(`Unexpected gateway request: ${request.method}`);
    },
  );
  const execute = createWorkerSessionToolExecutor({
    resolveGatewayContext,
    placements,
    dispatchChild,
    portals: {
      getService: () => undefined,
      carrier: { open: vi.fn() },
      onChanged: vi.fn(),
    },
    environments: {
      get: (environmentId: string) => {
        if (environmentId === SOURCE.environmentId) {
          return {
            state: "attached",
            ownerEpoch: SOURCE.ownerEpoch,
            attachedSessionIds: [SOURCE.sessionId],
            providerId: "fake",
            profileId: "cloud-profile",
            profileSnapshot: { install: "bundle", settings: { region: "source" } },
          };
        }
        if (environmentId === CHILD.environmentId) {
          return {
            state: "attached",
            ownerEpoch: CHILD.ownerEpoch,
            attachedSessionIds: [CHILD.sessionId],
            providerId: "fake",
            profileId: "cloud-profile",
            profileSnapshot: { install: "bundle", settings: { region: "source" } },
          };
        }
        if (environmentId === GRANDCHILD.environmentId) {
          return {
            state: "attached",
            ownerEpoch: GRANDCHILD.ownerEpoch,
            attachedSessionIds: [GRANDCHILD.sessionId],
            providerId: "fake",
            profileId: "cloud-profile",
            profileSnapshot: { install: "bundle", settings: { region: "source" } },
          };
        }
        return undefined;
      },
    } as never,
  });
  function activate(session: {
    agentId: string;
    environmentId: string;
    ownerEpoch: number;
    sessionId: string;
    sessionKey: string;
  }): void {
    let placement = placements.startDispatch(session);
    placement = placements.transition({
      sessionId: session.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: session.environmentId },
    });
    placement = placements.transition({
      sessionId: session.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: placement.generation,
      patch: { workerBundleHash: "a".repeat(64) },
    });
    placement = placements.transition({
      sessionId: session.sessionId,
      from: "syncing",
      to: "starting",
      expectedGeneration: placement.generation,
      patch: {
        workspaceBaseManifestRef: `manifest-${session.sessionId}`,
        remoteWorkspaceDir: `/workspace/${session.sessionId}`,
      },
    });
    placements.transition({
      sessionId: session.sessionId,
      from: "starting",
      to: "active",
      expectedGeneration: placement.generation,
      patch: { activeOwnerEpoch: session.ownerEpoch },
    });
  }

  function setEntry(
    sessionKey: string,
    sessionId: string,
    parent?: { sessionKey: string; sessionId: string },
  ): void {
    sessionEntries.set(sessionKey, {
      sessionId,
      updatedAt: Date.now(),
      ...(parent ? { parentSessionKey: parent.sessionKey, parentSessionId: parent.sessionId } : {}),
    });
  }

  async function send(toolCallId: string) {
    return await execute({
      identity,
      toolName: "sessions_send",
      request: {
        toolCallId,
        sessionKey: TARGET.sessionKey,
        message: "status",
        timeoutSeconds: 0,
      },
    });
  }

  function spawn(toolCallId: string, task = "start the child") {
    return execute({ identity, toolName: "sessions_spawn", request: { toolCallId, task } });
  }

  return {
    root,
    placements,
    identity,
    execute,
    sourceClaim,
    delegatedAuthorities,
    closeSourceRun: () => {
      sourceRunActive = false;
    },
    spawnState,
    activate,
    setEntry,
    send,
    spawn,
    async dispose() {
      if (placements.validateTurnClaim(sourceClaim)) {
        await placements.closeWorkerTurnToolState(sourceClaim);
        placements.releaseTurn(sourceClaim);
      }
      for (const authority of delegatedAuthorities) {
        releaseAgentRunDelegatedAuthority(authority);
      }
      rootAdmission.release();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export function installWorkerSessionToolTestFixture(
  mocks: WorkerSessionToolTestMocks,
  options: WorkerSessionToolTestOptions = {},
) {
  let fixture: Awaited<ReturnType<typeof createWorkerSessionToolTestFixture>>;
  beforeEach(async () => {
    fixture = await createWorkerSessionToolTestFixture(mocks, options);
  });
  afterEach(async () => {
    await fixture.dispose();
  });
  return () => fixture;
}
