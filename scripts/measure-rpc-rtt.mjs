import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_METHODS = ["health", "config.get"];
const DEFAULT_ITERATIONS = 10;
export const READY_TIMEOUT_MS = 120_000;
export const READY_PROBE_TIMEOUT_MS = 1_000;
const IS_DIRECT_RUN =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function usage() {
  return [
    "Usage: node --import tsx scripts/measure-rpc-rtt.mjs",
    "  --output-dir <dir>",
    "  [--repo-root <openclaw-repo>]",
    "  [--iterations <count>]",
    "  [--methods <comma-separated-methods>]",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    iterations: DEFAULT_ITERATIONS,
    methods: DEFAULT_METHODS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output-dir") {
      args.outputDir = argv[(index += 1)];
      continue;
    }
    if (arg === "--repo-root") {
      args.repoRoot = argv[(index += 1)];
      continue;
    }
    if (arg === "--iterations") {
      args.iterations = Number(argv[(index += 1)]);
      continue;
    }
    if (arg === "--methods") {
      args.methods = argv[(index += 1)]
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  if (!args.outputDir) {
    throw new Error(usage());
  }
  if (!Number.isInteger(args.iterations) || args.iterations < 1) {
    throw new Error("--iterations must be a positive integer.");
  }
  if (args.methods.length === 0) {
    throw new Error("--methods must include at least one gateway method.");
  }
  return args;
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
          return;
        }
        reject(new Error("failed to allocate loopback port"));
      });
    });
  });
}

async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

export async function waitForGatewayReady({
  child,
  fetchImpl = fetch,
  port,
  probeTimeoutMs = READY_PROBE_TIMEOUT_MS,
  readyTimeoutMs = READY_TIMEOUT_MS,
  sleepMs = 250,
  stderrPath,
}) {
  const startedAt = Date.now();
  let childExit = null;
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
  });
  const getChildExit = () =>
    childExit ??
    (child.exitCode != null || child.signalCode != null
      ? { code: child.exitCode, signal: child.signalCode }
      : null);
  while (Date.now() - startedAt < readyTimeoutMs) {
    const observedExit = getChildExit();
    if (observedExit) {
      const stderr = await fs.readFile(stderrPath, "utf8").catch(() => "");
      throw new Error(
        `gateway exited before readiness code=${observedExit.code ?? "null"} signal=${observedExit.signal ?? "null"}\n${stderr.slice(-4000)}`,
      );
    }
    for (const endpoint of ["/readyz", "/healthz"]) {
      try {
        const response = await fetchImpl(`http://127.0.0.1:${port}${endpoint}`, {
          signal: AbortSignal.timeout(probeTimeoutMs),
        });
        if (response.ok) {
          return;
        }
      } catch {
        // The gateway may not have bound the port yet.
      }
    }
    await sleep(sleepMs);
  }
  const stderr = await fs.readFile(stderrPath, "utf8").catch(() => "");
  throw new Error(`gateway did not become ready after ${readyTimeoutMs}ms\n${stderr.slice(-4000)}`);
}

async function stopGateway(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 1_500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function closeFileHandles(handles) {
  const results = await Promise.allSettled(
    handles.filter(Boolean).map((handle) => handle.close()),
  );
  const failedClose = results.find((result) => result.status === "rejected");
  if (failedClose) {
    throw failedClose.reason;
  }
}

export async function startGateway({
  configPath,
  env = process.env,
  openImpl = fs.open,
  port,
  repoRoot,
  spawnImpl = spawn,
  stderrPath,
  stdoutPath,
  tempRoot,
  token,
}) {
  const stdout = await openImpl(stdoutPath, "w");
  let stderr;
  try {
    stderr = await openImpl(stderrPath, "w");
  } catch (error) {
    try {
      await closeFileHandles([stdout]);
    } catch {}
    throw error;
  }

  let child;
  try {
    child = spawnImpl(
      "pnpm",
      [
        "openclaw",
        "gateway",
        "run",
        "--port",
        String(port),
        "--bind",
        "loopback",
        "--allow-unconfigured",
      ],
      {
        cwd: repoRoot,
        env: {
          ...env,
          HOME: path.join(tempRoot, "home"),
          XDG_CONFIG_HOME: path.join(tempRoot, "xdg-config"),
          XDG_DATA_HOME: path.join(tempRoot, "xdg-data"),
          XDG_CACHE_HOME: path.join(tempRoot, "xdg-cache"),
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
          OPENCLAW_GATEWAY_TOKEN: token,
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_TEST_FAST: "1",
        },
        stdio: ["ignore", stdout.fd, stderr.fd],
      },
    );
  } catch (error) {
    try {
      await closeFileHandles([stdout, stderr]);
    } catch {}
    throw error;
  }

  try {
    await closeFileHandles([stdout, stderr]);
  } catch (error) {
    try {
      await stopGateway(child);
    } catch {}
    throw error;
  }

  return child;
}

export async function cleanupTempRoot(tempRoot, { rmImpl = fs.rm } = {}) {
  try {
    await rmImpl(tempRoot, { force: true, recursive: true });
  } catch (error) {
    throw new Error(`failed to remove RPC RTT temp root: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }
}

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

function stats(samples) {
  const sorted = samples.toSorted((left, right) => left - right);
  return {
    avgMs: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    maxMs: Math.round(sorted.at(-1)),
    minMs: Math.round(sorted[0]),
    p50Ms: Math.round(quantile(sorted, 0.5)),
    p95Ms: Math.round(quantile(sorted, 0.95)),
  };
}

function toText(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function createGatewayClient({ WebSocket, url }) {
  const ws = new WebSocket(url, { handshakeTimeout: 8_000 });
  const pending = new Map();
  const rejectPending = (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    pending.clear();
  };
  ws.on("message", (data) => {
    let frame;
    try {
      frame = JSON.parse(toText(data));
    } catch {
      return;
    }
    if (frame?.type === "res") {
      const waiter = pending.get(frame.id);
      if (!waiter) {
        return;
      }
      pending.delete(frame.id);
      clearTimeout(waiter.timeout);
      waiter.resolve(frame);
    }
  });
  ws.on("close", (code, reason) => {
    rejectPending(new Error(`gateway websocket closed (${code}): ${toText(reason)}`));
  });
  ws.on("error", (error) => {
    rejectPending(error instanceof Error ? error : new Error(String(error)));
  });
  const waitOpen = async () =>
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("gateway websocket open timeout")), 8_000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  const request = async (method, params, timeoutMs = 10_000) =>
    await new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`gateway websocket is not open for ${method}`));
        return;
      }
      const id = randomUUID();
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify({ type: "req", id, method, params }), (error) => {
        if (!error) {
          return;
        }
        const waiter = pending.get(id);
        if (!waiter) {
          return;
        }
        pending.delete(id);
        clearTimeout(waiter.timeout);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  const close = () => {
    rejectPending(new Error("gateway websocket client closed"));
    ws.close();
  };
  return { close, request, waitOpen };
}

async function writeSummary({
  details,
  events,
  finishedAt,
  outputDir,
  measurement,
  startedAt,
  status,
}) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, "rpc-events.json"),
    `${JSON.stringify(events, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(outputDir, "qa-suite-summary.json"),
    `${JSON.stringify(
      {
        counts: {
          total: 1,
          passed: status === "pass" ? 1 : 0,
          failed: status === "pass" ? 0 : 1,
        },
        run: {
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          providerMode: "gateway-rpc",
          scenarioIds: ["rpc-gateway-smoke"],
        },
        scenarios: [
          {
            id: "rpc-gateway-smoke",
            title: "Gateway RPC loopback smoke",
            status,
            details,
            ...(measurement ? { rttMeasurement: measurement } : {}),
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(args.repoRoot ?? process.env.OPENCLAW_REPO_ROOT ?? process.cwd());
  const outputDir = path.resolve(args.outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  const tempRoot = await fs.mkdtemp(path.join(outputDir, "..", ".rpc-rtt-"));
  const startedAt = new Date();
  const token = `rpc-rtt-${randomUUID()}`;
  const port = await getFreePort();
  const configPath = path.join(tempRoot, "openclaw.json");
  const stdoutPath = path.join(tempRoot, "gateway.stdout.log");
  const stderrPath = path.join(tempRoot, "gateway.stderr.log");
  let gatewayChild;
  let status = "fail";
  let details = "";
  let measurement;
  let cleanupError;
  const events = [];
  try {
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          gateway: {
            mode: "local",
            bind: "loopback",
            port,
            auth: { mode: "token", token },
            controlUi: { enabled: false },
          },
          plugins: { enabled: false },
        },
        null,
        2,
      )}\n`,
    );
    gatewayChild = await startGateway({
      configPath,
      port,
      repoRoot,
      stderrPath,
      stdoutPath,
      tempRoot,
      token,
    });
    await waitForGatewayReady({ child: gatewayChild, port, stderrPath });

    const requireFromOpenClaw = createRequire(path.join(repoRoot, "package.json"));
    const WebSocket = requireFromOpenClaw("ws");
    const protocol = await import(
      pathToFileURL(path.join(repoRoot, "packages/gateway-protocol/src/version.ts")).href
    );
    const client = createGatewayClient({ WebSocket, url: `ws://127.0.0.1:${port}` });
    await client.waitOpen();
    const connectStarted = performance.now();
    const connect = await client.request(
      "connect",
      {
        minProtocol: protocol.MIN_CLIENT_PROTOCOL_VERSION,
        maxProtocol: protocol.PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          displayName: "openclaw-rtt rpc probe",
          version: "rtt",
          platform: process.platform,
          mode: "backend",
          instanceId: `openclaw-rtt-rpc-${randomUUID()}`,
        },
        locale: "en-US",
        userAgent: "openclaw-rtt-rpc",
        role: "operator",
        scopes: ["operator.admin"],
        caps: [],
        auth: { token },
      },
      10_000,
    );
    if (!connect.ok) {
      throw new Error(`connect failed: ${JSON.stringify(connect.error)}`);
    }
    events.push({
      event: "gateway-rpc.connect",
      payload: {
        method: "connect",
        ok: true,
        durationMs: Math.round(performance.now() - connectStarted),
      },
    });
    const samples = [];
    for (const method of args.methods) {
      for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
        const requestStartedAtMs = performance.now();
        const response = await client.request(method, {}, 10_000);
        const durationMs = Math.round(performance.now() - requestStartedAtMs);
        if (!response.ok) {
          throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
        }
        samples.push({ method, durationMs });
        events.push({
          event: "gateway-rpc",
          payload: { kind: "gateway-rpc", method, ok: true, durationMs, iteration },
        });
      }
    }
    client.close();
    const sampleStats = stats(samples.map((sample) => sample.durationMs));
    const byMethod = Object.fromEntries(
      args.methods.map((method) => [
        method,
        stats(
          samples.filter((sample) => sample.method === method).map((sample) => sample.durationMs),
        ),
      ]),
    );
    measurement = {
      finalMatchedReplyRttMs: sampleStats.p50Ms,
      durationMs: sampleStats.p50Ms,
      method: args.methods.join(","),
      source: "gateway-rpc",
    };
    details = JSON.stringify({
      iterations: args.iterations,
      methods: args.methods,
      stats: sampleStats,
      byMethod,
    });
    status = "pass";
  } catch (error) {
    details = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    if (gatewayChild) {
      await stopGateway(gatewayChild).catch(() => {});
    }
    try {
      await cleanupTempRoot(tempRoot);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError) {
    const cleanupDetails = formatErrorMessage(cleanupError);
    details = details ? `${details}\n${cleanupDetails}` : cleanupDetails;
    status = "fail";
  }
  const finishedAt = new Date();
  await writeSummary({ details, events, finishedAt, outputDir, measurement, startedAt, status });
  if (status !== "pass") {
    throw new Error(details || "RPC RTT measurement failed");
  }
}

if (IS_DIRECT_RUN) {
  main().catch(
    /** @param {unknown} error */ (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
