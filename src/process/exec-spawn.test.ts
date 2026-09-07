import { once } from "node:events";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { isPidAlive } from "../shared/pid-alive.js";
import { killPidIfAlive, waitForPidToExit } from "../test-utils/process-tree.js";
import { spawnCommand, withCommandProcessScope } from "./exec-spawn.js";

describe.skipIf(process.platform === "win32")("terminal command process ownership", () => {
  it.each([false, true])(
    "stops owned descendants without stopping another command (parent exited: %s)",
    async (exitParent) => {
      const unrelated = spawnCommand([process.execPath, "-e", "setInterval(()=>{},1000)"], {
        stdio: "ignore",
        reject: false,
      });
      try {
        await withCommandProcessScope(async (stop) => {
          const descendant =
            "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready');";
          const child = spawnCommand(
            [
              process.execPath,
              "-e",
              `const {spawn}=require('node:child_process');
              process.on('SIGTERM',()=>{});
              const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});
              child.once('message',()=>process.send(child.pid,()=>{${exitParent ? "child.disconnect();process.exit(0)" : "setInterval(()=>{},1000)"}}));`,
            ],
            { stdio: ["ignore", "pipe", "pipe", "ipc"], reject: false },
          );
          let descendantPid: number | undefined;
          try {
            const [message] = await once(child.nodeChildProcess, "message", {
              signal: AbortSignal.timeout(3_000),
            });
            descendantPid = Number(message);
            expect(Number.isSafeInteger(descendantPid)).toBe(true);
            if (exitParent) {
              await child;
            }
            expect(isPidAlive(descendantPid)).toBe(true);
            stop();
            expect(await waitForPidToExit(descendantPid)).toBe(true);
            await child;
            expect(isPidAlive(unrelated.pid!)).toBe(true);
            expect(() => spawnCommand([process.execPath, "-e", ""])).toThrow(
              "Command process scope is closed",
            );
          } finally {
            stop();
            killPidIfAlive(child.pid);
            killPidIfAlive(descendantPid);
            await child;
          }
        });
      } finally {
        killPidIfAlive(unrelated.pid);
        await unrelated;
      }
    },
  );
});
