import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { stageSandboxMedia } from "../../auto-reply/reply/stage-sandbox-media.js";
import { withSandboxMediaTempHome } from "../../auto-reply/stage-sandbox-media.test-harness.js";
import { captureGitHubPublicationWorkspaceSnapshot } from "../../gateway/github-publication-git-transport.js";
import { prepareNodeWorkspaceTransferSnapshot } from "../../gateway/worker-environments/node-workspace-transfer-snapshot.js";
import { prepareWorkerTurnMedia } from "../../gateway/worker-environments/worker-turn-media.js";
import { parseWorkerWorkspaceManifest } from "../../gateway/worker-environments/workspace-manifest.js";
import { applyStagedWorkerWorkspace } from "../../gateway/worker-environments/workspace-reconcile.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "../../gateway/worker-environments/workspace-sync-scripts.js";
import { createStagedInputOwnershipFixture } from "../../media/staged-inputs.test-support.js";
import { saveMediaBuffer } from "../../media/store.js";
import {
  captureManifest,
  runWorkspaceCommand,
} from "../../node-host/node-worker-workspace-commands.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { requireGit } from "./git.js";
import { ManagedWorktreeService } from "./service.js";
import { initializeManagedWorktreeTestRepository } from "./service.test-support.js";

const sandbox = vi.hoisted(() => ({ ensureSandboxWorkspaceForSession: vi.fn() }));
vi.mock("../sandbox.js", () => sandbox);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

it.each(["host", "writable sandbox", "cloud"])(
  "retains private staged inputs through reconciliation and restore without publishing them (%s)",
  async (mode) => {
    await withSandboxMediaTempHome("private-input-lifecycle-", async (home) => {
      const repo = await initializeManagedWorktreeTestRepository(home);
      const png = createSolidPngBuffer(3, 3, { r: 255, g: 0, b: 0 });
      await fs.mkdir(path.join(repo, "media/inbound"), { recursive: true });
      await fs.writeFile(path.join(repo, "media/inbound/project.png"), png);
      await fs.writeFile(
        path.join(repo, ".gitignore"),
        "unrelated-private.txt\nmedia/inbound/openclaw-staged-*/\n",
      );
      const explicitInput = `media/inbound/openclaw-staged-${"d".repeat(64)}/input-secret.txt`;
      await fs.mkdir(path.dirname(path.join(repo, explicitInput)), { recursive: true });
      await fs.writeFile(path.join(repo, explicitInput), `fixture bytes: ${explicitInput}\n`);
      await fs.writeFile(path.join(repo, ".worktreeinclude"), `${explicitInput}\n`);
      await requireGit(repo, [
        "add",
        ".gitignore",
        ".worktreeinclude",
        "media/inbound/project.png",
      ]);
      await requireGit(repo, ["commit", "-qm", "project-owned inputs"]);
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(home, "state") };
      const service = new ManagedWorktreeService({ env });
      const worktree = await service.create({ repoRoot: repo, name: "inputs", baseRef: "HEAD" });
      const cwd = worktree.path;
      const git = (args: string[]) => requireGit(cwd, args);
      const originalHead = await git(["rev-parse", "HEAD"]);
      const snapshot = async (localPath: string, name: string) => {
        const temporaryRoot = path.join(home, name);
        await fs.mkdir(temporaryRoot);
        return await prepareNodeWorkspaceTransferSnapshot({ localPath, temporaryRoot });
      };
      // Cloud attachments arrive after dispatch: their manifest is not the workspace base.
      const dispatched = mode === "cloud" ? await snapshot(cwd, "dispatch") : undefined;
      const remote = path.join(home, "remote");
      await requireGit(home, ["clone", "--quiet", "--no-hardlinks", cwd, remote]);
      const producerRoot = mode === "cloud" ? remote : cwd;
      const saved = await saveMediaBuffer(png, "image/png", "inbound");
      const text = await saveMediaBuffer(
        Buffer.from("private source text"),
        "text/plain",
        "inbound",
      );
      const controls = [".gitignore", ".git", "cache.pyc"];
      for (const name of controls) {
        await fs.writeFile(path.join(path.dirname(saved.path), name), "!*\n");
      }
      const media = [
        { path: saved.path, contentType: "image/png" },
        { path: text.path, contentType: "text/plain" },
        ...controls.map((name) => ({
          path: path.join(path.dirname(saved.path), name),
          contentType: "text/plain",
        })),
      ];
      let inputs: string[];
      if (mode === "cloud") {
        const unused = async () => {
          throw new Error("unexpected transport operation");
        };
        await prepareWorkerTurnMedia({
          turn: {
            sessionId: "inputs",
            agentId: "main",
            sessionFile: path.join(home, "session.sqlite"),
            workspaceDir: cwd,
            prompt: "inspect these inputs",
            media,
            runId: "input-turn",
            timeoutMs: 10_000,
          },
          history: [],
          workspace: { kind: "local", path: cwd },
          remoteWorkspaceDir: remote,
          isAuthorized: () => true,
          signal: new AbortController().signal,
          tunnel: {
            environmentId: "input-worker",
            ownerEpoch: 1,
            runWorkspaceCommand: unused,
            syncWorkspace: unused,
            reconcileWorkspace: unused,
            quiesceWorkspace: unused,
            stop: unused,
            stageAttachments: async ({ localPath }) => {
              for (const file of await fs.readdir(localPath, { recursive: true })) {
                const source = path.join(localPath, file);
                if ((await fs.stat(source)).isFile()) {
                  await fs.mkdir(path.dirname(path.join(remote, file)), { recursive: true });
                  await fs.copyFile(source, path.join(remote, file), fs.constants.COPYFILE_EXCL);
                }
              }
            },
          },
        });
        inputs = (await fs.readdir(path.join(remote, "media/inbound"), { recursive: true }))
          .filter((file) => path.basename(file).startsWith("input-"))
          .map((file) => `media/inbound/${file.split(path.sep).join("/")}`);
        inputs.sort((a, b) => {
          const order = (file: string) =>
            file.endsWith(path.basename(saved.path))
              ? 0
              : file.endsWith(path.basename(text.path))
                ? 1
                : 2;
          return order(a) - order(b);
        });
      } else {
        sandbox.ensureSandboxWorkspaceForSession.mockResolvedValue(
          mode === "host" ? null : { workspaceDir: cwd, workspaceAccess: "rw" },
        );
        const ctx = { media };
        const staged = await stageSandboxMedia({
          ctx,
          sessionCtx: ctx,
          cfg: {},
          sessionKey: "agent:main:inputs",
          workspaceDir: cwd,
        });
        inputs = [...staged.staged.values()].map((file) =>
          path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join("/"),
        );
      }
      expect(inputs).toHaveLength(5);
      for (const name of controls) {
        const file = inputs.find((input) => input.endsWith(`/input-${name}`));
        expect(file).toBeDefined();
        await expect(fs.readFile(path.join(producerRoot, file!), "utf8")).resolves.toBe("!*\n");
      }
      await fs.copyFile(
        path.join(producerRoot, inputs[0]!),
        path.join(producerRoot, "project-output.png"),
      );
      const assertPublication = async (root: string) => {
        const captured = await captureGitHubPublicationWorkspaceSnapshot({ cwd: root });
        const files = (
          await requireGit(root, ["ls-tree", "-r", "--name-only", captured.workspaceTree])
        ).split("\n");
        expect(files).toContain("project-output.png");
        expect(files).toContain("media/inbound/project.png");
        for (const input of inputs) {
          expect(files).not.toContain(input);
        }
      };
      await assertPublication(producerRoot);
      const base = dispatched ?? (await snapshot(cwd, "initial-transfer"));
      if (!dispatched) {
        for (const input of inputs) {
          expect(base.manifest.entries.map((entry) => entry.path)).toContain(input);
        }
        for (const entry of base.manifest.entries) {
          await fs.mkdir(path.dirname(path.join(remote, entry.path)), { recursive: true });
          await fs.copyFile(path.join(cwd, entry.path), path.join(remote, entry.path));
        }
      }
      // Download registers the received inventory before later captures reference it.
      expect(
        (
          await runWorkspaceCommand({
            workspaceDir: remote,
            homeDir: home,
            argv: [
              "node",
              "-e",
              REMOTE_WORKSPACE_MANIFEST_JS,
              remote,
              base.manifest.baseCommit ?? "",
              "publish",
              base.manifestRef.slice("sha256:".length),
            ],
            input: base.rawManifest,
          })
        ).trim(),
      ).toBe(base.manifestRef);
      const edited = createSolidPngBuffer(3, 3, { r: 0, g: 0, b: 255 });
      await fs.writeFile(path.join(remote, inputs[0]!), edited);
      await fs.writeFile(path.join(remote, inputs[1]!), "edited private source text");
      const manifestRef = await captureManifest({
        workspaceDir: remote,
        manifestHome: home,
        baseCommit: base.manifest.baseCommit,
        referenceManifestRef: base.manifestRef,
      });
      const raw = await fs.readFile(
        path.join(home, ".openclaw-worker", "manifests", `${manifestRef.slice(7)}.json`),
        "utf8",
      );
      const current = parseWorkerWorkspaceManifest(raw, manifestRef);
      const applied = await applyStagedWorkerWorkspace({
        root: cwd,
        stagingRoot: remote,
        baseManifestRef: base.manifestRef,
        currentManifestRef: manifestRef,
        base: base.manifest,
        current,
        journal: { load: () => undefined, begin: () => {}, commit: () => {}, abort: () => {} },
      });
      expect(applied.conflictPaths).toEqual([]);
      const replacement = await snapshot(cwd, "replacement-transfer");
      for (const input of inputs) {
        expect(replacement.manifest.entries.map((entry) => entry.path)).toContain(input);
      }
      const ownership = await createStagedInputOwnershipFixture(cwd);
      await service.remove({ id: worktree.id, reason: "input-retention-proof" });
      await service.restore({ id: worktree.id });
      for (const relative of ownership.ownedFiles) {
        await expect(fs.readFile(path.join(cwd, relative), "utf8")).resolves.toBe(
          `fixture bytes: ${relative}\n`,
        );
      }
      for (const relative of ownership.unownedFiles) {
        if (relative === explicitInput) {
          await expect(fs.readFile(path.join(cwd, relative), "utf8")).resolves.toBe(
            `fixture bytes: ${relative}\n`,
          );
        } else {
          await expect(fs.stat(path.join(cwd, relative))).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      expect(await git(["rev-parse", "HEAD"])).toBe(originalHead);
      expect(await git(["diff", "--cached", "--name-only"])).toBe("");
      for (const input of inputs) {
        expect(await git(["ls-files", "--", input])).toBe("");
        expect(await git(["check-ignore", "--", input])).toBe(input);
      }
      await expect(fs.readFile(path.join(cwd, inputs[0]!))).resolves.toEqual(edited);
      for (const name of controls) {
        const file = inputs.find((input) => input.endsWith(`/input-${name}`))!;
        await expect(fs.readFile(path.join(cwd, file), "utf8")).resolves.toBe("!*\n");
      }
      await expect(fs.readFile(path.join(cwd, inputs[1]!), "utf8")).resolves.toBe(
        "edited private source text",
      );
      await expect(fs.readFile(path.join(cwd, "media/inbound/project.png"))).resolves.toEqual(png);
      await expect(fs.readFile(path.join(cwd, ".gitignore"), "utf8")).resolves.toBe(
        "unrelated-private.txt\nmedia/inbound/openclaw-staged-*/\n",
      );
      await expect(fs.readFile(path.join(cwd, ".worktreeinclude"), "utf8")).resolves.toBe(
        `${explicitInput}\n`,
      );
      await assertPublication(cwd);
      closeOpenClawStateDatabaseForTest();
    });
  },
);
