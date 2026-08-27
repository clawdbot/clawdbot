import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  WORKER_EXEC_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../../infra/node-runner-inventory.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { VERSION } from "../../version.js";
import { resolveDevicePlacementEligibility } from "./device-placement-eligibility.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { REQUEST, type PlacementStore } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";

const runtimeNodeCommandPolicy = vi.hoisted(() => ({
  commands: { allow: ["codex.exec-server.stdio.v1"] } as {
    allow?: string[];
    deny?: string[];
  },
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    getRuntimeConfig: () => ({
      ...actual.getRuntimeConfig(),
      gateway: { nodes: { commands: runtimeNodeCommandPolicy.commands } },
    }),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const CODEX_COMMAND = "codex.exec-server.stdio.v1";
const OPENCLAW_DEVICE_REQUIREMENT = { requiredNodeCommands: [], consumesWorkerSlot: true };
const CODEX_DEVICE_REQUIREMENT = {
  requiredNodeCommands: [CODEX_COMMAND],
  consumesWorkerSlot: false,
};

function deviceProof(
  available = 2,
  commands = ["system.run", CODEX_COMMAND],
): NodeWorkerSupervisorNodeProof {
  return {
    nodeId: "device-1",
    connId: "conn-device-1",
    pairingIdentity: "identity-device-1",
    pairingGeneration: "generation-device-1",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: { enabled: true as const, capacity: { total: 2, available } },
    commands,
  };
}

function prepareCloudNodeDispatch(
  harness: ReturnType<typeof createHarness>,
  executionMode: "worker-turn" | "remote-exec" = "remote-exec",
) {
  const cloudNodeIdentity = {
    providerId: "generic-cloud-node",
    profileId: "multi-mode-cloud",
    nodeDeviceId: "device-1",
    sshEndpoint: null,
    sharedHost: false,
  };
  const ready = { ...harness.ready, ...cloudNodeIdentity };
  const attached = { ...harness.attached, ...cloudNodeIdentity };
  let isAttached = false;
  Object.assign(harness.environments, {
    requiresNodeEnrollment: (profileId: string) => profileId === ready.profileId,
  });
  vi.mocked(harness.environments.create).mockResolvedValue(ready);
  vi.mocked(harness.environments.get).mockImplementation((environmentId) =>
    environmentId === ready.environmentId ? (isAttached ? attached : ready) : undefined,
  );
  const attachSession = vi.mocked(harness.environments.attachSession).getMockImplementation();
  vi.mocked(harness.environments.attachSession).mockImplementation(async (params) => {
    if (!attachSession) {
      throw new Error("cloud node dispatch fixture has no session attachment owner");
    }
    const credential = await attachSession(params);
    isAttached = true;
    return credential;
  });
  return {
    ...REQUEST,
    profileId: ready.profileId,
    executionMode,
    devicePlacement:
      executionMode === "remote-exec" ? CODEX_DEVICE_REQUIREMENT : OPENCLAW_DEVICE_REQUIREMENT,
  };
}

describe("device worker placement dispatch", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  beforeEach(() => {
    runtimeNodeCommandPolicy.commands = { allow: [CODEX_COMMAND] };
    root = tempDirs.make("openclaw-device-dispatch-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("provisions, syncs, and activates a local-install device environment", async () => {
    const harness = createHarness(placementStore);
    bindDeviceWorkerAvailability(harness.environments, async () => ({
      available: true,
      node: deviceProof(),
    }));
    vi.mocked(harness.environments.createFromProfileSnapshot).mockResolvedValue({
      ...harness.ready,
      providerId: "device",
      profileId: "device:device-1",
      profileSnapshot: { install: "bundle", settings: { device: "device-1" } },
      leaseId: "lease-1",
      sshEndpoint: null,
      bootstrapReceipt: {
        bundleHash: "a".repeat(64),
        openclawVersion: "2026.8.12",
        protocolFeatures: [
          WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
          WORKER_EXEC_AUTHORITY_PROTOCOL_FEATURE,
        ],
        installKind: "bundle",
      },
      sharedHost: true,
      tunnelStatus: "stopped",
    });
    const request = {
      ...REQUEST,
      profileId: "device:device-1",
      deviceId: "device-1",
      devicePlacement: OPENCLAW_DEVICE_REQUIREMENT,
      inheritedProfile: {
        providerId: "device",
        profileSnapshot: { install: "bundle" as const, settings: { device: "device-1" } },
      },
    };

    await expect(harness.service.dispatch(request)).resolves.toMatchObject({
      state: "active",
      workerBundleHash: "a".repeat(64),
      remoteWorkspaceDir: "/worker/workspace",
    });

    expect(harness.environments.createFromProfileSnapshot).toHaveBeenCalledWith(
      { profileId: request.profileId, ...request.inheritedProfile },
      expect.stringMatching(/^session-dispatch:/u),
      undefined,
      REQUEST.executionMode,
    );
    expect(harness.environments.startTunnel).toHaveBeenCalledWith({
      environmentId: harness.ready.environmentId,
      ownerEpoch: expect.any(Number),
    });
    expect(harness.environments.attachSession).toHaveBeenCalledWith({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.placements.current()).toMatchObject({ state: "active" });
  });

  it("syncs paired-device remote-exec without launching an OpenClaw worker child", async () => {
    const harness = createHarness(placementStore);
    bindDeviceWorkerAvailability(harness.environments, async () => ({
      available: true,
      node: deviceProof(0),
    }));
    const nodeEnvironment = {
      ...harness.ready,
      providerId: "device",
      profileId: "device:device-1",
      profileSnapshot: { install: "bundle", settings: { device: "device-1" } },
      nodeDeviceId: "device-1",
      leaseId: "lease-1",
      sshEndpoint: null,
      sharedHost: true,
    } as const;
    vi.mocked(harness.environments.createFromProfileSnapshot).mockResolvedValue(nodeEnvironment);
    vi.mocked(harness.environments.get).mockImplementation((environmentId) => {
      if (environmentId !== nodeEnvironment.environmentId) {
        return undefined;
      }
      return vi.mocked(harness.environments.attachSession).mock.calls.length > 0
        ? {
            ...harness.attached,
            providerId: "device",
            profileId: "device:device-1",
            nodeDeviceId: "device-1",
            sshEndpoint: null,
            sharedHost: true,
          }
        : nodeEnvironment;
    });
    const request = {
      ...REQUEST,
      executionMode: "remote-exec" as const,
      profileId: "device:device-1",
      deviceId: "device-1",
      devicePlacement: CODEX_DEVICE_REQUIREMENT,
      inheritedProfile: {
        providerId: "device",
        profileSnapshot: { install: "bundle" as const, settings: { device: "device-1" } },
      },
    };

    await expect(harness.service.dispatch(request)).resolves.toMatchObject({
      state: "active",
      executionMode: "remote-exec",
      remoteWorkspaceDir: "/worker/workspace",
    });

    expect(harness.environments.createFromProfileSnapshot).toHaveBeenCalledWith(
      { profileId: request.profileId, ...request.inheritedProfile },
      expect.stringMatching(/^session-dispatch:/u),
      undefined,
      "remote-exec",
    );
    const workspaceTunnel = await vi.mocked(harness.environments.startTunnel).mock.results[0]
      ?.value;
    expect(workspaceTunnel?.syncWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: request.sessionId,
        localPath: expect.any(String),
        generation: expect.any(Number),
      }),
    );
    expect(workspaceTunnel?.launchTurn).not.toHaveBeenCalled();
  });

  it("activates non-device node remote-exec without a worker slot or worker child", async () => {
    const harness = createHarness(placementStore);
    const resolveAvailability = vi.fn(async () => ({
      available: true,
      node: deviceProof(0),
    }));
    bindDeviceWorkerAvailability(harness.environments, resolveAvailability);
    const request = prepareCloudNodeDispatch(harness);

    await expect(harness.service.dispatch(request)).resolves.toMatchObject({
      state: "active",
      executionMode: "remote-exec",
      remoteWorkspaceDir: "/worker/workspace",
    });

    expect(resolveAvailability).toHaveBeenCalledWith("device-1");
    expect(harness.environments.create).toHaveBeenCalledWith(
      "multi-mode-cloud",
      expect.stringMatching(/^session-dispatch:/u),
      undefined,
      "remote-exec",
    );
    const workspaceTunnel = await vi.mocked(harness.environments.startTunnel).mock.results[0]
      ?.value;
    expect(workspaceTunnel?.syncWorkspace).toHaveBeenCalledOnce();
    expect(workspaceTunnel?.launchTurn).not.toHaveBeenCalled();
  });

  it("does not require node command approval for an SSH-only remote-exec profile", async () => {
    const harness = createHarness(placementStore);
    runtimeNodeCommandPolicy.commands = { deny: [CODEX_COMMAND] };

    await expect(
      harness.service.dispatch({
        ...REQUEST,
        executionMode: "remote-exec",
        devicePlacement: CODEX_DEVICE_REQUIREMENT,
      }),
    ).resolves.toMatchObject({ state: "active", executionMode: "remote-exec" });

    expect(harness.environments.create).toHaveBeenCalledOnce();
  });

  it("rejects a remote-exec-only enrolled node before provider allocation when its command is denied", async () => {
    const harness = createHarness(placementStore);
    const request = prepareCloudNodeDispatch(harness);
    runtimeNodeCommandPolicy.commands = { deny: [CODEX_COMMAND] };
    Object.assign(harness.environments, {
      supportsExecutionMode: (_profileId: string, mode: string) => mode === "remote-exec",
      requiresNodeEnrollment: () => true,
    });

    await expect(harness.service.dispatch(request)).rejects.toThrow(CODEX_COMMAND);

    expect(harness.environments.create).not.toHaveBeenCalled();
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "undeclared required node command",
      node: deviceProof(0, ["system.run"]),
      deniedByGateway: false,
      expectedProvisionCalls: 1,
    },
    {
      name: "required node command denied by Gateway policy",
      node: deviceProof(0),
      deniedByGateway: true,
      expectedProvisionCalls: 0,
    },
  ])("rejects a non-device cloud node with an $name before workspace sync", async (scenario) => {
    const harness = createHarness(placementStore);
    bindDeviceWorkerAvailability(harness.environments, async () => ({
      available: true,
      node: scenario.node,
    }));
    if (scenario.deniedByGateway) {
      runtimeNodeCommandPolicy.commands = { deny: [CODEX_COMMAND] };
    }
    const request = prepareCloudNodeDispatch(harness);

    await expect(harness.service.dispatch(request)).rejects.toThrow("codex.exec-server.stdio.v1");

    expect(harness.environments.create).toHaveBeenCalledTimes(scenario.expectedProvisionCalls);
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.placements.current()).toMatchObject({ state: "failed" });
  });

  it("rejects a non-device cloud node whose current proof names a different node", async () => {
    const harness = createHarness(placementStore);
    bindDeviceWorkerAvailability(harness.environments, async () => ({
      available: true,
      node: { ...deviceProof(), nodeId: "replacement-node" },
    }));
    const request = prepareCloudNodeDispatch(harness);

    await expect(harness.service.dispatch(request)).rejects.toThrow();

    expect(harness.environments.create).toHaveBeenCalledOnce();
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.placements.current()).toMatchObject({ state: "failed" });
  });

  it("fences a non-device cloud node replaced inside the activation barrier", async () => {
    const harness = createHarness(placementStore);
    bindDeviceWorkerAvailability(harness.environments, async () => ({
      available: true,
      node: deviceProof(),
    }));
    const request = prepareCloudNodeDispatch(harness);
    let authorizationChecks = 0;

    await expect(
      harness.service.dispatch(request, undefined, () => {
        authorizationChecks += 1;
        if (authorizationChecks === 2) {
          vi.mocked(harness.environments.get).mockReturnValue({
            ...harness.attached,
            providerId: "generic-cloud-node",
            profileId: "multi-mode-cloud",
            nodeDeviceId: "replacement-node",
            sshEndpoint: null,
            sharedHost: false,
          });
        }
      }),
    ).rejects.toThrow("exact environment owner");

    expect(harness.environments.startTunnel).toHaveBeenCalledOnce();
    expect(harness.placements.current()).toMatchObject({ state: "failed" });
  });

  it("rejects a cloud node re-paired while its managed workspace is synchronizing", async () => {
    let currentNode = deviceProof(0);
    const harness = createHarness(placementStore, {
      isCurrentNodePlacement: (node) =>
        node.nodeId === currentNode.nodeId &&
        node.connId === currentNode.connId &&
        node.pairingGeneration === currentNode.pairingGeneration,
    });
    bindDeviceWorkerAvailability(harness.environments, async () => ({
      available: true,
      node: currentNode,
    }));
    const request = prepareCloudNodeDispatch(harness);

    await expect(
      harness.service.dispatch(request, (placement) => {
        if (placement.state === "starting") {
          currentNode = {
            ...currentNode,
            connId: "replacement-connection",
            pairingGeneration: "replacement-generation",
          };
        }
      }),
    ).rejects.toThrow();

    expect(harness.environments.startTunnel).toHaveBeenCalledOnce();
    expect(harness.placements.current()).toMatchObject({ state: "failed" });
  });

  it("fences a cloud node re-paired inside the synchronous activation callback", async () => {
    let currentNode = deviceProof(0);
    const harness = createHarness(placementStore, {
      isCurrentNodePlacement: (node) =>
        node.nodeId === currentNode.nodeId &&
        node.connId === currentNode.connId &&
        node.pairingGeneration === currentNode.pairingGeneration,
    });
    bindDeviceWorkerAvailability(harness.environments, async () => ({
      available: true,
      node: currentNode,
    }));
    const request = prepareCloudNodeDispatch(harness);
    let authorizationChecks = 0;

    await expect(
      harness.service.dispatch(request, undefined, () => {
        authorizationChecks += 1;
        if (authorizationChecks === 2) {
          currentNode = {
            ...currentNode,
            connId: "replacement-connection",
            pairingGeneration: "replacement-generation",
          };
        }
      }),
    ).rejects.toThrow("pairing generation");

    expect(harness.environments.startTunnel).toHaveBeenCalledOnce();
    expect(harness.placements.current()).toMatchObject({ state: "failed" });
  });

  it.each([
    { name: "withdraws its required node command", revocation: "command" as const },
    { name: "denies its required command in Gateway policy", revocation: "policy" as const },
  ])("fences a cloud node that $name inside the activation callback", async (scenario) => {
    let currentNode = deviceProof(0);
    const harness = createHarness(placementStore, {
      isCurrentNodePlacement: (node, requirement) =>
        node.nodeId === currentNode.nodeId &&
        node.connId === currentNode.connId &&
        node.pairingGeneration === currentNode.pairingGeneration &&
        requirement.requiredNodeCommands.every(
          (command) =>
            currentNode.commands.includes(command) &&
            runtimeNodeCommandPolicy.commands.allow?.includes(command) === true &&
            runtimeNodeCommandPolicy.commands.deny?.includes(command) !== true,
        ),
    });
    bindDeviceWorkerAvailability(harness.environments, async () => ({
      available: true,
      node: currentNode,
    }));
    const request = prepareCloudNodeDispatch(harness);
    let authorizationChecks = 0;

    await expect(
      harness.service.dispatch(request, undefined, () => {
        authorizationChecks += 1;
        if (authorizationChecks === 2) {
          if (scenario.revocation === "command") {
            currentNode = {
              ...currentNode,
              commands: currentNode.commands.filter((command) => command !== CODEX_COMMAND),
            };
          } else {
            runtimeNodeCommandPolicy.commands = { deny: [CODEX_COMMAND] };
          }
        }
      }),
    ).rejects.toThrow();

    expect(harness.environments.startTunnel).toHaveBeenCalledOnce();
    expect(harness.placements.current()).toMatchObject({ state: "failed" });
  });

  it("records an unavailable device dispatch as a durable failed placement", async () => {
    const harness = createHarness(placementStore);
    bindDeviceWorkerAvailability(harness.environments, async () => ({
      available: false,
      issue: NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
    }));
    const states: string[] = [];
    const request = {
      ...REQUEST,
      profileId: "device:offline-device",
      deviceId: "offline-device",
      devicePlacement: OPENCLAW_DEVICE_REQUIREMENT,
      inheritedProfile: {
        providerId: "device",
        profileSnapshot: {
          install: "bundle" as const,
          settings: { device: "offline-device" },
        },
      },
    };

    await expect(
      harness.service.dispatch(request, (placement) => states.push(placement.state)),
    ).rejects.toThrow(
      "device worker node offline-device requires an update before it can host sessions; run openclaw update, then reconnect it (for a headless node, run openclaw node restart)",
    );

    expect(states).toEqual(["requested", "failed"]);
    expect(harness.environments.createFromProfileSnapshot).not.toHaveBeenCalled();
    expect(createWorkerSessionPlacementStore({ database }).get(REQUEST.sessionId)).toMatchObject({
      state: "failed",
      environmentId: null,
      recoveryError: expect.stringContaining("run openclaw update"),
      terminalReason: expect.stringContaining("run openclaw node restart"),
      terminalAtMs: 1_000,
    });
  });

  it("rechecks a paired node immediately before provisioning after its eligibility changes", async () => {
    const harness = createHarness(placementStore);
    const resolveAvailability = vi
      .fn()
      .mockResolvedValueOnce({ available: true, node: deviceProof() })
      .mockResolvedValueOnce({ available: false, unavailableReason: "disconnected" });
    bindDeviceWorkerAvailability(harness.environments, resolveAvailability);
    const request = {
      ...REQUEST,
      profileId: "device:device-1",
      deviceId: "device-1",
      devicePlacement: OPENCLAW_DEVICE_REQUIREMENT,
      inheritedProfile: {
        providerId: "device",
        profileSnapshot: { install: "bundle" as const, settings: { device: "device-1" } },
      },
    };

    await expect(harness.service.dispatch(request)).rejects.toThrow("reconnect");

    expect(resolveAvailability).toHaveBeenCalledTimes(2);
    expect(harness.environments.createFromProfileSnapshot).not.toHaveBeenCalled();
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      environmentId: null,
      recoveryError: expect.stringContaining("reconnect"),
    });
  });

  it.each([
    {
      name: "allows remote-exec without a worker slot",
      node: deviceProof(0),
      requirement: CODEX_DEVICE_REQUIREMENT,
      config: { gateway: { nodes: { commands: { allow: [CODEX_COMMAND] } } } },
      expected: true,
    },
    {
      name: "rejects worker-turn when all slots are occupied",
      node: deviceProof(0),
      requirement: OPENCLAW_DEVICE_REQUIREMENT,
      config: {},
      expected: false,
      message: "at capacity",
    },
    {
      name: "rejects an undeclared required command",
      node: deviceProof(2, ["system.run"]),
      requirement: CODEX_DEVICE_REQUIREMENT,
      config: { gateway: { nodes: { commands: { allow: [CODEX_COMMAND] } } } },
      expected: false,
      message: "not enabled or approved",
    },
    {
      name: "rejects a declared command denied by Gateway policy",
      node: deviceProof(),
      requirement: CODEX_DEVICE_REQUIREMENT,
      config: { gateway: { nodes: { commands: { deny: [CODEX_COMMAND] } } } },
      expected: false,
      message: "not enabled or approved",
    },
    {
      name: "allows an explicitly enabled declared command",
      node: deviceProof(),
      requirement: CODEX_DEVICE_REQUIREMENT,
      config: { gateway: { nodes: { commands: { allow: [CODEX_COMMAND] } } } },
      expected: true,
    },
    {
      name: "rejects a replaced node connection",
      node: deviceProof(),
      requirement: OPENCLAW_DEVICE_REQUIREMENT,
      config: {},
      currentNode: { nodeId: "device-1", connId: "replaced-connection" },
      expected: false,
      message: "reconnect",
    },
  ])("$name", async ({ node, requirement, config, expected, ...scenario }) => {
    const service = {};
    bindDeviceWorkerAvailability(service, async () => ({ available: true, node }));

    const result = await resolveDevicePlacementEligibility({
      environmentService: service,
      deviceId: "device-1",
      requirement,
      config,
      ...("currentNode" in scenario ? { currentNode: scenario.currentNode } : {}),
    });

    expect(result.ok).toBe(expected);
    if (!result.ok && "message" in scenario && scenario.message) {
      expect(result.error).toContain(scenario.message);
    }
  });

  it.each([
    {
      name: "saturated worker-turn node",
      executionMode: "worker-turn" as const,
      node: deviceProof(0),
      providerId: "device",
      expectedMessage: "at capacity",
    },
    {
      name: "remote-exec node missing its required command",
      executionMode: "remote-exec" as const,
      node: deviceProof(0, ["system.run"]),
      providerId: "device",
      expectedMessage: "not enabled or approved",
    },
    {
      name: "non-device remote-exec cloud node missing its required command",
      executionMode: "remote-exec" as const,
      node: deviceProof(0, ["system.run"]),
      providerId: "generic-cloud-node",
      expectedMessage: "not enabled or approved",
    },
    {
      name: "saturated non-device worker-turn cloud node",
      executionMode: "worker-turn" as const,
      node: deviceProof(0),
      providerId: "generic-cloud-node",
      expectedMessage: "at capacity",
    },
  ])("fences recovery of a $name before workspace sync", async (scenario) => {
    const harness = createHarness(placementStore);
    const provisioning = harness.placements.seedProvisioning(scenario.executionMode);
    if (provisioning.state !== "provisioning") {
      throw new Error("paired-device recovery fixture did not enter provisioning");
    }
    const environment = {
      ...harness.ready,
      providerId: scenario.providerId,
      nodeDeviceId: "device-1",
      sshEndpoint: null,
    };
    vi.mocked(harness.environments.get).mockImplementation((environmentId) =>
      environmentId === environment.environmentId ? environment : undefined,
    );
    bindDeviceWorkerAvailability(harness.environments, async () => ({
      available: true,
      node: scenario.node,
    }));

    await harness.service.resumeProvisioning(provisioning, async () => {});

    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining(scenario.expectedMessage),
    });
  });

  it("adopts an offline paired-device placement without eagerly starting its tunnel", async () => {
    const harness = createHarness(placementStore);
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentNodeDeviceId("offline-device");
    harness.log.length = 0;

    await harness.service.reconcile();

    expect(harness.log).toEqual(["environment:reconcile", "workspace", "placement:adopted"]);
    expect(harness.placements.current()).toMatchObject({ state: "active" });
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("never hands a descriptor to a same-version local worker with the older strict parser", async () => {
    const harness = createHarness(placementStore);
    bindDeviceWorkerAvailability(harness.environments, async () => ({
      available: true,
      node: deviceProof(),
    }));
    vi.mocked(harness.environments.createFromProfileSnapshot).mockResolvedValue({
      ...harness.ready,
      providerId: "device",
      profileId: "device:device-1",
      profileSnapshot: { install: "bundle", settings: { device: "device-1" } },
      leaseId: "device-lease-1",
      sshEndpoint: null,
      bootstrapReceipt: {
        bundleHash: "a".repeat(64),
        openclawVersion: VERSION,
        protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
        installKind: "local",
      },
      sharedHost: true,
      tunnelStatus: "stopped",
    });
    const request = {
      ...REQUEST,
      profileId: "device:device-1",
      deviceId: "device-1",
      devicePlacement: OPENCLAW_DEVICE_REQUIREMENT,
      inheritedProfile: {
        providerId: "device",
        profileSnapshot: { install: "bundle" as const, settings: { device: "device-1" } },
      },
    };

    await expect(harness.service.dispatch(request)).rejects.toThrow(
      "current worker launch contract",
    );

    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledWith(harness.ready.environmentId);
    expect(harness.placements.current()).toMatchObject({ state: "failed" });
  });
});
