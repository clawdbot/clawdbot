import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import * as processIdentity from "../shared/pid-alive.js";
import { killPidIfAlive, waitForPidToExit } from "../test-utils/process-tree.js";
import { spawnCommand, withCommandProcessScope } from "./exec-spawn.js";

type ScopeCase = {
  name: string;
  exitParent: boolean;
  completion: "explicit" | "resolve" | "reject";
  identity?: "initially-missing" | "reused-after-exit";
};

const endings: ScopeCase[] = [false, true].flatMap((exitParent) =>
  (["explicit", "resolve", "reject"] as const).map((completion) => ({
    name: `stops owned descendants on ${completion} without stopping another command (parent exited: ${exitParent})`,
    exitParent,
    completion,
  })),
);
endings.push(
  {
    name: "stops a live child when its initial start-time probe failed",
    exitParent: false,
    completion: "explicit",
    identity: "initially-missing",
  },
  {
    name: "preserves a retained group when an exited root has a different identity",
    exitParent: true,
    completion: "explicit",
    identity: "reused-after-exit",
  },
);

describe.skipIf(process.platform === "win32")("terminal command process ownership", () => {
  it.each(endings)("$name", async ({ exitParent, completion, identity }) => {
    const unrelated = spawnCommand([process.execPath, "-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
      reject: false,
    });
    let child: ChildProcess | undefined;
    let childResult: Promise<unknown> | undefined;
    let descendantPid: number | undefined;
    const failure = new Error("scope fixture failure");
    const identityProbe = vi.spyOn(processIdentity, "getFileLockProcessStartTime");
    if (identity === "initially-missing") {
      identityProbe.mockReturnValueOnce(null);
    } else if (identity === "reused-after-exit") {
      identityProbe.mockReturnValue(1);
    }
    try {
      const running = withCommandProcessScope(async (stop) => {
        const descendant =
          "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready');";
        const command = spawnCommand(
          [
            process.execPath,
            "-e",
            `const {spawn}=require('node:child_process');
              process.on('SIGTERM',()=>{});
              const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});
              child.once('message',()=>process.send(child.pid,()=>{${exitParent ? "child.disconnect();process.exit(0)" : "setInterval(()=>{},1000)"}}));`,
          ],
          { stdio: ["ignore", "pipe", "pipe"], ipc: true, reject: false },
        );
        child = command.nodeChildProcess;
        childResult = command;
        const [message] = await once(child, "message", {
          signal: AbortSignal.timeout(3_000),
        });
        descendantPid = Number(message);
        expect(Number.isSafeInteger(descendantPid)).toBe(true);
        if (exitParent) {
          await command;
        }
        if (identity === "reused-after-exit") {
          expect(child.exitCode).toBe(0);
          identityProbe.mockReturnValue(2);
        }
        expect(processIdentity.isPidAlive(descendantPid)).toBe(true);
        if (completion === "explicit") {
          stop();
          expect(() => spawnCommand([process.execPath, "-e", ""])).toThrow(
            "Command process scope is closed",
          );
        } else if (completion === "reject") {
          throw failure;
        }
      });
      if (completion === "reject") {
        await expect(running).rejects.toBe(failure);
      } else {
        await running;
      }
      if (descendantPid === undefined) {
        throw new Error("Scope did not receive its descendant PID");
      }
      expect(await waitForPidToExit(descendantPid)).toBe(identity !== "reused-after-exit");
      await childResult;
      expect(processIdentity.isPidAlive(unrelated.pid!)).toBe(true);
    } finally {
      identityProbe.mockRestore();
      killPidIfAlive(child?.pid);
      killPidIfAlive(descendantPid);
      killPidIfAlive(unrelated.pid);
      await childResult;
      await unrelated;
    }
  });
});
