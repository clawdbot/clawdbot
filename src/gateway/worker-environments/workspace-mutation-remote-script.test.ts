import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForChildClose, waitForDead, waitForFile } from "../../../test/helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  REMOTE_GIT_WORKSPACE_RETRY_RESET_JS,
  REMOTE_WORKSPACE_RSYNC_RECEIVER_JS,
} from "./workspace-mutation-remote-script.js";

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
  return { exited };
}

describe("remote workspace mutation receiver script", () => {
  it.skipIf(process.platform === "win32")(
    "keeps receiver ownership while an internal receiver process can still mutate",
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
      const receiver = spawnTransaction(
        [
          "-e",
          REMOTE_WORKSPACE_RSYNC_RECEIVER_JS,
          workspace,
          home,
          relative,
          receiverNonce,
          workspace,
          "--server",
          ".",
          `${workspace}/`,
        ],
        env,
      );
      let gateReleased = false;
      try {
        await waitForFile(receiverMarker, 10_000);
        const workspaceKey = createHash("sha256").update(workspace).digest("hex");
        const lock = path.join(path.dirname(workspace), `.openclaw-accepted-lock-${workspaceKey}`);
        const [ownerName] = await fs.readdir(lock);
        const receiverPid = Number(
          /^owner\.receiver\.[a-f0-9]{32}\.([1-9][0-9]*)\./u.exec(ownerName!)?.[1],
        );
        expect(Number.isSafeInteger(receiverPid)).toBe(true);
        await waitForDead(receiverPid, 10_000);

        const reset = runCommandWithTimeout(
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
        expect(await receiver.exited).toMatchObject({ code: 0, signal: null, stderr: "" });
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
        if (!gateReleased) {
          const gateWriter = await fs.open(gate, "w");
          await gateWriter.write("cleanup\n");
          await gateWriter.close();
          await receiver.exited.catch(() => undefined);
        }
      }
    },
  );
});
