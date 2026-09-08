import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPidAlive } from "../shared/pid-alive.js";
import { killPidIfAlive, waitForPidToExit } from "../test-utils/process-tree.js";

const fixture = fileURLToPath(
  new URL("./runtime-cleanup-scope.windows.test-support.ts", import.meta.url),
);

describe.runIf(process.platform === "win32")("Windows executable process ownership", () => {
  it.each([
    { ownership: "cli", inherited: false, exitCode: 0 },
    { ownership: "cli", inherited: true, exitCode: 0 },
    { ownership: "cli", inherited: true, exitCode: 1 },
    { ownership: "borrowed", inherited: false, exitCode: 0 },
    { ownership: "gateway", inherited: false, exitCode: 0 },
  ])(
    "preserves $ownership exit $exitCode (inherited Job: $inherited)",
    async ({ ownership, inherited, exitCode }) => {
      const parent = spawn(
        process.execPath,
        ["--import", "tsx", fixture, "harness", ownership, String(inherited), String(exitCode)],
        { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true },
      );
      const closed = once(parent, "close");
      let diagnostics = "";
      parent.stderr?.on("data", (chunk) => (diagnostics += String(chunk)));
      let descendantPid: number | undefined;
      try {
        const [message] = await once(parent, "message", { signal: AbortSignal.timeout(20_000) });
        expect(message, diagnostics).toMatchObject({ code: exitCode, signal: null, stderr: "" });
        const result = JSON.parse(message.stdout);
        descendantPid = result.descendantPid;
        expect(Number.isSafeInteger(descendantPid), message.stdout).toBe(true);
        expect(result).toMatchObject({
          launcherExited: true,
          ...(inherited ? { inheritedJob: true } : {}),
        });
        expect(isPidAlive(parent.pid!)).toBe(true);
        if (ownership === "cli") {
          expect(await waitForPidToExit(descendantPid!)).toBe(true);
        } else {
          expect(isPidAlive(descendantPid!)).toBe(true);
        }
      } finally {
        killPidIfAlive(descendantPid);
        killPidIfAlive(parent.pid);
        await closed;
      }
    },
    30_000,
  );
});
