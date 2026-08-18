import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(process.platform === "win32")("OpenClaw stdio process-group ownership", () => {
  it(
    "kills same-group descendants after the leader exits spontaneously",
    { timeout: 10_000 },
    async () => {
      const root = tempDirs.make("mcp-stdio-descendant-");
      const serverPath = path.join(root, "leader.mjs");
      const descendantPidPath = path.join(root, "descendant.pid");
      const exitMarkerPath = path.join(root, "exit.marker");
      await fs.writeFile(
        serverPath,
        `import {spawn} from "node:child_process"; import fs from "node:fs"; const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid)); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitMarkerPath)})){clearInterval(timer);process.exit(1)}},10);`,
        "utf8",
      );
      const transport = new OpenClawStdioClientTransport({
        command: process.execPath,
        args: [serverPath],
        stderr: "ignore",
      });
      const closed = new Promise<void>((resolve) => {
        // MCP transports expose callback properties rather than EventTarget listeners.
        // oxlint-disable-next-line unicorn/prefer-add-event-listener
        transport.onclose = resolve;
      });
      let descendantPid = 0;
      try {
        await transport.start();
        await vi.waitFor(async () => {
          descendantPid = Number(await fs.readFile(descendantPidPath, "utf8"));
          expect(isPidAlive(descendantPid)).toBe(true);
        });
        await fs.writeFile(exitMarkerPath, "exit", "utf8");
        await closed;
        await vi.waitFor(() => expect(isPidAlive(descendantPid)).toBe(false));

        await transport.close();
        expect(isPidAlive(descendantPid)).toBe(false);
      } finally {
        await transport.forceClose();
        if (descendantPid && isPidAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );
});
