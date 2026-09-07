// Produces QA evidence for real Gateway loopback isolation and LAN exposure.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { WebSocket, type RawData } from "ws";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/index.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../../../../src/config/sessions/store-writer-state.js";
import { pickPrimaryLanIPv4 } from "../../../../src/gateway/net.js";
import { startGatewayServer, type GatewayServer } from "../../../../src/gateway/server.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "../../../../src/gateway/test-helpers.env.js";
import { resetAgentEventsForTest } from "../../../../src/infra/agent-events.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../../../src/test-utils/env.js";
import { getFreePort } from "../../../../src/test-utils/ports.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SOURCE_PATH = "test/e2e/qa-lab/runtime/gateway-loopback-lan-access.ts";
const SCENARIO_ID = "gateway-loopback-lan-access";
const PROBE_TIMEOUT_MS = 10_000;
const ENV_KEYS = [
  "HOME",
  ...GATEWAY_STARTUP_MUTATED_ENV_KEYS,
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
] as const;

type ProducerOptions = {
  artifactBase: string;
  repoRoot: string;
};

type GatewayResponseFrame = {
  error?: { message?: string };
  event?: string;
  id?: string;
  ok?: boolean;
  payload?: unknown;
  type?: string;
};

type ListenerProof = {
  authenticatedHealthRpc: boolean;
  healthStatus: number;
  invalidTokenRejected: boolean;
};

export type GatewayLoopbackLanProof = {
  lan: ListenerProof & {
    nonLoopbackInterface: boolean;
    reachableThroughInterface: boolean;
  };
  loopback: ListenerProof & {
    isolatedFromLanInterface: boolean;
  };
};

export function parseGatewayLoopbackLanOptions(args: string[]): ProducerOptions {
  let artifactBase: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option !== "--artifact-base") {
      throw new Error(`unknown argument: ${option}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error("--artifact-base requires a value");
    }
    artifactBase = value;
    index += 1;
  }
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return { artifactBase: path.resolve(artifactBase), repoRoot: process.cwd() };
}

export function assertGatewayLoopbackLanProof(proof: GatewayLoopbackLanProof): void {
  const checks = [
    ["loopback HTTP health", proof.loopback.healthStatus === 200],
    ["loopback invalid-token rejection", proof.loopback.invalidTokenRejected],
    ["loopback authenticated health RPC", proof.loopback.authenticatedHealthRpc],
    ["loopback isolation from LAN", proof.loopback.isolatedFromLanInterface],
    ["non-loopback interface selection", proof.lan.nonLoopbackInterface],
    ["LAN interface reachability", proof.lan.reachableThroughInterface],
    ["LAN HTTP health", proof.lan.healthStatus === 200],
    ["LAN invalid-token rejection", proof.lan.invalidTokenRejected],
    ["LAN authenticated health RPC", proof.lan.authenticatedHealthRpc],
  ] as const;
  const failed = checks.filter(([, passed]) => !passed).map(([label]) => label);
  if (failed.length > 0) {
    throw new Error(`Gateway network proof failed: ${failed.join(", ")}`);
  }
}

function resetGatewayTestState(): void {
  resetAgentEventsForTest({ preserveListeners: true });
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out opening Gateway WebSocket")),
      PROBE_TIMEOUT_MS,
    );
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}

function waitForFrame(
  ws: WebSocket,
  predicate: (frame: GatewayResponseFrame) => boolean,
  label: string,
): Promise<GatewayResponseFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error(`timed out waiting for ${label}`)),
      PROBE_TIMEOUT_MS,
    );
    const onMessage = (data: RawData) => {
      try {
        const frame = JSON.parse(rawDataToString(data)) as GatewayResponseFrame;
        if (predicate(frame)) {
          finish(undefined, frame);
        }
      } catch {
        // Ignore unrelated non-JSON frames while waiting for the selected response.
      }
    };
    const onClose = (code: number) => finish(new Error(`Gateway WebSocket closed (${code})`));
    const onError = (error: Error) => finish(error);
    const finish = (error?: Error, frame?: GatewayResponseFrame) => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
      if (error) {
        reject(error);
      } else {
        resolve(frame as GatewayResponseFrame);
      }
    };
    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

async function openGatewayWebSocket(params: {
  host: string;
  localAddress?: string;
  port: number;
}): Promise<WebSocket> {
  const ws = new WebSocket(`ws://${params.host}:${params.port}`, {
    localAddress: params.localAddress,
  });
  const challenge = waitForFrame(
    ws,
    (frame) =>
      frame.type === "event" && (frame as { event?: string }).event === "connect.challenge",
    "connect challenge",
  );
  await waitForOpen(ws);
  await challenge;
  return ws;
}

async function sendRequest(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown>,
): Promise<GatewayResponseFrame> {
  const id = randomUUID();
  const response = waitForFrame(
    ws,
    (frame) => frame.type === "res" && frame.id === id,
    `${method} response`,
  );
  const request = { type: "req", id, method, params };
  ws.send(JSON.stringify(request));
  return await response;
}

async function probeGatewayAuth(params: {
  host: string;
  localAddress?: string;
  port: number;
  token: string;
}): Promise<{ authenticatedHealthRpc: boolean; invalidTokenRejected: boolean }> {
  const connectParams = (token: string) => ({
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: GATEWAY_CLIENT_NAMES.TEST,
      displayName: "Gateway network QA",
      version: "1.0.0",
      platform: process.platform,
      mode: GATEWAY_CLIENT_MODES.TEST,
    },
    caps: [],
    auth: { token },
    role: "operator",
    scopes: [],
  });

  const invalidWs = await openGatewayWebSocket(params);
  let invalidTokenRejected = false;
  try {
    const invalid = await sendRequest(invalidWs, "connect", connectParams("invalid-token"));
    invalidTokenRejected =
      invalid.ok === false && (invalid.error?.message ?? "").toLowerCase().includes("unauthorized");
  } finally {
    invalidWs.terminate();
  }

  const validWs = await openGatewayWebSocket(params);
  let authenticatedHealthRpc = false;
  try {
    const connected = await sendRequest(validWs, "connect", connectParams(params.token));
    if (connected.ok !== true) {
      throw new Error(`valid Gateway token was rejected: ${connected.error?.message ?? "unknown"}`);
    }
    const health = await sendRequest(validWs, "health", {});
    authenticatedHealthRpc = health.ok === true;
  } finally {
    validWs.terminate();
  }
  return { authenticatedHealthRpc, invalidTokenRejected };
}

async function probeHttpHealth(params: {
  host: string;
  localAddress?: string;
  port: number;
}): Promise<number> {
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: params.host,
        localAddress: params.localAddress,
        path: "/healthz",
        port: params.port,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.setTimeout(PROBE_TIMEOUT_MS, () => {
      request.destroy(new Error("timed out waiting for Gateway HTTP health"));
    });
    request.end();
  });
}

async function probeTcpUnreachable(params: {
  host: string;
  localAddress: string;
  port: number;
}): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.connect(params);
    const timer = setTimeout(() => finish(true), 2_000);
    const finish = (unreachable: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(unreachable);
    };
    socket.once("connect", () => {
      // Linux can connect an ephemeral socket to itself on the probed address.
      // Identical endpoints do not mean a listener accepted LAN traffic.
      const selfConnected =
        socket.localAddress === socket.remoteAddress && socket.localPort === socket.remotePort;
      finish(selfConnected);
    });
    socket.once("error", () => finish(true));
  });
}

async function startGateway(port: number, bind: "lan" | "loopback", token: string) {
  const server = await startGatewayServer(port, {
    auth: { mode: "token", token },
    bind,
    controlUiEnabled: false,
    sidecarStartup: "defer",
  });
  // HTTP attachment precedes mandatory sidecar settlement. Network probes own
  // a fully admitted generation, not the intentional startup-unavailable phase.
  await server.startupSettled;
  return server;
}

async function stopGateway(server: GatewayServer | undefined): Promise<void> {
  if (server) {
    await server.close({ reason: "Gateway network QA complete" });
  }
  resetGatewayTestState();
}

export async function runGatewayLoopbackLanProof(): Promise<GatewayLoopbackLanProof> {
  const lanIp = pickPrimaryLanIPv4();
  if (!lanIp || net.isIP(lanIp) !== 4 || lanIp.startsWith("127.")) {
    throw new Error("no usable non-loopback IPv4 interface is available");
  }

  const env = captureEnv([...ENV_KEYS]);
  // openclaw-temp-dir: standalone producer removes this state root in finally
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-network-"));
  const stateDir = path.join(tempHome, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  const emptyPluginsDir = path.join(tempHome, "empty-bundled-plugins");
  const token = `gateway-network-${randomUUID()}`;
  let server: GatewayServer | undefined;

  try {
    for (const key of ENV_KEYS) {
      deleteTestEnvValue(key);
    }
    setTestEnvValue("HOME", tempHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
    setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
    setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
    setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
    setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
    setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
    setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
    setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", emptyPluginsDir);
    setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", "1");
    await fs.mkdir(emptyPluginsDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ gateway: { mode: "local", auth: { mode: "token", token } } }, null, 2)}\n`,
      "utf8",
    );
    resetGatewayTestState();

    const loopbackPort = await getFreePort("0.0.0.0");
    server = await startGateway(loopbackPort, "loopback", token);
    const loopbackHealthStatus = await probeHttpHealth({
      host: "127.0.0.1",
      port: loopbackPort,
    });
    const loopbackAuth = await probeGatewayAuth({
      host: "127.0.0.1",
      port: loopbackPort,
      token,
    });
    const isolatedFromLanInterface = await probeTcpUnreachable({
      host: lanIp,
      localAddress: lanIp,
      port: loopbackPort,
    });
    await stopGateway(server);
    server = undefined;

    const lanPort = await getFreePort("0.0.0.0");
    server = await startGateway(lanPort, "lan", token);
    const lanHealthStatus = await probeHttpHealth({
      host: lanIp,
      localAddress: lanIp,
      port: lanPort,
    });
    const lanAuth = await probeGatewayAuth({
      host: lanIp,
      localAddress: lanIp,
      port: lanPort,
      token,
    });

    const proof: GatewayLoopbackLanProof = {
      loopback: {
        ...loopbackAuth,
        healthStatus: loopbackHealthStatus,
        isolatedFromLanInterface,
      },
      lan: {
        ...lanAuth,
        healthStatus: lanHealthStatus,
        nonLoopbackInterface: true,
        reachableThroughInterface: lanHealthStatus === 200 && lanAuth.authenticatedHealthRpc,
      },
    };
    assertGatewayLoopbackLanProof(proof);
    return proof;
  } finally {
    await stopGateway(server);
    env.restore();
    await fs.rm(tempHome, { force: true, recursive: true });
  }
}

async function runProducer(options: ProducerOptions) {
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "gateway-loopback-lan-access.log",
    primaryModel: "gateway/network-access",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      codeRefs: [
        SOURCE_PATH,
        "src/gateway/net.ts",
        "src/gateway/server.ts",
        "src/gateway/server-runtime-config.ts",
      ],
      docsRefs: [
        "docs/gateway/index.md",
        "docs/gateway/protocol.md",
        "docs/gateway/security/index.md",
        "docs/concepts/qa-e2e-automation.md",
      ],
      id: SCENARIO_ID,
      sourcePath: SOURCE_PATH,
      title: "Gateway loopback and LAN access",
    },
  });
  const startedAt = Date.now();
  try {
    const proof = await runGatewayLoopbackLanProof();
    await fs.mkdir(options.artifactBase, { recursive: true });
    await fs.writeFile(
      path.join(options.artifactBase, "network-summary.json"),
      `${JSON.stringify(proof, null, 2)}\n`,
      "utf8",
    );
    writer.appendLog("pass: loopback isolation, LAN reachability, and token auth proven\n");
    return await writer.write({
      artifacts: [{ kind: "summary", filePath: "network-summary.json" }],
      details:
        "loopback HTTP/WS passed; LAN-address isolation passed; LAN-interface HTTP/WS passed; invalid tokens rejected",
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    writer.appendLog(`fail: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  }
}

async function main(args: string[]) {
  const evidence = await runProducer(parseGatewayLoopbackLanOptions(args));
  const status = evidence.entries[0]?.result.status;
  console.log(`Gateway loopback and LAN access status: ${status}`);
  return status === "pass" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
