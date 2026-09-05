import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { managedWorktrees } from "../agents/worktrees/service.js";
import * as sessionEntries from "../config/sessions/session-accessor.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { registerClonedProjectRegistry } from "../projects/project-registry.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { materializeSessionRepositoryWorkspaceOnGateway } from "./session-repository-materialization.js";
import { stageSessionRepositoryCheckpoint } from "./worker-environments/session-repository-checkpoints.js";
import { serializeWorkerWorkspaceManifest } from "./worker-environments/workspace-manifest.js";
import { readActualWorkspaceManifest } from "./worker-environments/workspace-reconcile-core.js";

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (await exec("git", ["-C", cwd, ...args])).stdout.trim();

describe("explicit repository move to Gateway", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["success", "revoked", "postcommit failure"] as const)(
    "retains only committed materialization: %s",
    async (outcome) => {
      await withOpenClawTestState({ label: "repository-materialize" }, async (state) => {
        const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
        await state.writeConfig(cfg);
        const source = state.path("source");
        await fsp.mkdir(source);
        await git(source, ["init", "-b", "main"]);
        await git(source, ["config", "user.name", "OpenClaw Test"]);
        await git(source, ["config", "user.email", "test@example.invalid"]);
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
        await fsp.writeFile(path.join(remote, "edited.txt"), "accepted\n");
        await fsp.writeFile(path.join(remote, "added.txt"), "new\n");
        await fsp.rm(path.join(remote, "deleted.txt"));
        const current = await readActualWorkspaceManifest({ root: remote, baseCommit });
        const scope = { agentId: "main", sessionKey: "agent:main:dashboard:materialization" };
        const repositories = getSessionRepositoryWorkspaceStore();
        let repository = repositories.create({
          ...scope,
          url,
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
          expect(entry.spawnedCwd).toBe(worktree.path);
          expect(await fsp.readFile(path.join(worktree.path, "edited.txt"), "utf8")).toBe(
            "accepted\n",
          );
          expect(await fsp.readFile(path.join(worktree.path, "added.txt"), "utf8")).toBe("new\n");
          await expect(fsp.stat(path.join(worktree.path, "deleted.txt"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect(await git(worktree.path, ["rev-parse", "HEAD"])).toBe(baseCommit);
          await materializeSessionRepositoryWorkspaceOnGateway({
            ...scope,
            cfg,
            sessionId,
            assertCurrent,
          });
          expect(managedWorktrees.findLiveByOwner("session", scope.sessionKey)?.id).toBe(
            worktree.id,
          );
        }
        // Retained publication may still need the original immutable source after the move.
        expect(repositories.get(repository.workspaceId)).toEqual(repository);
        expect(fs.existsSync(repositories.artifactPath(repository.workspaceId))).toBe(true);
        expect(await fsp.readFile(path.join(source, "edited.txt"), "utf8")).toBe("base\n");
      });
    },
  );
});
