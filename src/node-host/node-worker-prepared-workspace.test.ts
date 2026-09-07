import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { parseRemoteWorkspaceManifestCapture } from "../gateway/worker-environments/workspace-hash-memo.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
} from "../gateway/worker-environments/workspace-manifest.js";
import * as workspaceReconcile from "../gateway/worker-environments/workspace-reconcile-core.js";
import { readActualWorkspaceManifest } from "../gateway/worker-environments/workspace-reconcile.js";
import { runExec } from "../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { NodeWorkerPreparedWorkspaceBinding } from "../worker/node-workspace-prepared-protocol.js";
import { NODE_WORKSPACE_DRAIN_COMMAND } from "../worker/node-workspace-protocol.js";
import { NodeWorkerPreparedWorkspaceStore } from "./node-worker-prepared-workspace-store.js";
import { waitForNodeWorkerTerminal } from "./node-worker-supervisor.fixture.test-support.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_ENDPOINT,
  TEST_WORKER_SOURCE,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";
import { listen } from "./node-worker-transfer-client.test-support.js";
import * as workspaceCommands from "./node-worker-workspace-commands.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
afterEach(() => vi.restoreAllMocks());
const preparationKey = "a".repeat(64);
const cacheKey = "c".repeat(64);
const binding: NodeWorkerPreparedWorkspaceBinding = {
  action: "bind",
  gatewayNamespace: "gateway-prepared",
  environmentId: "environment-prepared",
  preparationKey,
  cacheKey,
  sessionId: "session-prepared",
  sessionKey: "agent:main:prepared",
  ownerEpoch: 2,
};

async function fixture() {
  const root = fs.realpathSync.native(tempDirs.make("node-prepared-workspace-"));
  const ownerRoot = path.join(
    root,
    ".openclaw-worker",
    "prepared",
    binding.gatewayNamespace,
    cacheKey,
  );
  const workspaceDir = path.join(ownerRoot, "workspace");
  const homeDir = path.join(ownerRoot, "home");
  await Promise.all([
    fsp.mkdir(workspaceDir, { recursive: true }),
    fsp.mkdir(homeDir, { recursive: true }),
  ]);
  const git = async (...args: string[]) =>
    (await runExec("git", ["-C", workspaceDir, ...args], { timeoutMs: 10_000 })).stdout.trim();
  await git("init", "--quiet");
  await fsp.writeFile(path.join(workspaceDir, ".gitignore"), ".venv/\n");
  await fsp.writeFile(path.join(workspaceDir, "source.txt"), "prepared source\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Prepared Test",
    "-c",
    "user.email=prepared@example.test",
    "commit",
    "--quiet",
    "-m",
    "prepared source",
  );
  const baseCommit = await git("rev-parse", "HEAD");
  const { manifestRef: sourceManifestRef, manifest } = await readActualWorkspaceManifest({
    root: workspaceDir,
    baseCommit,
  });
  const manifests = path.join(homeDir, ".openclaw-worker", "manifests");
  await fsp.mkdir(manifests, { recursive: true });
  await fsp.writeFile(
    path.join(manifests, `${sourceManifestRef.slice(7)}.json`),
    serializeWorkerWorkspaceManifest(manifest),
  );
  // Setup output appears after the pristine source manifest, as in project preparation.
  await fsp.mkdir(path.join(workspaceDir, ".venv"));
  await fsp.writeFile(
    path.join(workspaceDir, ".venv", "absolute-path"),
    `${workspaceDir}\n${homeDir}`,
  );
  const env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const options = { env, ephemeral: true };
  const runtime = new NodeWorkerWorkspaceRuntime(options);
  const registration = {
    action: "register" as const,
    gatewayNamespace: binding.gatewayNamespace,
    environmentId: binding.environmentId,
    preparationKey,
    cacheKey,
    workspaceDir,
    homeDir,
    sourceManifestRef,
  };
  const request = {
    workspaceDir,
    environmentId: binding.environmentId,
    sessionId: binding.sessionId,
    sessionKey: binding.sessionKey,
    ownerEpoch: binding.ownerEpoch,
  };
  const command = {
    gatewayNamespace: binding.gatewayNamespace,
    environmentId: binding.environmentId,
    sessionId: binding.sessionId,
    sessionKey: binding.sessionKey,
    preparationKey,
    generation: binding.ownerEpoch,
    argv: ["node", "-e", "process.stdout.write(process.cwd() + '\\n' + process.env.HOME)"],
  };
  return {
    root,
    ownerRoot,
    workspaceDir,
    homeDir,
    env,
    options,
    runtime,
    registration,
    request,
    command,
    baseCommit,
  };
}

describe("prepared node workspace ownership", () => {
  it("reuses registration hashes only in the bound generation and revalidates later edits", async () => {
    const f = await fixture();
    await f.runtime.prepare(f.registration);
    await expect(f.runtime.prepare({ ...binding, preparationKey: "b".repeat(64) })).rejects.toThrow(
      "does not match",
    );
    await f.runtime.prepare(binding);
    const capture = async (runtime = f.runtime) =>
      parseRemoteWorkspaceManifestCapture(
        (
          await runtime.exec({
            ...f.command,
            capture: {
              baseManifestRef: f.registration.sourceManifestRef,
              referenceManifestRef: f.registration.sourceManifestRef,
            },
          })
        ).stdout,
      );
    expect(await capture()).toMatchObject({
      manifestRef: f.registration.sourceManifestRef,
      metrics: { contentHashCount: 0, memoHitCount: 2 },
    });
    const sourcePath = path.join(f.workspaceDir, "source.txt");
    const originalStat = await fsp.stat(sourcePath);
    await fsp.writeFile(sourcePath, "modified source\n");
    await fsp.utimes(sourcePath, originalStat.atime, originalStat.mtime);
    const changed = await capture();
    expect(changed.manifestRef).not.toBe(f.registration.sourceManifestRef);
    expect(changed.metrics).toMatchObject({ contentHashCount: 1, memoHitCount: 1 });
    await f.runtime.prepare(binding);
    expect(await capture()).toMatchObject({
      manifestRef: changed.manifestRef,
      metrics: { contentHashCount: 0, memoHitCount: 2 },
    });
    expect(await capture(new NodeWorkerWorkspaceRuntime(f.options))).toMatchObject({
      manifestRef: changed.manifestRef,
      metrics: { contentHashCount: 2, memoHitCount: 0 },
    });
  });

  it.each([false, true])("serializes bind behind registration (aborted: %s)", async (aborted) => {
    const f = await fixture();
    const controller = new AbortController();
    const captured = createDeferred();
    const released = createDeferred();
    const capture = workspaceCommands.captureManifest;
    vi.spyOn(workspaceCommands, "captureManifest").mockImplementationOnce(async (params) => {
      const result = await capture(params);
      captured.resolve();
      await released.promise;
      return result;
    });
    const registration = f.runtime.prepare(f.registration, controller.signal);
    const registrationResult = registration.then(
      () => "registered",
      () => "rejected",
    );
    await captured.promise;
    const bound = f.runtime.prepare(binding);
    const bindingResult = bound.then(
      () => "bound",
      () => "rejected",
    );
    if (aborted) {
      controller.abort();
    }
    released.resolve();
    expect(await registrationResult).toBe(aborted ? "rejected" : "registered");
    expect(await bindingResult).toBe(aborted ? "rejected" : "bound");
    const row = new NodeWorkerPreparedWorkspaceStore({ env: f.env }).find(binding.environmentId);
    if (aborted) {
      expect(row).toBeUndefined();
    } else {
      expect(row).toMatchObject({ state: "bound", session_id: binding.sessionId });
    }
  });

  it("requires the bound host session key before launching a worker with prepared HOME", async () => {
    const f = await fixture();
    await f.runtime.prepare(f.registration);
    await f.runtime.prepare(binding);
    const input = testWorkerLaunchInput(f.workspaceDir, "prepared-turn", "env");
    input.gatewayNamespace = binding.gatewayNamespace;
    input.descriptor.admission.environmentId = binding.environmentId;
    input.descriptor.admission.sessionId = binding.sessionId;
    input.descriptor.admission.ownerEpoch = binding.ownerEpoch;
    const bundleRoot = path.join(f.root, "bundles");
    const bundleDir = path.join(
      bundleRoot,
      binding.gatewayNamespace,
      "bundles",
      input.expectedBundleHash,
    );
    await fsp.mkdir(bundleDir, { recursive: true });
    await fsp.writeFile(path.join(bundleDir, "worker.mjs"), TEST_WORKER_SOURCE);
    const supervisor = createNodeWorkerSupervisor({
      bundleRoot,
      env: f.env,
      workspace: f.runtime,
    });
    try {
      await expect(supervisor.launch(input, TEST_WORKER_ENDPOINT)).rejects.toThrow("bound session");
      await expect(
        supervisor.launch({ ...input, sessionKey: "agent:test:other" }, TEST_WORKER_ENDPOINT),
      ).rejects.toThrow("does not own");
      await expect(
        fsp.stat(path.join(f.workspaceDir, "prepared-turn.started.json")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await supervisor.launch({ ...input, sessionKey: binding.sessionKey }, TEST_WORKER_ENDPOINT);
      expect((await waitForNodeWorkerTerminal(supervisor, input.launchId)).state).toBe("completed");
      const childEnv = JSON.parse(
        await fsp.readFile(path.join(f.workspaceDir, "prepared-turn.env.json"), "utf8"),
      );
      expect(childEnv.HOME).toBe(f.homeDir);
    } finally {
      await supervisor.close();
    }
  });

  it("rejects a prepared command without its registration instead of creating a generation workspace", async () => {
    const f = await fixture();
    await expect(f.runtime.exec(f.command)).rejects.toThrow("registration is missing or changed");
    await expect(
      fsp.stat(path.join(f.root, "state", "node-host", binding.gatewayNamespace)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await f.runtime.prepare(f.registration);
    await f.runtime.prepare(binding);
    await expect(f.runtime.exec({ ...f.command, preparationKey: "b".repeat(64) })).rejects.toThrow(
      "registration is missing or changed",
    );
  });

  it("keeps fixed paths and HOME through exact bind replay and restart, rejecting other owners", async () => {
    const f = await fixture();
    const registered = await f.runtime.prepare(f.registration);
    await expect(f.runtime.prepare(f.registration)).resolves.toEqual(registered);
    await expect(
      f.runtime.prepare({ ...f.registration, cacheKey: "d".repeat(64) }),
    ).rejects.toThrow("escaped");
    await expect(f.runtime.prepare({ ...binding, cacheKey: "d".repeat(64) })).rejects.toThrow(
      "does not match",
    );
    expect(() => f.runtime.acquireManagedWorkspace(f.request)).toThrow("does not own");
    const bound = await f.runtime.prepare(binding);
    await expect(f.runtime.prepare(binding)).resolves.toEqual(bound);
    const restarted = new NodeWorkerWorkspaceRuntime(f.options);
    expect(
      new NodeWorkerPreparedWorkspaceStore({ env: f.env }).find(binding.environmentId),
    ).toMatchObject({
      cache_key: cacheKey,
      preparation_key: preparationKey,
      workspace_dir: f.workspaceDir,
      home_dir: f.homeDir,
    });
    const result = await restarted.exec(f.command);
    expect(result).toMatchObject({
      workspaceDir: f.workspaceDir,
      code: 0,
      stdout: `${f.workspaceDir}\n${f.homeDir}`,
    });
    const acquired = restarted.acquireManagedWorkspace(f.request);
    expect(acquired.homeDir).toBe(f.homeDir);
    acquired.release();
    for (const changed of [
      { sessionId: "other-session" },
      { sessionKey: "other-key" },
      { ownerEpoch: 3 },
      { environmentId: "other-environment" },
      { workspaceDir: f.homeDir },
    ]) {
      expect(() => restarted.acquireManagedWorkspace({ ...f.request, ...changed })).toThrow(
        "INVALID_REQUEST:",
      );
    }
    await expect(restarted.prepare({ ...binding, sessionId: "second-session" })).rejects.toThrow(
      "consumed",
    );
    await expect(restarted.prepare({ ...binding, preparationKey: "b".repeat(64) })).rejects.toThrow(
      "does not match",
    );
    await expect(restarted.prepare(f.registration)).rejects.toThrow("already owns");
    await expect(restarted.exec({ ...f.command, resetWorkspace: true })).rejects.toThrow(
      "cannot be reset",
    );
    await expect(restarted.exec({ ...f.command, sessionKey: undefined })).rejects.toThrow(
      "bound session",
    );
  });

  it("keeps shared nodes unregistered and rejects alias paths before registration", async () => {
    const f = await fixture();
    const shared = new NodeWorkerWorkspaceRuntime({ env: f.env });
    await expect(shared.prepare(f.registration)).rejects.toThrow("dedicated ephemeral");
    const outside = path.join(f.root, "outside");
    await fsp.rename(f.workspaceDir, outside);
    await fsp.symlink(outside, f.workspaceDir, "dir");
    await expect(f.runtime.prepare(f.registration)).rejects.toThrow("escaped");
    expect(
      new NodeWorkerPreparedWorkspaceStore({ env: f.env }).find(binding.environmentId),
    ).toBeUndefined();
    expect(await fsp.readFile(path.join(outside, "source.txt"), "utf8")).toBe("prepared source\n");
  });

  it("retains active bindings and leaves a permanent tombstone after retirement", async () => {
    const f = await fixture();
    await f.runtime.prepare(f.registration);
    await f.runtime.prepare(binding);
    const resourceCommand = {
      ...f.command,
      argv: ["openclaw-internal-skill-resources"],
      skillResources: { operation: "init" as const },
    };
    await expect(
      f.runtime.exec({ ...resourceCommand, sessionKey: "agent:main:other" }),
    ).rejects.toThrow("does not own");
    const initialized = await f.runtime.exec(resourceCommand);
    expect(initialized.code).toBe(0);
    const resourceRoot = (JSON.parse(initialized.stdout) as { root: string }).root;
    expect(path.dirname(resourceRoot)).toBe(f.ownerRoot);
    expect(await fsp.readdir(f.workspaceDir)).not.toContain(path.basename(resourceRoot));
    const retain = {
      version: 1 as const,
      gatewayNamespace: binding.gatewayNamespace,
      controllerId: "retention-owner",
      sequence: 1,
      retain: [],
    };
    const acquired = f.runtime.acquireManagedWorkspace(f.request);
    await expect(f.runtime.applyRetainSnapshot(retain, () => [])).resolves.toMatchObject({
      deleted: 0,
    });
    expect((await fsp.stat(resourceRoot)).isDirectory()).toBe(true);
    acquired.release();
    await expect(
      f.runtime.applyRetainSnapshot({ ...retain, sequence: 2 }, () => []),
    ).resolves.toMatchObject({ deleted: 1 });
    expect(
      new NodeWorkerPreparedWorkspaceStore({ env: f.env }).find(binding.environmentId),
    ).toMatchObject({
      state: "retired",
      cache_key: cacheKey,
      preparation_key: preparationKey,
      session_id: binding.sessionId,
      session_key: binding.sessionKey,
      owner_epoch: binding.ownerEpoch,
    });
    await expect(fsp.stat(f.ownerRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const restarted = new NodeWorkerWorkspaceRuntime(f.options);
    expect(() => restarted.acquireManagedWorkspace(f.request)).toThrow("does not own");
    await expect(restarted.exec(f.command)).rejects.toThrow("does not own");
    await expect(restarted.exec(resourceCommand)).rejects.toThrow("does not own");
  });

  it("leaves an interrupted in-place mutation unusable after restart", async () => {
    const f = await fixture();
    await f.runtime.prepare(f.registration);
    await f.runtime.prepare(binding);
    const store = new NodeWorkerPreparedWorkspaceStore({ env: f.env });
    const row = store.find(binding.environmentId)!;
    const mutation = store.beginMutation(row);
    mutation.close();
    const restarted = new NodeWorkerWorkspaceRuntime(f.options);
    await expect(
      restarted.exec({ ...f.command, argv: [NODE_WORKSPACE_DRAIN_COMMAND] }),
    ).resolves.toMatchObject({
      workspaceDir: f.workspaceDir,
      code: 0,
      stdout: "drained\n",
    });
    expect(() => restarted.acquireManagedWorkspace(f.request)).toThrow("does not own");
    await expect(restarted.prepare(binding)).rejects.toThrow("consumed");
    expect(() => mutation.complete()).toThrow("closed");
    expect(store.find(binding.environmentId)).toMatchObject({
      state: "retiring",
      session_id: binding.sessionId,
    });
  });

  it.each([
    "unchanged",
    "no delta",
    "tracked edit",
    "new eligible file",
    "recreated ignored file",
    "publication failure",
    "apply failure",
  ] as const)(
    "verifies the final prepared overlay without rereading unchanged content: %s",
    async (lateChange) => {
      const f = await fixture();
      await f.runtime.prepare(f.registration);
      await f.runtime.prepare(binding);
      if (lateChange === "recreated ignored file") {
        await fsp.writeFile(path.join(f.workspaceDir, "late.txt"), "eligible original\n");
      }
      const writesLate =
        lateChange === "tracked edit" ||
        lateChange === "new eligible file" ||
        lateChange === "recreated ignored file";
      const original: WorkerWorkspaceManifest = JSON.parse(
        await fsp.readFile(
          path.join(
            f.homeDir,
            ".openclaw-worker",
            "manifests",
            `${f.registration.sourceManifestRef.slice(7)}.json`,
          ),
          "utf8",
        ),
      );
      const body = Buffer.from(
        lateChange === "no delta" ? "prepared source\n" : "session overlay\n",
      );
      const contents = new Map([["source.txt", body]]);
      if (lateChange === "recreated ignored file") {
        contents.set(".gitignore", Buffer.from(".venv/\nlate.txt\n"));
      }
      const blobs = new Map<string, Buffer>();
      const raw = serializeWorkerWorkspaceManifest({
        ...original,
        entries: original.entries.map((entry) => {
          const bytes = contents.get(entry.path);
          if (!bytes) {
            return entry;
          }
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          blobs.set(sha256, bytes);
          return {
            path: entry.path,
            type: "file" as const,
            mode: 0o644,
            size: bytes.length,
            sha256,
          };
        }),
      });
      const manifestRef = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
      const requests: string[] = [];
      const server = createServer((req, res) => {
        requests.push(req.url ?? "");
        if (req.url?.endsWith("/manifest")) {
          res.writeHead(200).end(raw);
        } else {
          const blob = blobs.get(req.url?.split("/").at(-1) ?? "");
          res.writeHead(blob ? 200 : 404).end(blob);
        }
      });
      const url = await listen(server);
      const open = vi.spyOn(fsp, "open");
      let captures = 0;
      const capture = workspaceCommands.captureManifest;
      vi.spyOn(workspaceCommands, "captureManifest").mockImplementation(async (params) => {
        captures += 1;
        if (captures === 2 && writesLate) {
          if (lateChange === "recreated ignored file") {
            await expect(fsp.stat(path.join(f.workspaceDir, "late.txt"))).rejects.toMatchObject({
              code: "ENOENT",
            });
          }
          await fsp.writeFile(
            path.join(f.workspaceDir, lateChange === "tracked edit" ? "source.txt" : "late.txt"),
            "late writer\n",
          );
        }
        return await capture(params);
      });
      if (lateChange === "publication failure") {
        const run = workspaceCommands.runWorkspaceCommand;
        vi.spyOn(workspaceCommands, "runWorkspaceCommand").mockImplementation(async (params) => {
          if (params.argv.includes("publish")) {
            throw new Error("injected manifest publication failure");
          }
          return await run(params);
        });
      }
      if (lateChange === "apply failure") {
        const applyDirectories = workspaceReconcile.applyWorkspaceDirectoryChanges;
        vi.spyOn(workspaceReconcile, "applyWorkspaceDirectoryChanges").mockImplementation(
          async (params) => {
            await applyDirectories(params);
            throw new Error("injected failure after patch application");
          },
        );
      }
      try {
        const transfer = f.runtime.exec(
          {
            ...f.command,
            argv: ["openclaw-internal-workspace-transfer"],
            transfer: { direction: "download", token: "test-transfer", manifestRef },
          },
          undefined,
          { url },
        );
        if (lateChange === "apply failure" || lateChange === "publication failure") {
          await expect(transfer).rejects.toThrow("workspace-transfer-failed");
          expect(await fsp.readFile(path.join(f.workspaceDir, "source.txt"), "utf8")).toBe(
            "prepared source\n",
          );
          expect(
            new NodeWorkerPreparedWorkspaceStore({ env: f.env }).find(binding.environmentId),
          ).toMatchObject({ state: "bound", session_id: binding.sessionId });
          const restarted = new NodeWorkerWorkspaceRuntime(f.options);
          expect((await restarted.exec(f.command)).code).toBe(0);
          expect((await fsp.readdir(f.ownerRoot)).toSorted()).toEqual(["home", "workspace"]);
          if (lateChange === "publication failure") {
            expect(captures).toBe(1);
          }
          return;
        }
        if (writesLate) {
          await expect(transfer).rejects.toThrow("workspace-transfer-failed");
          expect(await fsp.readFile(path.join(f.workspaceDir, "source.txt"), "utf8")).toBe(
            lateChange === "tracked edit" ? "late writer\n" : body.toString(),
          );
          expect(
            new NodeWorkerPreparedWorkspaceStore({ env: f.env }).find(binding.environmentId),
          ).toMatchObject({ state: "retiring", session_id: binding.sessionId });
          const restarted = new NodeWorkerWorkspaceRuntime(f.options);
          await expect(restarted.exec(f.command)).rejects.toThrow("does not own");
          return;
        }
        const transferred = await transfer;
        expect(transferred).toMatchObject({
          workspaceDir: f.workspaceDir,
          code: 0,
          stdout: `${manifestRef}\n`,
        });
        expect(await fsp.readFile(path.join(f.workspaceDir, "source.txt"), "utf8")).toBe(
          body.toString(),
        );
        expect(
          await fsp.readFile(path.join(f.workspaceDir, ".venv", "absolute-path"), "utf8"),
        ).toBe(`${f.workspaceDir}\n${f.homeDir}`);
        expect(requests).toHaveLength(lateChange === "no delta" ? 1 : 2);
        expect(
          new NodeWorkerPreparedWorkspaceStore({ env: f.env }).find(binding.environmentId),
        ).toMatchObject({ state: "bound", session_id: binding.sessionId });
        const acquired = f.runtime.acquirePreparedWorkspace(f.request);
        expect(acquired?.workspaceDir).toBe(f.workspaceDir);
        acquired?.release();
        expect(
          open.mock.calls.filter(([file]) => file === path.join(f.workspaceDir, ".gitignore")),
        ).toHaveLength(0);
        expect(captures).toBe(2);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    },
  );
});
