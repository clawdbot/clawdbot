import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForChildClose, waitForDead, waitForFile } from "../../../test/helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { BUNDLE_HASH, prepareLocalWorkspaceRsyncBoundary } from "./tunnel.test-support.js";
import { REMOTE_GIT_WORKSPACE_RETRY_RESET_JS } from "./workspace-mutation-remote-script.js";
import {
  createWorkerWorkspaceRsyncReceiverPathFactory,
  WORKER_WORKSPACE_RSYNC_DESTINATION,
  workerWorkspaceRsyncReceiverEntryPath,
} from "./workspace-sync-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function spawnTransaction(argv: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = waitForChildClose(child, 10_000).then(({ code, signal }) => ({
    code,
    signal,
    stderr,
  }));
  return { pid: child.pid, exited };
}

function parseReceiverOwner(name: string) {
  const match = /^owner\.receiver\.[a-f0-9]{32}\.([1-9][0-9]*)\.([1-9][0-9]*)\.[a-f0-9]{32}$/u.exec(
    name,
  );
  if (!match) {
    throw new Error(`invalid receiver lock owner: ${name}`);
  }
  return { receiverPid: Number(match[1]), controllerPid: Number(match[2]) };
}

describe("remote workspace mutation receiver script", () => {
  it.skipIf(process.platform === "win32")(
    "keeps receiver ownership after its controller dies while a descendant can still mutate",
    async () => {
      const root = tempDirs.make("openclaw-workspace-receiver-lock-");
      let home = path.join(root, "home");
      const bin = path.join(root, "bin");
      const gate = path.join(root, "receiver-gate");
      const receiverMarker = path.join(root, "receiver-marker");
      const contenderMarker = path.join(root, "contender-marker");
      const preload = path.join(root, "contender-preload.cjs");
      const relative = ".openclaw-worker/workspaces/env/session/1";
      await Promise.all([fs.mkdir(home), fs.mkdir(bin)]);
      home = await fs.realpath(home);
      const workspace = path.join(home, relative);
      await fs.mkdir(path.join(workspace, "node_modules"), { recursive: true });
      await Promise.all([
        fs.writeFile(path.join(workspace, "current.txt"), "current\n"),
        fs.writeFile(path.join(workspace, "node_modules/cache"), "keep\n"),
      ]);
      const fifo = await runCommandWithTimeout(["mkfifo", gate], { timeoutMs: 10_000 });
      expect(fifo.code).toBe(0);
      await fs.writeFile(
        path.join(bin, "rsync"),
        '#!/bin/sh\nset -eu\n( : > "$OPENCLAW_TEST_RECEIVER_MARKER"; read -r _ < "$OPENCLAW_TEST_RECEIVER_GATE"; printf "late\\n" > "$OPENCLAW_TEST_RECEIVER_WORKSPACE/late.txt" ) </dev/null >/dev/null 2>&1 &\nexit 0\n',
        { mode: 0o755 },
      );
      await fs.writeFile(
        preload,
        String.raw`const fs = require("node:fs");
const kill = process.kill.bind(process);
process.kill = function(pid, signal) {
  if (signal === 0 && pid < 0 && process.argv[4] === process.env.OPENCLAW_TEST_RESET_NONCE) {
    fs.writeFileSync(process.env.OPENCLAW_TEST_CONTENDER_MARKER, "");
  }
  return kill(pid, signal);
};
`,
      );
      const receiverNonce = "b".repeat(32);
      const resetNonce = "c".repeat(32);
      const env = {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        OPENCLAW_TEST_RECEIVER_GATE: gate,
        OPENCLAW_TEST_RECEIVER_MARKER: receiverMarker,
        OPENCLAW_TEST_RECEIVER_WORKSPACE: workspace,
        OPENCLAW_TEST_RESET_NONCE: resetNonce,
        OPENCLAW_TEST_CONTENDER_MARKER: contenderMarker,
      };
      const receiverCommand = createWorkerWorkspaceRsyncReceiverPathFactory({
        receiverEntryPath: workerWorkspaceRsyncReceiverEntryPath(BUNDLE_HASH),
        remoteWorkspaceDir: workspace,
        canonicalHome: home,
        remoteRelative: relative,
      })("workspace-root");
      const boundary = await prepareLocalWorkspaceRsyncBoundary(home, [
        "rsync",
        `--rsync-path=${receiverCommand}`,
        "-e",
        "ssh",
        "--",
        "source",
        `test:${WORKER_WORKSPACE_RSYNC_DESTINATION}`,
      ]);
      const [node, receiverEntry, mode, context] = receiverCommand.split(" ");
      expect(node).toBe("node");
      const receiver = spawnTransaction(
        [
          path.join(home, receiverEntry!),
          mode!,
          context!,
          receiverNonce,
          "--server",
          ".",
          boundary.argv.at(-1)!.slice("test:".length),
        ],
        env,
      );
      let receiverGateReady = false;
      let gateReleased = false;
      let reset: ReturnType<typeof runCommandWithTimeout> | undefined;
      try {
        await waitForFile(receiverMarker, 10_000);
        receiverGateReady = true;
        const workspaceKey = createHash("sha256").update(workspace).digest("hex");
        const lock = path.join(path.dirname(workspace), `.openclaw-accepted-lock-${workspaceKey}`);
        const [ownerName] = await fs.readdir(lock);
        const { receiverPid, controllerPid } = parseReceiverOwner(ownerName!);
        expect(Number.isSafeInteger(receiverPid)).toBe(true);
        expect(controllerPid).toBe(receiver.pid);
        await waitForDead(receiverPid, 10_000);
        process.kill(controllerPid, "SIGKILL");
        expect(await receiver.exited).toMatchObject({ code: null, signal: "SIGKILL", stderr: "" });

        reset = runCommandWithTimeout(
          [
            process.execPath,
            "--require",
            preload,
            "-e",
            REMOTE_GIT_WORKSPACE_RETRY_RESET_JS,
            workspace,
            home,
            relative,
            resetNonce,
          ],
          { timeoutMs: 10_000, baseEnv: env },
        );
        await waitForFile(contenderMarker, 10_000);
        await expect(fs.readFile(path.join(workspace, "current.txt"), "utf8")).resolves.toBe(
          "current\n",
        );

        const gateWriter = await fs.open(gate, "w");
        await gateWriter.write("release\n");
        await gateWriter.close();
        gateReleased = true;
        expect(await reset).toMatchObject({ code: 0, stdout: `reset ${resetNonce}\n`, stderr: "" });
        await expect(fs.access(path.join(workspace, "late.txt"))).rejects.toThrow();
        await expect(fs.readFile(path.join(workspace, "node_modules/cache"), "utf8")).resolves.toBe(
          "keep\n",
        );
        expect(
          (await fs.readdir(path.dirname(workspace))).filter((name) =>
            name.startsWith(".openclaw-accepted-"),
          ),
        ).toEqual([]);
      } finally {
        if (!gateReleased && receiverGateReady) {
          const gateWriter = await fs.open(gate, "w");
          await gateWriter.write("cleanup\n");
          await gateWriter.close();
        } else if (!gateReleased && receiver.pid !== undefined) {
          process.kill(receiver.pid, "SIGKILL");
        }
        await receiver.exited.catch(() => undefined);
        await reset?.catch(() => undefined);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps receiver ownership while its live controller is releasing a dead receiver group",
    async () => {
      const root = tempDirs.make("openclaw-workspace-receiver-controller-lock-");
      let home = path.join(root, "home");
      const bin = path.join(root, "bin");
      const releaseGate = path.join(root, "release-gate");
      const releaseMarker = path.join(root, "release-marker");
      const contenderMarker = path.join(root, "contender-marker");
      const preload = path.join(root, "release-preload.cjs");
      const relative = ".openclaw-worker/workspaces/env/session/1";
      await Promise.all([fs.mkdir(home), fs.mkdir(bin)]);
      home = await fs.realpath(home);
      const workspace = path.join(home, relative);
      await fs.mkdir(path.join(workspace, "node_modules"), { recursive: true });
      await Promise.all([
        fs.writeFile(path.join(workspace, "current.txt"), "current\n"),
        fs.writeFile(path.join(workspace, "node_modules/cache"), "keep\n"),
        fs.writeFile(path.join(bin, "rsync"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }),
      ]);
      const fifo = await runCommandWithTimeout(["mkfifo", releaseGate], { timeoutMs: 10_000 });
      expect(fifo.code).toBe(0);
      await fs.writeFile(
        preload,
        String.raw`const fs = require("node:fs");
const renameSync = fs.renameSync.bind(fs);
fs.renameSync = function(source, destination) {
  if (
    process.argv[4] === process.env.OPENCLAW_TEST_RECEIVER_NONCE &&
    destination.includes(".released.")
  ) {
    fs.writeFileSync(process.env.OPENCLAW_TEST_RELEASE_MARKER, "");
    if (fs.readFileSync(process.env.OPENCLAW_TEST_RELEASE_GATE, "utf8").trim() !== "release") {
      throw new Error("invalid receiver controller release gate");
    }
  }
  return renameSync(source, destination);
};
const kill = process.kill.bind(process);
process.kill = function(pid, signal) {
  const result = kill(pid, signal);
  if (
    signal === 0 &&
    process.argv[4] === process.env.OPENCLAW_TEST_RESET_NONCE &&
    pid === Number(process.env.OPENCLAW_TEST_CONTROLLER_PID)
  ) {
    fs.writeFileSync(process.env.OPENCLAW_TEST_CONTENDER_MARKER, "");
  }
  return result;
};
`,
      );
      const receiverNonce = "d".repeat(32);
      const resetNonce = "e".repeat(32);
      const env = {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        OPENCLAW_TEST_RECEIVER_NONCE: receiverNonce,
        OPENCLAW_TEST_RESET_NONCE: resetNonce,
        OPENCLAW_TEST_RELEASE_GATE: releaseGate,
        OPENCLAW_TEST_RELEASE_MARKER: releaseMarker,
        OPENCLAW_TEST_CONTENDER_MARKER: contenderMarker,
      };
      const receiverCommand = createWorkerWorkspaceRsyncReceiverPathFactory({
        receiverEntryPath: workerWorkspaceRsyncReceiverEntryPath(BUNDLE_HASH),
        remoteWorkspaceDir: workspace,
        canonicalHome: home,
        remoteRelative: relative,
      })("workspace-root");
      const boundary = await prepareLocalWorkspaceRsyncBoundary(home, [
        "rsync",
        `--rsync-path=${receiverCommand}`,
        "-e",
        "ssh",
        "--",
        "source",
        `test:${WORKER_WORKSPACE_RSYNC_DESTINATION}`,
      ]);
      const [node, receiverEntry, mode, context] = receiverCommand.split(" ");
      expect(node).toBe("node");
      const receiver = spawnTransaction(
        [
          "--require",
          preload,
          path.join(home, receiverEntry!),
          mode!,
          context!,
          receiverNonce,
          "--server",
          ".",
          boundary.argv.at(-1)!.slice("test:".length),
        ],
        env,
      );
      let receiverPid: number | undefined;
      let releaseGateOpened = false;
      let reset: ReturnType<typeof runCommandWithTimeout> | undefined;
      try {
        await waitForFile(releaseMarker, 10_000);
        const workspaceKey = createHash("sha256").update(workspace).digest("hex");
        const lock = path.join(path.dirname(workspace), `.openclaw-accepted-lock-${workspaceKey}`);
        const [ownerName] = await fs.readdir(lock);
        const owner = parseReceiverOwner(ownerName!);
        receiverPid = owner.receiverPid;
        expect(owner.controllerPid).toBe(receiver.pid);
        await waitForDead(owner.receiverPid, 10_000);

        let resetSettled = false;
        reset = runCommandWithTimeout(
          [
            process.execPath,
            "--require",
            preload,
            "-e",
            REMOTE_GIT_WORKSPACE_RETRY_RESET_JS,
            workspace,
            home,
            relative,
            resetNonce,
          ],
          {
            timeoutMs: 10_000,
            baseEnv: { ...env, OPENCLAW_TEST_CONTROLLER_PID: String(owner.controllerPid) },
          },
        );
        void reset.then(
          () => {
            resetSettled = true;
          },
          () => {
            resetSettled = true;
          },
        );
        await waitForFile(contenderMarker, 10_000);
        expect(resetSettled).toBe(false);
        await expect(fs.readFile(path.join(workspace, "current.txt"), "utf8")).resolves.toBe(
          "current\n",
        );
        await expect(fs.readdir(lock)).resolves.toEqual([ownerName]);

        const releaseWriter = await fs.open(releaseGate, "w");
        await releaseWriter.write("release\n");
        await releaseWriter.close();
        releaseGateOpened = true;
        expect(await receiver.exited).toMatchObject({ code: 0, signal: null, stderr: "" });
        expect(await reset).toMatchObject({ code: 0, stdout: `reset ${resetNonce}\n`, stderr: "" });
        await expect(fs.access(path.join(workspace, "current.txt"))).rejects.toThrow();
        await expect(fs.readFile(path.join(workspace, "node_modules/cache"), "utf8")).resolves.toBe(
          "keep\n",
        );
        expect(
          (await fs.readdir(path.dirname(workspace))).filter((name) =>
            name.startsWith(".openclaw-accepted-"),
          ),
        ).toEqual([]);
      } finally {
        if (!releaseGateOpened) {
          try {
            await fs.access(releaseMarker);
            const releaseWriter = await fs.open(releaseGate, "w");
            await releaseWriter.write("release\n");
            await releaseWriter.close();
          } catch {
            if (receiver.pid !== undefined) {
              process.kill(receiver.pid, "SIGKILL");
            }
          }
        }
        await receiver.exited.catch(() => undefined);
        await reset?.catch(() => undefined);
        if (receiverPid !== undefined) {
          await waitForDead(receiverPid, 1_000).catch(() => undefined);
        }
      }
    },
  );
});
