import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import {
  ensureStagedInputDirectory,
  stagedInputDirectory,
  stagedInputFileName,
} from "../../media/staged-inputs.js";
import { createStagedInputOwnershipFixture } from "../../media/staged-inputs.test-support.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { captureGitHubPublicationWorkspaceSnapshot } from "../github-publication-git-transport.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import type { WorkerWorkspaceReconciliationJournal } from "./workspace-manifest.js";
import { ConcurrentWorkspacePathError } from "./workspace-reconcile.js";
import {
  deleteStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  "git",
  "git-with-empty-include",
  "git-with-explicit-include",
  "git-with-marker-only-include",
  "plain",
])(
  "reconciles private inputs staged after dispatch through the node transport (%s)",
  async (mode) => {
    const root = await fs.realpath(tempDirs.make("node-workspace-input-retention-"));
    const localPath = path.join(root, "gateway-workspace");
    await fs.mkdir(localPath);
    await fs.writeFile(path.join(localPath, "project.txt"), "existing project file\n");
    await fs.writeFile(
      path.join(localPath, ".gitignore"),
      "unrelated-private.txt\nmedia/inbound/openclaw-staged-*/\n",
    );
    const explicitlyIncluded = `${stagedInputDirectory("d".repeat(64))}/input-secret.txt`;
    if (mode.startsWith("git-with-")) {
      const includePaths =
        mode === "git-with-explicit-include"
          ? [explicitlyIncluded, explicitlyIncluded.replace("secret.txt", "cache.pyc")]
          : mode === "git-with-marker-only-include"
            ? [`${stagedInputDirectory("a1".repeat(32))}/.gitignore`]
            : [];
      await fs.writeFile(path.join(localPath, ".worktreeinclude"), includePaths.join("\n"));
    }
    if (mode !== "plain") {
      await requireGit(localPath, ["init", "--quiet"]);
      await requireGit(localPath, ["add", "."]);
      await requireGit(localPath, [
        "-c",
        "user.name=Workspace Test",
        "-c",
        "user.email=workspace@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "base before attachments",
      ]);
    }
    const ownership = await createStagedInputOwnershipFixture(localPath);
    const owner = new AbortController();
    const environmentId = "input-worker";
    const sessionId = "input-session";
    const ownerEpoch = 1;
    const service = createNodeWorkspaceTransferService({
      getOwner: () => ({
        credential: { ownerEpoch, sessionId, expiresAtMs: Date.now() + 60_000 },
        environment: {
          ownerEpoch,
          attachedSessionIds: [sessionId],
          destroyRequestedAtMs: null,
          state: "attached",
        },
      }),
      temporaryRoot: path.join(root, "transfers"),
    });
    const server = await startNodeWorkspaceTransferTestServer(service);
    const runtime = new NodeWorkerWorkspaceRuntime({ root: path.join(root, "node") });
    const actions = createNodeWorkerWorkspaceActions({
      environmentId,
      ownerEpoch,
      sessionId,
      ownerSignal: owner.signal,
      isOwnerCurrent: () => !owner.signal.aborted,
      workspaceTransfer: service,
      runWorkspaceCommand: (command) =>
        runtime.exec(
          {
            ...command,
            argv: [...command.argv],
            gatewayNamespace: "gateway-input-test",
            environmentId,
            sessionId,
            generation: ownerEpoch,
          },
          command.signal,
          { url: server.gatewayUrl },
        ),
    });
    try {
      const synced = await actions.syncWorkspace({ localPath, sessionId, generation: ownerEpoch });
      expect(synced.mode).toBe(mode === "plain" ? "plain" : "git");
      const remote = synced.remoteWorkspaceDir;
      for (const relative of ownership.ownedFiles) {
        await expect(fs.readFile(path.join(remote, relative))).resolves.toEqual(
          await fs.readFile(path.join(localPath, relative)),
        );
      }
      const selectedProjectFile = (relative: string) =>
        (mode === "plain" && !relative.endsWith(".pyc")) ||
        (mode === "git-with-explicit-include" && relative === explicitlyIncluded);
      for (const relative of ownership.unownedFiles) {
        if (selectedProjectFile(relative)) {
          await expect(fs.readFile(path.join(remote, relative))).resolves.toEqual(
            await fs.readFile(path.join(localPath, relative)),
          );
        } else {
          await expect
            .soft(fs.stat(path.join(remote, relative)), relative)
            .rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      // New ignored project files on the worker must not be promoted on return either.
      await createStagedInputOwnershipFixture(remote);
      for (const relative of ownership.unownedFiles) {
        await fs.writeFile(path.join(remote, relative), "worker project bytes\n");
      }
      const ordinaryOutput =
        mode === "plain" ? `${stagedInputDirectory("a1".repeat(32))}/new-output.txt` : undefined;
      if (ordinaryOutput) {
        await fs.writeFile(path.join(remote, ordinaryOutput), "ordinary project output\n");
      }
      let baseManifestRef = synced.manifestRef;
      let pending: WorkerWorkspaceReconciliationJournal | undefined;
      const reconcile = async (claimId: string) => {
        const ref = workerWorkspaceResultRef(claimId);
        let recorded: string | undefined;
        const quiescence = await actions.quiesceWorkspace(remote);
        try {
          const result = await actions.reconcileWorkspace({
            localPath,
            remoteWorkspaceDir: remote,
            baseManifestRef,
            journal: {
              load: () => pending,
              begin: (next) => {
                pending = next;
              },
              commit: (accepted) => {
                baseManifestRef = accepted;
                pending = undefined;
              },
              abort: () => {
                pending = undefined;
              },
            },
            stagedResult: {
              ref,
              record: (value) => {
                recorded = value;
              },
            },
          });
          const applied = await verifyReconciledWorkspaceFinal(result, quiescence);
          expect(recorded).toBe(ref);
          expect(baseManifestRef).toBe(result.manifestRef);
          await deleteStagedWorkerWorkspaceResult({ root: localPath, stagedResultRef: ref });
          return applied;
        } finally {
          await quiescence.resume();
        }
      };
      const attachmentsRoot = path.join(root, "attachments");
      await fs.mkdir(attachmentsRoot);
      const directory = stagedInputDirectory("a".repeat(64));
      await ensureStagedInputDirectory(attachmentsRoot, directory);
      const notesPath = `${directory}/${stagedInputFileName("notes.txt")}`;
      const pngPath = `${directory}/${stagedInputFileName("image.png")}`;
      const png = createSolidPngBuffer(3, 3, { r: 255, g: 0, b: 0 });
      const originalNotes = Buffer.from("original private notes\n");
      const expected = new Map([
        [notesPath, originalNotes],
        [`${directory}/input-cache.pyc`, Buffer.from("original input cache\n")],
        [pngPath, png],
        [`${directory}/${stagedInputFileName(".gitignore")}`, Buffer.from("!*\n")],
        [
          `${directory}/${stagedInputFileName(".git")}`,
          Buffer.from("ordinary input, not Git metadata\n"),
        ],
      ]);
      for (const [relative, bytes] of expected) {
        await fs.writeFile(path.join(attachmentsRoot, relative), bytes);
      }
      expected.set(
        `${directory}/.gitignore`,
        await fs.readFile(path.join(attachmentsRoot, directory, ".gitignore")),
      );
      const stage = () =>
        actions.stageAttachments!({
          localPath: attachmentsRoot,
          isAuthorized: () => !owner.signal.aborted,
          signal: owner.signal,
        });
      await stage();
      const editedNotes = Buffer.from("original private notes\nINPUT_EDIT_PRESERVED\n");
      await fs.writeFile(path.join(remote, notesPath), editedNotes);
      expected.set(notesPath, editedNotes);
      await fs.copyFile(path.join(remote, pngPath), path.join(remote, "proof-output.png"));
      await fs.writeFile(path.join(remote, "unrelated-keep.txt"), "unrelated worker file\n");
      await fs.writeFile(path.join(remote, "unrelated-private.txt"), "unselected ignored file\n");

      const assertRetained = async () => {
        if (ordinaryOutput) {
          await expect(fs.readFile(path.join(localPath, ordinaryOutput), "utf8")).resolves.toBe(
            "ordinary project output\n",
          );
        }
        for (const relative of ownership.unownedFiles) {
          await expect(fs.readFile(path.join(localPath, relative), "utf8")).resolves.toBe(
            selectedProjectFile(relative)
              ? "worker project bytes\n"
              : `fixture bytes: ${relative}\n`,
          );
        }
        for (const [relative, bytes] of expected) {
          // Assert Gateway bytes first: a successful upload alone did not prove retention.
          await expect(fs.readFile(path.join(localPath, relative))).resolves.toEqual(bytes);
          await expect(fs.readFile(path.join(remote, relative))).resolves.toEqual(bytes);
        }
        await expect(fs.readFile(path.join(localPath, "proof-output.png"))).resolves.toEqual(png);
        await expect(fs.readFile(path.join(localPath, "unrelated-keep.txt"), "utf8")).resolves.toBe(
          "unrelated worker file\n",
        );
        await expect(fs.readFile(path.join(localPath, "project.txt"), "utf8")).resolves.toBe(
          "existing project file\n",
        );
        if (mode !== "plain") {
          await expect(
            fs.stat(path.join(localPath, "unrelated-private.txt")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          const publication = await captureGitHubPublicationWorkspaceSnapshot({ cwd: localPath });
          const published = (
            await requireGit(localPath, ["ls-tree", "-r", "--name-only", publication.workspaceTree])
          ).split("\n");
          expect(published).toEqual(
            expect.arrayContaining(["project.txt", "proof-output.png", "unrelated-keep.txt"]),
          );
          for (const relative of expected.keys()) {
            expect(published).not.toContain(relative);
          }
          expect(await requireGit(localPath, ["ls-files", "--", "media/inbound"])).toBe("");
        }
      };
      expect((await reconcile("first-input-turn"))?.conflictPaths).toEqual([]);
      await assertRetained();

      const nextDirectory = stagedInputDirectory("b".repeat(64));
      await ensureStagedInputDirectory(attachmentsRoot, nextDirectory);
      const nextPath = `${nextDirectory}/${stagedInputFileName("next.txt")}`;
      const nextBytes = Buffer.from("next turn input\n");
      await fs.writeFile(path.join(attachmentsRoot, nextPath), nextBytes);
      expected.set(nextPath, nextBytes);
      expected.set(
        `${nextDirectory}/.gitignore`,
        await fs.readFile(path.join(attachmentsRoot, nextDirectory, ".gitignore")),
      );
      // The source still contains originalNotes; repeated staging must preserve the worker edit.
      await stage();
      await expect(fs.readFile(path.join(remote, notesPath))).resolves.toEqual(editedNotes);
      const editedCache = Buffer.from("edited input cache\n");
      await fs.writeFile(path.join(remote, directory, "input-cache.pyc"), editedCache);
      expected.set(`${directory}/input-cache.pyc`, editedCache);
      expect((await reconcile("next-input-turn"))?.conflictPaths).toEqual([]);
      await assertRetained();

      for (const { kind, identity, markerBefore } of [
        { kind: "addition", identity: "d".repeat(64), markerBefore: undefined },
        { kind: "replacement", identity: "e".repeat(64), markerBefore: Buffer.from("*\n") },
        {
          kind: "unchanged-marker-new-child",
          identity: "a1".repeat(32),
          markerBefore: expected.get(`${directory}/.gitignore`)!,
        },
      ]) {
        // Each marker addition/replacement starts from its own authoritative dispatch.
        const collisionDispatch = await actions.syncWorkspace({
          localPath,
          sessionId,
          generation: ownerEpoch,
        });
        baseManifestRef = collisionDispatch.manifestRef;
        expect(collisionDispatch.remoteWorkspaceDir).toBe(remote);
        const collision = stagedInputDirectory(identity);
        const markerPath = path.join(localPath, collision, ".gitignore");
        if (markerBefore) {
          await expect(fs.readFile(markerPath)).resolves.toEqual(markerBefore);
        } else {
          await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
        const markerLinksBefore = markerBefore ? (await fs.lstat(markerPath)).nlink : undefined;
        await fs.mkdir(path.join(remote, collision), { recursive: true });
        const workerMarker = path.join(remote, collision, ".gitignore");
        await fs.rm(workerMarker, { force: true });
        await fs.writeFile(workerMarker, expected.get(`${directory}/.gitignore`)!, { flag: "wx" });
        const localPrivate = new Map<string, Buffer>();
        for (const name of ["input-secret.txt", "input-cache.pyc"]) {
          const relative = `${collision}/${name}`;
          localPrivate.set(relative, await fs.readFile(path.join(localPath, relative)));
          await fs.writeFile(path.join(remote, relative), `worker collision bytes: ${relative}\n`);
        }
        const acceptedBeforeCollision = baseManifestRef;
        const claimId = `unowned-target-${kind}`;
        const collisionError = await reconcile(claimId).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect.soft(collisionError).toBeInstanceOf(ConcurrentWorkspacePathError);
        expect.soft(collisionError).toMatchObject({ message: expect.stringContaining("unowned") });
        if (markerBefore) {
          await expect.soft(fs.readFile(markerPath)).resolves.toEqual(markerBefore);
          expect.soft((await fs.lstat(markerPath)).nlink).toBe(markerLinksBefore);
        } else {
          await expect.soft(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
        for (const [relative, bytes] of localPrivate) {
          await expect.soft(fs.readFile(path.join(localPath, relative))).resolves.toEqual(bytes);
          await expect
            .soft(fs.readFile(path.join(remote, relative), "utf8"))
            .resolves.toBe(`worker collision bytes: ${relative}\n`);
        }
        expect.soft(baseManifestRef).toBe(acceptedBeforeCollision);
        expect.soft(pending).toBeUndefined();
        if (collisionError !== undefined) {
          await deleteStagedWorkerWorkspaceResult({
            root: localPath,
            stagedResultRef: workerWorkspaceResultRef(claimId),
          });
        }
        await fs.rm(path.join(remote, collision), { recursive: true });
      }
    } finally {
      owner.abort();
      await service.closeAll();
      await server.close();
    }
  },
);

it("restores node reconciliation after Gateway bootstrap changes without replacing its Git base", async () => {
  const root = await fs.realpath(tempDirs.make("node-workspace-restart-"));
  const localPath = path.join(root, "gateway-workspace");
  await fs.mkdir(localPath);
  await fs.writeFile(path.join(localPath, "project.txt"), "base project\n");
  await requireGit(localPath, ["init", "--quiet"]);
  await requireGit(localPath, ["config", "user.name", "Workspace Test"]);
  await requireGit(localPath, ["config", "user.email", "workspace@example.invalid"]);
  await requireGit(localPath, ["add", "."]);
  await requireGit(localPath, ["commit", "--quiet", "-m", "base before dispatch"]);
  const baseCommit = (await requireGit(localPath, ["rev-parse", "HEAD"])).trim();
  const owner = new AbortController();
  const environmentId = "restart-worker";
  const sessionId = "restart-session";
  const ownerEpoch = 1;
  const createService = () =>
    createNodeWorkspaceTransferService({
      getOwner: () => ({
        credential: { ownerEpoch, sessionId },
        environment: {
          ownerEpoch,
          attachedSessionIds: [sessionId],
          destroyRequestedAtMs: null,
          state: "attached",
        },
      }),
      temporaryRoot: path.join(root, "transfers"),
    });
  let service = createService();
  let server = await startNodeWorkspaceTransferTestServer(service);
  const runtime = new NodeWorkerWorkspaceRuntime({ root: path.join(root, "node") });
  const createActions = (
    restoredWorkspace?: Parameters<typeof createNodeWorkerWorkspaceActions>[0]["restoredWorkspace"],
  ) =>
    createNodeWorkerWorkspaceActions({
      environmentId,
      ownerEpoch,
      sessionId,
      ownerSignal: owner.signal,
      isOwnerCurrent: () => !owner.signal.aborted,
      workspaceTransfer: service,
      restoredWorkspace,
      runWorkspaceCommand: (command) =>
        runtime.exec(
          {
            ...command,
            argv: [...command.argv],
            gatewayNamespace: "gateway-restart-test",
            environmentId,
            sessionId,
            generation: ownerEpoch,
          },
          command.signal,
          { url: server.gatewayUrl },
        ),
    });
  try {
    const synced = await createActions().syncWorkspace({
      localPath,
      sessionId,
      generation: ownerEpoch,
    });
    const remote = synced.remoteWorkspaceDir;
    for (const name of ["SOUL.md", "USER.md", "IDENTITY.md"]) {
      await fs.writeFile(path.join(localPath, name), `local bootstrap ${name}\n`);
    }
    await requireGit(localPath, ["add", "SOUL.md", "USER.md", "IDENTITY.md"]);
    await requireGit(localPath, ["commit", "--quiet", "-m", "local bootstrap after dispatch"]);
    const gatewayCommit = (await requireGit(localPath, ["rev-parse", "HEAD"])).trim();
    expect(gatewayCommit).not.toBe(baseCommit);
    await fs.writeFile(path.join(localPath, "project.txt"), "Gateway project edit\n");
    await fs.writeFile(path.join(remote, "project.txt"), "worker project edit\n");
    await fs.writeFile(path.join(remote, "result.txt"), "worker result\n");
    await service.closeAll();
    await server.close();
    service = createService();
    server = await startNodeWorkspaceTransferTestServer(service);
    const restored = createActions({
      localPath,
      manifestRef: synced.manifestRef,
      remoteWorkspaceDir: remote,
    });
    await restored.validateRestoredWorkspace();

    let pending: WorkerWorkspaceReconciliationJournal | undefined;
    let accepted: string | undefined;
    const request = {
      localPath,
      remoteWorkspaceDir: remote,
      baseManifestRef: synced.manifestRef,
      journal: {
        load: () => pending,
        begin: (next: WorkerWorkspaceReconciliationJournal) => {
          pending = next;
        },
        commit: (ref: string) => {
          accepted = ref;
          pending = undefined;
        },
        abort: () => {
          pending = undefined;
        },
      },
    };
    const quiescence = await restored.quiesceWorkspace(remote);
    try {
      const result = await restored.reconcileWorkspace(request);
      await verifyReconciledWorkspaceFinal(result, quiescence);
      expect(result.getAppliedWorkspaceResult?.()?.conflictPaths).toEqual(["project.txt"]);
      expect(accepted).toBe(result.manifestRef);
    } finally {
      await quiescence.resume();
    }
    for (const workspace of [localPath, remote]) {
      await expect(fs.readFile(path.join(workspace, "project.txt"), "utf8")).resolves.toBe(
        "Gateway project edit\n",
      );
      await expect(fs.readFile(path.join(workspace, "result.txt"), "utf8")).resolves.toBe(
        "worker result\n",
      );
    }
    for (const name of ["SOUL.md", "USER.md", "IDENTITY.md"]) {
      await expect(fs.readFile(path.join(localPath, name), "utf8")).resolves.toBe(
        `local bootstrap ${name}\n`,
      );
    }
    expect((await requireGit(localPath, ["rev-parse", "HEAD"])).trim()).toBe(gatewayCommit);
    expect((await requireGit(remote, ["rev-parse", "HEAD"])).trim()).toBe(baseCommit);
    owner.abort();
    await expect(restored.reconcileWorkspace(request)).rejects.toThrow(
      "Node workspace transfer context is unavailable",
    );
  } finally {
    owner.abort();
    await service.closeAll();
    await server.close();
  }
});
