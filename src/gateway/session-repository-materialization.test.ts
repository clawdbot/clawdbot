import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as githubOAuth from "../agents/github-oauth-client.js";
import {
  resolveManagedGitHubProfileDir,
  writeManagedGitHubProfileFiles,
} from "../agents/github-tool-identity.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import * as sessionEntries from "../config/sessions/session-accessor.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as cloneRuntime from "../projects/project-clone-runtime.js";
import { ProjectCloneError } from "../projects/project-clone-runtime.js";
import * as projectCloning from "../projects/project-clone.js";
import { registerClonedProjectRegistry } from "../projects/project-registry.js";
import * as secretsRuntime from "../secrets/runtime-state.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as githubOAuthLifecycle from "./github-oauth-lifecycle.js";
import { captureGitHubPublicationWorkspaceSnapshot } from "./github-publication-git-transport.js";
import { REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS } from "./github-repository-publication-snapshot.js";
import { materializeSessionRepositoryWorkspaceOnGateway } from "./session-repository-materialization.js";
import { stageSessionRepositoryCheckpoint } from "./worker-environments/session-repository-checkpoints.js";
import { serializeWorkerWorkspaceManifest } from "./worker-environments/workspace-manifest.js";
import { readActualWorkspaceManifest } from "./worker-environments/workspace-reconcile-core.js";

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (await exec("git", ["-C", cwd, ...args])).stdout.trim();

describe("explicit repository move to Gateway", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["system", "agent", "revoked", "reset", "auth failure"] as const)(
    "keeps the current shared GitHub identity and move authority at clone admission: %s",
    async (scenario) => {
      await withOpenClawTestState(
        {
          label: "repository-materialize-identity",
          env: { GH_TOKEN: "synthetic-legacy-token", GITHUB_TOKEN: undefined },
        },
        async (state) => {
          const systemProfileId = "ghp_11111111111111111111111111111111";
          const agentProfileId = "ghp_22222222222222222222222222222222";
          const cfg: OpenClawConfig = {
            agents: { entries: { main: { workspace: state.workspaceDir } } },
            gateway: { controlUi: { github: { token: "synthetic-preview-token" } } },
          };
          const config: OpenClawConfig = {
            ...cfg,
            tools: { github: { profileId: systemProfileId } },
            agents: {
              entries: {
                main: {
                  workspace: state.workspaceDir,
                  ...(scenario === "agent"
                    ? { tools: { github: { profileId: agentProfileId } } }
                    : {}),
                },
              },
            },
          };
          await state.writeConfig(config);
          vi.spyOn(secretsRuntime, "getActiveSecretsRuntimeConfigSnapshot").mockReturnValue({
            config,
            sourceConfig: config,
            configRefsPrepared: true,
          });
          vi.spyOn(githubOAuthLifecycle, "requestCurrentGitHubOAuthRefresh").mockResolvedValue(
            undefined,
          );
          for (const [credentialScope, profileId] of [
            ["system", systemProfileId],
            ["agent", agentProfileId],
          ] as const) {
            await writeManagedGitHubProfileFiles(
              resolveManagedGitHubProfileDir({
                agentId: "main",
                scope: credentialScope,
                profileId,
              }),
              { login: `${credentialScope}-bot`, token: `synthetic-${credentialScope}-token` },
            );
          }
          const scope = { agentId: "main", sessionKey: "agent:main:dashboard:private-move" };
          const sessionId = "private-materialization-session";
          const repositories = getSessionRepositoryWorkspaceStore();
          const created = repositories.create({
            ...scope,
            url: "https://github.com/openclaw/private-materialization-fixture.git",
            runSetupScript: false,
            assertCurrent: () => {},
          });
          const repository = repositories.bindBase({
            workspaceId: created.workspaceId,
            expectedRevision: created.revision,
            baseCommit: "a".repeat(40),
            baseManifestHash: `sha256:${"b".repeat(64)}`,
            assertCurrent: () => {},
          });
          await upsertSessionEntryCore(scope, {
            sessionId,
            repositoryWorkspaceId: repository.workspaceId,
          });
          let current = true;
          const verify = vi
            .spyOn(githubOAuth, "verifyGitHubCredential")
            .mockImplementation(async () => {
              await Promise.resolve();
              if (scenario === "revoked") {
                current = false;
              } else if (scenario === "reset") {
                await sessionEntries.patchSessionEntryCore(scope, () => ({
                  lifecycleRevision: "reset-revision",
                }));
              }
              return {
                status: "available",
                account: { accountId: 42, login: "shared-bot", avatarUrl: null },
                scopes: [],
              };
            });
          const cloneFailure =
            scenario === "auth failure"
              ? new ProjectCloneError("auth_required", "GitHub rejected the Control UI credential")
              : new Error("fixture clone transport reached");
          const clone = vi
            .spyOn(projectCloning, "materializeProjectClone")
            .mockRejectedValue(cloneFailure);
          const operation = materializeSessionRepositoryWorkspaceOnGateway({
            ...scope,
            cfg,
            sessionId,
            assertCurrent: () => {
              if (!current) {
                throw new Error("move authority revoked");
              }
            },
          });
          if (scenario === "revoked" || scenario === "reset") {
            await expect(operation).rejects.toThrow(
              scenario === "revoked" ? "move authority revoked" : "Repository workspace changed",
            );
            expect(clone).not.toHaveBeenCalled();
          } else {
            if (scenario === "auth failure") {
              await expect(operation).rejects.toMatchObject({
                failure: "auth_required",
                message: expect.stringMatching(/shared GitHub identity.*Settings/u),
              });
            } else {
              await expect(operation).rejects.toBe(cloneFailure);
            }
            const token = `synthetic-${scenario === "agent" ? "agent" : "system"}-token`;
            expect(verify).toHaveBeenCalledWith(token);
            expect(clone).toHaveBeenCalledWith(
              { cfg, gitUrl: repository.url, requiredCommit: repository.baseCommit },
              expect.objectContaining({ token }),
            );
          }
          expect(loadSessionEntry(scope)?.repositoryWorkspaceId).toBe(repository.workspaceId);
          expect(managedWorktrees.findLiveByOwner("session", scope.sessionKey)).toBeUndefined();
        },
      );
    },
  );

  it.each([
    "success",
    "revoked",
    "postcommit failure",
    "publication unavailable",
    "requested topic",
  ] as const)("retains only committed materialization: %s", async (outcome) => {
    await withOpenClawTestState({ label: "repository-materialize" }, async (state) => {
      const cfg = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        tools: { github: { profileId: "ghp_11111111111111111111111111111111" } },
      };
      await state.writeConfig(cfg);
      const source = state.path("source");
      await fsp.mkdir(source);
      await git(source, ["init", "-b", "main"]);
      await git(source, ["config", "user.name", "OpenClaw Test"]);
      await git(source, ["config", "user.email", "test@example.invalid"]);
      await fsp.writeFile(path.join(source, ".gitignore"), "*.ignored\n");
      await fsp.writeFile(path.join(source, ".worktreeinclude"), "retained.ignored\n");
      await fsp.writeFile(path.join(source, "edited.txt"), "base\n");
      await fsp.writeFile(path.join(source, "deleted.txt"), "delete me\n");
      await git(source, ["add", "."]);
      await git(source, ["commit", "-m", "base"]);
      const baseCommit = await git(source, ["rev-parse", "HEAD"]);
      const url = "https://github.com/openclaw/materialization-fixture.git";
      await registerClonedProjectRegistry({ path: source, name: "Fixture", originUrl: url });
      const base = await readActualWorkspaceManifest({ root: source, baseCommit });
      const remote = state.path("remote");
      await exec("git", ["clone", "--", source, remote]);
      await fsp.writeFile(path.join(remote, "published[1].ignored"), "publishable\n");
      await fsp.writeFile(path.join(remote, "retained.ignored"), "recovery only\n");
      await git(remote, ["--literal-pathspecs", "add", "-f", "--", "published[1].ignored"]);
      await fsp.writeFile(path.join(remote, "edited.txt"), "accepted\n");
      await fsp.writeFile(path.join(remote, "added.txt"), "new\n");
      await fsp.rm(path.join(remote, "deleted.txt"));
      const current = await readActualWorkspaceManifest({ root: remote, baseCommit });
      const publicationStagingRoot = state.path("publication-snapshot");
      const publicationDigest =
        outcome === "publication unavailable"
          ? undefined
          : (
              await exec(process.execPath, [
                "-e",
                REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS,
                remote,
                baseCommit,
                publicationStagingRoot,
              ])
            ).stdout.trim();
      const scope = { agentId: "main", sessionKey: "agent:main:dashboard:materialization" };
      const repositories = getSessionRepositoryWorkspaceStore();
      let repository = repositories.create({
        ...scope,
        url,
        requestedRef: outcome === "requested topic" ? "topic" : undefined,
        runSetupScript: false,
        assertCurrent: () => {},
      });
      repository = repositories.bindBase({
        workspaceId: repository.workspaceId,
        expectedRevision: repository.revision,
        baseCommit,
        baseManifestHash: base.manifestRef,
        assertCurrent: () => {},
      });
      const checkpoint = await stageSessionRepositoryCheckpoint({
        workspaceId: repository.workspaceId,
        expectedRevision: repository.revision,
        stagingRoot: remote,
        ...(publicationDigest ? { publicationStagingRoot, publicationDigest } : {}),
        baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
        currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
        baseManifestRef: base.manifestRef,
        currentManifestRef: current.manifestRef,
        assertCurrent: () => {},
      });
      repository = await checkpoint.publish();
      const sessionId = "repository-materialization-session";
      await upsertSessionEntryCore(scope, {
        sessionId,
        repositoryWorkspaceId: repository.workspaceId,
      });
      const assertCurrent = () => {
        const worktree = managedWorktrees.findLiveByOwner("session", scope.sessionKey);
        if (
          outcome === "revoked" &&
          worktree &&
          fs.existsSync(path.join(worktree.path, "added.txt"))
        ) {
          throw new Error("move authority revoked");
        }
      };
      vi.spyOn(cloneRuntime, "readProjectCheckoutRemoteHead").mockImplementation(
        async ({ branch }) =>
          outcome === "requested topic" && branch === "topic" ? baseCommit : undefined,
      );
      if (outcome === "postcommit failure") {
        const patchSessionEntry = sessionEntries.patchSessionEntryCore;
        vi.spyOn(sessionEntries, "patchSessionEntryCore").mockImplementationOnce(
          async (...args) => {
            await patchSessionEntry(...args);
            throw new Error("postcommit observer failed");
          },
        );
      }
      const operation = materializeSessionRepositoryWorkspaceOnGateway({
        ...scope,
        cfg,
        sessionId,
        assertCurrent,
      });
      if (outcome === "revoked") {
        await expect(operation).rejects.toThrow("move authority revoked");
        expect(loadSessionEntry(scope)?.repositoryWorkspaceId).toBe(repository.workspaceId);
        expect(managedWorktrees.findLiveByOwner("session", scope.sessionKey)).toBeUndefined();
      } else {
        if (outcome === "postcommit failure") {
          await expect(operation).rejects.toThrow("postcommit observer failed");
        } else {
          await operation;
        }
        const entry = loadSessionEntry(scope)!;
        const worktree = managedWorktrees.findLiveByOwner("session", scope.sessionKey)!;
        expect(entry.repositoryWorkspaceId).toBeUndefined();
        expect(entry.worktree?.id).toBe(worktree.id);
        expect(worktree.baseRef).toBe(outcome === "requested topic" ? "topic" : "HEAD");
        expect(entry.spawnedCwd).toBe(worktree.path);
        expect(await fsp.readFile(path.join(worktree.path, "edited.txt"), "utf8")).toBe(
          "accepted\n",
        );
        expect(await fsp.readFile(path.join(worktree.path, "added.txt"), "utf8")).toBe("new\n");
        await expect(fsp.stat(path.join(worktree.path, "deleted.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await git(worktree.path, ["rev-parse", "HEAD"])).toBe(baseCommit);
        expect(await fsp.readFile(path.join(worktree.path, "published[1].ignored"), "utf8")).toBe(
          "publishable\n",
        );
        expect(await fsp.readFile(path.join(worktree.path, "retained.ignored"), "utf8")).toBe(
          "recovery only\n",
        );
        expect(await git(worktree.path, ["ls-files", "--", "published[1].ignored"])).toBe(
          publicationDigest ? "published[1].ignored" : "",
        );
        expect(await git(worktree.path, ["ls-files", "--", "retained.ignored"])).toBe("");
        expect(await git(worktree.path, ["diff", "--cached", "--name-only"])).toBe(
          publicationDigest ? "deleted.txt" : "",
        );
        const normalized = await captureGitHubPublicationWorkspaceSnapshot({
          cwd: worktree.path,
        });
        const published = (
          await git(worktree.path, ["ls-tree", "-r", "--name-only", normalized.workspaceTree])
        ).split("\n");
        expect(published.includes("published[1].ignored")).toBe(Boolean(publicationDigest));
        expect(published).not.toContain("retained.ignored");
        await materializeSessionRepositoryWorkspaceOnGateway({
          ...scope,
          cfg,
          sessionId,
          assertCurrent,
        });
        expect(managedWorktrees.findLiveByOwner("session", scope.sessionKey)?.id).toBe(worktree.id);
      }
      // Retained publication may still need the original immutable source after the move.
      expect(repositories.get(repository.workspaceId)).toEqual(repository);
      expect(fs.existsSync(repositories.artifactPath(repository.workspaceId))).toBe(true);
      expect(await fsp.readFile(path.join(source, "edited.txt"), "utf8")).toBe("base\n");
    });
  });
});
