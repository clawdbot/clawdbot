// Process coverage for one-shot Gateway CLI output followed by clean exit.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const activeChildren = new Set<ChildProcessWithoutNullStreams>();
const activeServers = new Set<WebSocketServer>();

afterEach(async () => {
  await Promise.all(
    Array.from(activeChildren, async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        // Let the launcher forward termination to its respawned child.
        child.kill("SIGTERM");
        await once(child, "close");
      }
    }),
  );
  await Promise.all(Array.from(activeServers, closeMinimalGatewayServer));
  activeServers.clear();
});

async function startCronListGateway(token: string): Promise<{ url: string }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  activeServers.add(wss);
  wss.on("connection", (ws) => {
    sendMinimalGatewayConnectChallenge(ws);
    ws.on("message", (data) => {
      const frame = parseMinimalGatewayRequestFrame(data);
      if (frame.type !== "req" || !frame.id) {
        return;
      }
      if (frame.method === "connect") {
        expect(frame.params?.auth?.token).toBe(token);
        sendMinimalGatewayResponse(
          ws,
          frame.id,
          buildMinimalGatewayHelloOkPayload({
            methods: ["cron.list"],
            auth: { role: "operator", scopes: ["operator.admin"] },
          }),
        );
        return;
      }
      if (frame.method === "cron.list") {
        sendMinimalGatewayResponse(ws, frame.id, {
          jobs: [],
          snapshotRevision: "test-revision",
          total: 0,
          offset: 0,
          limit: 50,
          hasMore: false,
          nextOffset: null,
          deliveryPreviews: {},
        });
      }
    });
  });
  await once(wss, "listening");
  const address = wss.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${address.port}` };
}

describe("gateway-backed CLI process exit", () => {
  it("exits promptly after cron list emits complete output", async () => {
    const root = tempDirs.make("openclaw-gateway-cli-exit-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const caTriggerPath = path.join(root, "load-default-ca.mjs");
    const token = "test-token";
    const gateway = await startCronListGateway(token);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      caTriggerPath,
      `if (process.env.OPENCLAW_NODE_OPTIONS_READY === "1") {
  const { getCACertificates } = await import("node:tls");
  getCACertificates("default");
}
`,
    );
    await fs.writeFile(
      configPath,
      JSON.stringify({
        gateway: { mode: "remote", remote: { url: gateway.url, token } },
      }),
    );

    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        pathToFileURL(caTriggerPath).href,
        "src/entry.ts",
        "cron",
        "list",
        "--json",
      ],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          HOME: root,
          NODE_ENV: undefined,
          NODE_OPTIONS: undefined,
          NODE_USE_SYSTEM_CA: "1",
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_NODE_OPTIONS_READY: undefined,
          OPENCLAW_STATE_DIR: stateDir,
          VITEST: undefined,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    activeChildren.add(child);
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let exitTimer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      once(child, "close").then(([code, signal]) => ({ code, signal })),
      new Promise<never>((_, reject) => {
        exitTimer = setTimeout(
          () => reject(new Error("cron list did not exit within 10 seconds")),
          10_000,
        );
        exitTimer.unref();
      }),
    ]).finally(() => {
      if (exitTimer) {
        clearTimeout(exitTimer);
      }
    });
    activeChildren.delete(child);

    expect(result, stderr).toEqual({ code: 0, signal: null });
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ jobs: [], total: 0 });
  }, 20_000);
});
