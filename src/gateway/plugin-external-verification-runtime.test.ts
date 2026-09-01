import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../infra/plugin-approval-canonical-decisions.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { completeExternalVerificationForPlugin } from "../plugins/external-verification-approval-runtime-state.js";
import type { PluginExternalVerificationAttempt } from "../plugins/external-verification-approval-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { markPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import type { PluginExternalApprovalVerifierRegistration } from "../plugins/registry-types.js";
import {
  closeOpenClawStateDatabaseForTest,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { getOperatorApprovalDetailed } from "./operator-approval-store.js";
import { PluginExternalVerificationRuntime } from "./plugin-external-verification-runtime.js";
import { cancelUnboundRunApprovals } from "./server-methods/approval-run-cancellation.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

let runtime: PluginExternalVerificationRuntime | null = null;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    runtime?.shutdown();
    runtime = null;
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    cleanup();
  });
});

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(tempDirs.make("openclaw-external-runtime-"));
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function createHarness(
  handler: (attempt: PluginExternalVerificationAttempt) => void | Promise<void>,
  options?: {
    publishResolution?: ConstructorParameters<
      typeof PluginExternalVerificationRuntime
    >[0]["publishResolution"];
    resolveVerifier?: ConstructorParameters<
      typeof PluginExternalVerificationRuntime
    >[0]["resolveVerifier"];
  },
) {
  const databaseOptions = createDatabaseOptions();
  const runtimeEpoch = "runtime-external";
  const owner = {};
  const verifier: PluginExternalApprovalVerifierRegistration = {
    pluginId: "agentkit",
    pluginName: "AgentKit",
    owner,
    handler,
    source: "/plugins/agentkit/index.js",
  };
  const verifierRegistry = createEmptyPluginRegistry();
  verifierRegistry.externalApprovalVerifiers.push(verifier);
  let activeVerifier: PluginExternalApprovalVerifierRegistration | null = verifier;
  const manager = new ExecApprovalManager<PluginApprovalRequestPayload>({
    approvalKind: "plugin",
    persistence: { runtimeEpoch, databaseOptions },
    resolveAllowedDecisions: resolveCanonicalPluginApprovalRequestAllowedDecisions,
    onLifecycle: (event) => runtime?.onApprovalLifecycle(event),
  });
  runtime = new PluginExternalVerificationRuntime({
    manager,
    runtimeEpoch,
    databaseOptions,
    ...(options?.publishResolution ? { publishResolution: options.publishResolution } : {}),
    resolveVerifier:
      options?.resolveVerifier ??
      ((pluginId) => (pluginId === verifier.pluginId ? activeVerifier : null)),
  });
  const request: PluginApprovalRequestPayload = {
    pluginId: "agentkit",
    title: "World verification",
    description: "Verify personhood before continuing.",
    toolName: "dangerous-tool",
    toolCallId: "call-1",
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "session-1",
    runId: "run-1",
    externalResolution: {
      label: "Verify with World",
      decisions: ["allow-once", "allow-always"],
    },
  };
  const record = manager.create(request, 60_000, "plugin:runtime-approval");
  const decision = manager.register(record, 60_000);
  return {
    databaseOptions,
    decision,
    manager,
    owner,
    retireVerifier: () => {
      activeVerifier = null;
      markPluginRegistryRetired(verifierRegistry);
    },
    setVerifier: (next: PluginExternalApprovalVerifierRegistration | null) => {
      activeVerifier = next;
    },
  };
}

function readApproval(databaseOptions: OpenClawStateDatabaseOptions) {
  const lookup = getOperatorApprovalDetailed({
    id: "plugin:runtime-approval",
    databaseOptions,
  });
  return lookup.outcome === "found" ? lookup.record : null;
}

describe("PluginExternalVerificationRuntime", () => {
  it("dispatches one immutable attempt and replays the same reviewer interaction", async () => {
    const attempts: PluginExternalVerificationAttempt[] = [];
    const handler = vi.fn(async (attempt: PluginExternalVerificationAttempt) => {
      attempts.push(attempt);
      await attempt.present({ message: "Open the verifier and complete the World proof." });
    });
    const { owner, decision } = createHarness(handler);
    const firstPresent = vi.fn(async () => undefined);
    const replayPresent = vi.fn(async () => undefined);

    const first = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-always",
      interactionId: "a".repeat(64),
      present: firstPresent,
    });
    const replay = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-always",
      interactionId: "a".repeat(64),
      present: replayPresent,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(firstPresent).toHaveBeenCalledWith("Open the verifier and complete the World proof.");
    expect(replayPresent).toHaveBeenCalledWith("Open the verifier and complete the World proof.");
    expect(replay).toEqual(first);
    expect(attempts[0]).toMatchObject({
      context: {
        approvalId: "plugin:runtime-approval",
        pluginId: "agentkit",
        runId: "run-1",
        toolName: "dangerous-tool",
        toolCallId: "call-1",
        sessionId: "session-1",
        decision: "allow-always",
      },
    });
    expect(Object.isFrozen(attempts[0])).toBe(true);
    expect(Object.isFrozen(attempts[0]?.context)).toBe(true);

    const completed = await runtime!.complete(owner, "agentkit", {
      attemptId: first.id,
      outcome: "succeeded",
    });
    expect(completed).toMatchObject({
      applied: true,
      attempt: { id: first.id, outcome: "succeeded" },
      approval: { status: "allowed", decision: "allow-always" },
      grantAuthorization: { approvalId: "plugin:runtime-approval", attemptId: first.id },
    });
    await expect(
      runtime!.complete(owner, "agentkit", {
        attemptId: first.id,
        outcome: "succeeded",
      }),
    ).resolves.toEqual({ ...completed, applied: false });
    await expect(decision).resolves.toBe("allow-always");
  });

  it("pins an approval with a live ceremony through run-end cleanup and honors the scan", async () => {
    const handler = vi.fn(async (attempt: PluginExternalVerificationAttempt) => {
      await attempt.present({ message: "Scan the World challenge." });
    });
    const { owner, decision, manager } = createHarness(handler);
    // Same run, no ceremony: run-end cleanup must still cancel this one.
    const abandoned = manager.create(
      {
        pluginId: "agentkit",
        title: "World verification",
        description: "Verify personhood before continuing.",
        toolName: "dangerous-tool",
        toolCallId: "call-abandoned",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-1",
        runId: "run-1",
        externalResolution: {
          label: "Verify with World",
          decisions: ["allow-once", "allow-always"],
        },
      },
      60_000,
      "plugin:runtime-abandoned",
    );
    manager.register(abandoned, 60_000);

    const attempt = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-always",
      interactionId: "d".repeat(64),
      present: async () => undefined,
    });

    const cancelled = cancelUnboundRunApprovals({
      runId: "run-1",
      manager,
      spare: (pending) => runtime!.hasActiveCeremonyForApproval(pending.id),
      publish: () => undefined,
    });
    expect(cancelled).toBe(1);
    expect(manager.listPendingRecords().map((record) => record.id)).toEqual([
      "plugin:runtime-approval",
    ]);

    // The reviewer's scan still lands: trust is honored, the grant mints.
    const completed = await runtime!.complete(owner, "agentkit", {
      attemptId: attempt.id,
      outcome: "succeeded",
    });
    expect(completed).toMatchObject({
      applied: true,
      approval: { status: "allowed", decision: "allow-always" },
    });
    await expect(decision).resolves.toBe("allow-always");
  });

  it("covers matching pending approvals when an allow-always ceremony mints the grant", async () => {
    const handler = vi.fn(async (attempt: PluginExternalVerificationAttempt) => {
      await attempt.present({ message: "Scan the World challenge." });
    });
    const { owner, decision, manager } = createHarness(handler);
    const baseRequest: PluginApprovalRequestPayload = {
      pluginId: "agentkit",
      title: "World verification",
      description: "Verify personhood before continuing.",
      toolName: "dangerous-tool",
      toolCallId: "call-2",
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      runId: "run-1",
      externalResolution: {
        label: "Verify with World",
        decisions: ["allow-once", "allow-always"],
      },
    };
    // Same tool + session lifecycle: the grant's own predicate covers this one.
    const covered = manager.create(baseRequest, 60_000, "plugin:runtime-covered");
    const coveredDecision = manager.register(covered, 60_000);
    // Different session lifecycle: must keep its own ceremony.
    const foreign = manager.create(
      { ...baseRequest, toolCallId: "call-3", sessionId: "session-2" },
      60_000,
      "plugin:runtime-foreign",
    );
    manager.register(foreign, 60_000);

    const attempt = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-always",
      interactionId: "b".repeat(64),
      present: async () => undefined,
    });
    await runtime!.complete(owner, "agentkit", {
      attemptId: attempt.id,
      outcome: "succeeded",
    });

    await expect(decision).resolves.toBe("allow-always");
    await expect(coveredDecision).resolves.toBe("allow-once");
    expect(manager.listPendingRecords().map((record) => record.id)).toEqual([
      "plugin:runtime-foreign",
    ]);
  });

  it("expires through the manager before replaying a delayed reviewer interaction", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let attempt: PluginExternalVerificationAttempt | undefined;
    const { databaseOptions, decision } = createHarness(async (value) => {
      attempt = value;
      await value.present({ message: "Verify now." });
    });
    const firstPresent = vi.fn(async () => undefined);
    await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      present: firstPresent,
    });
    now.mockReturnValue(61_000);
    const replayPresent = vi.fn(async () => undefined);

    await expect(
      runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        present: replayPresent,
      }),
    ).resolves.toMatchObject({
      outcome: "timed-out",
      terminalSource: "timeout",
    });

    expect(firstPresent).toHaveBeenCalledOnce();
    expect(replayPresent).not.toHaveBeenCalled();
    expect(attempt?.signal.aborted).toBe(true);
    expect(readApproval(databaseOptions)).toMatchObject({
      status: "expired",
      terminalReason: "timeout",
    });
    await expect(decision).resolves.toBeNull();
  });

  it("expires through the manager when a verifier completes after the deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let attempt: PluginExternalVerificationAttempt | undefined;
    const { databaseOptions, owner, decision } = createHarness(async (value) => {
      attempt = value;
      await value.present({ message: "Verify now." });
    });
    const started = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-always",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });
    now.mockReturnValue(61_000);

    await expect(
      runtime!.complete(owner, "agentkit", {
        attemptId: started.id,
        outcome: "succeeded",
      }),
    ).resolves.toMatchObject({
      applied: false,
      approval: { status: "expired" },
      attempt: { outcome: "timed-out", terminalSource: "timeout" },
    });
    expect(attempt?.signal.aborted).toBe(true);
    expect(readApproval(databaseOptions)).toMatchObject({
      status: "expired",
      terminalReason: "timeout",
    });
    await expect(decision).resolves.toBeNull();
  });

  it("issues stable native action generations and rejects stale retry replacement", async () => {
    const handler = vi.fn(async (attempt: PluginExternalVerificationAttempt) => {
      await attempt.present({ message: `Verify attempt ${attempt.id}.` });
    });
    createHarness(handler);

    const firstAction = runtime!.prepareNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
    });
    expect(
      runtime!.prepareNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
      }),
    ).toEqual(firstAction);
    expect(firstAction.intent).toBe("start");

    const first = await runtime!.dispatchNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      token: firstAction.token,
    });
    const replay = await runtime!.dispatchNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      token: firstAction.token,
    });
    expect(replay).toEqual({ ...first, outcome: "replay" });
    expect(handler).toHaveBeenCalledTimes(1);

    await expect(
      runtime!.dispatchNativeAction({
        approvalId: "plugin:other",
        decision: "allow-once",
        token: firstAction.token,
      }),
    ).rejects.toThrow("external verification action is invalid");
    await expect(
      runtime!.dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-always",
        token: firstAction.token,
      }),
    ).rejects.toThrow("external verification action is invalid");

    const retryAction = runtime!.prepareNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
    });
    expect(retryAction.intent).toBe("retry");
    expect(retryAction.token).not.toBe(firstAction.token);

    const newer = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      interactionId: "f".repeat(64),
      present: async () => undefined,
    });
    await expect(
      runtime!.dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        token: firstAction.token,
      }),
    ).resolves.toMatchObject({
      outcome: "stale-action",
      attempt: { id: newer.id },
      presentations: [`Verify attempt ${newer.id}.`],
    });
    const staleRetry = await runtime!.dispatchNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      token: retryAction.token,
    });
    expect(staleRetry).toMatchObject({
      outcome: "stale-action",
      attempt: { id: newer.id },
      presentations: [`Verify attempt ${newer.id}.`],
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("binds native action tokens and presentation replay to one reviewer device", async () => {
    const handler = vi.fn(async (attempt: PluginExternalVerificationAttempt) => {
      await attempt.present({ message: `Verify attempt ${attempt.id}.` });
    });
    createHarness(handler);

    const deviceAAction = runtime!.prepareNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      reviewerDeviceId: "device-a",
    });
    expect(
      runtime!.prepareNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        reviewerDeviceId: "device-a",
      }),
    ).toEqual(deviceAAction);
    const deviceBAction = runtime!.prepareNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      reviewerDeviceId: "device-b",
    });
    expect(deviceBAction.token).not.toBe(deviceAAction.token);

    await expect(
      runtime!.dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        reviewerDeviceId: "device-b",
        token: deviceAAction.token,
      }),
    ).rejects.toThrow("external verification action is invalid");

    const started = await runtime!.dispatchNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      reviewerDeviceId: "device-a",
      token: deviceAAction.token,
    });
    await expect(
      runtime!.dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        reviewerDeviceId: "device-b",
        token: deviceBAction.token,
      }),
    ).resolves.toMatchObject({
      outcome: "stale-action",
      attempt: { id: started.attempt.id },
      presentations: [],
    });
    await expect(
      runtime!.dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        reviewerDeviceId: "device-a",
        token: deviceAAction.token,
      }),
    ).resolves.toEqual({ ...started, outcome: "replay" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects a stale weaker native action after a stronger attempt starts", async () => {
    const handler = vi.fn(async (attempt: PluginExternalVerificationAttempt) => {
      await attempt.present({ message: `Verify attempt ${attempt.id}.` });
    });
    const { databaseOptions } = createHarness(handler);
    const weakerAction = runtime!.prepareNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
    });
    await runtime!.dispatchNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      token: weakerAction.token,
    });
    const stronger = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-always",
      interactionId: "f".repeat(64),
      present: async () => undefined,
    });

    await expect(
      runtime!.dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        token: weakerAction.token,
      }),
    ).rejects.toThrow("external verification action is stale; prepare a fresh action");
    expect(handler).toHaveBeenCalledTimes(2);
    expect(readApproval(databaseOptions)).toMatchObject({ status: "pending" });
    expect(stronger.context.decision).toBe("allow-always");
  });

  it("coalesces concurrent native dispatches until every presentation is ready", async () => {
    let releaseSetup = () => {};
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let signalFirstPresentation = () => {};
    const firstPresentation = new Promise<void>((resolve) => {
      signalFirstPresentation = resolve;
    });
    const handler = vi.fn(async (attempt: PluginExternalVerificationAttempt) => {
      await attempt.present({ message: "First reviewer instruction." });
      signalFirstPresentation();
      await setupGate;
      await attempt.present({ message: "Second reviewer instruction." });
    });
    createHarness(handler);
    const action = runtime!.prepareNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
    });

    const firstDispatch = runtime!.dispatchNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      token: action.token,
    });
    await firstPresentation;
    let replaySettled = false;
    const replayDispatch = runtime!
      .dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        token: action.token,
      })
      .finally(() => {
        replaySettled = true;
      });
    await Promise.resolve();
    expect(replaySettled).toBe(false);

    releaseSetup();
    const [first, replay] = await Promise.all([firstDispatch, replayDispatch]);
    expect(first).toMatchObject({
      outcome: "started",
      presentations: ["First reviewer instruction.", "Second reviewer instruction."],
    });
    expect(replay).toEqual({ ...first, outcome: "replay" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("replays a native setup failure without reporting an empty success", async () => {
    let invocation = 0;
    const handler = vi.fn(() => {
      invocation += 1;
      throw new Error(`setup failed ${invocation}`);
    });
    const { databaseOptions } = createHarness(handler);
    const action = runtime!.prepareNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
    });
    const dispatch = () =>
      runtime!.dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        token: action.token,
      });

    await expect(dispatch()).rejects.toThrow("setup failed 1");
    await expect(dispatch()).resolves.toMatchObject({
      outcome: "replay",
      presentations: [],
      attempt: {
        outcome: "failed",
        terminalSource: "verifier-error",
      },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(readApproval(databaseOptions)).toMatchObject({ status: "pending" });

    const retry = runtime!.prepareNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
    });
    expect(retry.token).not.toBe(action.token);
    await expect(
      runtime!.dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        token: retry.token,
      }),
    ).rejects.toThrow("setup failed 2");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("invalidates a prepared native action when the registered verifier instance changes", async () => {
    const handler = vi.fn(async (attempt: PluginExternalVerificationAttempt) => {
      await attempt.present({ message: "Verify this attempt." });
    });
    const { setVerifier } = createHarness(handler);
    const prepared = runtime!.prepareNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
    });
    setVerifier({
      pluginId: "agentkit",
      pluginName: "Replacement AgentKit",
      owner: {},
      handler,
      source: "/plugins/agentkit/replacement.js",
    });

    await expect(
      runtime!.dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        token: prepared.token,
      }),
    ).rejects.toThrow("external verification action is invalid");
    expect(handler).not.toHaveBeenCalled();
    expect(
      runtime!.prepareNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
      }).token,
    ).not.toBe(prepared.token);
  });

  it("keeps the approval pending when the verifier fails before presenting instructions", async () => {
    const { databaseOptions } = createHarness(() => undefined);

    await expect(
      runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        present: async () => undefined,
      }),
    ).rejects.toThrow("returned without presenting reviewer instructions");
    expect(readApproval(databaseOptions)).toMatchObject({ status: "pending" });
  });

  it("returns a durable setup failure without replaying its closed presentation", async () => {
    const handler = vi.fn(async (attempt: PluginExternalVerificationAttempt) => {
      await attempt.present({ message: "Verify this request." });
      throw new Error("setup failed");
    });
    createHarness(handler);

    await expect(
      runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        present: async () => undefined,
      }),
    ).rejects.toThrow("external verifier failed: setup failed");
    const replayPresent = vi.fn(async () => undefined);
    await expect(
      runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        present: replayPresent,
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      terminalSource: "verifier-error",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(replayPresent).not.toHaveBeenCalled();
  });

  it("durably fails an attempt when verifier lookup throws", async () => {
    createHarness(() => undefined, {
      resolveVerifier: () => {
        const error = new Error("registry unavailable");
        Object.defineProperty(error, "name", { value: 42 });
        throw error;
      },
    });

    await expect(
      runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        present: async () => undefined,
      }),
    ).rejects.toThrow("external verifier lookup failed: registry unavailable");
    await expect(
      runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        present: async () => undefined,
      }),
    ).resolves.toMatchObject({
      errorClass: "unknown-error",
      outcome: "failed",
      terminalSource: "verifier-error",
    });
  });

  it("does not count reviewer instructions when delivery fails and the verifier swallows it", async () => {
    const { databaseOptions } = createHarness(async (attempt) => {
      try {
        await attempt.present({ message: "Verify now." });
      } catch {}
    });

    await expect(
      runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        present: async () => {
          throw new Error("delivery failed");
        },
      }),
    ).rejects.toThrow("returned without presenting reviewer instructions");
    expect(readApproval(databaseOptions)).toMatchObject({ status: "pending" });
  });

  it("bounds concurrent reviewer presentations to the native response contract", async () => {
    const { databaseOptions } = createHarness(async (attempt) => {
      await Promise.all(
        Array.from({ length: 9 }, (_, index) =>
          attempt.present({ message: `Reviewer message ${index + 1}.` }),
        ),
      );
    });

    await expect(
      runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        present: async () => undefined,
      }),
    ).rejects.toThrow("may present at most 8 reviewer messages");
    expect(readApproval(databaseOptions)).toMatchObject({ status: "pending" });
  });

  it("rejects completion from a stale plugin instance", async () => {
    const { owner, databaseOptions } = createHarness(async (attempt) => {
      await attempt.present({ message: "Verify now." });
    });
    const started = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-always",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });

    await expect(
      runtime!.complete({}, "agentkit", {
        attemptId: started.id,
        outcome: "succeeded",
      }),
    ).rejects.toThrow("not found for this plugin instance");
    expect(readApproval(databaseOptions)).toMatchObject({ status: "pending" });

    await expect(
      runtime!.complete(owner, "agentkit", {
        attemptId: started.id,
        outcome: "failed",
      }),
    ).resolves.toMatchObject({ applied: false, attempt: { outcome: "failed" } });
  });

  it("revokes presentation and aborts the attempt when its verifier registry retires", async () => {
    let attempt: PluginExternalVerificationAttempt | undefined;
    const { retireVerifier } = createHarness(async (value) => {
      attempt = value;
      await value.present({ message: "Verify now." });
    });
    const started = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });

    retireVerifier();

    expect(attempt?.signal.aborted).toBe(true);
    await expect(attempt?.present({ message: "stale verifier output" })).rejects.toThrow(
      "verifier-retired",
    );
    await expect(
      runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        present: async () => undefined,
      }),
    ).resolves.toMatchObject({
      id: started.id,
      outcome: "cancelled",
      terminalSource: "verifier-retired",
    });
  });

  it("revokes the prior attempt before a retry reports a missing verifier", async () => {
    let attempt: PluginExternalVerificationAttempt | undefined;
    const { setVerifier } = createHarness(async (value) => {
      attempt = value;
      await value.present({ message: "Verify now." });
    });
    await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });
    setVerifier(null);

    await expect(
      runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "b".repeat(64),
        present: async () => undefined,
      }),
    ).rejects.toThrow("has no active external verifier");
    expect(attempt?.signal.aborted).toBe(true);
    await expect(attempt?.present({ message: "stale retry output" })).rejects.toThrow(
      "reviewer-retry",
    );
  });

  it("rejects completion before the verifier presents reviewer instructions", async () => {
    let earlyCompletion: Promise<unknown> | undefined;
    const harness = createHarness(async (attempt) => {
      earlyCompletion = runtime!.complete(owner, "agentkit", {
        attemptId: attempt.id,
        outcome: "succeeded",
      });
      await expect(earlyCompletion).rejects.toThrow("before reviewer presentation finishes");
      await attempt.present({ message: "Verify now." });
    });
    const owner = harness.owner;

    const started = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });

    await expect(earlyCompletion).rejects.toThrow("before reviewer presentation finishes");
    expect(readApproval(harness.databaseOptions)).toMatchObject({ status: "pending" });
    await expect(
      runtime!.complete(owner, "agentkit", {
        attemptId: started.id,
        outcome: "succeeded",
      }),
    ).resolves.toMatchObject({ applied: true });
  });

  it("accepts an immediately resolved verifier after presentation", async () => {
    let completion: Promise<unknown> | undefined;
    const harness = createHarness(async (attempt) => {
      await attempt.present({ message: "Verify now." });
      completion = runtime!.complete(owner, "agentkit", {
        attemptId: attempt.id,
        outcome: "succeeded",
      });
      await expect(completion).resolves.toMatchObject({ applied: true });
    });
    const owner = harness.owner;

    const started = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });

    await expect(completion).resolves.toMatchObject({ applied: true });
    expect(started).toMatchObject({ outcome: "succeeded", terminalSource: "plugin-completion" });
    expect(readApproval(harness.databaseOptions)).toMatchObject({
      status: "allowed",
      decision: "allow-once",
    });
  });

  it("cancels the canonical approval and aborts the handler on graceful shutdown", async () => {
    let signal: AbortSignal | undefined;
    let owner: object;
    let abortCompletion: ReturnType<typeof completeExternalVerificationForPlugin> | undefined;
    const harness = createHarness(async (attempt) => {
      signal = attempt.signal;
      attempt.signal.addEventListener(
        "abort",
        () => {
          abortCompletion = completeExternalVerificationForPlugin(owner, "agentkit", {
            attemptId: attempt.id,
            outcome: "succeeded",
          });
        },
        { once: true },
      );
      await attempt.present({ message: "Verify now." });
    });
    owner = harness.owner;
    await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });

    runtime!.shutdown();
    runtime = null;

    expect(signal?.aborted).toBe(true);
    expect(readApproval(harness.databaseOptions)).toMatchObject({
      status: "cancelled",
      terminalReason: "gateway-restart",
    });
    await expect(abortCompletion).resolves.toMatchObject({
      applied: false,
      approval: { status: "cancelled" },
      attempt: { outcome: "cancelled" },
    });
    await expect(harness.decision).resolves.toBeNull();
  });

  it("aborts retry and run-cancelled attempts and permanently closes presentation", async () => {
    const attempts: PluginExternalVerificationAttempt[] = [];
    const { manager, owner, decision } = createHarness(async (attempt) => {
      attempts.push(attempt);
      await attempt.present({ message: "Verify now." });
    });
    const first = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });
    const second = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-always",
      interactionId: "b".repeat(64),
      present: async () => undefined,
    });

    expect(attempts[0]?.signal.aborted).toBe(true);
    await expect(attempts[0]?.present({ message: "stale retry output" })).rejects.toThrow(
      "reviewer-retry",
    );
    expect(
      manager.forceDenyDetailed(
        "plugin:runtime-approval",
        "run-aborted",
        { kind: "system", id: null },
        "cancelled",
      ),
    ).toMatchObject({ outcome: "denied", record: { status: "cancelled" } });
    expect(attempts[1]?.signal.aborted).toBe(true);
    await expect(attempts[1]?.present({ message: "stale cancelled output" })).rejects.toThrow(
      "run-aborted",
    );
    await expect(
      runtime!.complete(owner, "agentkit", {
        attemptId: second.id,
        outcome: "succeeded",
      }),
    ).resolves.toMatchObject({
      applied: false,
      attempt: { outcome: "cancelled", terminalSource: "run-aborted" },
    });
    await expect(decision).resolves.toBeNull();
  });

  it.each([
    {
      name: "normal denial",
      decision: "deny",
      terminalSource: "user",
      terminate: (manager: ExecApprovalManager<PluginApprovalRequestPayload>) =>
        manager.resolveDetailed(
          "plugin:runtime-approval",
          "deny",
          { kind: "channel", id: "telegram:owner" },
          "telegram:owner",
        ),
    },
    {
      name: "expiry",
      decision: null,
      terminalSource: "timeout",
      terminate: (manager: ExecApprovalManager<PluginApprovalRequestPayload>) =>
        manager.expire("plugin:runtime-approval"),
    },
  ])(
    "aborts and closes presentation after $name",
    async ({ decision: expectedDecision, terminalSource, terminate }) => {
      let attempt: PluginExternalVerificationAttempt | undefined;
      const { manager, decision } = createHarness(async (value) => {
        attempt = value;
        await value.present({ message: "Verify now." });
      });
      await runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        present: async () => undefined,
      });

      terminate(manager);

      expect(attempt?.signal.aborted).toBe(true);
      await expect(attempt?.present({ message: "stale terminal output" })).rejects.toThrow(
        terminalSource,
      );
      await expect(decision).resolves.toBe(expectedDecision);
    },
  );

  it("keeps a winning grant when completion commits before a later run cancellation", async () => {
    const { manager, owner, decision } = createHarness(async (attempt) => {
      await attempt.present({ message: "Verify now." });
    });
    const started = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-always",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });
    const completed = await runtime!.complete(owner, "agentkit", {
      attemptId: started.id,
      outcome: "succeeded",
    });

    expect(completed).toMatchObject({
      applied: true,
      approval: { status: "allowed", decision: "allow-always" },
      grantAuthorization: { attemptId: started.id, decision: "allow-always" },
    });
    expect(
      manager.forceDenyDetailed(
        "plugin:runtime-approval",
        "run-aborted",
        { kind: "system", id: null },
        "cancelled",
      ),
    ).toMatchObject({ outcome: "already-terminal", record: { status: "allowed" } });
    await expect(
      runtime!.complete(owner, "agentkit", {
        attemptId: started.id,
        outcome: "succeeded",
      }),
    ).resolves.toEqual({ ...completed, applied: false });
    await expect(decision).resolves.toBe("allow-always");
  });

  it("returns durable grant authorization when post-commit publication fails", async () => {
    const publishResolution = vi.fn(async () => {
      throw new Error("push unavailable");
    });
    const { owner, decision, databaseOptions } = createHarness(
      async (attempt) => {
        await attempt.present({ message: "Verify now." });
      },
      { publishResolution },
    );
    const logError = vi.fn();
    runtime!.attachContext({
      getRuntimeConfig: () => ({}),
      logGateway: { error: logError },
    } as unknown as GatewayRequestContext);
    const started = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-always",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });

    await expect(
      runtime!.complete(owner, "agentkit", {
        attemptId: started.id,
        outcome: "succeeded",
      }),
    ).resolves.toMatchObject({
      applied: true,
      approval: { status: "allowed", decision: "allow-always" },
      grantAuthorization: { attemptId: started.id, decision: "allow-always" },
    });
    expect(publishResolution).toHaveBeenCalledTimes(1);
    expect(publishResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        liveRecord: expect.objectContaining({ resolvedBy: "plugin:agentkit" }),
      }),
    );
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("publication failed after durable completion: push unavailable"),
    );
    expect(readApproval(databaseOptions)).toMatchObject({
      status: "allowed",
      decision: "allow-always",
    });
    await expect(decision).resolves.toBe("allow-always");
  });

  it("cancels only run A when concurrent approvals share one session", async () => {
    const attemptsByRun = new Map<string, PluginExternalVerificationAttempt>();
    const { manager, owner, decision } = createHarness(async (attempt) => {
      attemptsByRun.set(attempt.context.runId, attempt);
      await attempt.present({ message: `Verify ${attempt.context.runId}.` });
    });
    const secondRequest: PluginApprovalRequestPayload = {
      pluginId: "agentkit",
      title: "Second World verification",
      description: "Verify personhood before continuing.",
      toolName: "dangerous-tool",
      toolCallId: "call-2",
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      runId: "run-2",
      externalResolution: {
        label: "Verify with World",
        decisions: ["allow-once"],
      },
    };
    const secondRecord = manager.create(secondRequest, 60_000, "plugin:runtime-approval-2");
    const secondDecision = manager.register(secondRecord, 60_000);
    const first = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });
    const second = await runtime!.start({
      approvalId: "plugin:runtime-approval-2",
      decision: "allow-once",
      interactionId: "b".repeat(64),
      present: async () => undefined,
    });

    expect(
      manager.forceDenyDetailed(
        "plugin:runtime-approval",
        "run-aborted",
        { kind: "system", id: null },
        "cancelled",
      ),
    ).toMatchObject({ outcome: "denied" });
    expect(attemptsByRun.get("run-1")?.signal.aborted).toBe(true);
    expect(attemptsByRun.get("run-2")?.signal.aborted).toBe(false);
    await expect(
      runtime!.complete(owner, "agentkit", {
        attemptId: second.id,
        outcome: "succeeded",
      }),
    ).resolves.toMatchObject({ applied: true, approval: { status: "allowed" } });
    await expect(
      runtime!.complete(owner, "agentkit", {
        attemptId: first.id,
        outcome: "succeeded",
      }),
    ).resolves.toMatchObject({ applied: false, attempt: { outcome: "cancelled" } });
    await expect(decision).resolves.toBeNull();
    await expect(secondDecision).resolves.toBe("allow-once");
  });
});
