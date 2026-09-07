import { once } from "node:events";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { isPidAlive } from "../shared/pid-alive.js";
import { killPidIfAlive, waitForPidToExit } from "../test-utils/process-tree.js";
import { spawnCommand, withCommandProcessScope } from "./exec-spawn.js";

const endings = [false, true].flatMap((exitParent) =>
  (["explicit", "resolve", "reject"] as const).map((completion) => ({ exitParent, completion })),
);

describe.skipIf(process.platform === "win32")("terminal command process ownership", () => {
  it.each(endings)(
    "stops owned descendants on $completion without stopping another command (parent exited: $exitParent)",
    async ({ exitParent, completion }) => {
      const unrelated = spawnCommand([process.execPath, "-e", "setInterval(()=>{},1000)"], {
        stdio: "ignore",
        reject: false,
      });
      let child: ReturnType<typeof spawnCommand> | undefined;
      let descendantPid: number | undefined;
      const failure = new Error("scope fixture failure");
      try {
        const running = withCommandProcessScope(async (stop) => {
          const descendant =
            "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready');";
          child = spawnCommand(
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
          const [message] = await once(child.nodeChildProcess, "message", {
            signal: AbortSignal.timeout(3_000),
          });
          descendantPid = Number(message);
          expect(Number.isSafeInteger(descendantPid)).toBe(true);
          if (exitParent) {
            await child;
          }
          expect(isPidAlive(descendantPid)).toBe(true);
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
        expect(await waitForPidToExit(descendantPid)).toBe(true);
        await child;
        expect(isPidAlive(unrelated.pid!)).toBe(true);
      } finally {
        killPidIfAlive(child?.pid);
        killPidIfAlive(descendantPid);
        killPidIfAlive(unrelated.pid);
        await child;
        await unrelated;
      }
    },
  );
});
