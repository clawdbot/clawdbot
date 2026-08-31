import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as support from "./service.test-support.js";

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
