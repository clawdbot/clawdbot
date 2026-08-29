import path from "node:path";
import { vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { clearRuntimeConfigSnapshot } from "../../config/io.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { MintedWorkerCredential } from "./credential.js";
import { measureNodeWorkerLaunchBytes } from "./node-launch-adapter.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import { createWorkerSessionTurnPlacementProvider as createRawWorkerSessionTurnPlacementProvider } from "./worker-turn-launcher.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

export type WorkerTurnLauncherOptions = Parameters<
  typeof createRawWorkerSessionTurnPlacementProvider
>[0];
export type WorkerTurnEnvironmentService = WorkerTurnLauncherOptions["environments"];
type WorkerTurnEnvironmentRecord = NonNullable<ReturnType<WorkerTurnEnvironmentService["get"]>>;

export const SESSION_ID = "session-worker-turn";
export const SESSION_KEY = "agent:main:worker-turn";
export const ENVIRONMENT_ID = "environment-worker-turn";
export const OWNER_EPOCH = 3;
const BUNDLE_HASH = "a".repeat(64);
export const MANIFEST_REF = `sha256:${"b".repeat(64)}`;
const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");

export const measureLaunchTurn: WorkerTurnTunnelHandle["measureLaunchTurn"] = (plan, claim) =>
  measureNodeWorkerLaunchBytes("fixture-node", {
    environmentSession: 1,
    launchId: plan.assignment.turnId,
    gatewayNamespace: "fixture-gateway",
    expectedBundleHash: plan.admission.handshake.bundleHash,
    placementGeneration: claim.placementGeneration,
    descriptor: plan,
  });

let testState: OpenClawTestState;
let database: OpenClawStateDatabase;
let cleanupAdmissionSink: (() => void) | undefined;

export let root: string;
export let placements: WorkerSessionPlacementStore;
export let sessionFile: string;
export let sessionTarget: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
};

export async function setupWorkerTurnLauncherTest(): Promise<void> {
  testState = await createOpenClawTestState({
    label: "worker-turn",
    layout: "state-only",
  });
  root = testState.root;
  database = openOpenClawStateDatabase({ env: testState.env });
  placements = createWorkerSessionPlacementStore({ database });
  sessionTarget = {
    agentId: "main",
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    storePath: path.join(root, "sessions.json"),
  };
  await upsertSessionEntryCore(sessionTarget, {
    sessionId: SESSION_ID,
    updatedAt: Date.now(),
  });
  SessionManager.open(sessionTarget);
  sessionFile = SESSION_KEY;
}

export async function cleanupWorkerTurnLauncherTest(): Promise<void> {
  cleanupAdmissionSink?.();
  cleanupAdmissionSink = undefined;
  clearRuntimeConfigSnapshot();
  closeOpenClawStateDatabaseForTest();
  resetAgentEventsForTest();
  await testState.cleanup();
}

export function setWorkerTurnAdmissionCleanup(cleanup: () => void): void {
  cleanupAdmissionSink = cleanup;
}

export function setWorkerTurnSessionTarget(target: typeof sessionTarget): typeof sessionTarget {
  sessionTarget = target;
  sessionFile = target.sessionKey;
  return target;
}

type DefaultedWorkerTurnLauncherOption =
  | "reconcileActivePlacement"
  | "redispatchReclaimed"
  | "resolveWorkspacePath"
  | "workspaceOperations";

export function createWorkerSessionTurnPlacementProvider(
  options: Omit<WorkerTurnLauncherOptions, DefaultedWorkerTurnLauncherOption> &
    Partial<Pick<WorkerTurnLauncherOptions, DefaultedWorkerTurnLauncherOption>>,
) {
  return createRawWorkerSessionTurnPlacementProvider({
    reconcileActivePlacement: async () => {
      throw new Error("unexpected active placement reconciliation");
    },
    redispatchReclaimed: async () => {
      throw new Error("unexpected reclaimed placement redispatch");
    },
    resolveWorkspacePath: async () => root,
    workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
    ...options,
  });
}

export function openSessionManager(): SessionManager {
  return SessionManager.open(sessionTarget);
}

export function seedActivePlacement(
  executionMode: "worker-turn" | "remote-exec" = "worker-turn",
  remoteWorkspaceDir = "/worker/workspace",
): void {
  let placement = placements.startDispatch({
    sessionId: SESSION_ID,
    sessionKey: sessionTarget.sessionKey,
    agentId: sessionTarget.agentId,
    executionMode,
  });
  placement = placements.transition({
    sessionId: SESSION_ID,
    from: "requested",
    to: "provisioning",
    expectedGeneration: placement.generation,
    patch: { environmentId: ENVIRONMENT_ID },
  });
  placement = placements.transition({
    sessionId: SESSION_ID,
    from: "provisioning",
    to: "syncing",
    expectedGeneration: placement.generation,
    patch: { workerBundleHash: BUNDLE_HASH },
  });
  placement = placements.transition({
    sessionId: SESSION_ID,
    from: "syncing",
    to: "starting",
    expectedGeneration: placement.generation,
    patch: {
      remoteWorkspaceDir,
      workspaceBaseManifestRef: MANIFEST_REF,
    },
  });
  placements.transition({
    sessionId: SESSION_ID,
    from: "starting",
    to: "active",
    expectedGeneration: placement.generation,
    patch: { activeOwnerEpoch: OWNER_EPOCH },
  });
}

export function seedReclaimedPlacement() {
  seedActivePlacement();
  const active = placements.get(SESSION_ID);
  if (active?.state !== "active") {
    throw new Error("expected active placement to reclaim");
  }
  const draining = placements.startDrain({
    sessionId: SESSION_ID,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
    expectedGeneration: active.generation,
  });
  const reconciling = placements.startReconcile({
    sessionId: SESSION_ID,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
    expectedGeneration: draining.generation,
  });
  const reclaimed = placements.transition({
    sessionId: SESSION_ID,
    from: "reconciling",
    to: "reclaimed",
    expectedGeneration: reconciling.generation,
  });
  if (reclaimed.state !== "reclaimed") {
    throw new Error("expected reclaimed placement");
  }
  return reclaimed;
}

export function attachedEnvironment(): WorkerTurnEnvironmentRecord {
  return {
    environmentId: ENVIRONMENT_ID,
    providerId: "fake",
    profileId: "development",
    profileSnapshot: { settings: { region: "test" } },
    provisionOperationId: "provision-worker-turn",
    nodeSetupId: null,
    nodeDeviceId: null,
    sharedHost: false,
    bootstrapReceipt: {
      bundleHash: BUNDLE_HASH,
      openclawVersion: "2026.7.2",
      protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
      installKind: "bundle",
    },
    ownerEpoch: OWNER_EPOCH,
    teardownTerminalState: null,
    attachedSessionIds: [SESSION_ID],
    lastError: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    stateChangedAtMs: 1,
    idleSinceAtMs: null,
    destroyRequestedAtMs: null,
    tunnelStatus: "connected",
    state: "attached",
    desktop: null,
    desktopAvailable: false,
    desktopApps: [],
    leaseId: "lease-worker-turn",
    sshEndpoint: {
      host: "worker.example.test",
      port: 22,
      user: "worker",
      hostKey: HOST_KEY,
      keyRef: { source: "file", provider: "worker-keys", id: "/worker/key" },
    },
  };
}

export function browserEnvironment(): WorkerTurnEnvironmentRecord {
  return {
    ...attachedEnvironment(),
    desktop: {
      protocol: "rfb",
      port: 5900,
      apps: [
        {
          id: "browser",
          executablePath: "/usr/local/bin/openclaw-worker-browser",
          cdpPort: 9222,
        },
      ],
    },
    desktopAvailable: true,
    desktopApps: ["browser"],
  };
}

export function credential(deliveryId = "c".repeat(43)): MintedWorkerCredential {
  return {
    credential: ["worker", "turn", "credential"].join("-"),
    deliveryId,
    environmentId: ENVIRONMENT_ID,
    bundleHash: BUNDLE_HASH,
    sessionId: SESSION_ID,
    rpcSetVersion: 1,
    ownerEpoch: OWNER_EPOCH,
    expiresAtMs: Date.now() + 60_000,
  };
}

export function unusedEnvironments(): WorkerTurnEnvironmentService {
  const unexpected = () => new Error("unexpected worker environment call");
  return {
    get: vi.fn(() => undefined),
    resolveSshIdentity: vi.fn(async () => {
      throw unexpected();
    }),
    acquireTurnCredential: vi.fn(async () => {
      throw unexpected();
    }),
    acknowledgeCredentialDelivery: vi.fn(() => {
      throw unexpected();
    }),
    startTunnel: vi.fn(async () => {
      throw unexpected();
    }),
    stopTunnel: vi.fn(async () => {
      throw unexpected();
    }),
    destroy: vi.fn(async () => {
      throw unexpected();
    }),
  };
}

export function turn(runId = "run-worker-turn", executionIdentity = false) {
  const config = {
    ...(executionIdentity
      ? { logging: { audit: { enabled: true, executionIdentity: true } } }
      : {}),
    agents: {
      defaults: {
        models: {
          "openai/gpt-test": { agentRuntime: { id: "openclaw" } },
        },
      },
    },
  };
  return {
    preparedRunAdmission: prepareAgentRunAdmission({
      cfg: config,
      operationalRunInstance: createOperationalRunInstanceRef(runId),
      facts: {
        runId,
        agentId: sessionTarget.agentId,
        ingress: { kind: "worker", boundary: "test.worker-turn", state: "present" },
      },
    }),
    sessionId: SESSION_ID,
    sessionKey: sessionTarget.sessionKey,
    agentId: sessionTarget.agentId,
    messageChannel: "telegram",
    currentMessagingTarget: "chat-worker",
    agentAccountId: "worker-account",
    currentThreadTs: "thread-worker",
    sessionFile,
    sessionTarget,
    workspaceDir: root,
    permissionMode: "workspace" as const,
    sessionRoot: root,
    prompt: "Inspect this workspace",
    timeoutMs: 5_000,
    runId,
    provider: "openai",
    model: "gpt-test",
    modelHasVision: true,
    config,
  };
}

export function hasLoneSurrogate(value: string): boolean {
  return Array.from(value).some((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint >= 0xd800 && codePoint <= 0xdfff;
  });
}
