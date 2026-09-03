#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { parseArgs } from "node:util";

const WATCH_CLIENT = Object.freeze({
  id: "openclaw-watchos",
  displayName: "Upgrade Survivor Watch",
  version: "2026.8.10",
  platform: "watchOS 11.5.0",
  deviceFamily: "Apple Watch",
  mode: "node",
  instanceId: "watchos-upgrade-survivor",
});
const WATCH_COMMANDS = Object.freeze(["device.info", "device.status", "system.notify"]);
const WATCH_PROTOCOL = 4;

function requiredOption(values, name) {
  const value = values[name];
  assert(typeof value === "string" && value.length > 0, `--${name} is required`);
  return value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeDeviceMetadata(value) {
  return value.trim().replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

function buildSignaturePayload({ deviceId, signedAt, token, nonce }) {
  return [
    "v3",
    deviceId,
    WATCH_CLIENT.id,
    WATCH_CLIENT.mode,
    "node",
    "",
    String(signedAt),
    token,
    nonce,
    normalizeDeviceMetadata(WATCH_CLIENT.platform),
    normalizeDeviceMetadata(WATCH_CLIENT.deviceFamily),
  ].join("|");
}

function createIdentity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const rawPublicKey = Buffer.from(publicDer).subarray(-32);
  return {
    deviceId: sha256(rawPublicKey),
    publicKey: rawPublicKey.toString("base64url"),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
    instanceId: WATCH_CLIENT.instanceId,
  };
}

function loadIdentity(stateFile) {
  const state = fs.existsSync(stateFile) ? readJson(stateFile) : createIdentity();
  for (const field of ["deviceId", "publicKey", "privateKeyPem", "instanceId"]) {
    assert(typeof state[field] === "string" && state[field].length > 0, `state omitted ${field}`);
  }
  assert.equal(state.instanceId, WATCH_CLIENT.instanceId, "watch instanceId changed");
  return state;
}

function decodeBootstrapSetup(setupFile) {
  const result = readJson(setupFile);
  assert(typeof result.setupCode === "string", "setupCode missing");
  const encoded = result.setupCode.toLowerCase().startsWith("oc-pair://")
    ? result.setupCode.slice("oc-pair://".length)
    : result.setupCode;
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  assert(typeof payload.bootstrapToken === "string", "bootstrapToken missing");
  assert(payload.token === undefined, "setup payload included a gateway token");
  assert(payload.password === undefined, "setup payload included a gateway password");
  if (payload.expiresAtMs !== undefined) {
    assert(
      Number.isSafeInteger(payload.expiresAtMs) && payload.expiresAtMs > Date.now(),
      "setup payload expired",
    );
  }
  const candidates = [payload.url, ...(Array.isArray(payload.urls) ? payload.urls : [])];
  let secureUrl;
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "wss:" || parsed.protocol === "https:") {
        secureUrl = parsed;
        break;
      }
    } catch {
      // Match the app parser: an invalid candidate does not hide a later secure fallback.
    }
  }
  assert(secureUrl, "setup payload omitted a trusted TLS endpoint");
  assert(!secureUrl.username && !secureUrl.password, "setup endpoint included userinfo");
  assert(!secureUrl.search && !secureUrl.hash, "setup endpoint included query or fragment");
  return {
    credential: payload.bootstrapToken,
    endpoint: {
      host: secureUrl.hostname,
      port: Number(secureUrl.port || "443"),
      tls: true,
    },
  };
}

function watchApiBaseUrlFromEndpoint(endpoint) {
  assert(endpoint && typeof endpoint === "object", "persisted endpoint missing");
  assert.equal(endpoint.tls, true, "persisted endpoint is not TLS");
  assert(typeof endpoint.host === "string" && endpoint.host.length > 0, "endpoint host missing");
  assert(
    Number.isSafeInteger(endpoint.port) && endpoint.port >= 1 && endpoint.port <= 65535,
    "endpoint port invalid",
  );
  const url = new URL("https://localhost");
  url.hostname = endpoint.host;
  url.port = String(endpoint.port);
  return `${url.origin}/api/nodes/watch`;
}

async function readResponseJson(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} ${response.status}: non-JSON response`);
  }
}

async function connect(values) {
  const mode = requiredOption(values, "mode");
  assert(mode === "bootstrap" || mode === "device", `unsupported connect mode: ${mode}`);
  const stateFile = requiredOption(values, "state");
  const outputFile = requiredOption(values, "out");
  const label = requiredOption(values, "label");
  const state = loadIdentity(stateFile);
  const setup =
    mode === "bootstrap" ? decodeBootstrapSetup(requiredOption(values, "credential")) : undefined;
  if (setup) {
    state.endpoint = setup.endpoint;
    writeJson(stateFile, state);
  }
  const endpointSource = setup ? "setupCode" : "persistedState";
  const baseUrl = watchApiBaseUrlFromEndpoint(state.endpoint);
  const credential = setup ? setup.credential : state.deviceToken;
  assert(typeof credential === "string" && credential.length > 0, `${mode} credential missing`);

  const challengeResponse = await fetch(`${baseUrl}/challenge`, {
    headers: { accept: "application/json" },
  });
  const challenge = await readResponseJson(challengeResponse, "challenge");
  assert.equal(challengeResponse.status, 200, `challenge failed: ${JSON.stringify(challenge)}`);
  assert.equal(challenge.ok, true, "challenge response was not ok");
  assert(
    typeof challenge.nonce === "string" && challenge.nonce.length > 0,
    "challenge nonce missing",
  );
  const signedAt = Number.isSafeInteger(challenge.ts) ? challenge.ts : Date.now();
  const privateKey = crypto.createPrivateKey(state.privateKeyPem);
  const signature = crypto
    .sign(
      null,
      Buffer.from(
        buildSignaturePayload({
          deviceId: state.deviceId,
          signedAt,
          token: credential,
          nonce: challenge.nonce,
        }),
        "utf8",
      ),
      privateKey,
    )
    .toString("base64url");
  const auth = mode === "bootstrap" ? { bootstrapToken: credential } : { deviceToken: credential };
  const body = {
    minProtocol: WATCH_PROTOCOL,
    maxProtocol: WATCH_PROTOCOL,
    client: WATCH_CLIENT,
    caps: [],
    commands: WATCH_COMMANDS,
    permissions: { notifications: true },
    role: "node",
    scopes: [],
    auth,
    device: {
      id: state.deviceId,
      publicKey: state.publicKey,
      signature,
      signedAt,
      nonce: challenge.nonce,
    },
    locale: "en-US",
    userAgent: WATCH_CLIENT.platform,
  };
  const connectResponse = await fetch(`${baseUrl}/connect`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await readResponseJson(connectResponse, "connect");
  assert.equal(connectResponse.status, 200, `connect failed: ${JSON.stringify(response)}`);
  assert.equal(response.ok, true, "connect response was not ok");
  for (const field of ["sessionToken", "deviceToken", "nodeId"]) {
    assert(
      typeof response[field] === "string" && response[field].length > 0,
      `connect omitted ${field}`,
    );
  }
  assert.equal(response.nodeId, state.deviceId, "connect returned another node identity");
  assert.equal(response.protocol, WATCH_PROTOCOL, "connect negotiated another protocol");
  state.deviceToken = response.deviceToken;
  writeJson(stateFile, state);
  const pollResponse = await fetch(`${baseUrl}/poll`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${response.sessionToken}`,
    },
  });
  const poll = await readResponseJson(pollResponse, "poll");
  assert.equal(pollResponse.status, 200, `poll failed: ${JSON.stringify(poll)}`);
  assert.equal(poll.ok, true, "poll response was not ok");
  const artifact = {
    label,
    ok: true,
    mode,
    authField: mode === "bootstrap" ? "bootstrapToken" : "deviceToken",
    challengeStatus: challengeResponse.status,
    connectStatus: connectResponse.status,
    pollStatus: pollResponse.status,
    pollAuthenticated: true,
    transport: "https",
    endpointSource,
    challengeTimestampSource: Number.isSafeInteger(challenge.ts) ? "gateway" : "local-clock",
    protocol: response.protocol,
    protocolRange: [WATCH_PROTOCOL, WATCH_PROTOCOL],
    clientId: WATCH_CLIENT.id,
    clientMode: WATCH_CLIENT.mode,
    nodeId: state.deviceId,
    instanceId: state.instanceId,
    deviceTokenSha256: sha256(response.deviceToken),
    sessionTokenSha256: sha256(response.sessionToken),
  };
  writeJson(outputFile, artifact);
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
}

function assertGatewayState(values) {
  const state = readJson(requiredOption(values, "state"));
  const nodesResult = readJson(requiredOption(values, "nodes"));
  const devicesResult = readJson(requiredOption(values, "devices"));
  const outputFile = requiredOption(values, "out");
  const label = requiredOption(values, "label");
  const nodes = Array.isArray(nodesResult) ? nodesResult : nodesResult.nodes;
  const pending = Array.isArray(devicesResult.pending) ? devicesResult.pending : [];
  const paired = Array.isArray(devicesResult.paired) ? devicesResult.paired : [];
  assert(Array.isArray(nodes), "node.list result omitted nodes");
  const node = nodes.find(
    (entry) => entry?.id === state.deviceId || entry?.nodeId === state.deviceId,
  );
  const pendingForWatch = pending.filter((entry) => entry?.deviceId === state.deviceId);
  const pairedForWatch = paired.filter((entry) => entry?.deviceId === state.deviceId);
  assert(node, `${label}: watch missing from node.list`);
  assert.equal(node.clientId ?? node.client?.id, WATCH_CLIENT.id, `${label}: wrong client id`);
  assert.equal(
    node.clientMode ?? node.client?.mode,
    WATCH_CLIENT.mode,
    `${label}: wrong client mode`,
  );
  assert.equal(pending.length, 0, `${label}: pending pairing table is not empty`);
  assert.equal(pendingForWatch.length, 0, `${label}: watch pairing remains pending`);
  assert.equal(pairedForWatch.length, 1, `${label}: expected one paired watch`);
  const artifact = {
    label,
    ok: true,
    onlineNode: true,
    pendingTotal: pending.length,
    pendingForWatch: pendingForWatch.length,
    pairedForWatch: pairedForWatch.length,
    clientId: WATCH_CLIENT.id,
    clientMode: WATCH_CLIENT.mode,
    nodeId: state.deviceId,
    instanceId: state.instanceId,
  };
  writeJson(outputFile, artifact);
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
}

async function main() {
  const command = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      credential: { type: "string" },
      devices: { type: "string" },
      label: { type: "string" },
      mode: { type: "string" },
      nodes: { type: "string" },
      out: { type: "string" },
      state: { type: "string" },
    },
    strict: true,
  });
  if (command === "connect") {
    await connect(values);
    return;
  }
  if (command === "assert-state") {
    assertGatewayState(values);
    return;
  }
  throw new Error(`unknown watchOS direct-node command: ${command ?? "<missing>"}`);
}

main().catch((/** @type {unknown} */ error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  console.error("[watchos-direct-node] FAILED (exit 1)");
  process.exitCode = 1;
});
