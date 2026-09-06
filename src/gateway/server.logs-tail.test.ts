import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { flushLogger, getChildLogger, setLoggerOverride } from "../logging/logger.js";
import { installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("tails configured rolling placeholders through authenticated Gateway RPC", async () => {
  const tempDir = tempDirs.make("openclaw-gateway-log-tail-");
  setLoggerOverride({
    file: path.join(tempDir, "openclaw-YYYY-MM-DD.log"),
    level: "info",
    consoleLevel: "silent",
  });
  try {
    getChildLogger({ module: "log-tail" }).warn({ reason: "disabled" }, "rolling RPC record");
    await flushLogger();

    const response = await rpcReq<{ file: string; lines: string[] }>(ws, "logs.tail", {
      limit: 200,
      maxBytes: 256_000,
    });

    expect(response.ok).toBe(true);
    expect(response.payload?.lines).toEqual(
      expect.arrayContaining([expect.stringContaining("rolling RPC record")]),
    );
    expect(path.dirname(response.payload?.file ?? "")).toBe(tempDir);
    expect(path.basename(response.payload?.file ?? "")).toMatch(
      /^openclaw-\d{4}-\d{2}-\d{2}\.log$/,
    );
  } finally {
    await flushLogger();
    setLoggerOverride({ level: "silent", consoleLevel: "silent" });
  }
});
