import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { WorkerProviderError, type WorkerProfile } from "../../plugins/types.js";
import { hashWorkerCredential } from "./credential.js";
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

  it("delegates configured machine options to the profile provider", async () => {
    const listMachineOptions = vi.fn(() => [{ id: "standard", label: "Standard", default: true }]);
    const workerService = support.createService(support.createProvider({ listMachineOptions }));

    await expect(workerService.listMachineOptions("development")).resolves.toEqual([
      { id: "standard", label: "Standard", default: true },
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
    Object.defineProperty(provider, "listMachineOptions", { value: () => options });
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
