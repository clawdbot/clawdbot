// Replay, restart-adoption, and serialization coverage for worker provider provisioning.
// Split from provider-provisioning.test.ts to stay under the max-lines cap.
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { WorkerProviderError } from "../../plugins/types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import * as support from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;

describe("worker environment service provision replay", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("adopts one committed provision across a service and store restart", async () => {
    const physicalLeases = new Set<string>();
    const operationIds: string[] = [];
    const machineClasses: Array<string | undefined> = [];
    const destroyed: string[] = [];
    let creates = 0;
    let loseFirstReply = true;
    const provider = () =>
      support.createProvider({
        provision: async (_profile, operationId, options) => {
          operationIds.push(operationId);
          machineClasses.push(options?.machineClass);
          if (!physicalLeases.has("lease-restarted")) {
            creates += 1;
            physicalLeases.add("lease-restarted");
          }
          if (loseFirstReply) {
            loseFirstReply = false;
            throw new Error("provider response was lost after commit");
          }
          return { leaseId: "lease-restarted", ssh: support.SSH_ENDPOINT };
        },
        destroy: async ({ leaseId }) => {
          destroyed.push(leaseId);
          physicalLeases.delete(leaseId);
        },
      });
    const first = support.createService(provider());

    await expect(
      first.create("development", "request-restart-replay", "large"),
    ).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    const environmentId = expectDefined(
      support.testState.store.list()[0],
      "persisted provision intent",
    ).environmentId;
    const operationId = expectDefined(
      support.testState.store.get(environmentId),
      "persisted provision record",
    ).provisionOperationId;
    expect(operationId).toMatch(/^provision:v2:[a-f0-9]{64}$/u);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "provisioning",
      leaseId: null,
    });

    await first.stop();
    support.testState.service = undefined;
    closeOpenClawStateDatabaseForTest();
    support.testState.stateDb = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: support.testState.root },
    });
    support.testState.store = createWorkerEnvironmentStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });

    const restarted = support.createService(provider());
    restarted.start();
    await support.waitForFast(() =>
      expect(support.testState.store.get(environmentId)).toMatchObject({
        state: "ready",
        leaseId: "lease-restarted",
        lastError: null,
      }),
    );
    await restarted.destroy(environmentId);

    expect(creates).toBe(1);
    expect(operationIds).toEqual([operationId, operationId]);
    expect(machineClasses).toEqual(["large", "large"]);
    expect(destroyed).toEqual(["lease-restarted"]);
    expect(physicalLeases.size).toBe(0);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "destroyed",
      leaseId: "lease-restarted",
    });
  });

  it("records a permanent legacy provision replay failure without allocating", async () => {
    const legacyOperationId = `provision:${"0".repeat(64)}`;
    const intent = support.testState.store.createIntent({
      environmentId: "worker-legacy-provision",
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: legacyOperationId,
    });
    support.testState.store.transition({
      environmentId: intent.environmentId,
      from: intent.state,
      to: "provisioning",
    });
    const allocate = vi.fn(async () => ({ leaseId: "must-not-exist", ssh: support.SSH_ENDPOINT }));
    const provider = support.createProvider({
      provision: async (_profile, operationId) => {
        if (operationId === legacyOperationId) {
          throw new WorkerProviderError("Legacy Crabbox provision state cannot be replayed safely");
        }
        return await allocate();
      },
    });

    await support.createService(provider).reconcileOnce();

    expect(allocate).not.toHaveBeenCalled();
    expect(support.testState.store.get(intent.environmentId)).toMatchObject({
      state: "failed",
      leaseId: null,
      lastError: "Legacy Crabbox provision state cannot be replayed safely",
    });
  });

  it("does not resolve a provider provision timeout when the service override is set", async () => {
    const resolveProvisionTimeoutMs = vi.fn(() => {
      throw new Error("provider timeout hook must not run");
    });
    const workerService = support.createService(
      support.createProvider({ resolveProvisionTimeoutMs }),
      {
        providerCallTimeoutMs: 1_000,
      },
    );

    await expect(
      workerService.create("development", "request-provider-timeout-override"),
    ).resolves.toMatchObject({ state: "ready" });
    expect(resolveProvisionTimeoutMs).not.toHaveBeenCalled();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["non-finite", Number.NaN],
    ["timer overflow", MAX_TIMER_TIMEOUT_MS + 1],
  ])("rejects a %s provider provision timeout before allocation", async (_label, timeoutMs) => {
    const provision = vi.fn(async () => ({
      leaseId: "lease-invalid-timeout",
      ssh: support.SSH_ENDPOINT,
    }));
    const workerService = support.createService(
      support.createProvider({
        provision,
        resolveProvisionTimeoutMs: () => timeoutMs,
      }),
    );

    await expect(
      workerService.create("development", `request-invalid-provider-timeout-${String(timeoutMs)}`),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining("Worker provider provision timeout must be an integer"),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(provision).not.toHaveBeenCalled();
  });

  it("serializes destroy and provision replay behind a timed-out provider operation", async () => {
    const events: string[] = [];
    const operationIds: string[] = [];
    let active = 0;
    let maxActive = 0;
    let originalProvisionCalls = 0;
    let finishFirstProvision: (() => void) | undefined;
    const firstProvisionPending = new Promise<void>((resolve) => {
      finishFirstProvision = resolve;
    });
    const destroy = vi.fn(async () => {
      events.push("destroy:start");
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      events.push("destroy:end");
    });
    const provider = support.createProvider({
      provision: async (_profile, operationId) => {
        originalProvisionCalls += 1;
        const call = originalProvisionCalls;
        operationIds.push(operationId);
        events.push(`provision:${call}:start`);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (call === 1) {
          await firstProvisionPending;
        }
        active -= 1;
        events.push(`provision:${call}:end`);
        return { leaseId: "lease-timeout-replay", ssh: support.SSH_ENDPOINT };
      },
      destroy,
      resolveProvisionTimeoutMs: () => 20,
    });
    const workerService = support.createService(provider);
    const creation = workerService.create("development", "request-provider-timeout-race");
    const creationResult = expect(creation).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    let environmentId: string | undefined;
    let teardownResult: Promise<void> | undefined;
    try {
      await support.waitForFast(() => expect(events).toEqual(["provision:1:start"]));
      const queuedEnvironmentId = expectDefined(
        support.testState.store.list()[0],
        "timed-out provision row",
      ).environmentId;
      environmentId = queuedEnvironmentId;
      const teardown = workerService.destroy(queuedEnvironmentId);
      teardownResult = expect(teardown).resolves.toMatchObject({ state: "destroyed" });
      await creationResult;
      await support.waitForFast(() =>
        expect(
          support.testState.store.get(queuedEnvironmentId)?.destroyRequestedAtMs,
        ).not.toBeNull(),
      );
      expect(originalProvisionCalls).toBe(1);
      expect(destroy).not.toHaveBeenCalled();
      expect(maxActive).toBe(1);
    } finally {
      finishFirstProvision?.();
    }

    await teardownResult;
    const finalEnvironmentId = expectDefined(environmentId, "timed-out provision environment id");
    expect(operationIds).toHaveLength(2);
    expect(new Set(operationIds).size).toBe(1);
    expect(maxActive).toBe(1);
    expect(events).toEqual([
      "provision:1:start",
      "provision:1:end",
      "provision:2:start",
      "provision:2:end",
      "destroy:start",
      "destroy:end",
    ]);
    expect(support.testState.store.get(finalEnvironmentId)).toMatchObject({ state: "destroyed" });
  });

  it("adopts an indeterminate allocation before a replay preparation failure", async () => {
    const events: string[] = [];
    let preparationFails = false;
    support.testState.prepareInstallation = vi.fn(async () => {
      events.push("prepare");
      if (preparationFails) {
        throw new Error("persisted bundle is unavailable");
      }
      return support.BUNDLE_ARTIFACT;
    });
    let provisionCalls = 0;
    const operationIds: string[] = [];
    const provider = support.createProvider({
      provision: async (_profile, operationId) => {
        events.push("provision");
        provisionCalls += 1;
        operationIds.push(operationId);
        if (provisionCalls === 1) {
          throw new Error("provision response was lost");
        }
        return { leaseId: "lease-replayed", ssh: support.SSH_ENDPOINT };
      },
      destroy: async () => void events.push("destroy"),
    });
    const workerService = support.createService(provider);

    await expect(
      workerService.create("development", "request-lost-provision"),
    ).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    preparationFails = true;
    await workerService.reconcileOnce();

    expect(events).toEqual(["prepare", "provision", "provision", "prepare", "destroy"]);
    expect(new Set(operationIds).size).toBe(1);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      teardownTerminalState: "failed",
      lastError: "persisted bundle is unavailable",
    });
  });

  it.each([
    ["missing result", null, "invalid provision result"],
    ["missing transport", { leaseId: "lease-invalid" }, "invalid provision result"],
    [
      "ambiguous transport",
      { leaseId: "lease-invalid", ssh: support.SSH_ENDPOINT, node: { deviceId: "device-1" } },
      "invalid provision result",
    ],
    [
      "blank node device id",
      { leaseId: "lease-invalid", node: { deviceId: " " } },
      "invalid node device id",
    ],
    [
      "malformed SSH endpoint",
      { leaseId: "lease-invalid", ssh: { ...support.SSH_ENDPOINT, keyRef: "not-a-secret-ref" } },
      "SSH key must be a canonical SecretRef",
    ],
    [
      "excessive SSH fallback ports",
      {
        leaseId: "lease-invalid",
        ssh: {
          ...support.SSH_ENDPOINT,
          fallbackPorts: Array.from({ length: 11 }, (_, index) => 2300 + index),
        },
      },
      "SSH fallback ports cannot exceed 10",
    ],
    [
      "invalid shared-host declaration",
      { leaseId: "lease-invalid", ssh: support.SSH_ENDPOINT, sharedHost: "yes" },
      "invalid provision result",
    ],
    [
      "unsupported desktop protocol",
      {
        leaseId: "lease-invalid",
        ssh: support.SSH_ENDPOINT,
        desktop: { protocol: "rdp", port: 5900 },
      },
      'desktop protocol must be "rfb"',
    ],
    [
      "invalid desktop port",
      {
        leaseId: "lease-invalid",
        ssh: support.SSH_ENDPOINT,
        desktop: { protocol: "rfb", port: 0 },
      },
      "desktop port must be an integer",
    ],
    [
      "relative desktop password path",
      {
        leaseId: "lease-invalid",
        ssh: support.SSH_ENDPOINT,
        desktop: { protocol: "rfb", port: 5900, passwordFilePath: "vnc.password" },
      },
      "desktop password file path must be absolute",
    ],
    [
      "unrecognized desktop app metadata",
      {
        leaseId: "lease-invalid",
        ssh: support.SSH_ENDPOINT,
        desktop: {
          protocol: "rfb",
          port: 5900,
          apps: [
            {
              id: "browser",
              executablePath: "/usr/local/bin/openclaw-worker-browser",
              cdpPort: 9222,
              command: "chromium",
            },
          ],
        },
      },
      "browser desktop app contains unknown fields",
    ],
  ])("keeps %s from a provider retryable", async (_name, result, error) => {
    const workerService = support.createService(
      support.createProvider({ provision: async () => result as never }),
    );

    await expect(workerService.create("development", "request-malformed")).rejects.toMatchObject({
      code: "provider_failure",
      message: expect.stringContaining(error),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "provisioning",
      lastError: expect.stringContaining(error),
    });
  });
});
