import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { WebSocket, type RawData } from "ws";
import {
  QA_EVIDENCE_FILENAME,
  createQaGatewayChild,
  type QaEvidenceSummaryJson,
  type QaGatewayChild,
} from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { ConnectErrorDetailCodes } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import {
  ErrorCodes,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import {
  MAX_BUFFERED_BYTES,
  MAX_PAYLOAD_BYTES,
  TICK_INTERVAL_MS,
} from "../../../../src/gateway/server-constants.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { createQaScriptEvidenceWriter, type QaScriptEvidenceStatus } from "./script-evidence.ts";

const SCENARIO_ID = "gateway-websocket-protocol-contracts";
const SCENARIO_SOURCE = "qa/scenarios/runtime/gateway-websocket-protocol-contracts.yaml";
const SOURCE_PATH = "test/e2e/qa-lab/runtime/gateway-websocket-protocol-contracts.ts";
const FIXTURE_PLUGIN_ID = "qa-gateway-websocket-contracts";
const FIXTURE_SURFACE = "qa-websocket-surface";
const FIXTURE_ROUTE = "/qa-websocket-surface";
const FIXTURE_RESPONSE = "gateway-websocket-surface-ok";
const FRAME_TIMEOUT_MS = 15_000;

type ProducerOptions = {
  artifactBase: string;
  repoRoot: string;
};

type ProofResult = {
  details?: string;
  durationMs: number;
  status: QaScriptEvidenceStatus;
};

type CloseInfo = {
  code: number;
  reason: string;
};

type RawGatewayClient = {
  frames: unknown[];
  socket: WebSocket;
  closeInfo: () => CloseInfo | undefined;
};

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function parseOptions(argv: readonly string[]): ProducerOptions {
  const artifactIndex = argv.indexOf("--artifact-base");
  const artifactBase = artifactIndex >= 0 ? argv[artifactIndex + 1] : undefined;
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  const repoIndex = argv.indexOf("--repo-root");
  return {
    artifactBase: path.resolve(artifactBase),
    repoRoot: path.resolve(repoIndex >= 0 ? (argv[repoIndex + 1] ?? process.cwd()) : process.cwd()),
  };
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

async function openRawGatewayClient(url: string): Promise<RawGatewayClient> {
  const socket = new WebSocket(url);
  const frames: unknown[] = [];
  let closeInfo: CloseInfo | undefined;
  socket.on("message", (data) => {
    frames.push(JSON.parse(rawDataText(data)));
  });
  socket.on("close", (code, reason) => {
    closeInfo = { code, reason: reason.toString("utf8") };
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { frames, socket, closeInfo: () => closeInfo };
}

async function waitForFrame(
  client: RawGatewayClient,
  predicate: (frame: unknown) => boolean,
  startIndex = 0,
): Promise<unknown> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const frame = client.frames.slice(startIndex).find(predicate);
    if (frame !== undefined) {
      return frame;
    }
    const close = client.closeInfo();
    if (close) {
      throw new Error(
        `Gateway socket closed before expected frame: code=${close.code} reason=${close.reason}`,
      );
    }
    await sleep(20);
  }
  throw new Error(`timed out waiting for Gateway frame; captured=${JSON.stringify(client.frames)}`);
}

async function waitForClose(client: RawGatewayClient): Promise<CloseInfo> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const close = client.closeInfo();
    if (close) {
      return close;
    }
    await sleep(20);
  }
  throw new Error(`timed out waiting for Gateway close; captured=${JSON.stringify(client.frames)}`);
}

function sendFrame(client: RawGatewayClient, frame: unknown): void {
  client.socket.send(JSON.stringify(frame));
}

async function closeClient(client: RawGatewayClient): Promise<void> {
  if (client.socket.readyState === WebSocket.CLOSED) {
    return;
  }
  const closed = waitForClose(client);
  client.socket.close();
  await closed.catch(() => undefined);
}

function challengeFrame(frame: unknown): frame is {
  type: "event";
  event: "connect.challenge";
  payload: { nonce: string; ts: number };
} {
  if (!isRecord(frame) || frame.type !== "event" || frame.event !== "connect.challenge") {
    return false;
  }
  const payload = frame.payload;
  return (
    isRecord(payload) &&
    typeof payload.nonce === "string" &&
    payload.nonce.length > 0 &&
    Number.isInteger(payload.ts)
  );
}

function responseFor(id: string) {
  return (frame: unknown) => isRecord(frame) && frame.type === "res" && frame.id === id;
}

function requireResponse(frame: unknown, label: string): Record<string, unknown> {
  assertContract(isRecord(frame), `${label} response was not an object`);
  assertContract(frame.type === "res", `${label} response was not a response frame`);
  return frame;
}

function requireErrorCode(response: Record<string, unknown>, code: string, label: string) {
  assertContract(isRecord(response.error), `${label} response omitted error`);
  assertContract(
    response.error.code === code,
    `${label} error code was ${String(response.error.code)}`,
  );
  return response.error;
}

function buildConnectRequest(params: {
  id: string;
  token: string;
  minProtocol: number;
  maxProtocol: number;
}) {
  return {
    type: "req",
    id: params.id,
    method: "connect",
    params: {
      minProtocol: params.minProtocol,
      maxProtocol: params.maxProtocol,
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        version: "qa-websocket-contracts",
        platform: process.platform,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
      role: "operator",
      scopes: ["operator.admin"],
      auth: { token: params.token },
    },
  };
}

async function readChallenge(client: RawGatewayClient) {
  const challenge = await waitForFrame(client, challengeFrame);
  assertContract(
    client.frames[0] === challenge,
    "connect.challenge was not the first Gateway frame",
  );
  assertContract(challengeFrame(challenge), "Gateway connect challenge had invalid shape");
  assertContract(
    Math.abs(Date.now() - challenge.payload.ts) < FRAME_TIMEOUT_MS,
    `connect.challenge timestamp was stale: ${challenge.payload.ts}`,
  );
  return challenge;
}

async function connectCurrentProtocol(params: { token: string; wsUrl: string }) {
  const client = await openRawGatewayClient(params.wsUrl);
  await readChallenge(client);
  const connectIndex = client.frames.length;
  sendFrame(
    client,
    buildConnectRequest({
      id: "connect-current",
      token: params.token,
      minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
    }),
  );
  const response = requireResponse(
    await waitForFrame(client, responseFor("connect-current"), connectIndex),
    "current protocol connect",
  );
  assertContract(
    response.ok === true,
    `current protocol connect failed: ${JSON.stringify(response)}`,
  );
  assertContract(isRecord(response.payload), "current protocol connect omitted hello payload");
  assertContract(response.payload.type === "hello-ok", "current protocol connect was not hello-ok");
  assertContract(
    response.payload.protocol === PROTOCOL_VERSION,
    `Gateway negotiated protocol ${String(response.payload.protocol)}`,
  );
  return { client, hello: response.payload };
}

async function proveFirstRequestValidation(params: { token: string; wsUrl: string }) {
  const nonConnect = await openRawGatewayClient(params.wsUrl);
  await readChallenge(nonConnect);
  sendFrame(nonConnect, { type: "req", id: "first-health", method: "health", params: {} });
  const rejected = requireResponse(
    await waitForFrame(nonConnect, responseFor("first-health")),
    "non-connect first request",
  );
  requireErrorCode(rejected, ErrorCodes.INVALID_REQUEST, "non-connect first request");
  const nonConnectClose = await waitForClose(nonConnect);
  assertContract(
    nonConnectClose.code === 1008,
    `non-connect first request closed with ${nonConnectClose.code}`,
  );

  const malformed = await openRawGatewayClient(params.wsUrl);
  await readChallenge(malformed);
  sendFrame(malformed, {
    type: "req",
    id: "malformed-first",
    method: "connect",
    params: {},
    unexpected: true,
  });
  const malformedClose = await waitForClose(malformed);
  assertContract(
    malformedClose.code === 1008,
    `malformed first request closed with ${malformedClose.code}`,
  );
  assertContract(
    malformedClose.reason.includes("invalid request frame"),
    `malformed first close reason was ${malformedClose.reason}`,
  );
}

async function proveProtocolMismatch(params: { token: string; wsUrl: string }) {
  const client = await openRawGatewayClient(params.wsUrl);
  await readChallenge(client);
  const disjointProtocol = PROTOCOL_VERSION + 1;
  sendFrame(
    client,
    buildConnectRequest({
      id: "connect-mismatch",
      token: params.token,
      minProtocol: disjointProtocol,
      maxProtocol: disjointProtocol,
    }),
  );
  const response = requireResponse(
    await waitForFrame(client, responseFor("connect-mismatch")),
    "protocol mismatch",
  );
  const error = requireErrorCode(response, ErrorCodes.INVALID_REQUEST, "protocol mismatch");
  assertContract(isRecord(error.details), "protocol mismatch omitted structured details");
  assertContract(
    error.details.code === ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
    `protocol mismatch detail code was ${String(error.details.code)}`,
  );
  assertContract(
    error.details.expectedProtocol === PROTOCOL_VERSION,
    `protocol mismatch expectedProtocol was ${String(error.details.expectedProtocol)}`,
  );
  assertContract(
    error.details.clientMinProtocol === disjointProtocol &&
      error.details.clientMaxProtocol === disjointProtocol,
    "protocol mismatch did not preserve the client range",
  );
  const close = await waitForClose(client);
  assertContract(close.code === 1002, `protocol mismatch closed with ${close.code}`);
}

function requireHelloPolicy(hello: Record<string, unknown>) {
  assertContract(isRecord(hello.policy), "hello-ok omitted policy");
  assertContract(
    hello.policy.maxPayload === MAX_PAYLOAD_BYTES,
    `hello maxPayload was ${String(hello.policy.maxPayload)}`,
  );
  assertContract(
    hello.policy.maxBufferedBytes === MAX_BUFFERED_BYTES,
    `hello maxBufferedBytes was ${String(hello.policy.maxBufferedBytes)}`,
  );
  assertContract(
    hello.policy.tickIntervalMs === TICK_INTERVAL_MS,
    `hello tickIntervalMs was ${String(hello.policy.tickIntervalMs)}`,
  );
}

async function proveRuntimeValidation(client: RawGatewayClient) {
  const malformedIndex = client.frames.length;
  sendFrame(client, {
    type: "req",
    id: "runtime-malformed",
    method: "health",
    params: {},
    unexpected: true,
  });
  const malformed = requireResponse(
    await waitForFrame(client, responseFor("runtime-malformed"), malformedIndex),
    "post-auth malformed envelope",
  );
  const malformedError = requireErrorCode(
    malformed,
    ErrorCodes.INVALID_REQUEST,
    "post-auth malformed envelope",
  );
  assertContract(
    String(malformedError.message).startsWith("invalid request frame:"),
    `post-auth malformed envelope bypassed runtime validation: ${String(malformedError.message)}`,
  );

  const methodIndex = client.frames.length;
  sendFrame(client, {
    type: "req",
    id: "invalid-method-params",
    method: "node.describe",
    params: {},
  });
  const invalidParams = requireResponse(
    await waitForFrame(client, responseFor("invalid-method-params"), methodIndex),
    "invalid method params",
  );
  const methodError = requireErrorCode(
    invalidParams,
    ErrorCodes.INVALID_REQUEST,
    "invalid method params",
  );
  assertContract(
    !String(methodError.message).startsWith("invalid request frame:"),
    "valid request envelope did not reach the method validator",
  );
}

function requirePluginSurfaceUrl(hello: Record<string, unknown>): string {
  assertContract(isRecord(hello.pluginSurfaceUrls), "hello-ok omitted pluginSurfaceUrls");
  const url = hello.pluginSurfaceUrls[FIXTURE_SURFACE];
  assertContract(typeof url === "string" && url.length > 0, "hello-ok omitted fixture surface URL");
  assertContract(
    new URL(url).pathname.startsWith("/__openclaw__/cap/"),
    `fixture surface URL was not capability scoped: ${new URL(url).pathname}`,
  );
  return url;
}

async function fetchFixtureSurface(scopedUrl: string) {
  const response = await fetch(`${scopedUrl}${FIXTURE_ROUTE}`, {
    headers: { connection: "close" },
    signal: AbortSignal.timeout(FRAME_TIMEOUT_MS),
  });
  const body = await response.text();
  assertContract(
    response.status === 200,
    `fixture surface returned HTTP ${response.status}: ${body}`,
  );
  assertContract(body === FIXTURE_RESPONSE, `fixture surface returned ${body}`);
}

async function provePluginSurface(client: RawGatewayClient, hello: Record<string, unknown>) {
  const originalUrl = requirePluginSurfaceUrl(hello);
  await fetchFixtureSurface(originalUrl);
  const refreshIndex = client.frames.length;
  sendFrame(client, {
    type: "req",
    id: "refresh-plugin-surface",
    method: "plugin.surface.refresh",
    params: { surface: FIXTURE_SURFACE, observedUrl: originalUrl },
  });
  const response = requireResponse(
    await waitForFrame(client, responseFor("refresh-plugin-surface"), refreshIndex),
    "plugin surface refresh",
  );
  assertContract(
    response.ok === true,
    `plugin surface refresh failed: ${JSON.stringify(response)}`,
  );
  assertContract(isRecord(response.payload), "plugin surface refresh omitted payload");
  assertContract(
    isRecord(response.payload.pluginSurfaceUrls),
    "plugin surface refresh omitted surface URLs",
  );
  const refreshedUrl = response.payload.pluginSurfaceUrls[FIXTURE_SURFACE];
  assertContract(
    typeof refreshedUrl === "string" && refreshedUrl.length > 0,
    "plugin surface refresh omitted refreshed URL",
  );
  assertContract(refreshedUrl !== originalUrl, "plugin surface refresh did not rotate the URL");
  await fetchFixtureSurface(refreshedUrl);
}

async function createFixturePlugin() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-ws-contracts-"));
  const pluginDir = path.join(root, FIXTURE_PLUGIN_ID);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: FIXTURE_PLUGIN_ID,
        activation: { onStartup: true },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `module.exports = {
  id: ${JSON.stringify(FIXTURE_PLUGIN_ID)},
  register(api) {
    api.registerHttpRoute({
      path: ${JSON.stringify(FIXTURE_ROUTE)},
      auth: "plugin",
      nodeCapability: { surface: ${JSON.stringify(FIXTURE_SURFACE)}, ttlMs: 60000 },
      handler(_req, res) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(${JSON.stringify(FIXTURE_RESPONSE)});
        return true;
      },
    });
  },
};\n`,
    "utf8",
  );
  return {
    pluginDir,
    cleanup: () => fs.rm(root, { force: true, recursive: true }),
  };
}

function withFixturePlugin(config: OpenClawConfig, pluginDir: string): OpenClawConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      enabled: true,
      allow: [...new Set([...(config.plugins?.allow ?? []), FIXTURE_PLUGIN_ID])],
      load: {
        ...config.plugins?.load,
        paths: [...new Set([...(config.plugins?.load?.paths ?? []), pluginDir])],
      },
      entries: {
        ...config.plugins?.entries,
        [FIXTURE_PLUGIN_ID]: { enabled: true },
      },
    },
  };
}

async function runProof(options: ProducerOptions): Promise<string> {
  const fixture = await createFixturePlugin();
  const gatewayOwner = createQaGatewayChild();
  let gateway: QaGatewayChild | undefined;
  let primaryClient: RawGatewayClient | undefined;
  let proofError: Error | undefined;
  let details = "";
  try {
    gateway = await gatewayOwner.start({
      repoRoot: options.repoRoot,
      useRepoCli: true,
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
      fastMode: true,
      mutateConfig: (config) => withFixturePlugin(config, fixture.pluginDir),
    });
    await proveFirstRequestValidation(gateway);
    await proveProtocolMismatch(gateway);
    const connected = await connectCurrentProtocol(gateway);
    primaryClient = connected.client;
    requireHelloPolicy(connected.hello);
    await proveRuntimeValidation(primaryClient);
    await provePluginSurface(primaryClient, connected.hello);
    details = [
      `challenge nonce/timestamp and first-frame ordering verified`,
      `pre-auth and runtime validation verified`,
      `protocol ${PROTOCOL_VERSION} selected and disjoint range rejected`,
      `policy=${MAX_PAYLOAD_BYTES}/${MAX_BUFFERED_BYTES}/${TICK_INTERVAL_MS}`,
      `plugin surface rotated and served`,
    ].join("; ");
  } catch (error) {
    proofError = new Error(
      `${formatErrorMessage(error)}${gateway ? `\nGateway logs:\n${gateway.logs()}` : ""}`,
      { cause: error },
    );
  } finally {
    await closeClient(primaryClient as RawGatewayClient).catch(() => undefined);
    const tempRoot = gateway?.tempRoot;
    await stopQaGatewayFixture(gatewayOwner).catch(() => undefined);
    await fixture.cleanup();
    if (!proofError && tempRoot && existsSync(tempRoot)) {
      proofError = new Error(`Gateway temp root was not cleaned up: ${tempRoot}`);
    }
  }
  if (proofError) {
    throw proofError;
  }
  return details;
}

async function produceProof(options: ProducerOptions): Promise<ProofResult> {
  const startedAt = Date.now();
  try {
    return {
      details: await runProof(options),
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    };
  } catch (error) {
    return {
      details: formatErrorMessage(error),
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    };
  }
}

async function runProducer(options: ProducerOptions): Promise<QaEvidenceSummaryJson> {
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: `${SCENARIO_ID}.log`,
    primaryModel: "mock-openai/gpt-5.6-luna",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Gateway WebSocket runtime contracts",
      sourcePath: SCENARIO_SOURCE,
      docsRefs: ["docs/gateway/protocol.md", "docs/concepts/qa-e2e-automation.md"],
      codeRefs: [
        SOURCE_PATH,
        "src/gateway/server/ws-connection/message-handler.ts",
        "src/gateway/server/ws-connection/connect-admission.ts",
        "src/gateway/server/ws-connection/connect-hello.ts",
        "src/gateway/server-methods/nodes.read.ts",
      ],
    },
  });
  const result = await produceProof(options);
  writer.appendLog(`${result.status}: ${result.details ?? "no details"}\n`);
  return await writer.write(result);
}

async function main(argv: readonly string[]) {
  const evidence = await runProducer(parseOptions(argv));
  const status = evidence.entries[0]?.result.status;
  console.log(`Gateway WebSocket contract evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Gateway WebSocket contract status: ${status}`);
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
