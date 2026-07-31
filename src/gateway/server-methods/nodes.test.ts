import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approveDevicePairing,
  listDevicePairing,
  requestDevicePairing,
  revokeDeviceToken,
  rotateDeviceToken,
  withPairedDeviceRecords,
} from "../../infra/device-pairing.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticSecurityEvent,
} from "../../infra/diagnostic-events.js";
import {
  captureNodePairingGeneration,
  captureNodePairingState,
} from "../../infra/node-pairing-state.js";
import { approveNodePairing, requestNodePairing } from "../../infra/node-pairing.js";
import { loadApnsRegistration, registerApnsRegistration } from "../../infra/push-apns.js";
import { resetRemoteNodeSkillsForTests } from "../../skills/runtime/remote-skills.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { drainNodePendingWork, enqueueNodePendingWork } from "../node-pending-work.js";
import {
  captureNodeWakeLifecycle,
  runNodeWakeAttempt,
  runNodeWakeNudgeAttempt,
} from "../node-wake-state.js";
import {
  getNodeWakeStateSnapshot,
  resetNodeWakeStateForTest,
} from "../node-wake-state.test-support.js";
import { nodeHandlers } from "./nodes.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const createdStates: OpenClawTestState[] = [];
const pairingGenerationHooks = vi.hoisted(() => ({
  beforeCapture: vi.fn<(nodeId: string) => Promise<void> | void>(),
}));

vi.mock("../../infra/node-pairing-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/node-pairing-state.js")>();
  return {
    ...actual,
    captureNodePairingState: async (nodeId: string) => {
      await pairingGenerationHooks.beforeCapture(nodeId);
      return await actual.captureNodePairingState(nodeId);
    },
    captureNodePairingGeneration: async (nodeId: string) => {
      await pairingGenerationHooks.beforeCapture(nodeId);
      return await actual.captureNodePairingGeneration(nodeId);
    },
  };
});

async function createState(label: string): Promise<OpenClawTestState> {
  const state = await createOpenClawTestState({ label, layout: "state-only" });
  createdStates.push(state);
  return state;
}

async function seedNodeWakeState(nodeId: string): Promise<void> {
  await runNodeWakeAttempt({
    nodeId,
    force: true,
    throttleMs: 60_000,
    attempt: async (markAttempted) => {
      markAttempted();
      return { available: true, throttled: false, path: "sent", durationMs: 1 };
    },
  });
  await runNodeWakeNudgeAttempt({
    nodeId,
    throttleMs: 60_000,
    throttled: () => ({ sent: false, throttled: true, reason: "throttled", durationMs: 0 }),
    attempt: async () => ({ sent: true, throttled: false, reason: "sent", durationMs: 1 }),
  });
}

afterEach(async () => {
  resetDiagnosticEventsForTest();
  resetRemoteNodeSkillsForTests();
  resetNodeWakeStateForTest();
  pairingGenerationHooks.beforeCapture.mockReset();
  vi.clearAllMocks();
  closeOpenClawStateDatabaseForTest();
  while (createdStates.length > 0) {
    await createdStates.pop()?.cleanup();
  }
});

function captureSecurityEvents(): {
  events: DiagnosticSecurityEvent[];
  stop: () => void;
} {
  const events: DiagnosticSecurityEvent[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "security.event") {
      events.push(event);
    }
  });
  return { events, stop };
}

function createContext() {
  return {
    broadcast: vi.fn(),
    disconnectClientsForDevice: vi.fn(),
    getRuntimeConfig: vi.fn(() => ({})),
    invalidateClientsForDevice: vi.fn(),
    logGateway: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    nodeRegistry: {
      get: vi.fn(),
      listConnected: vi.fn(() => []),
      listConnectedForPairingStates: vi.fn(() => []),
      getActiveNode: vi.fn(),
      updateSurface: vi.fn(),
      updateNodeSkills: vi.fn(),
    },
  };
}

function createClient(scopes: string[], deviceId?: string, opts?: { isDeviceTokenAuth?: boolean }) {
  return {
    ...(opts?.isDeviceTokenAuth !== undefined ? { isDeviceTokenAuth: opts.isDeviceTokenAuth } : {}),
    connect: {
      scopes,
      ...(deviceId ? { device: { id: deviceId } } : {}),
    },
  } as never;
}

function createOptions(
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): {
  context: ReturnType<typeof createContext>;
  opts: GatewayRequestHandlerOptions;
} {
  const context = createContext();
  const opts = {
    req: { type: "req", id: "req-1", method: "node.pair.remove", params },
    params,
    client: createClient(["operator.pairing", "operator.admin"]),
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context,
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
  return { context, opts };
}

describe("nodeHandlers node.skills.update", () => {
  it("stores and publishes a validated replacement catalog for the calling node", async () => {
    const skill = {
      name: "release-helper",
      description: "Prepare a release",
      content: "---\nname: release-helper\ndescription: Prepare a release\n---\n",
    };
    const { context, opts } = createOptions(
      { skills: [skill] },
      {
        client: {
          connId: "conn-1",
          connect: { device: { id: "node-1" }, client: { id: "node-client" } },
        } as never,
      },
    );
    context.nodeRegistry.updateNodeSkills.mockReturnValue({
      nodeId: "node-1",
      displayName: "Build Mac",
      nodeSkills: [skill],
    });

    await expectDefined(
      nodeHandlers["node.skills.update"],
      'nodeHandlers["node.skills.update"] test invariant',
    )(opts);

    expect(context.nodeRegistry.updateNodeSkills).toHaveBeenCalledWith("node-1", "conn-1", [skill]);
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { nodeId: "node-1", skills: [skill] },
      undefined,
    );
  });
});

async function pairAndroidNodeDevice(stateDir: string, nodeId: string): Promise<void> {
  const pending = await requestDevicePairing(
    {
      deviceId: nodeId,
      publicKey: `public-key-${nodeId}`,
      displayName: "Galaxy A54 5G",
      platform: "android",
      deviceFamily: "Android",
      clientId: "openclaw-android",
      clientMode: "node",
      role: "node",
      roles: ["node"],
      scopes: [],
    },
    stateDir,
  );
  const approved = await approveDevicePairing(
    pending.request.requestId,
    { callerScopes: [] },
    stateDir,
  );
  expect(approved?.status).toBe("approved");
}

async function pairMixedRoleAndroidDevice(stateDir: string, nodeId: string): Promise<void> {
  const pending = await requestDevicePairing(
    {
      deviceId: nodeId,
      publicKey: `public-key-${nodeId}`,
      displayName: "Galaxy A54 5G",
      platform: "android",
      deviceFamily: "Android",
      clientId: "openclaw-android",
      clientMode: "node",
      role: "operator",
      roles: ["operator", "node"],
      scopes: ["operator.pairing"],
    },
    stateDir,
  );
  const approved = await approveDevicePairing(
    pending.request.requestId,
    { callerScopes: ["operator.pairing"] },
    stateDir,
  );
  expect(approved?.status).toBe("approved");
}

async function approveNodeSurface(stateDir: string, nodeId: string): Promise<void> {
  const pending = await requestNodePairing(
    {
      nodeId,
      platform: "android",
      deviceFamily: "Android",
      clientId: "openclaw-android",
      clientMode: "node",
      displayName: "Galaxy A54 5G",
    },
    stateDir,
  );
  const approved = await approveNodePairing(
    pending.request.requestId,
    { callerScopes: ["operator.pairing"] },
    stateDir,
  );
  expect(approved).toEqual(expect.objectContaining({ node: expect.objectContaining({ nodeId }) }));
}

async function readPaired(stateDir: string): Promise<Record<string, unknown>> {
  const { paired } = await listDevicePairing(stateDir);
  return Object.fromEntries(paired.map((device) => [device.deviceId, device]));
}

describe("nodeHandlers node.pair.approve", () => {
  it("promotes the first surface only for the same authenticated pairing identity", async () => {
    const state = await createState("node-approve-promotes-pending-identity");
    const nodeId = "node-pending-identity-stable";
    await pairAndroidNodeDevice(state.stateDir, nodeId);
    const pending = await requestNodePairing(
      {
        nodeId,
        platform: "android",
        deviceFamily: "Android",
        clientId: "openclaw-android",
        clientMode: "node",
        displayName: "Galaxy A54 5G pending",
      },
      state.stateDir,
    );
    const pendingState = await captureNodePairingState(nodeId);
    expect(pendingState?.generation).toBeNull();

    const { context, opts } = createOptions({ requestId: pending.request.requestId });
    context.nodeRegistry.get.mockReturnValue({
      nodeId,
      connId: "conn-pending-identity-stable",
      pairingIdentity: pendingState?.identity.key,
    });

    await expectDefined(
      nodeHandlers["node.pair.approve"],
      'nodeHandlers["node.pair.approve"] test invariant',
    )(opts);

    const approvedState = await captureNodePairingState(nodeId);
    expect(approvedState?.identity.key).toBe(pendingState?.identity.key);
    expect(approvedState?.generation).not.toBeNull();
    expect(context.nodeRegistry.updateSurface).toHaveBeenCalledWith(
      nodeId,
      expect.objectContaining({ commands: expect.any(Array) }),
      {
        expectedConnId: "conn-pending-identity-stable",
        expectedPairingIdentity: pendingState?.identity.key,
        nextPairingGeneration: approvedState?.generation?.key,
      },
    );
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ node: expect.objectContaining({ nodeId }) }),
      undefined,
    );
  });

  it("invalidates an in-flight wake when node-surface approval rotates generation", async () => {
    const state = await createState("node-approve-invalidates-wake");
    const nodeId = "node-surface-reapproval";
    await pairAndroidNodeDevice(state.stateDir, nodeId);
    await approveNodeSurface(state.stateDir, nodeId);
    const previousGeneration = await captureNodePairingGeneration(nodeId);
    const previousState = await captureNodePairingState(nodeId);
    expect(previousGeneration).not.toBeNull();
    expect(previousState).not.toBeNull();
    const pending = await requestNodePairing(
      {
        nodeId,
        platform: "android",
        deviceFamily: "Android",
        clientId: "openclaw-android",
        clientMode: "node",
        displayName: "Galaxy A54 5G reapproved",
      },
      state.stateDir,
    );
    const lifecycle = captureNodeWakeLifecycle(nodeId);
    const { context, opts } = createOptions({ requestId: pending.request.requestId });
    context.nodeRegistry.get.mockReturnValue({
      nodeId,
      connId: "conn-surface-reapproval",
      pairingIdentity: previousState?.identity.key,
      pairingGeneration: previousGeneration?.key,
    });

    await expectDefined(
      nodeHandlers["node.pair.approve"],
      'nodeHandlers["node.pair.approve"] test invariant',
    )(opts);

    expect(lifecycle.aborted).toBe(true);
    const nextGeneration = await captureNodePairingGeneration(nodeId);
    expect(nextGeneration?.key).not.toBe(previousGeneration?.key);
    expect(context.nodeRegistry.updateSurface).toHaveBeenCalledWith(
      nodeId,
      expect.objectContaining({ commands: expect.any(Array) }),
      {
        expectedConnId: "conn-surface-reapproval",
        expectedPairingIdentity: previousState?.identity.key,
        expectedPairingGeneration: previousGeneration?.key,
        nextPairingGeneration: nextGeneration?.key,
      },
    );
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ node: expect.objectContaining({ nodeId }) }),
      undefined,
    );
  });

  it("does not promote a session authenticated before external device reapproval", async () => {
    const state = await createState("node-approve-rejects-stale-live-session");
    const nodeId = "node-stale-surface-session";
    await pairAndroidNodeDevice(state.stateDir, nodeId);
    await approveNodeSurface(state.stateDir, nodeId);
    const staleGeneration = await captureNodePairingGeneration(nodeId);
    const staleState = await captureNodePairingState(nodeId);
    expect(staleGeneration).not.toBeNull();
    expect(staleState).not.toBeNull();
    const pending = await requestNodePairing(
      {
        nodeId,
        platform: "android",
        deviceFamily: "Android",
        clientId: "openclaw-android",
        clientMode: "node",
        displayName: "Galaxy A54 5G reapproved",
      },
      state.stateDir,
    );
    await pairAndroidNodeDevice(state.stateDir, nodeId);
    const currentGeneration = await captureNodePairingGeneration(nodeId);
    expect(currentGeneration?.key).not.toBe(staleGeneration?.key);

    const { context, opts } = createOptions({ requestId: pending.request.requestId });
    context.nodeRegistry.get.mockReturnValue({
      nodeId,
      connId: "conn-authenticated-before-reapproval",
      pairingIdentity: staleState?.identity.key,
      pairingGeneration: staleGeneration?.key,
    });

    await expectDefined(
      nodeHandlers["node.pair.approve"],
      'nodeHandlers["node.pair.approve"] test invariant',
    )(opts);

    expect(context.nodeRegistry.updateSurface).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ node: expect.objectContaining({ nodeId }) }),
      undefined,
    );
  });

  it("does not promote an old session when reapproval wins after surface approval commits", async () => {
    const state = await createState("node-approve-fences-post-approval-repair");
    const nodeId = "node-post-approval-repair";
    await pairAndroidNodeDevice(state.stateDir, nodeId);
    await approveNodeSurface(state.stateDir, nodeId);
    const staleGeneration = await captureNodePairingGeneration(nodeId);
    const staleState = await captureNodePairingState(nodeId);
    expect(staleGeneration).not.toBeNull();
    expect(staleState).not.toBeNull();
    const pending = await requestNodePairing(
      {
        nodeId,
        platform: "android",
        deviceFamily: "Android",
        clientId: "openclaw-android",
        clientMode: "node",
        displayName: "Galaxy A54 5G surface refresh",
      },
      state.stateDir,
    );
    let captureCount = 0;
    pairingGenerationHooks.beforeCapture.mockImplementation(async (capturedNodeId) => {
      if (capturedNodeId !== nodeId) {
        return;
      }
      captureCount += 1;
      if (captureCount === 2) {
        await pairAndroidNodeDevice(state.stateDir, nodeId);
      }
    });

    const { context, opts } = createOptions({ requestId: pending.request.requestId });
    context.nodeRegistry.get.mockReturnValue({
      nodeId,
      connId: "conn-authenticated-before-post-approval-repair",
      pairingIdentity: staleState?.identity.key,
      pairingGeneration: staleGeneration?.key,
    });

    await expectDefined(
      nodeHandlers["node.pair.approve"],
      'nodeHandlers["node.pair.approve"] test invariant',
    )(opts);

    const currentGeneration = await captureNodePairingGeneration(nodeId);
    expect(currentGeneration?.key).not.toBe(staleGeneration?.key);
    expect(context.nodeRegistry.updateSurface).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ node: expect.objectContaining({ nodeId }) }),
      undefined,
    );
  });

  it("does not promote a generation-less session after external node-token rotation", async () => {
    const state = await createState("node-approve-fences-pending-identity");
    const nodeId = "node-pending-identity-rotation";
    await pairAndroidNodeDevice(state.stateDir, nodeId);
    const pending = await requestNodePairing(
      {
        nodeId,
        platform: "android",
        deviceFamily: "Android",
        clientId: "openclaw-android",
        clientMode: "node",
        displayName: "Galaxy A54 5G pending",
      },
      state.stateDir,
    );
    const staleState = await captureNodePairingState(nodeId);
    expect(staleState?.generation).toBeNull();

    const rotated = await rotateDeviceToken({
      deviceId: nodeId,
      role: "node",
      scopes: [],
      baseDir: state.stateDir,
    });
    expect(rotated.ok).toBe(true);
    const currentState = await captureNodePairingState(nodeId);
    expect(currentState?.generation).toBeNull();
    expect(currentState?.identity.key).not.toBe(staleState?.identity.key);

    const { context, opts } = createOptions({ requestId: pending.request.requestId });
    context.nodeRegistry.get.mockReturnValue({
      nodeId,
      connId: "conn-authenticated-before-token-rotation",
      pairingIdentity: staleState?.identity.key,
    });

    await expectDefined(
      nodeHandlers["node.pair.approve"],
      'nodeHandlers["node.pair.approve"] test invariant',
    )(opts);

    expect(context.nodeRegistry.updateSurface).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ node: expect.objectContaining({ nodeId }) }),
      undefined,
    );
  });
});

describe("nodeHandlers node.pair.remove", () => {
  it("clears and invalidates wake state when removing a disconnected device-backed node", async () => {
    const state = await createState("node-remove-clears-wake-state");
    const nodeId = "disconnected-ios-node";
    await pairAndroidNodeDevice(state.stateDir, nodeId);
    await registerApnsRegistration({
      nodeId,
      transport: "direct",
      token: "ABCD1234ABCD1234ABCD1234ABCD1234",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
    });
    await seedNodeWakeState(nodeId);
    enqueueNodePendingWork({ nodeId, type: "location.request" });
    const wakeLifecycle = captureNodeWakeLifecycle(nodeId);

    const { opts } = createOptions({ nodeId });
    await expectDefined(
      nodeHandlers["node.pair.remove"],
      'nodeHandlers["node.pair.remove"] test invariant',
    )(opts);
    await Promise.resolve();

    expect(opts.respond).toHaveBeenCalledWith(true, { nodeId }, undefined);
    expect(getNodeWakeStateSnapshot(nodeId)).toBeUndefined();
    expect(wakeLifecycle.aborted).toBe(true);
    expect(drainNodePendingWork(nodeId).items.map((item) => item.id)).toEqual(["baseline-status"]);
    await expect(loadApnsRegistration(nodeId)).resolves.toBeNull();
  });

  it("preserves an APNs registration created after node-role removal commits", async () => {
    const state = await createState("node-remove-apns-registration-race");
    const nodeId = "ios-node-registration-race";
    await pairAndroidNodeDevice(state.stateDir, nodeId);
    await registerApnsRegistration({
      nodeId,
      transport: "direct",
      token: "ABCD1234ABCD1234ABCD1234ABCD1234",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
    });

    const { context, opts } = createOptions({ nodeId });
    let replacementWrite: Promise<unknown> | undefined;
    context.invalidateClientsForDevice.mockImplementation(() => {
      replacementWrite = (async () => {
        await pairAndroidNodeDevice(state.stateDir, nodeId);
        await approveNodeSurface(state.stateDir, nodeId);
        const replacementGeneration = await captureNodePairingGeneration(nodeId);
        if (!replacementGeneration) {
          throw new Error("expected replacement pairing generation");
        }
        return await registerApnsRegistration({
          nodeId,
          transport: "direct",
          token: "DCBA4321DCBA4321DCBA4321DCBA4321",
          topic: "ai.openclaw.ios",
          environment: "sandbox",
          expectedPairingGeneration: replacementGeneration.key,
        });
      })();
    });

    await expectDefined(
      nodeHandlers["node.pair.remove"],
      'nodeHandlers["node.pair.remove"] test invariant',
    )(opts);
    await replacementWrite;

    await expect(loadApnsRegistration(nodeId)).resolves.toMatchObject({
      nodeId,
      transport: "direct",
      token: "dcba4321dcba4321dcba4321dcba4321",
    });
  });

  it("removes Android device-backed node rows from the paired-device store", async () => {
    const state = await createState("node-remove-android-device-backed");
    const nodeId = "android-node-1";
    await pairAndroidNodeDevice(state.stateDir, nodeId);

    expect(Object.hasOwn(await readPaired(state.stateDir), nodeId)).toBe(true);

    const { context, opts } = createOptions({ nodeId: ` ${nodeId} ` });
    const captured = captureSecurityEvents();
    const respond = vi.mocked(opts.respond);
    respond.mockImplementation(() => {
      expect(context.invalidateClientsForDevice).toHaveBeenCalledWith(nodeId, {
        role: "node",
        reason: "device-pair-removed",
      });
      expect(context.disconnectClientsForDevice).not.toHaveBeenCalled();
    });

    try {
      await expectDefined(
        nodeHandlers["node.pair.remove"],
        'nodeHandlers["node.pair.remove"] test invariant',
      )(opts);
      await Promise.resolve();
    } finally {
      captured.stop();
    }

    expect(respond).toHaveBeenCalledWith(true, { nodeId }, undefined);
    expect(Object.hasOwn(await readPaired(state.stateDir), nodeId)).toBe(false);
    expect(context.invalidateClientsForDevice).toHaveBeenCalledWith(nodeId, {
      role: "node",
      reason: "device-pair-removed",
    });
    expect(context.disconnectClientsForDevice).toHaveBeenCalledWith(nodeId, { role: "node" });
    expect(context.nodeRegistry.updateSurface).toHaveBeenCalledWith(nodeId, {
      caps: [],
      commands: [],
      permissions: undefined,
    });
    expect(context.broadcast).toHaveBeenCalledWith(
      "node.pair.resolved",
      expect.objectContaining({
        decision: "removed",
        nodeId,
        requestId: "",
      }),
      { dropIfSlow: true },
    );
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      type: "security.event",
      category: "auth",
      action: "device.role.removed",
      outcome: "success",
      severity: "medium",
      target: { kind: "device", idHash: expect.stringMatching(/^sha256:[a-f0-9]{12}$/u) },
      policy: { id: "gateway.device-pairing", decision: "allow" },
      control: { id: "node.pair.remove", family: "auth" },
      attributes: { role: "node", removed_device: true },
    });
    expect(JSON.stringify(captured.events)).not.toContain(nodeId);
  });

  it.each(["revoked", "tokenless"] as const)(
    "removes %s device-backed node approvals",
    async (tokenState) => {
      const state = await createState(`node-remove-${tokenState}-device-backed`);
      const nodeId = `${tokenState}-android-node-1`;
      await pairAndroidNodeDevice(state.stateDir, nodeId);

      if (tokenState === "revoked") {
        const revoked = await revokeDeviceToken({
          deviceId: nodeId,
          role: "node",
          baseDir: state.stateDir,
        });
        expect(revoked.ok).toBe(true);
      } else {
        await withPairedDeviceRecords(state.stateDir, (pairedByDeviceId) => {
          delete pairedByDeviceId[nodeId]?.tokens;
          return { value: undefined, persist: true };
        });
      }

      const { context, opts } = createOptions({ nodeId });
      await expectDefined(
        nodeHandlers["node.pair.remove"],
        'nodeHandlers["node.pair.remove"] test invariant',
      )(opts);
      await Promise.resolve();

      expect(opts.respond).toHaveBeenCalledWith(true, { nodeId }, undefined);
      expect(Object.hasOwn(await readPaired(state.stateDir), nodeId)).toBe(false);
      expect(context.disconnectClientsForDevice).toHaveBeenCalledWith(nodeId, { role: "node" });
    },
  );

  it("removes the device row together with its approved node surface", async () => {
    const state = await createState("node-remove-merged-backing-stores");
    const nodeId = "merged-android-node-1";
    await pairAndroidNodeDevice(state.stateDir, nodeId);
    await approveNodeSurface(state.stateDir, nodeId);

    expect(Object.hasOwn(await readPaired(state.stateDir), nodeId)).toBe(true);

    const { context, opts } = createOptions({ nodeId: ` ${nodeId} ` });
    const respond = vi.mocked(opts.respond);
    respond.mockImplementation(() => {
      expect(context.invalidateClientsForDevice).toHaveBeenCalledWith(nodeId, {
        role: "node",
        reason: "device-pair-removed",
      });
      expect(context.disconnectClientsForDevice).not.toHaveBeenCalled();
    });

    await expectDefined(
      nodeHandlers["node.pair.remove"],
      'nodeHandlers["node.pair.remove"] test invariant',
    )(opts);
    await Promise.resolve();

    expect(respond).toHaveBeenCalledWith(true, { nodeId }, undefined);
    expect(Object.hasOwn(await readPaired(state.stateDir), nodeId)).toBe(false);
    expect(context.invalidateClientsForDevice).toHaveBeenCalledWith(nodeId, {
      role: "node",
      reason: "device-pair-removed",
    });
    expect(context.disconnectClientsForDevice).toHaveBeenCalledWith(nodeId, { role: "node" });
    expect(context.nodeRegistry.updateSurface).toHaveBeenCalledWith(nodeId, {
      caps: [],
      commands: [],
      permissions: undefined,
    });
    expect(context.broadcast).toHaveBeenCalledWith(
      "node.pair.resolved",
      expect.objectContaining({
        decision: "removed",
        nodeId,
        requestId: "",
      }),
      { dropIfSlow: true },
    );
  });

  it("preserves non-node device roles when removing a mixed-role node row", async () => {
    const state = await createState("node-remove-mixed-role-device");
    const nodeId = "mixed-role-android-node-1";
    await pairMixedRoleAndroidDevice(state.stateDir, nodeId);
    await registerApnsRegistration({
      nodeId,
      transport: "direct",
      token: "ABCD1234ABCD1234ABCD1234ABCD1234",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
    });

    const before = await readPaired(state.stateDir);
    expect(
      (before[nodeId] as { roles?: string[]; tokens?: Record<string, unknown> }).roles,
    ).toEqual(["operator", "node"]);

    const { context, opts } = createOptions({ nodeId });

    await expectDefined(
      nodeHandlers["node.pair.remove"],
      'nodeHandlers["node.pair.remove"] test invariant',
    )(opts);
    await Promise.resolve();

    expect(opts.respond).toHaveBeenCalledWith(true, { nodeId }, undefined);
    const after = await readPaired(state.stateDir);
    expect((after[nodeId] as { roles?: string[]; tokens?: Record<string, unknown> }).roles).toEqual(
      ["operator"],
    );
    expect(
      Object.hasOwn(
        (after[nodeId] as { tokens?: Record<string, unknown> }).tokens ?? {},
        "operator",
      ),
    ).toBe(true);
    expect(
      Object.hasOwn((after[nodeId] as { tokens?: Record<string, unknown> }).tokens ?? {}, "node"),
    ).toBe(false);
    await expect(loadApnsRegistration(nodeId)).resolves.toMatchObject({
      nodeId,
      transport: "direct",
      token: "abcd1234abcd1234abcd1234abcd1234",
    });
    expect(context.invalidateClientsForDevice).toHaveBeenCalledWith(nodeId, {
      role: "node",
      reason: "device-pair-removed",
    });
    expect(context.disconnectClientsForDevice).toHaveBeenCalledWith(nodeId, { role: "node" });
  });

  it("removes mixed-role device-backed node rows for shared-auth operator.pairing without admin", async () => {
    // Aligns with device.pair.remove: shared-auth / CLI operators that hold
    // operator.pairing (but not operator.admin) manage pairings on others'
    // behalf and must be able to remove the node role from a mixed-role row.
    const state = await createState("node-remove-mixed-role-shared-auth");
    const nodeId = "shared-auth-mixed-role-android-node-1";
    await pairMixedRoleAndroidDevice(state.stateDir, nodeId);

    const before = await readPaired(state.stateDir);
    expect((before[nodeId] as { roles?: string[] }).roles).toEqual(["operator", "node"]);

    const { context, opts } = createOptions(
      { nodeId },
      { client: createClient(["operator.pairing"]) },
    );

    await expectDefined(
      nodeHandlers["node.pair.remove"],
      'nodeHandlers["node.pair.remove"] test invariant',
    )(opts);
    await Promise.resolve();

    expect(opts.respond).toHaveBeenCalledWith(true, { nodeId }, undefined);
    const after = await readPaired(state.stateDir);
    expect((after[nodeId] as { roles?: string[] }).roles).toEqual(["operator"]);
    expect(context.invalidateClientsForDevice).toHaveBeenCalledWith(nodeId, {
      role: "node",
      reason: "device-pair-removed",
    });
    expect(context.disconnectClientsForDevice).toHaveBeenCalledWith(nodeId, { role: "node" });
  });

  it("rejects mixed-role device-backed node removal from non-admin device-token self-service callers", async () => {
    // Mirror device.pair.remove: a device-token self-service caller (proves
    // ownership of its own device id, no operator.admin) cannot remove the node
    // role from a mixed-role row it owns.
    const state = await createState("node-remove-mixed-role-device-token");
    const nodeId = "device-token-mixed-role-android-node-1";
    await pairMixedRoleAndroidDevice(state.stateDir, nodeId);

    const { context, opts } = createOptions(
      { nodeId },
      { client: createClient(["operator.pairing"], nodeId, { isDeviceTokenAuth: true }) },
    );
    const captured = captureSecurityEvents();

    try {
      await expectDefined(
        nodeHandlers["node.pair.remove"],
        'nodeHandlers["node.pair.remove"] test invariant',
      )(opts);
    } finally {
      captured.stop();
    }

    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "node pairing removal denied" }),
    );
    expect(Object.hasOwn(await readPaired(state.stateDir), nodeId)).toBe(true);
    expect(context.invalidateClientsForDevice).not.toHaveBeenCalled();
    expect(context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      action: "device.role.removal_denied",
      outcome: "denied",
      severity: "medium",
      policy: {
        id: "gateway.device-pairing",
        decision: "deny",
        reason: "role-management-requires-admin",
      },
      control: { id: "node.pair.remove", family: "auth" },
      attributes: { role: "node" },
    });
  });
});
