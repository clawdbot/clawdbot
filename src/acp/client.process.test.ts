/** Real-process lifecycle tests for the interactive ACP client. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { runAcpClientInteractive } from "./client.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("runAcpClientInteractive process lifecycle", () => {
  it("force-kills the spawned ACP server when the handshake fails", async () => {
    const dir = await tempDirs.make("openclaw-acp-client-process-test-");
    const pidFile = path.join(dir, "server.pid");
    const termFile = path.join(dir, "server.term");
    // The client prepends "acp" to server args, so this becomes `node acp`.
    await writeFile(
      path.join(dir, "acp"),
      `
const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(termFile)}, "SIGTERM");
});
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params.protocolVersion,
        agentCapabilities: { loadSession: false },
      },
    }) + "\\n");
  } else if (request.method === "session/new") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message: "fixture newSession failure",
        data: { stage: "newSession" },
      },
    }) + "\\n");
  }
});
setInterval(() => {}, 60_000);
`,
    );

    let serverPid: number | undefined;
    try {
      const error = await runAcpClientInteractive({
        serverCommand: process.execPath,
        cwd: dir,
      }).catch((caught: unknown) => caught);
      serverPid = Number(await readFile(pidFile, "utf8"));

      expect(error).toMatchObject({
        name: "RequestError",
        code: -32000,
        message: "fixture newSession failure",
        data: { stage: "newSession" },
      });
      if (process.platform !== "win32") {
        expect(await readFile(termFile, "utf8")).toBe("SIGTERM");
      }
      expect(() => process.kill(serverPid as number, 0)).toThrow();
    } finally {
      if (serverPid !== undefined) {
        try {
          process.kill(serverPid, "SIGKILL");
        } catch {
          // Already reaped.
        }
      }
    }
  }, 20_000);
});
