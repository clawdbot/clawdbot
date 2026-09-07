import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForChildClose, waitForPidFile } from "../../../test/helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createWorkerTunnelManager } from "./tunnel.js";
import {
  BUNDLE_HASH,
  PWD_COMMAND,
  SSH,
  fakeRunner,
  git,
  localWorkspaceRunner,
  resolveIdentity,
  rsyncReceiverNonce,
  sshResetNonce,
  startConnectedTunnel,
  success,
  waitForFast,
  workspaceSetup,
} from "./tunnel.test-support.js";
import { rsyncArgvPort, sshArgvPort } from "./worker-ssh-argv.test-support.js";
import { parseWorkerWorkspaceManifest } from "./workspace-reconcile.js";
import { stableWorkerPathComponent } from "./workspace-sync-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("worker tunnel manager", () => {
  it("syncs a dirty workspace over pinned rsync and records an immutable manifest", async () => {
    const manifestRef = `sha256:${"b".repeat(64)}`;
    const { remoteWorkspaceDir, stdout: setupStdout } = workspaceSetup(
      "/home/worker",
      "worker:sync",
      "session:one",
      7,
    );
    const localPath = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worker-sync-test-"));
    await fs.writeFile(path.join(localPath, ".worktreeinclude"), "cache/*.bin\n");
    await git(localPath, "init");
    await git(localPath, "config", "user.name", "Worker Sync Test");
    await git(localPath, "config", "user.email", "worker-sync@example.invalid");
    await fs.mkdir(path.join(localPath, "src"), { recursive: true });
    await fs.writeFile(path.join(localPath, "src/tracked.ts"), "tracked\n");
    await git(localPath, "add", ".worktreeinclude", "src/tracked.ts");
    await git(localPath, "commit", "-m", "base");
    const commit = await git(localPath, "rev-parse", "HEAD");
    const fake = fakeRunner((argv, options) => {
      if (argv.includes("--show-toplevel")) {
        return success(`${localPath}\n`);
      }
      if (argv.includes("--verify")) {
        return success(`${commit}\n`);
      }
      if (
        typeof options.input === "string" &&
        options.input.includes("unsafe worker workspace directory")
      ) {
        return success(setupStdout);
      }
      if (argv.at(-1)?.includes("worker workspace symlink escapes")) {
        return success(`${manifestRef}\n`);
      }
      return undefined;
    });
    const { handle } = await startConnectedTunnel(fake, "worker:sync", 5);

    try {
      await expect(
        handle.syncWorkspace({
          source: { kind: "local", path: localPath },
          sessionId: "session:one",
          generation: 7,
          gitAuthor: {
            name: "roboclaw-bot",
            email: "42+roboclaw-bot@users.noreply.github.com",
          },
        }),
      ).resolves.toEqual({ mode: "git", remoteWorkspaceDir, manifestRef });

      const outboundTransfers = fake.runs.filter((entry) => entry.argv[0] === "rsync");
      expect(outboundTransfers).toHaveLength(2);
      expect(new Set(outboundTransfers.map((entry) => rsyncReceiverNonce(entry.argv))).size).toBe(
        2,
      );
      const transfer = outboundTransfers.at(-1);
      expect(transfer?.argv).toContain("--checksum");
      expect(transfer?.argv).toContain(`${localPath}/`);
      expect(transfer?.argv.at(-1)).toBe("worker@worker.example.test:openclaw-rsync-destination");
      expect(transfer?.argv).not.toContain("--protect-args");
      expect(transfer?.argv.some((arg) => arg.startsWith("--files-from="))).toBe(true);
      const remoteShell = transfer?.argv[transfer.argv.indexOf("-e") + 1];
      expect(remoteShell).toContain("ClearAllForwardings=yes");
      expect(remoteShell).toContain("ControlMaster=no");
      expect(remoteShell).toContain("ControlPath=none");
      const manifest = fake.runs.find((entry) =>
        entry.argv.at(-1)?.includes("worker workspace symlink escapes"),
      );
      expect(manifest?.argv.at(-1)).toContain(commit);
      const gitSetup = fake.runs.find(
        (entry) =>
          entry.argv.join("\0").includes(remoteWorkspaceDir) &&
          entry.argv.join("\0").includes("42+roboclaw-bot@users.noreply.github.com"),
      );
      expect(gitSetup?.argv.join("\0")).toContain("roboclaw-bot");
    } finally {
      await handle.stop();
      await fs.rm(localPath, { recursive: true });
    }
  });

  it("fails workspace sync before manifest creation when rsync fails", async () => {
    const { stdout: setupStdout } = workspaceSetup(
      "/home/worker",
      "worker:sync-failure",
      "session:two",
      2,
    );
    const fake = fakeRunner((argv, options) => {
      if (argv[0] === "git") {
        return { ...success(), code: 128 };
      }
      if (argv[0] === "rsync") {
        return { ...success("", "transfer denied"), code: 23 };
      }
      if (
        typeof options.input === "string" &&
        options.input.includes("unsafe worker workspace directory")
      ) {
        return success(setupStdout);
      }
      return undefined;
    });
    const { handle } = await startConnectedTunnel(fake, "worker:sync-failure", 2, {
      ssh: { ...SSH, fallbackPorts: [22] },
    });

    await expect(
      handle.syncWorkspace({
        source: { kind: "local", path: tempDirs.make("openclaw-worker-sync-failure-") },
        sessionId: "session:two",
        generation: 2,
      }),
    ).rejects.toThrow("Worker workspace sync failed: transfer denied");
    expect(
      fake.runs.some((entry) => entry.argv.at(-1)?.includes("worker workspace symlink escapes")),
    ).toBe(false);
    const rsyncCalls = fake.runs.filter((entry) => entry.argv[0] === "rsync");
    expect(rsyncCalls).toHaveLength(1);
    expect(rsyncArgvPort(rsyncCalls[0]!.argv)).toBe(2202);
    expect(rsyncReceiverNonce(rsyncCalls[0]!.argv)).toMatch(/^[a-f0-9]{32}$/u);

    await handle.stop();
  });

  it("moves a later fresh workspace transfer to an advertised fallback", async () => {
    const endpoint = { ...SSH, port: 2222, fallbackPorts: [22] };
    const { remoteWorkspaceDir, stdout: setupStdout } = workspaceSetup(
      "/home/worker",
      "worker:fallback-sync",
      "session:fallback",
      1,
    );
    const manifestRef = `sha256:${"c".repeat(64)}`;
    const localPath = tempDirs.make("openclaw-worker-fallback-sync-");
    await fs.writeFile(path.join(localPath, "artifact.txt"), "transfer me\n");
    const fake = fakeRunner((argv, options) => {
      if (
        typeof options.input === "string" &&
        options.input.includes("unsafe worker workspace directory")
      ) {
        return success(setupStdout);
      }
      if (argv[0] === "rsync") {
        return rsyncArgvPort(argv) === 2222
          ? { ...success("", "primary transport unavailable"), code: 255 }
          : success();
      }
      if (argv.at(-1)?.includes("worker workspace symlink escapes")) {
        return success(`${manifestRef}\n`);
      }
      return undefined;
    });
    const { handle } = await startConnectedTunnel(fake, "worker:fallback-sync", 1, {
      ssh: endpoint,
    });

    try {
      await expect(
        handle.syncWorkspace({
          source: { kind: "local", path: localPath },
          sessionId: "session:fallback",
          generation: 1,
        }),
      ).resolves.toEqual({ mode: "plain", remoteWorkspaceDir, manifestRef });
      await expect(handle.runWorkspaceCommand(PWD_COMMAND)).resolves.toEqual(success());

      const freshConnections = fake.runs.filter(
        (entry) => entry.argv[0] === "ssh" || entry.argv[0] === "rsync",
      );
      const ports = freshConnections.map((entry) =>
        entry.argv[0] === "ssh" ? sshArgvPort(entry.argv) : rsyncArgvPort(entry.argv),
      );
      expect(ports).toEqual(expect.arrayContaining([2222, 22]));
      expect(new Set(ports)).toEqual(new Set([2222, 22]));
      const transfers = freshConnections.filter((entry) => entry.argv[0] === "rsync");
      expect(transfers.map((entry) => rsyncReceiverNonce(entry.argv))).toEqual([
        expect.stringMatching(/^[a-f0-9]{32}$/u),
        expect.stringMatching(/^[a-f0-9]{32}$/u),
      ]);
      expect(rsyncReceiverNonce(transfers[0]!.argv)).not.toBe(
        rsyncReceiverNonce(transfers[1]!.argv),
      );
      expect(sshArgvPort(fake.runs.at(-1)!.argv)).toBe(22);

      const identityPath = fake.runs[0]!.argv[fake.runs[0]!.argv.indexOf("-i") + 1]!;
      const knownHostsOption = fake.runs[0]!.argv.find((value) =>
        value.startsWith("UserKnownHostsFile="),
      )!;
      for (const connection of freshConnections) {
        expect(connection.argv.join(" ")).toContain(identityPath);
        expect(connection.argv.join(" ")).toContain(knownHostsOption);
      }
    } finally {
      await handle.stop();
      await fs.rm(localPath, { recursive: true, force: true });
    }
  });

  it("rejects an unrelated setup path before transfer", async () => {
    const unrelated = await fs.realpath(tempDirs.make("openclaw-worker-unrelated-"));
    const remoteRelative = [
      ".openclaw-worker/workspaces",
      stableWorkerPathComponent("worker:malformed-setup", 16),
      stableWorkerPathComponent("session:malformed", 32),
      "1",
    ].join("/");
    const attackerWorkspace = path.join(unrelated, remoteRelative);
    await fs.mkdir(attackerWorkspace, { recursive: true });
    const sentinel = path.join(attackerWorkspace, "sentinel.txt");
    await fs.writeFile(sentinel, "keep\n");
    const localPath = tempDirs.make("openclaw-worker-malformed-setup-");
    await fs.writeFile(path.join(localPath, "local.txt"), "local\n");
    const fake = fakeRunner((_argv, options) =>
      typeof options.input === "string" &&
      options.input.includes("unsafe worker workspace directory")
        ? success(
            `${JSON.stringify({
              tag: "openclaw-workspace-setup-v1",
              canonicalHome: "/home/worker",
              canonicalWorkspace: attackerWorkspace,
            })}\n`,
          )
        : undefined,
    );
    const { handle } = await startConnectedTunnel(fake, "worker:malformed-setup", 1);

    try {
      await expect(
        handle.syncWorkspace({
          source: { kind: "local", path: localPath },
          sessionId: "session:malformed",
          generation: 1,
        }),
      ).rejects.toThrow("Worker workspace setup returned an invalid response");
      await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("keep\n");
      expect(fake.runs.some((entry) => entry.argv[0] === "rsync")).toBe(false);
      expect(
        fake.runs.some((entry) =>
          entry.argv.at(-1)?.includes("worker workspace mutation no longer matches"),
        ),
      ).toBe(false);
    } finally {
      await handle.stop();
    }
  });

  it.skipIf(process.platform === "win32")(
    "serializes fallback reset behind the live remote receiver",
    async () => {
      const root = tempDirs.make("openclaw-worker-convergent-sync-");
      const localPath = path.join(root, "local");
      const remoteHome = path.join(root, "remote-home");
      const bin = path.join(root, "bin");
      const receiverGate = path.join(root, "receiver-gate");
      const receiverMarker = path.join(root, "receiver-marker");
      await Promise.all([fs.mkdir(localPath), fs.mkdir(remoteHome), fs.mkdir(bin)]);
      const canonicalRemoteHome = await fs.realpath(remoteHome);
      const fifo = await runCommandWithTimeout(["mkfifo", receiverGate], { timeoutMs: 10_000 });
      expect(fifo.code).toBe(0);
      await Promise.all([
        fs.writeFile(path.join(localPath, "current.txt"), "current\n"),
        fs.writeFile(path.join(localPath, "stale.txt"), "remove before fallback\n"),
      ]);
      const userDirectories = [
        "openclaw-inbound-project",
        "openclaw-inbound-12345678-1234-4234-8234-123456789ab-",
      ];
      for (const directory of userDirectories) {
        await fs.mkdir(path.join(localPath, directory));
        await fs.writeFile(path.join(localPath, directory, "current.txt"), "user project\n");
        await fs.writeFile(
          path.join(localPath, directory, "stale.txt"),
          "remove before fallback\n",
        );
      }
      await git(localPath, "init");
      await git(localPath, "config", "user.name", "Worker Sync Test");
      await git(localPath, "config", "user.email", "worker-sync@example.invalid");
      await git(localPath, "add", ".");
      await git(localPath, "commit", "-m", "base");
      const baseCommit = await git(localPath, "rev-parse", "HEAD");

      const fakeRsync = path.join(bin, "rsync");
      await fs.writeFile(
        fakeRsync,
        '#!/bin/sh\nset -eu\nprintf \'%s\\n\' "$$" > "$OPENCLAW_TEST_RECEIVER_MARKER"\nread -r _ < "$OPENCLAW_TEST_RECEIVER_GATE"\nprintf \'late stale write\\n\' > "$OPENCLAW_TEST_RECEIVER_WORKSPACE/stale-late.txt"\n',
        { mode: 0o755 },
      );

      let primaryTransfer = true;
      let receiverChild: ChildProcess | undefined;
      let receiverExited:
        | Promise<{ code: number | null; signal: NodeJS.Signals | null }>
        | undefined;
      let receiverWorkspace: string | undefined;
      let receiverRelative: string | undefined;
      let receiverGroupPid: number | undefined;
      let receiverStderr = "";
      let resetAcknowledgement: { nonce: string; groupAlive: boolean } | undefined;
      const processGroupIsAlive = (pid: number): boolean => {
        try {
          process.kill(-pid, 0);
          return true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EPERM") {
            return true;
          }
          if (code === "ESRCH") {
            return false;
          }
          throw error;
        }
      };
      const fake = localWorkspaceRunner(
        remoteHome,
        async (argv, localArgv, options, receiverTarget) => {
          const isWorkspaceTransfer = argv.some((arg) => arg.startsWith("--files-from="));
          if (!primaryTransfer || !isWorkspaceTransfer || rsyncArgvPort(argv) !== 2222) {
            return undefined;
          }
          primaryTransfer = false;
          const remoteWorkspaceDir = receiverTarget;
          if (!remoteWorkspaceDir) {
            throw new Error("missing test rsync destination");
          }
          const canonicalReceiverWorkspace = remoteWorkspaceDir.replace(/\/$/u, "");
          receiverWorkspace = canonicalReceiverWorkspace;
          for (const directory of [
            "node_modules",
            "openclaw-inbound-12345678-1234-4234-8234-123456789abc",
          ]) {
            await fs.mkdir(path.join(remoteWorkspaceDir, directory), { recursive: true });
            await fs.writeFile(
              path.join(remoteWorkspaceDir, directory, "worker-cache"),
              "preserve\n",
            );
          }
          const transferred = await runCommandWithTimeout(localArgv, options);
          if (transferred.termination !== "exit" || transferred.code !== 0) {
            throw new Error(transferred.stderr || "test rsync transfer failed");
          }
          await fs.rm(path.join(localPath, "stale.txt"));
          for (const directory of userDirectories) {
            await fs.rm(path.join(localPath, directory, "stale.txt"));
          }
          const remoteRelative = path
            .relative(canonicalRemoteHome, remoteWorkspaceDir)
            .split(path.sep)
            .join("/");
          receiverRelative = remoteRelative.replace(/\/$/u, "");
          receiverChild = spawn(localArgv[0]!, localArgv.slice(1), {
            env: {
              ...process.env,
              HOME: canonicalRemoteHome,
              OPENCLAW_TEST_RECEIVER_PATH: `${bin}:${process.env.PATH ?? ""}`,
              OPENCLAW_TEST_RECEIVER_GATE: receiverGate,
              OPENCLAW_TEST_RECEIVER_MARKER: receiverMarker,
              OPENCLAW_TEST_RECEIVER_WORKSPACE: remoteWorkspaceDir,
            },
            stdio: ["ignore", "ignore", "pipe"],
          });
          receiverChild.stderr?.setEncoding("utf8");
          receiverChild.stderr?.on("data", (chunk: string) => {
            receiverStderr += chunk;
          });
          receiverExited = waitForChildClose(receiverChild, 10_000);
          receiverGroupPid = await Promise.race([
            waitForPidFile(receiverMarker, 10_000),
            receiverExited.then(() => {
              throw new Error(receiverStderr || "test receiver exited before its marker");
            }),
          ]);
          return { ...transferred, code: 255, stderr: "primary transport disconnected" };
        },
        (argv, result) => {
          const acknowledged = /^reset ([a-f0-9]{32})\n$/u.exec(result.stdout)?.[1];
          if (acknowledged) {
            if (receiverGroupPid === undefined) {
              throw new Error("test receiver process group was not captured");
            }
            resetAcknowledgement = {
              nonce: acknowledged,
              groupAlive: processGroupIsAlive(receiverGroupPid),
            };
          }
        },
      );
      const manager = createWorkerTunnelManager({ runner: fake.runner });
      const handle = await manager.start({
        bundleHash: BUNDLE_HASH,
        environmentId: "worker:convergent-sync",
        ownerEpoch: 1,
        ssh: { ...SSH, port: 2222, fallbackPorts: [22] },
        resolveIdentity,
      });

      try {
        const syncing = handle.syncWorkspace({
          source: { kind: "local", path: localPath },
          sessionId: "session:convergent-sync",
          generation: 1,
        });
        let syncSettled = false;
        void syncing.then(
          () => {
            syncSettled = true;
          },
          () => {
            syncSettled = true;
          },
        );
        await Promise.race([
          waitForFast(
            () => {
              expect(
                fake.runs.map((entry) => [
                  entry.argv[0],
                  entry.argv[0] === "ssh" ? sshArgvPort(entry.argv) : rsyncArgvPort(entry.argv),
                ]),
              ).toContainEqual(["ssh", 22]);
            },
            { timeout: 10_000 },
          ),
          syncing.then(
            () => {
              throw new Error("workspace sync settled before fallback reset");
            },
            (error: unknown) => {
              throw error;
            },
          ),
        ]);
        const primaryTransfers = fake.runs.filter(
          (entry) =>
            entry.argv[0] === "rsync" && entry.argv.some((arg) => arg.startsWith("--files-from=")),
        );
        expect(primaryTransfers.map((entry) => rsyncArgvPort(entry.argv))).toEqual([2222]);
        expect(
          fake.runs.some((entry) =>
            entry.argv.at(-1)?.includes("worker workspace symlink escapes"),
          ),
        ).toBe(false);
        expect(syncSettled).toBe(false);
        expect(receiverWorkspace).toBeDefined();
        expect(receiverRelative).toBeDefined();
        const resetCommands = fake.runs.flatMap((entry) => {
          const nonce = sshResetNonce(entry.argv, {
            workspace: receiverWorkspace!,
            canonicalHome: canonicalRemoteHome,
            remoteRelative: receiverRelative!,
          });
          return nonce ? [{ ...entry, nonce }] : [];
        });
        expect(resetCommands).toHaveLength(1);
        expect(sshArgvPort(resetCommands[0]!.argv)).toBe(22);
        expect(receiverGroupPid).toBeDefined();
        expect(processGroupIsAlive(receiverGroupPid!)).toBe(true);
        expect(resetAcknowledgement).toBeUndefined();
        await expect(fs.readFile(path.join(receiverWorkspace!, "stale.txt"), "utf8")).resolves.toBe(
          "remove before fallback\n",
        );
        await expect(
          fs.readFile(path.join(receiverWorkspace!, "current.txt"), "utf8"),
        ).resolves.toBe("current\n");
        const manifestDirectory = path.join(remoteHome, ".openclaw-worker/manifests");
        const publishedManifests = await fs.readdir(manifestDirectory).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
          }
          throw error;
        });
        expect(publishedManifests).toEqual([]);

        const gateWriter = await fs.open(receiverGate, "w");
        await gateWriter.write("release\n");
        await gateWriter.close();
        if (!receiverExited) {
          throw new Error("workspace receiver did not start");
        }
        const receiverExit = await receiverExited;
        expect(receiverExit.signal).toBeNull();
        expect(receiverExit.code).not.toBe(0);
        const result = await syncing;
        expect(resetAcknowledgement).toEqual({
          nonce: resetCommands[0]!.nonce,
          groupAlive: false,
        });
        expect(result.mode).toBe("git");
        await expect(
          fs.readFile(path.join(result.remoteWorkspaceDir, "current.txt"), "utf8"),
        ).resolves.toBe("current\n");
        await expect(
          fs.access(path.join(result.remoteWorkspaceDir, "stale.txt")),
        ).rejects.toThrow();
        await expect(
          fs.readFile(path.join(result.remoteWorkspaceDir, "node_modules/worker-cache"), "utf8"),
        ).resolves.toBe("preserve\n");
        await expect(
          fs.readFile(
            path.join(
              result.remoteWorkspaceDir,
              "openclaw-inbound-12345678-1234-4234-8234-123456789abc/worker-cache",
            ),
            "utf8",
          ),
        ).resolves.toBe("preserve\n");
        for (const directory of userDirectories) {
          await expect(
            fs.readFile(path.join(result.remoteWorkspaceDir, directory, "current.txt"), "utf8"),
          ).resolves.toBe("user project\n");
          await expect(
            fs.access(path.join(result.remoteWorkspaceDir, directory, "stale.txt")),
          ).rejects.toThrow();
        }

        const digest = result.manifestRef.slice("sha256:".length);
        const rawManifest = await fs.readFile(
          path.join(remoteHome, ".openclaw-worker/manifests", `${digest}.json`),
          "utf8",
        );
        const manifest = parseWorkerWorkspaceManifest(rawManifest, result.manifestRef);
        expect(manifest.entries.map((entry) => entry.path)).toEqual([
          "current.txt",
          ...userDirectories.map((directory) => `${directory}/current.txt`).toSorted(),
        ]);
        expect(await git(result.remoteWorkspaceDir, "rev-parse", "HEAD")).toBe(baseCommit);
        await expect(
          fs.access(path.join(result.remoteWorkspaceDir, "stale-late.txt")),
        ).rejects.toThrow();

        const transfers = fake.runs.filter(
          (entry) =>
            entry.argv[0] === "rsync" && entry.argv.some((arg) => arg.startsWith("--files-from=")),
        );
        expect(transfers.map((entry) => rsyncArgvPort(entry.argv))).toEqual([2222, 22]);
        const fileLists = transfers.map((entry) =>
          entry.argv.find((arg) => arg.startsWith("--files-from="))!.slice(13),
        );
        expect(new Set(fileLists.map((file) => path.dirname(file))).size).toBe(1);
        expect(fileLists.map((file) => path.basename(file))).toEqual(["attempt-0", "attempt-1"]);
        for (const transfer of transfers) {
          expect(transfer.argv).toContain("--delete-delay");
          expect(transfer.argv).not.toContain("--delete-excluded");
          expect(transfer.argv.some((arg) => arg.startsWith("--rsync-path="))).toBe(true);
        }
        expect(fake.runs.some((entry) => entry.argv.at(-1)?.endsWith("'true'"))).toBe(false);
        const residue = (await fs.readdir(path.dirname(result.remoteWorkspaceDir))).filter((name) =>
          name.startsWith(".openclaw-accepted-"),
        );
        expect(residue).toEqual([]);
      } finally {
        if (receiverChild && receiverChild.exitCode === null && receiverChild.signalCode === null) {
          const markerExists = await fs
            .access(receiverMarker)
            .then(() => true)
            .catch(() => false);
          if (markerExists) {
            const gateWriter = await fs.open(receiverGate, "w");
            await gateWriter.write("cleanup\n");
            await gateWriter.close();
          }
          await receiverExited;
        }
        await handle.stop();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed when the managed workspace owner drifts before fallback reset",
    async () => {
      const root = tempDirs.make("openclaw-worker-retry-owner-");
      const localPath = path.join(root, "local");
      const remoteHome = path.join(root, "remote-home");
      const unrelated = path.join(root, "unrelated");
      await Promise.all([fs.mkdir(localPath), fs.mkdir(remoteHome), fs.mkdir(unrelated)]);
      await fs.writeFile(path.join(localPath, "current.txt"), "current\n");
      await fs.writeFile(path.join(unrelated, "sentinel.txt"), "keep\n");
      await git(localPath, "init");
      await git(localPath, "config", "user.name", "Worker Sync Test");
      await git(localPath, "config", "user.email", "worker-sync@example.invalid");
      await git(localPath, "add", ".");
      await git(localPath, "commit", "-m", "base");

      let primaryTransfer = true;
      const fake = localWorkspaceRunner(
        remoteHome,
        async (argv, localArgv, options, receiverTarget) => {
          if (
            !primaryTransfer ||
            !argv.some((arg) => arg.startsWith("--files-from=")) ||
            rsyncArgvPort(argv) !== 2222
          ) {
            return undefined;
          }
          primaryTransfer = false;
          const workspace = receiverTarget?.replace(/\/$/u, "");
          if (!workspace) {
            throw new Error("missing test rsync destination");
          }
          const transferred = await runCommandWithTimeout(localArgv, options);
          if (transferred.termination !== "exit" || transferred.code !== 0) {
            throw new Error(transferred.stderr || "test rsync transfer failed");
          }
          await fs.rm(workspace, { recursive: true });
          await fs.symlink(unrelated, workspace, "dir");
          return { ...transferred, code: 255, stderr: "primary transport disconnected" };
        },
      );
      const manager = createWorkerTunnelManager({ runner: fake.runner });
      const handle = await manager.start({
        bundleHash: BUNDLE_HASH,
        environmentId: "worker:retry-owner",
        ownerEpoch: 1,
        ssh: { ...SSH, port: 2222, fallbackPorts: [22] },
        resolveIdentity,
      });

      try {
        await expect(
          handle.syncWorkspace({
            source: { kind: "local", path: localPath },
            sessionId: "session:retry-owner",
            generation: 1,
          }),
        ).rejects.toThrow("attested owner");
        await expect(fs.readFile(path.join(unrelated, "sentinel.txt"), "utf8")).resolves.toBe(
          "keep\n",
        );
        const transfers = fake.runs.filter(
          (entry) =>
            entry.argv[0] === "rsync" && entry.argv.some((arg) => arg.startsWith("--files-from=")),
        );
        expect(transfers.map((entry) => rsyncArgvPort(entry.argv))).toEqual([2222]);
        const resets = fake.runs.filter((entry) =>
          entry.argv.at(-1)?.includes("worker workspace mutation no longer matches"),
        );
        expect(resets).toHaveLength(1);
        expect(sshArgvPort(resets[0]!.argv)).toBe(22);
        expect(
          fake.runs.some((entry) =>
            entry.argv.at(-1)?.includes("worker workspace symlink escapes"),
          ),
        ).toBe(false);
      } finally {
        await handle.stop();
      }
    },
  );

  it.each([
    { probe: "HEAD", failedArg: "--verify", message: "HEAD probe timed out" },
    { probe: "repository-root", failedArg: "--show-toplevel", message: "root probe timed out" },
  ])(
    "does not downgrade an operational $probe probe failure to plain sync",
    async ({ failedArg, message }) => {
      const { stdout: setupStdout } = workspaceSetup(
        "/home/worker",
        "worker:probe-failure",
        "session:probe",
        1,
      );
      const localPath = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worker-probe-"));
      await fs.mkdir(path.join(localPath, ".git"));
      const fake = fakeRunner((argv, options) => {
        if (argv.includes(failedArg)) {
          return { ...success("", message), code: null, killed: true, termination: "timeout" };
        }
        if (argv.includes("--show-toplevel")) {
          return success(`${localPath}\n`);
        }
        if (argv.includes("--verify")) {
          return success("0123456789abcdef0123456789abcdef01234567\n");
        }
        if (
          typeof options.input === "string" &&
          options.input.includes("unsafe worker workspace directory")
        ) {
          return success(setupStdout);
        }
        return undefined;
      });
      const { handle } = await startConnectedTunnel(fake, "worker:probe-failure", 1);

      try {
        await expect(
          handle.syncWorkspace({
            source: { kind: "local", path: localPath },
            sessionId: "session:probe",
            generation: 1,
          }),
        ).rejects.toThrow(`Worker workspace sync failed: ${message}`);
        expect(fake.runs.some((entry) => entry.argv[0] === "rsync")).toBe(false);
      } finally {
        await handle.stop();
        await fs.rm(localPath, { recursive: true, force: true });
      }
    },
  );

  it("mirrors plain workspaces and rejects escaping symlinks in a git overlay", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worker-sync-modes-"));
    const plainPath = path.join(root, "plain");
    const gitPath = path.join(root, "git");
    const remoteHome = path.join(root, "remote-home");
    await Promise.all([
      fs.mkdir(path.join(plainPath, "nested/.git"), { recursive: true }),
      fs.mkdir(gitPath, { recursive: true }),
      fs.mkdir(remoteHome, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(plainPath, "hello.txt"), "plain\n"),
      fs.writeFile(path.join(plainPath, "nested/.git/config"), "private metadata\n"),
    ]);
    // Result staging stores refs in an unborn repository for a plain workspace.
    // A later dispatch must keep using plain-mode sync until the user creates HEAD.
    await git(plainPath, "init");
    const attachmentDirectory = "openclaw-inbound-12345678-1234-4234-8234-123456789abc";
    const userDirectories = [
      "openclaw-inbound-project",
      "openclaw-inbound-12345678-1234-4234-8234-123456789ab-",
    ];
    await Promise.all([
      fs.mkdir(path.join(plainPath, "__pycache__")),
      fs.mkdir(path.join(plainPath, attachmentDirectory)),
    ]);
    await Promise.all([
      fs.writeFile(path.join(plainPath, "__pycache__/fizzbuzz.pyc"), "derived\n"),
      fs.writeFile(path.join(plainPath, ".mypy_cache"), "derived name file\n"),
      fs.writeFile(path.join(plainPath, attachmentDirectory, "report.pdf"), "inbound original\n"),
    ]);
    for (const directory of userDirectories) {
      await fs.mkdir(path.join(plainPath, directory));
      await fs.writeFile(path.join(plainPath, directory, "report.txt"), "user project\n");
    }
    await git(gitPath, "init");
    await git(gitPath, "config", "user.name", "Worker Sync Test");
    await git(gitPath, "config", "user.email", "worker-sync@example.invalid");
    await fs.writeFile(path.join(gitPath, "tracked.txt"), "tracked\n");
    await git(gitPath, "add", "tracked.txt");
    await git(gitPath, "commit", "-m", "base");
    await fs.symlink(path.join(root, "outside"), path.join(gitPath, "escape"));

    const fake = localWorkspaceRunner(remoteHome);
    const { handle } = await startConnectedTunnel(fake, "worker:real-sync-modes", 12);

    try {
      const plain = await handle.syncWorkspace({
        source: { kind: "local", path: plainPath },
        sessionId: "session:plain-sync",
        generation: 1,
      });
      expect(plain.mode).toBe("plain");
      await expect(
        fs.readFile(path.join(plain.remoteWorkspaceDir, "hello.txt"), "utf8"),
      ).resolves.toBe("plain\n");
      await expect(
        fs.access(path.join(plain.remoteWorkspaceDir, "nested/.git/config")),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(plain.remoteWorkspaceDir, "__pycache__/fizzbuzz.pyc")),
      ).rejects.toThrow();
      await expect(fs.access(path.join(plain.remoteWorkspaceDir, ".mypy_cache"))).rejects.toThrow();
      await expect(
        fs.access(path.join(plain.remoteWorkspaceDir, attachmentDirectory)),
      ).rejects.toThrow();
      for (const directory of userDirectories) {
        await expect(
          fs.readFile(path.join(plain.remoteWorkspaceDir, directory, "report.txt"), "utf8"),
        ).resolves.toBe("user project\n");
      }

      await expect(
        handle.syncWorkspace({
          source: { kind: "local", path: gitPath },
          sessionId: "session:symlink-sync",
          generation: 2,
        }),
      ).rejects.toThrow("Cloud workspace symlink is not portable or escapes the sync root");
    } finally {
      await handle.stop();
      await fs.rm(root, { recursive: true });
    }
  }, 60_000);
});
