// QA evidence for the real Gateway TLS listener and public client pinning boundary.
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import { GatewayClient } from "@openclaw/gateway-client";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import { startGatewayServer } from "../../../../src/gateway/server.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "../../../../src/gateway/test-helpers.env.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { normalizeFingerprint } from "../../../../src/infra/tls/fingerprint.js";
import { loadGatewayTlsRuntime } from "../../../../src/infra/tls/gateway.js";
import { createDeferred } from "../../../helpers/promise.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SCENARIO_ID = "gateway-tls-pinning";
const SOURCE_PATH = "qa/scenarios/runtime/gateway-tls-pinning.yaml";
const DISCOVERY_PLUGIN_ID = "tls-discovery-proof";
const CONNECTION_TIMEOUT_MS = 15_000;
const ENV_KEYS = [
  "HOME",
  ...GATEWAY_STARTUP_MUTATED_ENV_KEYS,
  "NODE_ENV",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BONJOUR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_PROVIDERS",
  "VITEST",
] as const;

type ProducerOptions = {
  artifactBase: string;
  repoRoot: string;
};

export type GatewayTlsPinningProof = {
  advertisedFingerprint: string;
  cleartextMismatch: string;
  healthResponded: boolean;
  peerFingerprint: string;
  wrongPinFailure: string;
  wrongPinHelloObserved: boolean;
};

function parseOptions(argv: readonly string[]): ProducerOptions {
  const readValue = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const artifactBase = readValue("--artifact-base");
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return {
    artifactBase: path.resolve(artifactBase),
    repoRoot: path.resolve(readValue("--repo-root") ?? process.cwd()),
  };
}

function captureEnvironment() {
  const snapshot = new Map<string, string | undefined>(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  return () => {
    for (const [key, value] of snapshot) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

async function writeDiscoveryProbePlugin(
  pluginDir: string,
  advertisementPath: string,
): Promise<void> {
  await fs.mkdir(pluginDir, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      `${JSON.stringify(
        {
          id: DISCOVERY_PLUGIN_ID,
          activation: { onStartup: true },
          configSchema: {
            type: "object",
            additionalProperties: false,
            properties: {},
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    fs.writeFile(
      path.join(pluginDir, "index.cjs"),
      `const fs = require("node:fs");
module.exports = {
  id: ${JSON.stringify(DISCOVERY_PLUGIN_ID)},
  register(api) {
    api.registerGatewayDiscoveryService({
      id: ${JSON.stringify(DISCOVERY_PLUGIN_ID)},
      advertise(context) {
        fs.writeFileSync(${JSON.stringify(advertisementPath)}, JSON.stringify(context), "utf8");
      },
    });
  },
};
`,
      "utf8",
    ),
  ]);
}

async function readAdvertisedFingerprint(advertisementPath: string): Promise<string> {
  const advertisement: unknown = JSON.parse(await fs.readFile(advertisementPath, "utf8"));
  if (!isRecord(advertisement) || advertisement.gatewayTlsEnabled !== true) {
    throw new Error("Gateway discovery publisher did not advertise TLS");
  }
  const fingerprint = advertisement.gatewayTlsFingerprintSha256;
  if (typeof fingerprint !== "string") {
    throw new Error("Gateway discovery publisher did not advertise a TLS fingerprint");
  }
  const normalized = normalizeFingerprint(fingerprint);
  if (!normalized) {
    throw new Error("Gateway discovery publisher advertised an invalid TLS fingerprint");
  }
  return normalized;
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate a loopback port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForPeerFingerprint(port: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = tls.connect({
      host: "127.0.0.1",
      minVersion: "TLSv1.3",
      port,
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out reading Gateway TLS peer certificate"));
    }, CONNECTION_TIMEOUT_MS);
    timer.unref?.();
    const cleanup = () => clearTimeout(timer);
    socket.once("secureConnect", () => {
      const fingerprint = normalizeFingerprint(socket.getPeerCertificate().fingerprint256 ?? "");
      cleanup();
      socket.end();
      if (!fingerprint) {
        reject(new Error("Gateway peer certificate did not expose a SHA-256 fingerprint"));
        return;
      }
      resolve(fingerprint);
    });
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${CONNECTION_TIMEOUT_MS}ms`)),
      CONNECTION_TIMEOUT_MS,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function connectWithExactPin(url: string, tlsFingerprint: string): Promise<boolean> {
  const hello = createDeferred<void>();
  const client = new GatewayClient({
    url,
    tlsFingerprint,
    onConnectError: hello.reject,
    onHelloOk: () => hello.resolve(),
  });
  try {
    client.start();
    await withTimeout(hello.promise, "Gateway exact-pin hello");
    const health = await client.request("health", {});
    return health !== null && typeof health === "object";
  } finally {
    await client.stopAndWait().catch(() => undefined);
  }
}

async function connectWithWrongPin(
  url: string,
  tlsFingerprint: string,
): Promise<{ error: string; helloObserved: boolean }> {
  const failure = createDeferred<Error>();
  let helloObserved = false;
  const client = new GatewayClient({
    url,
    tlsFingerprint,
    onConnectError: (error) => {
      client.stop();
      failure.resolve(error);
    },
    onHelloOk: () => {
      helloObserved = true;
    },
  });
  try {
    client.start();
    const error = await withTimeout(failure.promise, "Gateway wrong-pin failure");
    if (!/fingerprint mismatch/iu.test(error.message)) {
      throw new Error(`wrong pin failed for an unexpected reason: ${error.message}`);
    }
    if (helloObserved) {
      throw new Error("wrong TLS pin reached Gateway hello");
    }
    return { error: error.message, helloObserved };
  } finally {
    await client.stopAndWait().catch(() => undefined);
  }
}

async function proveCleartextMismatch(port: number, tlsFingerprint: string): Promise<string> {
  const failure = createDeferred<Error>();
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    tlsFingerprint,
    onConnectError: failure.resolve,
  });
  try {
    client.start();
    const error = await withTimeout(failure.promise, "Gateway plaintext pin policy");
    if (!/fingerprint requires wss:\/\//iu.test(error.message)) {
      throw new Error(`plaintext mismatch failed for an unexpected reason: ${error.message}`);
    }
    return error.message;
  } finally {
    await client.stopAndWait().catch(() => undefined);
  }
}

export async function runGatewayTlsPinningProof(): Promise<GatewayTlsPinningProof> {
  const restoreEnvironment = captureEnvironment();
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-tls-pinning-"));
  const stateDir = path.join(runtimeRoot, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const certPath = path.join(runtimeRoot, "tls", "gateway-cert.pem");
  const keyPath = path.join(runtimeRoot, "tls", "gateway-key.pem");
  const pluginDir = path.join(runtimeRoot, "discovery-plugin");
  const advertisementPath = path.join(runtimeRoot, "gateway-discovery-advertisement.json");
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;

  try {
    process.env.HOME = runtimeRoot;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
    process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    process.env.OPENCLAW_SKIP_CRON = "1";
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
    process.env.OPENCLAW_SKIP_PROVIDERS = "1";
    delete process.env.NODE_ENV;
    delete process.env.OPENCLAW_DISABLE_BONJOUR;
    delete process.env.VITEST;
    await writeDiscoveryProbePlugin(pluginDir, advertisementPath);

    const preparedTls = await loadGatewayTlsRuntime({
      enabled: true,
      autoGenerate: true,
      certPath,
      keyPath,
    });
    if (!preparedTls.enabled || !preparedTls.fingerprintSha256) {
      throw new Error(preparedTls.error ?? "Gateway TLS runtime did not expose a fingerprint");
    }
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          gateway: {
            auth: { mode: "none" },
            bind: "loopback",
            controlUi: { enabled: false },
            tls: { enabled: true, autoGenerate: false, certPath, keyPath },
          },
          plugins: {
            enabled: true,
            allow: [DISCOVERY_PLUGIN_ID],
            load: { paths: [pluginDir] },
            entries: {
              [DISCOVERY_PLUGIN_ID]: { enabled: true },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    clearConfigCache();
    clearRuntimeConfigSnapshot();

    const port = await getFreePort();
    server = await startGatewayServer(port, {
      auth: { mode: "none" },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    const url = `wss://127.0.0.1:${port}`;
    const advertisedFingerprint = await readAdvertisedFingerprint(advertisementPath);
    const peerFingerprint = await waitForPeerFingerprint(port);
    if (peerFingerprint !== advertisedFingerprint) {
      throw new Error("Gateway advertised TLS fingerprint did not match the live peer certificate");
    }

    const healthResponded = await connectWithExactPin(url, advertisedFingerprint);
    const wrongPin = `${advertisedFingerprint.slice(0, -1)}${
      advertisedFingerprint.endsWith("0") ? "1" : "0"
    }`;
    const wrongPinResult = await connectWithWrongPin(url, wrongPin);
    const cleartextMismatch = await proveCleartextMismatch(port, advertisedFingerprint);

    return {
      advertisedFingerprint,
      cleartextMismatch,
      healthResponded,
      peerFingerprint,
      wrongPinFailure: wrongPinResult.error,
      wrongPinHelloObserved: wrongPinResult.helloObserved,
    };
  } finally {
    await server?.close({ reason: "Gateway TLS pinning proof complete" }).catch(() => undefined);
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    restoreEnvironment();
    await fs.rm(runtimeRoot, { force: true, recursive: true });
  }
}

export async function runGatewayTlsPinningProducer(
  options: ProducerOptions,
): Promise<QaEvidenceSummaryJson> {
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: `${SCENARIO_ID}.log`,
    primaryModel: "mock-openai/gpt-5.6-luna",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Gateway TLS certificate pinning",
      sourcePath: SOURCE_PATH,
      docsRefs: ["docs/gateway/index.md", "docs/gateway/discovery.md", "docs/gateway/protocol.md"],
      codeRefs: [
        "src/infra/tls/gateway.ts",
        "src/gateway/server-runtime-state.ts",
        "packages/gateway-client/src/client.ts",
      ],
    },
  });
  const startedAt = Date.now();
  try {
    const proof = await runGatewayTlsPinningProof();
    await fs.mkdir(options.artifactBase, { recursive: true });
    const summaryPath = path.join(options.artifactBase, "gateway-tls-pinning-summary.json");
    await fs.writeFile(summaryPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
    writer.appendLog("pass: exact pin connected; wrong pin and plaintext mismatch rejected\n");
    return await writer.write({
      artifacts: [{ filePath: summaryPath, kind: "summary" }],
      details: "Real TLS Gateway pinning contract passed.",
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = formatErrorMessage(error);
    writer.appendLog(`fail: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  }
}

async function main(argv: readonly string[]) {
  const evidence = await runGatewayTlsPinningProducer(parseOptions(argv));
  const status = evidence.entries[0]?.result.status;
  console.log(`Gateway TLS pinning evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Gateway TLS pinning status: ${status}`);
  return status === "pass" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error: unknown) => {
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    });
}
