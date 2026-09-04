import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  WorkerProviderError,
  type WorkerExecutionMode,
  type WorkerLease,
  type WorkerProfile,
} from "../../plugins/types.js";
import { hashWorkerCredential } from "./credential.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import * as support from "./service.test-support.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("persists intent and an immutable profile snapshot before provisioning", async () => {
    const operationIds: string[] = [];
    const provider = support.createProvider({
      provision: async (profile, operationId, options) => {
        operationIds.push(operationId);
        expect(support.testState.store.list()[0]).toMatchObject({
          state: "provisioning",
          provisionOperationId: operationId,
          profileSnapshot: {
            install: "bundle",
            machineClass: "beast",
            settings: { region: "test" },
          },
        });
        support.getDevelopmentProfile().settings = { region: "mutated" };
        expect(profile).toEqual({ region: "test" });
        expect(options).toEqual({ machineClass: "beast" });
        return { leaseId: "lease-1", ssh: support.SSH_ENDPOINT };
      },
    });

    const workerService = support.createService(provider);
    const result = await workerService.create("development", "request-1", "beast");
    const repeated = await workerService.create("development", "request-1", "beast");

    expect(result).toMatchObject({ state: "ready", leaseId: "lease-1", ownerEpoch: 1 });
    expect(repeated.environmentId).toBe(result.environmentId);
    expect(operationIds).toHaveLength(1);
    expect(operationIds[0]).toMatch(/^provision:v2:[a-f0-9]{64}$/u);
    expect(result.profileSnapshot).toMatchObject({ settings: { region: "test" } });
    expect(support.testState.store.getCredential(result.environmentId)).toMatchObject({
      credentialHash: hashWorkerCredential(support.CREDENTIAL),
      ownerEpoch: 1,
      sessionId: null,
    });
    const persistedCredential = support.testState.stateDb.db
      .prepare("SELECT * FROM worker_environment_credentials WHERE environment_id = ?")
      .get(result.environmentId);
    expect(persistedCredential).toMatchObject({
      credential_hash: hashWorkerCredential(support.CREDENTIAL),
    });
    expect(JSON.stringify(persistedCredential)).not.toContain(support.CREDENTIAL);
    const binding = { environmentId: result.environmentId, ownerEpoch: 1, sessionId: null };
    const grant = workerService.takeMintedCredential(binding);
    expect(grant).toMatchObject({
      credential: support.CREDENTIAL,
      ownerEpoch: 1,
      sessionId: null,
    });
    expect(workerService.acknowledgeCredentialDelivery(grant!)).toBe(true);
    expect(support.testState.store.getCredential(result.environmentId)).toMatchObject({
      deliveredAtMs: support.testState.nowMs,
    });
    expect(workerService.takeMintedCredential(binding)).toBeUndefined();
    await expect(workerService.create("development", "request-1", "fast")).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("requires explicit placement modes before provider allocation", async () => {
    const provision = vi.fn(support.createProvider().provision);
    const provider = support.createProvider({ supportedExecutionModes: undefined, provision });
    const workerService = support.createService(provider);

    await expect(
      workerService.create("development", "mode-configured", undefined, "remote-exec"),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    await expect(
      workerService.createFromProfileSnapshot(
        {
          profileId: "development",
          providerId: provider.id,
          profileSnapshot: { install: "bundle", settings: { region: "test" } },
        },
        "mode-inherited",
        undefined,
        "worker-turn",
      ),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([]);

    await expect(workerService.create("development", "lifecycle-only")).resolves.toMatchObject({
      state: "ready",
    });
    expect(provision).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledWith(
      { region: "test" },
      expect.stringMatching(/^provision:v2:[a-f0-9]{64}$/u),
      undefined,
    );
  });

  it("P1: direct creation preserves the default setup of an advertised node provider", async () => {
    const provision = vi.fn(async () => ({
      leaseId: "lease-direct-default-node",
      node: { deviceId: "device-direct-default-node" },
    }));
    const workerService = support.createService(
      support.createProvider({
        supportedExecutionModes: ["worker-turn", "remote-exec"],
        provision,
      }),
      { ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT) },
    );

    const environment = await workerService.create("development", "request-direct-default-node");

    expect(environment).toMatchObject({
      state: "ready",
      nodeDeviceId: "device-direct-default-node",
    });
    expect(environment.profileSnapshot).not.toHaveProperty("executionMode");
    expect(provision).toHaveBeenCalledWith(
      { region: "test" },
      expect.stringMatching(/^provision:v2:[a-f0-9]{64}$/u),
      undefined,
    );
  });

  it.each<{
    mode: WorkerExecutionMode;
    lease: WorkerLease;
    transport: "node" | "SSH";
    inherited?: true;
  }>([
    {
      mode: "worker-turn",
      lease: { leaseId: "lease-worker-turn-node", node: { deviceId: "worker-turn-device" } },
      transport: "node",
    },
    {
      mode: "remote-exec",
      lease: { leaseId: "lease-remote-exec-node", node: { deviceId: "remote-exec-device" } },
      transport: "node",
    },
    {
      mode: "remote-exec",
      lease: { leaseId: "lease-remote-exec-ssh", ssh: support.SSH_ENDPOINT },
      transport: "SSH",
    },
    {
      mode: "remote-exec",
      lease: { leaseId: "lease-inherited-node", node: { deviceId: "inherited-device" } },
      transport: "node",
      inherited: true,
    },
  ])(
    "forwards $mode placement to its $transport provider transport (inherited: $inherited)",
    async ({ mode, lease, transport, inherited }) => {
      const provision = vi.fn(async () => lease);
      const provider = support.createProvider({
        supportedExecutionModes: ["worker-turn", "remote-exec"],
        provision,
      });
      const workerService = support.createService(provider, {
        ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT),
      });
      const idempotencyKey = `transport-${mode}-${transport}-${inherited ? "inherited" : "profile"}`;

      const result = inherited
        ? await workerService.createFromProfileSnapshot(
            {
              profileId: "development",
              providerId: provider.id,
              profileSnapshot: { install: "bundle", settings: { region: "test" } },
            },
            idempotencyKey,
            undefined,
            mode,
          )
        : await workerService.create("development", idempotencyKey, undefined, mode);

      expect(result).toMatchObject({
        state: "ready",
        leaseId: lease.leaseId,
        profileSnapshot: { executionMode: mode, settings: { region: "test" } },
        ...(lease.node ? { nodeDeviceId: lease.node.deviceId, sshEndpoint: null } : {}),
      });
      expect(provision).toHaveBeenCalledWith(
        { region: "test" },
        expect.stringMatching(/^provision:v2:[a-f0-9]{64}$/u),
        { executionMode: mode },
      );
      expect(support.testState.bootstrapWorker).toHaveBeenCalledTimes(transport === "SSH" ? 1 : 0);
    },
  );

  it("rejects an SSH lease for worker-turn placement even when its provider also supports remote-exec", async () => {
    const lease = { leaseId: "lease-worker-turn-ssh", ssh: support.SSH_ENDPOINT };
    const destroy = vi.fn(async () => {});
    const provider = support.createProvider({
      supportedExecutionModes: ["worker-turn", "remote-exec"],
      provision: async () => lease,
      destroy,
    });
    const workerService = support.createService(provider);

    await expect(
      workerService.create("development", "transport-worker-turn-ssh", undefined, "worker-turn"),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining("worker-turn providers must return a node lease"),
    });

    expect(destroy).toHaveBeenCalledWith({ leaseId: lease.leaseId, profile: { region: "test" } });
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([
      expect.objectContaining({
        state: "failed",
        leaseId: null,
        nodeDeviceId: null,
        sshEndpoint: null,
        lastError: "worker-turn providers must return a node lease",
      }),
    ]);
  });

  it("rejects a repeated operation id when its selected execution mode changes", async () => {
    const provision = vi.fn(async () => ({
      leaseId: "lease-stable-operation-mode",
      node: { deviceId: "device-stable-operation-mode" },
    }));
    const workerService = support.createService(
      support.createProvider({
        supportedExecutionModes: ["worker-turn", "remote-exec"],
        provision,
      }),
      { ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT) },
    );

    const original = await workerService.create(
      "development",
      "request-stable-operation-mode",
      undefined,
      "worker-turn",
    );
    await expect(
      workerService.create(
        "development",
        "request-stable-operation-mode",
        undefined,
        "worker-turn",
      ),
    ).resolves.toMatchObject({ environmentId: original.environmentId });
    await expect(
      workerService.create(
        "development",
        "request-stable-operation-mode",
        undefined,
        "remote-exec",
      ),
    ).rejects.toMatchObject({ code: "invalid_profile" });

    expect(provision).toHaveBeenCalledOnce();
    expect(support.testState.store.get(original.environmentId)).toMatchObject({
      state: "ready",
      leaseId: original.leaseId,
    });
  });

  it("delegates configured machine options to the profile provider", async () => {
    const listMachineOptions = vi.fn(async () => [
      { id: "standard", label: "Standard", cpu: 32, memoryGb: 64, default: true },
    ]);
    const workerService = support.createService(support.createProvider({ listMachineOptions }));

    await expect(workerService.listMachineOptions("development")).resolves.toEqual([
      { id: "standard", label: "Standard", cpu: 32, memoryGb: 64, default: true },
    ]);
    expect(listMachineOptions).toHaveBeenCalledWith({ region: "test" });
  });

  it.each([
    [
      "duplicate ids",
      [
        { id: "fast", label: "Fast" },
        { id: "fast", label: "Faster" },
      ],
    ],
    ["blank ids", [{ id: " ", label: "Fast" }]],
    ["malformed labels", [{ id: "fast", label: 16 }]],
    ["non-positive CPU counts", [{ id: "fast", label: "Fast", cpu: 0 }]],
    ["non-integer memory sizes", [{ id: "fast", label: "Fast", memoryGb: 63.5 }]],
    ["implausible memory sizes", [{ id: "fast", label: "Fast", memoryGb: 65_537 }]],
    [
      "multiple defaults",
      [
        { id: "standard", label: "Standard", default: true },
        { id: "fast", label: "Fast", default: true },
      ],
    ],
    [
      "over-limit catalogs",
      Array.from({ length: 33 }, (_, index) => ({ id: `machine-${index}`, label: "Machine" })),
    ],
  ])("omits %s returned by a worker provider", async (_name, options) => {
    const provider = support.createProvider();
    Object.defineProperty(provider, "listMachineOptions", { value: async () => options });
    const workerService = support.createService(provider);

    await expect(workerService.listMachineOptions("development")).resolves.toBeUndefined();
  });

  it("creates a nested environment from its parent's snapshot after config drift", async () => {
    const provisionedProfiles: WorkerProfile[] = [];
    let lease = 0;
    let credential = 0;
    const workerService = support.createService(
      support.createProvider({
        provision: async (profile) => {
          provisionedProfiles.push(structuredClone(profile));
          lease += 1;
          return { leaseId: `lease-${lease}`, ssh: support.SSH_ENDPOINT };
        },
      }),
      {
        generateWorkerCredential: () => `nested-worker-credential-${(credential += 1)}`,
      },
    );
    const parent = await workerService.create("development", "parent-profile-snapshot");
    support.getDevelopmentProfile().settings = { region: "mutated" };
    support.getDevelopmentProfile().provider = "FaKe";

    const child = await workerService.createFromProfileSnapshot(
      {
        profileId: parent.profileId,
        providerId: parent.providerId,
        profileSnapshot: parent.profileSnapshot,
      },
      "child-profile-snapshot",
    );

    expect(provisionedProfiles).toEqual([{ region: "test" }, { region: "test" }]);
    expect(child).toMatchObject({
      profileId: parent.profileId,
      providerId: parent.providerId,
      profileSnapshot: parent.profileSnapshot,
    });
  });

  it.each([
    {
      name: "removed",
      mutate: () => {
        support.testState.config.cloudWorkers = { profiles: {} };
      },
      code: "profile_not_found",
    },
    {
      name: "assigned to a different provider",
      mutate: () => {
        support.getDevelopmentProfile().provider = "replacement";
      },
      code: "invalid_profile",
    },
  ])("rejects a fresh inherited environment when its profile was $name", async (testCase) => {
    let lease = 0;
    let credential = 0;
    const provision = vi.fn(async () => ({
      leaseId: `inherited-lease-${(lease += 1)}`,
      ssh: support.SSH_ENDPOINT,
    }));
    const workerService = support.createService(support.createProvider({ provision }), {
      generateWorkerCredential: () => `inherited-worker-credential-${(credential += 1)}`,
    });
    const parent = await workerService.create("development", "parent-inherited-profile");
    const inherited = {
      profileId: parent.profileId,
      providerId: parent.providerId,
      profileSnapshot: parent.profileSnapshot,
    };
    testCase.mutate();

    await expect(
      workerService.createFromProfileSnapshot(inherited, "fresh-inherited-profile"),
    ).rejects.toMatchObject({ code: testCase.code });
    expect(provision).toHaveBeenCalledOnce();
    expect(support.testState.store.list()).toHaveLength(1);

    await expect(
      workerService.createFromProfileSnapshot(inherited, "parent-inherited-profile"),
    ).resolves.toMatchObject({ environmentId: parent.environmentId });
    expect(provision).toHaveBeenCalledOnce();
  });

  it("allows paired-device placement without configured cloud profiles", async () => {
    support.testState.config.cloudWorkers = { profiles: {} };
    const provision = vi.fn(async () => ({
      leaseId: "device-lease",
      node: { deviceId: "device-1" },
    }));
    const workerService = support.createService(
      support.createProvider({
        id: DEVICE_WORKER_PROVIDER_ID,
        supportedExecutionModes: ["worker-turn"],
        provision,
      }),
      { ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT) },
    );

    await expect(
      workerService.createFromProfileSnapshot(
        {
          profileId: "device:device-1",
          providerId: DEVICE_WORKER_PROVIDER_ID,
          profileSnapshot: { install: "bundle", settings: { device: "device-1" } },
        },
        "paired-profileless",
        undefined,
        "worker-turn",
      ),
    ).resolves.toMatchObject({ state: "ready", nodeDeviceId: "device-1" });
    expect(provision).toHaveBeenCalledOnce();
  });

  it("revokes removed configured device profiles without disabling synthetic paired devices", async () => {
    let lease = 0;
    let credential = 0;
    const profile = support.getDevelopmentProfile();
    profile.provider = DEVICE_WORKER_PROVIDER_ID;
    profile.settings = { device: "device-1" };
    const provision = vi.fn(async () => ({
      leaseId: `named-device-lease-${(lease += 1)}`,
      node: { deviceId: "device-1" },
    }));
    const workerService = support.createService(
      support.createProvider({
        id: DEVICE_WORKER_PROVIDER_ID,
        supportedExecutionModes: ["worker-turn"],
        provision,
      }),
      {
        ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT),
        generateWorkerCredential: () => `named-device-credential-${(credential += 1)}`,
      },
    );
    const parent = await workerService.create(
      "development",
      "named-device-parent",
      undefined,
      "worker-turn",
    );
    support.testState.config.cloudWorkers = { profiles: {} };

    await expect(
      workerService.createFromProfileSnapshot(
        {
          profileId: parent.profileId,
          providerId: parent.providerId,
          profileSnapshot: parent.profileSnapshot,
        },
        "named-device-child",
        undefined,
        "worker-turn",
      ),
    ).rejects.toMatchObject({ code: "profile_not_found" });
    expect(provision).toHaveBeenCalledOnce();
  });

  it("rejects plaintext secret fields before persisting intent", async () => {
    support.getDevelopmentProfile().settings = {
      keyRef: "not-a-secret-ref",
    };
    const provision = vi.fn(support.createProvider().provision);

    await expect(
      support
        .createService(support.createProvider({ provision }))
        .create("development", "request-secret"),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([]);
  });

  it("records permanent provider profile rejection as terminal", async () => {
    let provisionCalls = 0;
    const provider = support.createProvider({
      provision: async () => {
        provisionCalls += 1;
        throw new WorkerProviderError("region is required");
      },
    });
    const workerService = support.createService(provider);

    await expect(workerService.create("development", "request-invalid")).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining("region is required"),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    const record = expectDefined(
      support.testState.store.list()[0],
      "store.list()[0] test invariant",
    );
    expect(record).toMatchObject({ state: "failed", lastError: "region is required" });

    await workerService.reconcileOnce();
    await expect(workerService.destroy(record.environmentId)).resolves.toMatchObject({
      state: "failed",
    });
    expect(provisionCalls).toBe(1);
  });

  it("rejects non-canonical profile ids before persistence", async () => {
    const workerService = support.createService(support.createProvider());

    await expect(workerService.create(" development ", "request-spaced")).rejects.toMatchObject({
      code: "invalid_profile",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.list()).toEqual([]);
  });

  it.each(["direct destroy", "restart reconcile"] as const)(
    "cancels a requested intent without allocating on %s",
    async (mode) => {
      const intent = support.testState.store.createIntent({
        environmentId: `worker-cancel-${mode}`,
        providerId: "fake",
        profileId: "development",
        profileSnapshot: { settings: { region: "test" } },
        provisionOperationId: `provision:cancel-${mode}`,
      });
      const provision = vi.fn(support.createProvider().provision);
      const workerService = support.createService(support.createProvider({ provision }));

      if (mode === "direct destroy") {
        await workerService.destroy(intent.environmentId);
      } else {
        support.testState.store.requestDestroy({
          environmentId: intent.environmentId,
          state: "requested",
        });
        support.testState.providersEnabled = false;
        await workerService.reconcileOnce();
      }

      expect(provision).not.toHaveBeenCalled();
      expect(support.testState.store.get(intent.environmentId)).toMatchObject({
        state: "failed",
        lastError: "Provisioning canceled before provider allocation",
        destroyRequestedAtMs: expect.any(Number),
      });
    },
  );
});
