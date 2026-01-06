import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  approveNodePairing,
  listNodePairing,
} from "../src/infra/node-pairing.js";

type GatewayInstance = {
  name: string;
  port: number;
  bridgePort: number;
  hookToken: string;
  homeDir: string;
  configPath: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
};

type NodeListPayload = {
  nodes?: Array<{ nodeId?: string; connected?: boolean; paired?: boolean }>;
};

type HealthPayload = { ok?: boolean };

type PairingList = {
  pending: Array<{ requestId: string; nodeId: string }>;
};

const GATEWAY_START_TIMEOUT_MS = 45_000;
const E2E_TIMEOUT_MS = 120_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getFreePort = async () => {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  if (!addr || typeof addr === "string") {
    srv.close();
    throw new Error("failed to bind ephemeral port");
  }
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return addr.port;
};

const waitForPortOpen = async (
  proc: ChildProcessWithoutNullStreams,
  chunksOut: string[],
  chunksErr: string[],
  port: number,
  timeoutMs: number,
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (proc.exitCode !== null) {
      const stdout = chunksOut.join("");
      const stderr = chunksErr.join("");
      throw new Error(
        `gateway exited before listening (code=${String(proc.exitCode)} signal=${String(proc.signalCode)})\n` +
          `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", (err) => {
          socket.destroy();
          reject(err);
        });
      });
      return;
    } catch {
      // keep polling
    }

    await sleep(25);
  }
  const stdout = chunksOut.join("");
  const stderr = chunksErr.join("");
  throw new Error(
    `timeout waiting for gateway to listen on port ${port}\n` +
      `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
  );
};

const spawnGatewayInstance = async (name: string): Promise<GatewayInstance> => {
  const port = await getFreePort();
  const bridgePort = await getFreePort();
  const hookToken = `token-${name}-${randomUUID()}`;
  const homeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `clawdbot-e2e-${name}-`),
  );
  const configDir = path.join(homeDir, ".clawdbot");
  await fs.mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, "clawdbot.json");
  const config = {
    gateway: { port },
    hooks: { enabled: true, token: hookToken, path: "/hooks" },
    bridge: { bind: "loopback", port: bridgePort },
  };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  const stdout: string[] = [];
  const stderr: string[] = [];
  let child: ChildProcessWithoutNullStreams | null = null;

  try {
    child = spawn(
      "bun",
      [
        "src/index.ts",
        "gateway",
        "--port",
        String(port),
        "--bind",
        "loopback",
        "--allow-unconfigured",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: homeDir,
          CLAWDBOT_CONFIG_PATH: configPath,
          CLAWDBOT_STATE_DIR: path.join(homeDir, ".clawdbot", "state"),
          CLAWDBOT_GATEWAY_TOKEN: "",
          CLAWDBOT_GATEWAY_PASSWORD: "",
          CLAWDBOT_SKIP_PROVIDERS: "1",
          CLAWDBOT_SKIP_BROWSER_CONTROL_SERVER: "1",
          CLAWDBOT_SKIP_CANVAS_HOST: "1",
          CLAWDBOT_ENABLE_BRIDGE_IN_TESTS: "1",
          CLAWDBOT_BRIDGE_HOST: "127.0.0.1",
          CLAWDBOT_BRIDGE_PORT: String(bridgePort),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d) => stdout.push(String(d)));
    child.stderr?.on("data", (d) => stderr.push(String(d)));

    await waitForPortOpen(
      child,
      stdout,
      stderr,
      port,
      GATEWAY_START_TIMEOUT_MS,
    );

    return {
      name,
      port,
      bridgePort,
      hookToken,
      homeDir,
      configPath,
      child,
      stdout,
      stderr,
    };
  } catch (err) {
    if (child && child.exitCode === null && !child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    await fs.rm(homeDir, { recursive: true, force: true });
    throw err;
  }
};

const stopGatewayInstance = async (inst: GatewayInstance) => {
  if (inst.child.exitCode === null && !inst.child.killed) {
    try {
      inst.child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => {
      if (inst.child.exitCode !== null) return resolve(true);
      inst.child.once("exit", () => resolve(true));
    }),
    sleep(5_000).then(() => false),
  ]);
  if (!exited && inst.child.exitCode === null && !inst.child.killed) {
    try {
      inst.child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
  await fs.rm(inst.homeDir, { recursive: true, force: true });
};

const runCliJson = async (
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<unknown> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = spawn("bun", ["src/index.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d) => stdout.push(String(d)));
  child.stderr?.on("data", (d) => stderr.push(String(d)));
  const result = await new Promise<{
    code: number | null;
    signal: string | null;
  }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const out = stdout.join("").trim();
  if (result.code !== 0) {
    throw new Error(
      `cli failed (code=${String(result.code)} signal=${String(result.signal)})\n` +
        `--- stdout ---\n${out}\n--- stderr ---\n${stderr.join("")}`,
    );
  }
  try {
    return out ? (JSON.parse(out) as unknown) : null;
  } catch (err) {
    throw new Error(
      `cli returned non-json output: ${String(err)}\n` +
        `--- stdout ---\n${out}\n--- stderr ---\n${stderr.join("")}`,
    );
  }
};

const postJson = async (url: string, body: unknown) => {
  const payload = JSON.stringify(body);
  const parsed = new URL(url);
  return await new Promise<{ status: number; json: unknown }>(
    (resolve, reject) => {
      const req = httpRequest(
        {
          method: "POST",
          hostname: parsed.hostname,
          port: Number(parsed.port),
          path: `${parsed.pathname}${parsed.search}`,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            let json: unknown = null;
            if (data.trim()) {
              try {
                json = JSON.parse(data);
              } catch {
                json = data;
              }
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    },
  );
};

const createLineReader = (socket: net.Socket) => {
  let buffer = "";
  const pending: Array<(line: string) => void> = [];

  const flush = () => {
    while (pending.length > 0) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const resolve = pending.shift();
      resolve?.(line);
    }
  };

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    flush();
  });

  const readLine = async () => {
    flush();
    const idx = buffer.indexOf("\n");
    if (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      return line;
    }
    return await new Promise<string>((resolve) => pending.push(resolve));
  };

  return readLine;
};

const sendLine = (socket: net.Socket, obj: unknown) => {
  socket.write(`${JSON.stringify(obj)}\n`);
};

const readLineWithTimeout = async (
  readLine: () => Promise<string>,
  label: string,
  timeoutMs = 10_000,
) => {
  const timer = sleep(timeoutMs).then(() => {
    throw new Error(`timeout waiting for ${label}`);
  });
  return await Promise.race([readLine(), timer]);
};

const waitForPairRequest = async (
  baseDir: string,
  nodeId: string,
  timeoutMs = 10_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = (await listNodePairing(baseDir)) as PairingList;
    const match = list.pending.find((p) => p.nodeId === nodeId);
    if (match?.requestId) return match.requestId;
    await sleep(50);
  }
  throw new Error(`timeout waiting for pairing request for ${nodeId}`);
};

const pairNode = async (inst: GatewayInstance, nodeId: string) => {
  const socket = net.connect({ host: "127.0.0.1", port: inst.bridgePort });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const readLine = createLineReader(socket);
  sendLine(socket, {
    type: "pair-request",
    nodeId,
    platform: "ios",
    version: "1.0.0",
  });

  const baseDir = path.join(inst.homeDir, ".clawdbot");
  const requestId = await waitForPairRequest(baseDir, nodeId);
  const approved = await approveNodePairing(requestId, baseDir);
  expect(approved).toBeTruthy();

  const pairLine = JSON.parse(
    await readLineWithTimeout(readLine, `pair-ok (${nodeId})`),
  ) as { type?: string; token?: string };
  expect(pairLine.type).toBe("pair-ok");
  expect(pairLine.token).toBeTruthy();

  const helloLine = JSON.parse(
    await readLineWithTimeout(readLine, `hello-ok (${nodeId})`),
  ) as { type?: string };
  expect(helloLine.type).toBe("hello-ok");

  return socket;
};

describe("gateway multi-instance e2e", () => {
  const instances: GatewayInstance[] = [];

  afterAll(async () => {
    for (const inst of instances) {
      await stopGatewayInstance(inst);
    }
  });

  it(
    "spins up two gateways and exercises WS + HTTP + node pairing",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const gwA = await spawnGatewayInstance("a");
      instances.push(gwA);
      const gwB = await spawnGatewayInstance("b");
      instances.push(gwB);

      const [healthA, healthB] = (await Promise.all([
        runCliJson(["health", "--json", "--timeout", "10000"], {
          CLAWDBOT_GATEWAY_PORT: String(gwA.port),
          CLAWDBOT_GATEWAY_TOKEN: "",
          CLAWDBOT_GATEWAY_PASSWORD: "",
        }),
        runCliJson(["health", "--json", "--timeout", "10000"], {
          CLAWDBOT_GATEWAY_PORT: String(gwB.port),
          CLAWDBOT_GATEWAY_TOKEN: "",
          CLAWDBOT_GATEWAY_PASSWORD: "",
        }),
      ])) as [HealthPayload, HealthPayload];
      expect(healthA.ok).toBe(true);
      expect(healthB.ok).toBe(true);

      const [hookResA, hookResB] = await Promise.all([
        postJson(
          `http://127.0.0.1:${gwA.port}/hooks/wake?token=${gwA.hookToken}`,
          { text: "wake a", mode: "now" },
        ),
        postJson(
          `http://127.0.0.1:${gwB.port}/hooks/wake?token=${gwB.hookToken}`,
          { text: "wake b", mode: "now" },
        ),
      ]);
      expect(hookResA.status).toBe(200);
      expect((hookResA.json as { ok?: boolean } | undefined)?.ok).toBe(true);
      expect(hookResB.status).toBe(200);
      expect((hookResB.json as { ok?: boolean } | undefined)?.ok).toBe(true);

      const nodeASocket = await pairNode(gwA, "node-a");
      const nodeBSocket = await pairNode(gwB, "node-b");

      const [nodeListA, nodeListB] = (await Promise.all([
        runCliJson(
          ["nodes", "status", "--json", "--url", `ws://127.0.0.1:${gwA.port}`],
          {
            CLAWDBOT_GATEWAY_TOKEN: "",
            CLAWDBOT_GATEWAY_PASSWORD: "",
          },
        ),
        runCliJson(
          ["nodes", "status", "--json", "--url", `ws://127.0.0.1:${gwB.port}`],
          {
            CLAWDBOT_GATEWAY_TOKEN: "",
            CLAWDBOT_GATEWAY_PASSWORD: "",
          },
        ),
      ])) as [NodeListPayload, NodeListPayload];
      expect(
        nodeListA.nodes?.some(
          (n) =>
            n.nodeId === "node-a" && n.connected === true && n.paired === true,
        ),
      ).toBe(true);
      expect(
        nodeListB.nodes?.some(
          (n) =>
            n.nodeId === "node-b" && n.connected === true && n.paired === true,
        ),
      ).toBe(true);

      nodeASocket.destroy();
      nodeBSocket.destroy();
    },
  );
});
