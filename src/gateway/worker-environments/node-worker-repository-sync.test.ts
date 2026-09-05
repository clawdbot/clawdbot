import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import type { WorkerWorkspaceReconcileRequest } from "./tunnel-contract.js";
import { createWorkerWorkspaceActions } from "./workspace-sync.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("rejects repository sources on SSH before invoking any remote command", async () => {
  const run = vi.fn();
  const waitForPrepared = vi.fn();
  const actions = createWorkerWorkspaceActions({
    environmentId: "environment-ssh",
    ownerSignal: new AbortController().signal,
    runner: { run },
    waitForPrepared,
    tasks: new Set(),
    bundleHash: "a".repeat(64),
  });
  await expect(
    actions.syncWorkspace({
      sessionId: "session-ssh",
      generation: 1,
      source: {
        kind: "repository",
        url: "https://github.com/example/repository.git",
        branch: "openclaw/session",
      },
    }),
  ).rejects.toThrow("managed node");
  await expect(
    actions.reconcileWorkspace({
      remoteWorkspaceDir: "/worker/workspace",
      baseManifestRef: `sha256:${"b".repeat(64)}`,
      source: {
        kind: "repository",
        referenceManifestRef: `sha256:${"b".repeat(64)}`,
        prepareCheckpoint: vi.fn(),
      },
    }),
  ).rejects.toThrow("managed node");
  expect(waitForPrepared).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it.each([
  { publication: "available", filters: false, closeOwner: false },
  { publication: "blocked by filters", filters: true, closeOwner: false },
  { publication: "blocked when the owner closes", filters: true, closeOwner: true },
])(
  "preserves repository checkpoints with publication $publication",
  async ({ filters, closeOwner }) => {
    const root = await fs.realpath(tempDirs.make("node-repository-roundtrip-"));
    const origin = path.join(root, "origin");
    const home = path.join(root, "node-home");
    await fs.mkdir(path.join(origin, ".openclaw"), { recursive: true });
    await fs.writeFile(path.join(origin, ".gitignore"), "*.ignored\n");
    await fs.writeFile(path.join(origin, ".worktreeinclude"), "retained.ignored\n");
    await fs.writeFile(path.join(origin, "retained-removal.ignored"), "keep recovered bytes\n");
    await fs.writeFile(path.join(origin, "tracked.txt"), "base\n");
    await fs.writeFile(path.join(origin, "a-original.txt"), "turn one\n");
    if (filters) {
      await fs.writeFile(path.join(origin, ".gitattributes"), "*.dat filter=example\n");
    }
    await fs.writeFile(
      path.join(origin, ".openclaw", "worktree-setup.sh"),
      "#!/bin/sh\nprintf 'prepared\\n' > setup.txt\n",
      { mode: 0o755 },
    );
    const gitAt = async (cwd: string, ...args: string[]) => {
      const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], {
        timeoutMs: 10_000,
        baseEnv: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      expect(result.code, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const git = (...args: string[]) => gitAt(origin, ...args);
    await git("init", "--quiet");
    await git("add", ".");
    await git("add", "-f", "retained-removal.ignored");
    await git(
      "-c",
      "user.name=Repository Test",
      "-c",
      "user.email=repository@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "base",
    );
    const baseCommit = await git("rev-parse", "HEAD");
    let epoch = 1;
    const service = createNodeWorkspaceTransferService({
      temporaryRoot: path.join(root, "transfers"),
      getOwner: () => ({
        credential: { ownerEpoch: epoch, sessionId: "session-1" },
        environment: {
          ownerEpoch: epoch,
          attachedSessionIds: ["session-1"],
          destroyRequestedAtMs: null,
          state: "attached",
        },
      }),
    });
    const server = await startNodeWorkspaceTransferTestServer(service);
    let runtime = new NodeWorkerWorkspaceRuntime({
      root: path.join(home, "node-host"),
      env: { PATH: process.env.PATH, HOME: home },
    });
    const createActions = () => {
      const ownerEpoch = epoch;
      const ownerSignal = new AbortController().signal;
      return createNodeWorkerWorkspaceActions({
        environmentId: "environment-1",
        ownerEpoch,
        sessionId: "session-1",
        ownerSignal,
        isOwnerCurrent: () => epoch === ownerEpoch,
        workspaceTransfer: service,
        runWorkspaceCommand: async (command) => {
          if (epoch !== ownerEpoch) {
            throw new Error("node workspace authority closed");
          }
          try {
            return await runtime.exec(
              {
                gatewayNamespace: "gateway-1",
                environmentId: "environment-1",
                sessionId: "session-1",
                generation: ownerEpoch,
                ...command,
                argv: [...command.argv],
              },
              ownerSignal,
              { url: server.gatewayUrl },
            );
          } catch (error) {
            if (
              closeOwner &&
              command.transfer?.direction === "upload" &&
              command.transfer.publicationBaseCommit
            ) {
              epoch += 1;
            }
            throw error;
          }
        },
      });
    };
    const source = {
      kind: "repository" as const,
      url: pathToFileURL(origin).href,
      ref: "HEAD",
      branch: "openclaw/session",
      gitToken: "synthetic-repository-token",
      runSetupScript: true,
    };
    try {
      const actions = createActions();
      const first = await actions.syncWorkspace({
        sessionId: "session-1",
        generation: epoch,
        source,
      });
      expect(first.mode).toBe("repository");
      if (first.mode !== "repository") {
        throw new Error("Repository source was not prepared");
      }
      expect(first.baseCommit).toBe(baseCommit);
      expect(first.manifestRef).not.toBe(first.baseManifestRef);
      expect(await fs.readFile(path.join(first.remoteWorkspaceDir, "setup.txt"), "utf8")).toBe(
        "prepared\n",
      );
      let checkpoint:
        | Parameters<
            Extract<
              WorkerWorkspaceReconcileRequest["source"],
              { kind: "repository" }
            >["prepareCheckpoint"]
          >[0]
        | undefined;
      let revision = 0;
      const capture = async (active = actions, directory = first.remoteWorkspaceDir) => {
        const result = await active.reconcileWorkspace({
          remoteWorkspaceDir: directory,
          baseManifestRef: first.baseManifestRef,
          source: {
            kind: "repository",
            referenceManifestRef: checkpoint?.currentManifestRef ?? first.manifestRef,
            prepareCheckpoint: async (payload) => {
              const stagingRoot = path.join(root, `checkpoint-${++revision}`);
              await fs.cp(payload.stagingRoot, stagingRoot, { recursive: true });
              if (filters) {
                expect(payload.publicationDigest).toBeUndefined();
                expect(payload.publicationStagingRoot).toBeUndefined();
              } else {
                expect(payload.publicationDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
                expect(
                  JSON.parse(
                    await fs.readFile(
                      path.join(payload.publicationStagingRoot!, "snapshot.json"),
                      "utf8",
                    ),
                  ),
                ).toMatchObject({ baseCommit });
              }
              const publicationStagingRoot = payload.publicationStagingRoot
                ? path.join(root, `publication-${revision}`)
                : undefined;
              if (publicationStagingRoot) {
                await fs.cp(payload.publicationStagingRoot!, publicationStagingRoot, {
                  recursive: true,
                });
              }
              const captured = { ...payload, stagingRoot, publicationStagingRoot };
              return {
                verify: async () => {
                  expect(await fs.stat(stagingRoot)).toBeDefined();
                },
                publish: async () => {
                  checkpoint = captured;
                },
                discard: async () => {
                  await fs.rm(stagingRoot, { recursive: true, force: true });
                },
              };
            },
          },
        });
        await result.verifyStable();
        await result.verifyLocalStable();
        await result.publishStagedResult?.();
      };
      if (closeOwner) {
        await expect(capture()).rejects.toThrow();
        expect(revision).toBe(0);
        expect(checkpoint).toBeUndefined();
        return;
      }
      // Startup must accept setup output even when GitHub normalization is unavailable.
      await capture();
      expect(revision).toBe(1);
      expect(checkpoint).toBeDefined();
      await gitAt(first.remoteWorkspaceDir, "rm", "--cached", "retained-removal.ignored");
      await fs.writeFile(
        path.join(first.remoteWorkspaceDir, "published[1].ignored"),
        "publishable\n",
      );
      await fs.writeFile(
        path.join(first.remoteWorkspaceDir, "retained.ignored"),
        "recovery only\n",
      );
      await gitAt(
        first.remoteWorkspaceDir,
        "--literal-pathspecs",
        "add",
        "-f",
        "--",
        "published[1].ignored",
      );
      await fs.writeFile(path.join(first.remoteWorkspaceDir, "first.txt"), "turn one\n");
      await capture();
      await fs.writeFile(path.join(first.remoteWorkspaceDir, "second.txt"), "turn two\n");
      await fs.rm(path.join(first.remoteWorkspaceDir, "tracked.txt"));
      await capture();
      expect(checkpoint).toBeDefined();

      epoch += 1;
      const replacement = createActions();
      const restored = await replacement.syncWorkspace({
        sessionId: "session-1",
        generation: epoch,
        source: { ...source, baseCommit, checkpoint },
      });
      expect(restored.remoteWorkspaceDir).not.toBe(first.remoteWorkspaceDir);
      expect(restored.manifestRef).toBe(checkpoint!.currentManifestRef);
      expect(await fs.readFile(path.join(restored.remoteWorkspaceDir, "first.txt"), "utf8")).toBe(
        "turn one\n",
      );
      expect(await fs.readFile(path.join(restored.remoteWorkspaceDir, "second.txt"), "utf8")).toBe(
        "turn two\n",
      );
      expect(await fs.readFile(path.join(restored.remoteWorkspaceDir, "setup.txt"), "utf8")).toBe(
        "prepared\n",
      );
      await expect(
        fs.stat(path.join(restored.remoteWorkspaceDir, "tracked.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(checkpoint!.stagingRoot)).toSorted()).toEqual([
        "first.txt",
        "published[1].ignored",
        "retained.ignored",
        "second.txt",
        "setup.txt",
      ]);
      expect(
        await fs.readFile(path.join(restored.remoteWorkspaceDir, "published[1].ignored"), "utf8"),
      ).toBe("publishable\n");
      expect(
        await gitAt(restored.remoteWorkspaceDir, "ls-files", "--", "published[1].ignored"),
      ).toBe(filters ? "" : "published[1].ignored");
      expect(await gitAt(restored.remoteWorkspaceDir, "ls-files", "--", "retained.ignored")).toBe(
        "",
      );
      expect(
        await fs.readFile(
          path.join(restored.remoteWorkspaceDir, "retained-removal.ignored"),
          "utf8",
        ),
      ).toBe("keep recovered bytes\n");
      expect(
        await gitAt(restored.remoteWorkspaceDir, "ls-files", "--", "retained-removal.ignored"),
      ).toBe(filters ? "retained-removal.ignored" : "");
      expect(await gitAt(restored.remoteWorkspaceDir, "diff", "--cached", "--name-only")).toBe(
        filters ? "" : "retained-removal.ignored\ntracked.txt",
      );
      // A node process restart loses in-memory transfer refs; the Gateway owns the accepted ref.
      runtime = new NodeWorkerWorkspaceRuntime({
        root: path.join(home, "node-host"),
        env: { PATH: process.env.PATH, HOME: home },
      });
      await capture(replacement, restored.remoteWorkspaceDir);
      expect(
        JSON.parse(checkpoint!.currentManifestRaw).entries.map(
          (entry: { path: string }) => entry.path,
        ),
      ).toContain("published[1].ignored");
      if (!filters) {
        const snapshot = JSON.parse(
          await fs.readFile(
            path.join(checkpoint!.publicationStagingRoot!, "snapshot.json"),
            "utf8",
          ),
        );
        expect(snapshot.entries.map((entry: { path: string }) => entry.path)).toContain(
          "published[1].ignored",
        );
        expect(snapshot.entries.map((entry: { path: string }) => entry.path)).not.toContain(
          "retained.ignored",
        );
        expect(snapshot.entries).toContainEqual({
          path: "retained-removal.ignored",
          mode: "100644",
          sha: null,
        });
      }
    } finally {
      await server.close();
      await service.closeAll();
    }
  },
);
