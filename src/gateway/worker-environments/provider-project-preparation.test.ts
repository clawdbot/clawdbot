import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readWorkerProjectPreparation } from "./preparation-identity.js";
import { createWorkerEnvironmentService } from "./service.js";
import * as support from "./service.test-support.js";
import * as workspaceGitBase from "./workspace-git-base.js";

type ProjectPreparation = NonNullable<
  NonNullable<Parameters<WorkerProvider["provision"]>[2]>["project"]
>;

async function repository(name: string) {
  const root = path.join(support.testState.root, name);
  await fs.mkdir(root);
  await requireGit(root, ["init", "--quiet"]);
  await requireGit(root, ["config", "user.name", "Project Test"]);
  await requireGit(root, ["config", "user.email", "project@example.invalid"]);
  await fs.writeFile(path.join(root, "input.txt"), `${name} base\n`);
  await requireGit(root, ["add", "."]);
  await requireGit(root, ["commit", "--quiet", "-m", "base"]);
  return { root, baseCommit: await requireGit(root, ["rev-parse", "HEAD"]) };
}

function createService(provision: WorkerProvider["provision"], providerCallTimeoutMs?: number) {
  let credentialIndex = 0;
  return support.createService(
    support.createProvider({
      supportsProjectPreparation: () => true,
      provision,
    }),
    {
      projectNamespace: "gateway",
      generateWorkerCredential: () => `${support.CREDENTIAL}-${++credentialIndex}`,
      ...(providerCallTimeoutMs ? { providerCallTimeoutMs } : {}),
    },
  );
}

describe("worker provider project preparation ownership", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("prepares the inherited machine class while preserving explicit overrides and defaults", async () => {
    const git = await repository("inherited-machine-class");
    const settings = { region: "test", class: "standard" };
    support.getDevelopmentProfile().settings = settings;
    const provider = support.createProvider({
      requiresNodeEnrollment: true,
      supportsProjectPreparation: (profile, machineClass) =>
        (machineClass ?? profile.class) !== "unprepared",
      resolvePreparationTarget: (profile, machineClass) => {
        if (typeof profile.class !== "string") {
          throw new Error("Missing fixture machine class");
        }
        return { machineClass: machineClass ?? profile.class, platform: "linux", arch: "x64" };
      },
    });
    const service = createWorkerEnvironmentService({
      store: support.testState.store,
      getConfig: () => support.testState.config,
      resolveProvider: () => provider,
      projectNamespace: "gateway",
      prepareInstallation: support.testState.prepareInstallation,
      bootstrapWorker: support.testState.bootstrapWorker,
      prepareNodeArtifacts: async () => ({
        artifacts: {
          nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
          enabledPluginIds: [...support.NODE_BOOTSTRAP.enabledPluginIds],
          workerBundleHash: support.BUNDLE_HASH,
          workerArchiveSha256: support.BUNDLE_ARTIFACT.tarballSha256,
          openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
          protocolFeatures: [],
        },
        assertCurrent: () => {},
      }),
      executeInference: async () => ({ type: "error", reason: "cancelled", message: "unused" }),
    });
    support.testState.service = service;
    const inherited = {
      providerId: provider.id,
      profileSnapshot: { install: "bundle", settings, machineClass: "large" },
    };
    const prepare = (options: Parameters<typeof service.prepareProjectIntent>[1] = {}) =>
      service.prepareProjectIntent("development", { projectPath: git.root, ...options });
    const configured = await prepare();
    const large = await prepare({ inherited });
    const explicitLarge = await prepare({ machineClass: "large" });
    const override = await prepare({ inherited, machineClass: "standard" });

    expect(
      readWorkerProjectPreparation(configured.profileSnapshot.project)?.target.machineClass,
    ).toBe("standard");
    expect(large.profileSnapshot.machineClass).toBe("large");
    expect(readWorkerProjectPreparation(large.profileSnapshot.project)?.target.machineClass).toBe(
      "large",
    );
    expect(large.preparationKey).toBe(explicitLarge.preparationKey);
    expect(large.preparationKey).not.toBe(configured.preparationKey);
    expect(override.profileSnapshot.machineClass).toBe("standard");
    expect(override.preparationKey).toBe(configured.preparationKey);

    const ineligible = await prepare({
      inherited: {
        ...inherited,
        profileSnapshot: { ...inherited.profileSnapshot, machineClass: "unprepared" },
      },
    });
    expect(ineligible.profileSnapshot.project).toBeUndefined();
    expect(ineligible.preparationKey).toBeUndefined();
    const ordinary = await prepare({ inherited, projectPath: undefined });
    expect(ordinary.profileSnapshot.machineClass).toBe("large");
    expect(ordinary.profileSnapshot.project).toBeUndefined();
    expect(ordinary.preparationKey).toBeUndefined();
    expect(support.testState.store.list()).toEqual([]);
  });

  it("cancels project snapshot preparation before creating an allocation intent", async () => {
    const git = await repository("cancelled-project-snapshot");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const controller = new AbortController();
    const original = workspaceGitBase.prepareWorkerProjectSnapshot;
    let snapshotSignal: AbortSignal | undefined;
    const snapshot = vi
      .spyOn(workspaceGitBase, "prepareWorkerProjectSnapshot")
      .mockImplementationOnce(async (params) => {
        snapshotSignal = params.signal;
        entered.resolve();
        await release.promise;
        return await original(params);
      });
    const provision = vi.fn<WorkerProvider["provision"]>(async () => ({
      leaseId: "unexpected-project-lease",
      ssh: support.SSH_ENDPOINT,
    }));
    const service = createService(provision);
    const creation = service
      .create(
        "development",
        "cancelled-project-snapshot",
        undefined,
        undefined,
        git.root,
        controller.signal,
      )
      .catch((error: unknown) => error);
    try {
      await entered.promise;
      controller.abort(new DOMException("Stop project preparation", "AbortError"));
      await setImmediate();
      expect(snapshotSignal?.aborted).toBe(true);
    } finally {
      release.resolve();
      await creation;
      snapshot.mockRestore();
    }
    expect(await creation).toMatchObject({ name: "AbortError" });
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([]);
  });

  it("interrupts an active project transfer but retains its provider until the transport settles", async () => {
    const git = await repository("cancelled-project-transfer");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const controller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    let settled = false;
    const events: string[] = [];
    const service = createService(async (_profile, _operationId, options) => {
      const project = expectDefined(options?.project, "provider project preparation");
      await project.prepare({
        runScript: async (_script, signal) => {
          transportSignal = signal;
          entered.resolve();
          await release.promise;
          events.push("transport settled");
          signal.throwIfAborted();
          return '{"ready":true}';
        },
        upload: async () => {
          throw new Error("No upload should follow canceled inspection");
        },
      });
      return { leaseId: "unexpected-transfer-lease", ssh: support.SSH_ENDPOINT };
    });
    const creation = service
      .create(
        "development",
        "cancelled-project-transfer",
        undefined,
        undefined,
        git.root,
        controller.signal,
      )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await entered.promise;
      controller.abort(new DOMException("Stop project transfer", "AbortError"));
      await setImmediate();
      expect(transportSignal?.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(events).toEqual([]);
      expect(support.testState.store.list()[0]).toMatchObject({
        state: "provisioning",
        destroyRequestedAtMs: support.testState.nowMs,
      });
    } finally {
      release.resolve();
      await creation;
    }
    expect(await creation).toMatchObject({ name: "AbortError" });
    expect(events).toEqual(["transport settled"]);
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
  });

  it("persists project identity and the Git base before provision and replays them after restart and HEAD advance", async () => {
    const git = await repository("project");
    const projects: ProjectPreparation[] = [];
    const operationIds: string[] = [];
    const provision: WorkerProvider["provision"] = async (_profile, operationId, options) => {
      const project = expectDefined(options?.project, "provider project preparation");
      projects.push(project);
      operationIds.push(operationId);
      const record = support.testState.store
        .list()
        .find((entry) => entry.provisionOperationId === operationId);
      expect(record).toMatchObject({
        state: "provisioning",
        leaseId: null,
        profileSnapshot: {
          project: { key: project.key, root: git.root, baseCommit: git.baseCommit },
        },
      });
      expect(project.key).toMatch(/^[a-f0-9]{64}$/u);
      expect(project.baseCommit).toBe(git.baseCommit);
      expect(() => project.assertCurrent()).not.toThrow();
      if (projects.length === 1) {
        throw new Error("provider response was lost after allocation");
      }
      return { leaseId: "lease-project", ssh: support.SSH_ENDPOINT };
    };
    const first = createService(provision);
    await expect(
      first.create("development", "project-replay", undefined, undefined, git.root),
    ).rejects.toMatchObject({ code: "provider_failure" });
    expect(projects[0]?.signal.aborted).toBe(true);
    await fs.writeFile(path.join(git.root, "input.txt"), "newer project HEAD\n");
    await requireGit(git.root, ["commit", "--quiet", "-am", "advance"]);
    expect(await requireGit(git.root, ["rev-parse", "HEAD"])).not.toBe(git.baseCommit);
    await support.reopenWorkerEnvironmentStore();

    const restarted = createService(provision);
    await expect(
      restarted.create("development", "project-replay", undefined, undefined, git.root),
    ).resolves.toMatchObject({ state: "ready", leaseId: "lease-project" });
    expect(operationIds).toHaveLength(2);
    expect(operationIds[1]).toBe(operationIds[0]);
    expect(projects[1]?.key).toBe(projects[0]?.key);
    expect(projects[1]?.baseCommit).toBe(git.baseCommit);
    expect(projects[1]).not.toBe(projects[0]);
    expect(projects[1]?.signal.aborted).toBe(true);
  });

  it("rejects another project root using the same idempotency key before calling the provider", async () => {
    const first = await repository("first-project");
    const second = await repository("second-project");
    const provision = vi.fn<WorkerProvider["provision"]>(async () => ({
      leaseId: "lease-project",
      ssh: support.SSH_ENDPOINT,
    }));
    const service = createService(provision);
    await service.create("development", "same-request", undefined, undefined, first.root);
    const snapshot = support.testState.store.list()[0]?.profileSnapshot;

    await expect(
      service.create("development", "same-request", undefined, undefined, second.root),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Idempotency key belongs to another project",
    });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(support.testState.store.list()[0]?.profileSnapshot).toEqual(snapshot);
  });

  it("refills the admitted commit and recipe after the source checkout advances", async () => {
    const git = await repository("refill-source");
    const recipePath = path.join(git.root, ".openclaw", "worktree-setup.sh");
    await fs.mkdir(path.dirname(recipePath));
    await fs.writeFile(recipePath, "#!/bin/sh\nprintf 'approved B'\n", { mode: 0o755 });
    await requireGit(git.root, ["add", "."]);
    await requireGit(git.root, ["update-index", "--chmod=+x", ".openclaw/worktree-setup.sh"]);
    await requireGit(git.root, ["commit", "--quiet", "-m", "approved recipe B"]);
    const admittedCommit = await requireGit(git.root, ["rev-parse", "HEAD"]);
    const admittedRecipe = await requireGit(git.root, [
      "rev-parse",
      "HEAD:.openclaw/worktree-setup.sh",
    ]);
    const provision = vi.fn<WorkerProvider["provision"]>(async () => {
      throw new Error("fixture reached reserve allocation");
    });
    const provider = support.createProvider({
      supportedExecutionModes: ["worker-turn"],
      requiresNodeEnrollment: true,
      supportsProjectPreparation: () => true,
      resolvePreparationTarget: () => ({ machineClass: "small", platform: "linux", arch: "x64" }),
      resolvePreparedIdleTimeoutMs: () => 60_000,
      provision,
    });
    const service = createWorkerEnvironmentService({
      store: support.testState.store,
      getConfig: () => support.testState.config,
      resolveProvider: () => provider,
      projectNamespace: "gateway",
      prepareInstallation: support.testState.prepareInstallation,
      bootstrapWorker: support.testState.bootstrapWorker,
      prepareNodeArtifacts: async () => ({
        artifacts: {
          nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
          enabledPluginIds: [...support.NODE_BOOTSTRAP.enabledPluginIds],
          workerBundleHash: support.BUNDLE_HASH,
          workerArchiveSha256: support.BUNDLE_ARTIFACT.tarballSha256,
          openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
          protocolFeatures: [],
        },
        assertCurrent: () => {},
      }),
      executeInference: async () => ({ type: "error", reason: "cancelled", message: "unused" }),
      now: () => support.testState.nowMs,
      prepareNodeEnrollment: async () => {
        throw new Error("fixture never enrolls a reserve");
      },
    });
    support.testState.service = service;
    const intent = await service.prepareProjectIntent("development", {
      projectPath: git.root,
      executionMode: "worker-turn",
      setupAuthorized: true,
    });
    const preparation = expectDefined(
      readWorkerProjectPreparation(intent.profileSnapshot.project),
      "approved project preparation",
    );
    expect(preparation.setupRecipe).toBe(admittedRecipe);
    const reserve = support.testState.store.createIntent({
      environmentId: "admitted-refill",
      providerId: provider.id,
      profileId: "development",
      provisionOperationId: "admitted-refill-operation",
      profileSnapshot: intent.profileSnapshot,
      preparation: {
        key: preparation.key,
        demandAtMs: support.testState.nowMs,
        expiresAtMs: support.testState.nowMs + 60_000,
      },
    });
    await fs.writeFile(recipePath, "#!/bin/sh\nprintf 'unapproved C'\n");
    await requireGit(git.root, ["commit", "--quiet", "-am", "later recipe C"]);
    expect(await requireGit(git.root, ["rev-parse", "HEAD"])).not.toBe(admittedCommit);
    expect(await requireGit(git.root, ["rev-parse", "HEAD:.openclaw/worktree-setup.sh"])).not.toBe(
      admittedRecipe,
    );

    service.schedulePreparedRefill();
    await support.waitForFast(() => expect(provision).toHaveBeenCalledOnce());
    expect(provision.mock.calls[0]?.[2]?.project).toMatchObject({
      baseCommit: admittedCommit,
      preparation: { key: preparation.key, cacheKey: preparation.cacheKey, purpose: "reserve" },
    });
    expect(support.testState.store.get(reserve.environmentId)).toMatchObject({
      destroyRequestedAtMs: null,
      profileSnapshot: {
        project: {
          baseCommit: admittedCommit,
          preparation: {
            key: preparation.key,
            cacheKey: preparation.cacheKey,
            setupRecipe: admittedRecipe,
          },
        },
      },
    });
    await service.stop();
  });

  it.each([true, false])(
    "a fresh inherited allocation uses only its current project (has project=%s)",
    async (hasProject) => {
      const first = await repository("inherited-project");
      const second = await repository("current-project");
      const projects: Array<ProjectPreparation | undefined> = [];
      const service = createService(async (_profile, operationId, options) => {
        projects.push(options?.project);
        return { leaseId: `lease-${operationId}`, ssh: support.SSH_ENDPOINT };
      });
      const original = await service.create(
        "development",
        "original",
        undefined,
        undefined,
        first.root,
      );
      const originalRecord = expectDefined(
        support.testState.store.get(original.environmentId),
        "original allocation",
      );
      const inherited = {
        profileId: originalRecord.profileId,
        providerId: originalRecord.providerId,
        profileSnapshot: originalRecord.profileSnapshot,
      };
      const next = await service.createFromProfileSnapshot(
        inherited,
        "fresh",
        undefined,
        undefined,
        hasProject ? second.root : undefined,
      );
      const nextRecord = expectDefined(
        support.testState.store.get(next.environmentId),
        "fresh allocation",
      );
      if (hasProject) {
        expect(nextRecord.profileSnapshot.project).toMatchObject({
          root: second.root,
          baseCommit: second.baseCommit,
        });
        expect(projects[1]?.key).not.toBe(projects[0]?.key);
        expect(projects[1]?.baseCommit).toBe(second.baseCommit);
      } else {
        expect(nextRecord.profileSnapshot.project).toBeUndefined();
        expect(projects[1]).toBeUndefined();
      }
      await expect(
        service.createFromProfileSnapshot(
          inherited,
          "fresh",
          undefined,
          undefined,
          hasProject ? second.root : undefined,
        ),
      ).resolves.toMatchObject({ environmentId: next.environmentId, state: "ready" });
      expect(projects).toHaveLength(2);
      expect(
        support.testState.store.get(original.environmentId)?.profileSnapshot.project,
      ).toMatchObject({ root: first.root, baseCommit: first.baseCommit });
      expect(inherited.profileSnapshot.project).toEqual(originalRecord.profileSnapshot.project);
    },
  );

  it.each(["return", "timeout"])(
    "revokes retained project callbacks after provider %s",
    async (outcome) => {
      const git = await repository("closure-project");
      const release = createDeferredCore();
      let retained: ProjectPreparation | undefined;
      const service = createService(
        async (_profile, _operationId, options) => {
          retained = options?.project;
          if (outcome === "timeout") {
            await release.promise;
          }
          return { leaseId: "lease-closed-project", ssh: support.SSH_ENDPOINT };
        },
        outcome === "timeout" ? 20 : undefined,
      );
      try {
        const creation = service.create("development", "closure", undefined, undefined, git.root);
        if (outcome === "timeout") {
          await expect(creation).rejects.toMatchObject({ code: "provider_failure" });
        } else {
          await expect(creation).resolves.toMatchObject({ state: "ready" });
        }
        const project = expectDefined(retained, "retained project callback");
        expect(project.signal.aborted).toBe(true);
        const transport = {
          runScript: vi.fn(async () => '{"ready":true}'),
          upload: vi.fn(async () => {}),
        };
        expect(() => project.assertCurrent()).toThrow();
        expect(() => project.prepare(transport)).toThrow();
        expect(transport.runScript).not.toHaveBeenCalled();
        expect(transport.upload).not.toHaveBeenCalled();
      } finally {
        release.resolve();
      }
    },
  );
});
