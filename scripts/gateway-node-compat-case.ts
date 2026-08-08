import { spawn, type ChildProcess } from "node:child_process";
import { createPublicKey, randomUUID, timingSafeEqual, verify } from "node:crypto";
import {
  chmodSync,
  chownSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { WebSocket, WebSocketServer, type RawData } from "ws";

type CaseInput = {
  caseId: string;
  gateway: "baseline" | "candidate";
  node: "baseline" | "candidate";
  outcome: "passed" | "protocol-mismatch";
};
type Observation = {
  clientMin: number;
  clientMax: number;
  helloProtocol: number | null;
  identity: { clientId: string; mode: string; platform: string; role: string };
  protocolError: unknown;
};

const GATEWAY_PORT = 18789;
const OBSERVER_PORT = 18790;
const GATEWAY_UID = 65532;
const GATEWAY_GID = 65532;
const NODE_UID = 65533;
const NODE_GID = 65533;
const CLI_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const CLI_FAILURE_SUMMARY_LIMIT = 512;
const CHILD_STOP_GRACE_MS = 5_000;
const CHILD_KILL_WAIT_MS = 5_000;
const childExitPromises = new WeakMap<ChildProcess, Promise<number>>();
const SYSTEM_WHICH_OPERATION = {
  command: "system.which",
  params: { bins: ["node"] },
} as const;
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}

async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) {
    throw new Error("usage: gateway-node-compat-case.ts <input.json> <output.json>");
  }
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as CaseInput;
  const architecture = process.env.OPENCLAW_GATEWAY_NODE_ARCH;
  if ((architecture !== "arm64" && architecture !== "x64") || process.arch !== architecture) {
    throw new Error(`Container architecture ${process.arch} does not match ${architecture}.`);
  }
  const token = randomUUID().replaceAll("-", "");
  const children = new Set<ChildProcess>();
  const startedAt = new Date().toISOString();
  const runtimeRoot = createRuntimeRoot();
  try {
    const gateway = runtime(input.gateway);
    const node = runtime(input.node);
    const gatewayEnv = runtimeEnv(
      prepareRuntimeHome({
        root: runtimeRoot,
        name: "gateway",
        uid: GATEWAY_UID,
        gid: GATEWAY_GID,
      }),
      gateway.binDir,
      token,
    );
    const nodeEnv = runtimeEnv(
      prepareRuntimeHome({
        root: runtimeRoot,
        name: "node",
        uid: NODE_UID,
        gid: NODE_GID,
      }),
      node.binDir,
      token,
    );
    const observer = await startObserver(token);
    const startNode = () =>
      start(
        node.cli,
        [
          "node",
          "run",
          "--host",
          "127.0.0.1",
          "--port",
          String(OBSERVER_PORT),
          "--node-id",
          input.caseId,
          "--display-name",
          input.caseId,
        ],
        nodeEnv,
        children,
        NODE_UID,
        NODE_GID,
      );
    const bootstrapNode = startNode();
    await observer.captureExpectedIdentity(bootstrapNode);
    await stopChild(bootstrapNode);

    const gatewayChild = start(
      gateway.cli,
      [
        "gateway",
        "run",
        "--bind",
        "loopback",
        "--port",
        String(GATEWAY_PORT),
        "--force",
        "--allow-unconfigured",
      ],
      gatewayEnv,
      children,
      GATEWAY_UID,
      GATEWAY_GID,
    );
    await waitForPort(GATEWAY_PORT, gatewayChild);
    observer.activate(`ws://127.0.0.1:${GATEWAY_PORT}`);
    try {
      let operation: unknown = null;
      if (input.outcome === "passed") {
        let latestCliFailure: string | null = null;
        await approveAndInvoke({
          caseId: input.caseId,
          cli: async (args) => {
            const result = await cliJson(
              gateway.cli,
              gatewayCliArgs(args, `ws://127.0.0.1:${GATEWAY_PORT}`, token),
              gatewayEnv,
            );
            // Polling may fail transiently; retain the latest bounded failure for a terminal error.
            if (result.failure) {
              latestCliFailure = result.failure;
            }
            return result.value;
          },
          cliFailureSummary: () => latestCliFailure,
          nodeChild: startNode(),
          startNode,
        });
        operation = observer.readOperation();
      } else {
        const disjointHome = prepareRuntimeHome({
          root: runtimeRoot,
          name: "disjoint",
          uid: NODE_UID,
          gid: NODE_GID,
        });
        await runDisjointClient(
          node.packageRoot,
          token,
          observer.authorizeDisjointProbe(),
          disjointHome,
          runtimeEnv(disjointHome, "", token),
          children,
          NODE_UID,
          NODE_GID,
        );
      }
      const observation = validateObservedIdentity(observer.read());
      const mismatch =
        input.outcome === "protocol-mismatch"
          ? normalizeMismatch(observation, input.gateway === "baseline" ? "2026.5.7" : undefined)
          : null;
      writeFileSync(
        outputPath,
        `${JSON.stringify({
          observation,
          operation,
          mismatch,
          architecture,
          startedAt,
          completedAt: new Date().toISOString(),
        })}\n`,
        { encoding: "utf8", mode: 0o644 },
      );
    } finally {
      await observer.close();
    }
  } finally {
    try {
      await Promise.all([...children].map((child) => stopChild(child)));
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  }
}

function runtime(id: "baseline" | "candidate") {
  const prefix = `/runtimes/${id}`;
  return {
    binDir: join(prefix, "bin"),
    cli: join(prefix, "bin", "openclaw"),
    packageRoot: join(prefix, "lib", "node_modules", "openclaw"),
  };
}

function createRuntimeRoot() {
  const root = mkdtempSync("/tmp/openclaw-gateway-node-compat-");
  chmodSync(root, 0o711);
  assertTrustedRuntimeRoot(root, 0, 0);
  return root;
}

function assertTrustedRuntimeRoot(root: string, uid: number, gid: number) {
  const stat = lstatSync(root);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== uid ||
    stat.gid !== gid ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error("Gateway/node compatibility runtime root is not trusted.");
  }
}

export function prepareRuntimeHome(
  params: {
    root: string;
    name: string;
    uid: number;
    gid: number;
    rootUid?: number;
    rootGid?: number;
  },
  chown: typeof chownSync = chownSync,
) {
  const rootUid = params.rootUid ?? 0;
  const rootGid = params.rootGid ?? 0;
  assertTrustedRuntimeRoot(params.root, rootUid, rootGid);
  const home = join(params.root, params.name);
  if (lstatSync(home, { throwIfNoEntry: false })) {
    throw new Error(`Refusing existing runtime home ${params.name}.`);
  }
  mkdirSync(home, { mode: 0o700 });
  const created = lstatSync(home);
  if (
    created.isSymbolicLink() ||
    !created.isDirectory() ||
    created.uid !== rootUid ||
    created.gid !== rootGid
  ) {
    throw new Error(`Runtime home ${params.name} was not created by the trusted supervisor.`);
  }
  chown(home, params.uid, params.gid);
  return home;
}

function runtimeEnv(home: string, binDir: string, gatewayToken: string) {
  return {
    HOME: home,
    PATH: `${binDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    OPENCLAW_CONFIG_PATH: join(home, "openclaw.json"),
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: join(home, ".openclaw"),
  };
}

function start(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  children: Set<ChildProcess>,
  uid: number,
  gid: number,
) {
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "inherit", "inherit"],
    uid,
    gid,
  });
  children.add(child);
  void waitForExit(child);
  child.once("close", () => children.delete(child));
  return child;
}

async function waitForPort(port: number, child: ChildProcess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (isChildTerminal(child)) {
      throw new Error(`Gateway exited before opening port ${port}.`);
    }
    const connected = await new Promise<boolean>((resolvePromise) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(250);
      socket.once("connect", () => {
        socket.destroy();
        resolvePromise(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolvePromise(false);
      });
      socket.once("error", () => resolvePromise(false));
    });
    if (connected) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for port ${port}.`);
}

export async function approveAndInvoke(params: {
  caseId: string;
  cli: (args: string[]) => Promise<unknown>;
  cliFailureSummary?: () => string | null;
  nodeChild: ChildProcess;
  startNode: () => ChildProcess;
  stopNode?: (child: ChildProcess) => Promise<void>;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<unknown>;
  timeoutMs?: number;
}) {
  const now = params.now ?? Date.now;
  const wait = params.wait ?? delay;
  const stopNode = params.stopNode ?? stopChild;
  const deadline = now() + (params.timeoutMs ?? 60_000);
  const approvedDeviceRequests = new Set<string>();
  const approvedNodeRequests = new Set<string>();
  let nodeChild = params.nodeChild;
  const failure = (message: string) => {
    const summary = params.cliFailureSummary?.();
    return new Error(summary ? `${message} Last CLI failure: ${summary}` : message);
  };
  const matchesNode = (entry: unknown) =>
    isRecord(entry) &&
    entry.displayName === params.caseId &&
    (entry.role === "node" || (Array.isArray(entry.roles) && entry.roles.includes("node")));
  while (now() < deadline) {
    if (isChildTerminal(nodeChild)) {
      throw failure("Node exited before invocation.");
    }

    const devices = await params.cli(["devices", "list"]);
    const pendingDevices =
      isRecord(devices) && Array.isArray(devices.pending)
        ? devices.pending.filter(matchesNode)
        : [];
    const pairedDevices =
      isRecord(devices) && Array.isArray(devices.paired) ? devices.paired.filter(matchesNode) : [];
    if (pendingDevices.length > 1 || pairedDevices.length > 1) {
      throw new Error(`Multiple device pairings matched ${params.caseId}.`);
    }
    const pendingDevice = pendingDevices[0];
    const pairedDevice = pairedDevices[0];
    const pendingDeviceId =
      isRecord(pendingDevice) && typeof pendingDevice.deviceId === "string"
        ? pendingDevice.deviceId
        : "";
    const pairedDeviceId =
      isRecord(pairedDevice) && typeof pairedDevice.deviceId === "string"
        ? pairedDevice.deviceId
        : "";
    if (pendingDeviceId && pairedDeviceId && pendingDeviceId !== pairedDeviceId) {
      throw new Error(`Multiple device pairings matched ${params.caseId}.`);
    }
    const deviceRequestId =
      isRecord(pendingDevice) && typeof pendingDevice.requestId === "string"
        ? pendingDevice.requestId
        : "";
    if (deviceRequestId && !approvedDeviceRequests.has(deviceRequestId)) {
      const approved = await params.cli(["devices", "approve", deviceRequestId]);
      if (approved) {
        approvedDeviceRequests.add(deviceRequestId);
        await stopNode(nodeChild);
        nodeChild = params.startNode();
      }
      await wait(250);
      continue;
    }
    const deviceId = pairedDeviceId;
    if (!deviceId) {
      await wait(250);
      continue;
    }

    const pending = await params.cli(["nodes", "pending"]);
    if (Array.isArray(pending)) {
      const requests = pending.filter(
        (entry) =>
          isRecord(entry) &&
          (entry.nodeId === deviceId || entry.nodeId === params.caseId) &&
          entry.displayName === params.caseId,
      );
      if (requests.length > 1) {
        throw new Error(`Multiple pending requests matched ${params.caseId}.`);
      }
      const requestId = requests[0]?.requestId;
      if (typeof requestId === "string" && !approvedNodeRequests.has(requestId)) {
        const approved = await params.cli(["nodes", "approve", requestId]);
        if (approved) {
          approvedNodeRequests.add(requestId);
          await stopNode(nodeChild);
          nodeChild = params.startNode();
        }
        await wait(250);
        continue;
      }
    }

    const status = await params.cli(["nodes", "status"]);
    const nodes =
      isRecord(status) && Array.isArray(status.nodes)
        ? status.nodes.filter(
            (entry) =>
              isRecord(entry) && (entry.nodeId === deviceId || entry.displayName === params.caseId),
          )
        : [];
    if (nodes.length > 1) {
      throw new Error(`Multiple connected nodes matched ${params.caseId}.`);
    }
    const node = nodes[0];
    const operation = resolveApprovedNodeOperation(node);
    const nodeId = isRecord(node) && typeof node.nodeId === "string" ? node.nodeId : "";
    if (!operation || !nodeId) {
      await wait(250);
      continue;
    }

    const result = await params.cli([
      "nodes",
      "invoke",
      "--node",
      nodeId,
      "--command",
      operation.command,
      "--params",
      JSON.stringify(operation.params),
    ]);
    if (!isRecord(result) || result.ok !== true || result.command !== operation.command) {
      throw failure(`Approved node operation failed for ${params.caseId}.`);
    }
    const payload = isRecord(result.payload) ? result.payload : {};
    const bins = isRecord(payload.bins) ? payload.bins : {};
    if (typeof bins.node !== "string" || !bins.node) {
      throw new Error(`Approved node operation returned no node binary for ${params.caseId}.`);
    }
    return {
      method: "node.invoke",
      command: operation.command,
      params: operation.params,
      ok: true,
      result: { bins: { node: bins.node } },
    };
  }
  throw failure(`Timed out invoking ${params.caseId}.`);
}

export function resolveApprovedNodeOperation(node: unknown) {
  if (!isRecord(node) || node.paired !== true || node.connected !== true) {
    return null;
  }
  if (typeof node.approvalState === "string" && node.approvalState !== "approved") {
    return null;
  }
  const commands = Array.isArray(node.commands)
    ? node.commands.filter((command): command is string => typeof command === "string")
    : [];
  return commands.includes(SYSTEM_WHICH_OPERATION.command) ? SYSTEM_WHICH_OPERATION : null;
}

export function buildObservedNodeOperation(requestPayload: unknown, resultParams: unknown) {
  const request = isRecord(requestPayload) ? requestPayload : {};
  const result = isRecord(resultParams) ? resultParams : {};
  const requestParams =
    typeof request.paramsJSON === "string" ? JSON.parse(request.paramsJSON) : undefined;
  const resultPayload =
    typeof result.payloadJSON === "string" ? JSON.parse(result.payloadJSON) : result.payload;
  if (
    typeof request.id !== "string" ||
    typeof request.nodeId !== "string" ||
    request.command !== SYSTEM_WHICH_OPERATION.command ||
    !isDeepStrictEqual(requestParams, SYSTEM_WHICH_OPERATION.params) ||
    result.id !== request.id ||
    result.nodeId !== request.nodeId ||
    result.ok !== true ||
    !isRecord(resultPayload) ||
    !isRecord(resultPayload.bins) ||
    typeof resultPayload.bins.node !== "string" ||
    !resultPayload.bins.node
  ) {
    throw new Error("Observer did not capture one matching successful node invocation.");
  }
  return {
    method: "node.invoke",
    command: request.command,
    params: requestParams,
    ok: true,
    result: { bins: { node: resultPayload.bins.node } },
  };
}

function gatewayCliArgs(args: string[], url: string, token: string) {
  return [...args, "--json", "--url", url, "--token", token];
}

export function isChildTerminal(child: Pick<ChildProcess, "exitCode" | "signalCode">): boolean {
  return child.exitCode != null || child.signalCode != null;
}

export async function stopChild(
  child: ChildProcess,
  options: { graceMs?: number; killWaitMs?: number } = {},
) {
  const exit = waitForExit(child);
  if (!isChildTerminal(child)) {
    child.kill("SIGTERM");
  }
  if (await waitForExitWithin(exit, options.graceMs ?? CHILD_STOP_GRACE_MS)) {
    return;
  }
  child.kill("SIGKILL");
  if (!(await waitForExitWithin(exit, options.killWaitMs ?? CHILD_KILL_WAIT_MS))) {
    throw new Error("Child process did not exit after SIGKILL.");
  }
}

async function cliJson(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    uid: GATEWAY_UID,
    gid: GATEWAY_GID,
  });
  const exit = waitForExit(child);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let capturedBytes = 0;
  let exceededLimit = false;
  const capture = (target: Buffer[]) => (chunk: unknown) => {
    const bytes = Buffer.from(chunk as Uint8Array);
    const remaining = CLI_OUTPUT_LIMIT_BYTES - capturedBytes;
    if (remaining > 0) {
      target.push(bytes.subarray(0, remaining));
      capturedBytes += Math.min(bytes.length, remaining);
    }
    if (bytes.length > remaining) {
      exceededLimit = true;
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", capture(stdout));
  child.stderr.on("data", capture(stderr));
  const status: number = await exit;
  if (exceededLimit) {
    throw new Error(`CLI output exceeded ${CLI_OUTPUT_LIMIT_BYTES} bytes.`);
  }
  if (status !== 0) {
    return {
      value: null,
      failure: formatCliFailureDiagnostic({
        args,
        status,
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    };
  }
  const text = Buffer.concat(stdout).toString("utf8").trim();
  return {
    value: text ? (JSON.parse(text) as unknown) : null,
    failure: null,
  };
}

export function formatCliFailureDiagnostic(params: {
  args: string[];
  status: number;
  stderr: string;
}) {
  let stderr = stripTerminalSequences(params.stderr);
  for (let index = 0; index < params.args.length; index += 1) {
    if (params.args[index] === "--token") {
      const secret = params.args[index + 1];
      if (secret) {
        stderr = stderr.replaceAll(secret, "[redacted]");
      }
    }
  }
  const sanitized = stderr.replace(/\s+/gu, " ").trim() || "(no stderr)";
  const bounded =
    sanitized.length <= CLI_FAILURE_SUMMARY_LIMIT
      ? sanitized
      : `${sanitized.slice(0, CLI_FAILURE_SUMMARY_LIMIT - 3)}...`;
  return `exit ${params.status}: ${bounded}`;
}

function stripTerminalSequences(value: string) {
  let result = "";
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index) ?? 0;
    const width = codePoint > 0xffff ? 2 : 1;
    const nextCodeUnit = value.charCodeAt(index + width);
    if ((codePoint === 0x1b && nextCodeUnit === 0x5b) || codePoint === 0x9b) {
      index += codePoint === 0x1b ? 2 : 1;
      while (index < value.length) {
        const codeUnit = value.charCodeAt(index++);
        if (codeUnit >= 0x40 && codeUnit <= 0x7e) {
          break;
        }
      }
      continue;
    }
    if ((codePoint === 0x1b && nextCodeUnit === 0x5d) || codePoint === 0x9d) {
      index += codePoint === 0x1b ? 2 : 1;
      while (index < value.length) {
        const codeUnit = value.charCodeAt(index++);
        if (codeUnit === 0x07) {
          break;
        }
        if (codeUnit === 0x1b && value.charCodeAt(index) === 0x5c) {
          index += 1;
          break;
        }
      }
      continue;
    }
    if (codePoint === 0x1b) {
      index += Math.min(2, value.length - index);
      continue;
    }
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      result += " ";
    } else {
      result += String.fromCodePoint(codePoint);
    }
    index += width;
  }
  return result;
}

async function runDisjointClient(
  packageRoot: string,
  gatewayToken: string,
  observerCredential: string,
  home: string,
  env: NodeJS.ProcessEnv,
  children: Set<ChildProcess>,
  uid: number,
  gid: number,
) {
  const runtimeUrl = pathToFileURL(
    join(packageRoot, "dist", "plugin-sdk", "gateway-runtime.js"),
  ).href;
  const scriptPath = join(home, "disjoint-client.mjs");
  writeFileSync(
    scriptPath,
    `
const { GatewayClient } = await import(${JSON.stringify(runtimeUrl)});
const timeout = setTimeout(() => process.exit(1), 15000);
const client = new GatewayClient({
  url: \`ws://127.0.0.1:${OBSERVER_PORT}/?observer_probe=\${encodeURIComponent(process.env.OPENCLAW_OBSERVER_PROBE_CREDENTIAL ?? "")}\`,
  token: ${JSON.stringify(gatewayToken)},
  clientName: "node-host", clientVersion: "gateway-node-compat-disjoint",
  platform: "linux", mode: "node", role: "node", scopes: [], caps: [],
  commands: ["system.which"], minProtocol: 1, maxProtocol: 2,
  onConnectError: () => { clearTimeout(timeout); client.stop(); process.exit(0); },
  onHelloOk: () => process.exit(1),
});
client.start();
`,
    { encoding: "utf8", mode: 0o644 },
  );
  try {
    const child = start(
      process.execPath,
      [scriptPath],
      {
        ...env,
        OPENCLAW_OBSERVER_PROBE_CREDENTIAL: observerCredential,
      },
      children,
      uid,
      gid,
    );
    if ((await waitForExit(child)) !== 0) {
      throw new Error("Disjoint client did not receive a protocol mismatch.");
    }
  } finally {
    rmSync(scriptPath, { force: true });
  }
}

type ObserverDeviceIdentity = { id: string; publicKey: string };

export function consumeOneTimeObserverCredential(presented: string, expected: string | undefined) {
  const presentedBytes = Buffer.from(presented);
  const expectedBytes = Buffer.from(expected ?? "");
  if (
    !expected ||
    presentedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(presentedBytes, expectedBytes)
  ) {
    throw new Error("Observer rejected an unauthorized or reused disjoint probe.");
  }
}

export function validateDisjointObserverConnect(
  frame: Record<string, unknown>,
  gatewayToken: string,
) {
  const connect = isRecord(frame.params) ? frame.params : {};
  const client = isRecord(connect.client) ? connect.client : {};
  const auth = isRecord(connect.auth) ? connect.auth : {};
  if (
    frame.method !== "connect" ||
    typeof frame.id !== "string" ||
    connect.minProtocol !== 1 ||
    connect.maxProtocol !== 2 ||
    connect.role !== "node" ||
    client.id !== "node-host" ||
    client.mode !== "node" ||
    client.platform !== "linux" ||
    auth.token !== gatewayToken
  ) {
    throw new Error("Observer rejected an invalid disjoint protocol probe.");
  }
  return {
    clientMin: 1,
    clientMax: 2,
    helloProtocol: null,
    identity: {
      clientId: "node-host",
      mode: "node",
      platform: "linux",
      role: "node",
    },
    protocolError: null,
  } satisfies Observation;
}

export function validateObserverConnectCredential(
  frame: Record<string, unknown>,
  params: {
    expectedDevice?: ObserverDeviceIdentity;
    gatewayToken: string;
    nonce: string;
    usedSignatures?: Set<string>;
  },
) {
  const connect = isRecord(frame.params) ? frame.params : {};
  const client = isRecord(connect.client) ? connect.client : {};
  const auth = isRecord(connect.auth) ? connect.auth : {};
  const device = isRecord(connect.device) ? connect.device : {};
  const scopes =
    Array.isArray(connect.scopes) && connect.scopes.every((scope) => typeof scope === "string")
      ? (connect.scopes as string[])
      : [];
  const signatureToken =
    typeof auth.token === "string"
      ? auth.token
      : typeof auth.deviceToken === "string"
        ? auth.deviceToken
        : typeof auth.bootstrapToken === "string"
          ? auth.bootstrapToken
          : "";
  if (
    frame.method !== "connect" ||
    typeof frame.id !== "string" ||
    typeof connect.minProtocol !== "number" ||
    !Number.isSafeInteger(connect.minProtocol) ||
    typeof connect.maxProtocol !== "number" ||
    !Number.isSafeInteger(connect.maxProtocol) ||
    typeof connect.role !== "string" ||
    typeof client.id !== "string" ||
    typeof client.mode !== "string" ||
    typeof client.platform !== "string" ||
    typeof device.id !== "string" ||
    typeof device.publicKey !== "string" ||
    typeof device.signature !== "string" ||
    !Number.isSafeInteger(device.signedAt) ||
    device.nonce !== params.nonce ||
    signatureToken !== params.gatewayToken
  ) {
    throw new Error("Observer rejected an invalid node session credential.");
  }
  if (
    params.expectedDevice &&
    (device.id !== params.expectedDevice.id || device.publicKey !== params.expectedDevice.publicKey)
  ) {
    throw new Error("Observer rejected a node session from an unexpected device identity.");
  }
  if (params.usedSignatures?.has(device.signature)) {
    throw new Error("Observer rejected a reused node session credential.");
  }
  const payloadBase = {
    deviceId: device.id,
    clientId: client.id,
    clientMode: client.mode,
    role: connect.role,
    scopes,
    signedAtMs: Number(device.signedAt),
    token: signatureToken,
    nonce: params.nonce,
  };
  const payloads = [
    [
      "v3",
      payloadBase.deviceId,
      payloadBase.clientId,
      payloadBase.clientMode,
      payloadBase.role,
      payloadBase.scopes.join(","),
      String(payloadBase.signedAtMs),
      payloadBase.token,
      payloadBase.nonce,
      normalizeDeviceMetadata(client.platform),
      normalizeDeviceMetadata(client.deviceFamily),
    ].join("|"),
    [
      "v2",
      payloadBase.deviceId,
      payloadBase.clientId,
      payloadBase.clientMode,
      payloadBase.role,
      payloadBase.scopes.join(","),
      String(payloadBase.signedAtMs),
      payloadBase.token,
      payloadBase.nonce,
    ].join("|"),
  ];
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(device.publicKey, "base64url"),
    ]),
    format: "der",
    type: "spki",
  });
  const signature = Buffer.from(device.signature, "base64url");
  if (!payloads.some((payload) => verify(null, Buffer.from(payload), publicKey, signature))) {
    throw new Error("Observer rejected an invalid node session signature.");
  }
  params.usedSignatures?.add(device.signature);
  return {
    device: { id: device.id, publicKey: device.publicKey },
    observation: {
      clientMin: connect.minProtocol,
      clientMax: connect.maxProtocol,
      helloProtocol: null,
      identity: {
        clientId: client.id,
        mode: client.mode,
        platform: client.platform,
        role: connect.role,
      },
      protocolError: null,
    } satisfies Observation,
  };
}

async function startObserver(gatewayToken: string) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: OBSERVER_PORT });
  const usedSignatures = new Set<string>();
  let expectedDevice: ObserverDeviceIdentity | undefined;
  let upstreamUrl = "";
  let observation: Observation | undefined;
  let invocationRequest: unknown;
  let invocationResult: unknown;
  let inconsistent = false;
  let pendingDisjointCredential: string | undefined;
  let resolveBootstrap: (() => void) | undefined;
  let rejectBootstrap: ((error: Error) => void) | undefined;
  const bootstrap = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveBootstrap = resolvePromise;
    rejectBootstrap = rejectPromise;
  });
  server.on("connection", (downstream, request) => {
    if (!upstreamUrl) {
      if (expectedDevice) {
        downstream.terminate();
        return;
      }
      const nonce = randomUUID();
      downstream.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce, ts: Date.now() },
        }),
      );
      downstream.once("message", (data) => {
        try {
          const captured = validateObserverConnectCredential(parseFrame(data), {
            gatewayToken,
            nonce,
            usedSignatures,
          });
          expectedDevice = captured.device;
          resolveBootstrap?.();
        } catch (error) {
          inconsistent = true;
          rejectBootstrap?.(error instanceof Error ? error : new Error(String(error)));
        } finally {
          downstream.terminate();
        }
      });
      return;
    }

    const upstream = new WebSocket(upstreamUrl);
    const pending: Array<{ data: RawData; isBinary: boolean }> = [];
    const presentedDisjointCredential = new URL(
      request.url ?? "/",
      "http://observer.invalid",
    ).searchParams.get("observer_probe");
    let isDisjointProbe = false;
    if (presentedDisjointCredential) {
      try {
        consumeOneTimeObserverCredential(presentedDisjointCredential, pendingDisjointCredential);
        pendingDisjointCredential = undefined;
        isDisjointProbe = true;
      } catch {
        inconsistent = true;
        downstream.terminate();
        upstream.terminate();
        return;
      }
    }
    let connectId = "";
    let authenticated = false;
    let nonce = "";
    downstream.on("message", (data, isBinary) => {
      const frame = parseFrame(data);
      if (!authenticated) {
        if (!isDisjointProbe && (!nonce || !expectedDevice)) {
          inconsistent = true;
          downstream.terminate();
          return;
        }
        let capturedObservation: Observation;
        try {
          capturedObservation = isDisjointProbe
            ? validateDisjointObserverConnect(frame, gatewayToken)
            : validateObserverConnectCredential(frame, {
                expectedDevice,
                gatewayToken,
                nonce,
                usedSignatures,
              }).observation;
        } catch {
          inconsistent = true;
          downstream.terminate();
          return;
        }
        inconsistent ||= Boolean(
          observation && !isDeepStrictEqual(observation.identity, capturedObservation.identity),
        );
        observation = capturedObservation;
        connectId = frame.id as string;
        authenticated = true;
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(data, { binary: isBinary });
        } else {
          pending.push({ data, isBinary });
        }
        return;
      }
      if (frame.method === "connect") {
        inconsistent = true;
        downstream.terminate();
        return;
      }
      if (frame.method === "node.invoke.result") {
        if (invocationResult !== undefined) {
          inconsistent = true;
        } else {
          invocationResult = frame.params;
        }
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      } else {
        pending.push({ data, isBinary });
      }
    });
    upstream.on("open", () => {
      for (const message of pending.splice(0)) {
        upstream.send(message.data, { binary: message.isBinary });
      }
    });
    upstream.on("message", (data, isBinary) => {
      const frame = parseFrame(data);
      if (frame.event === "connect.challenge") {
        const payload = isRecord(frame.payload) ? frame.payload : {};
        nonce = typeof payload.nonce === "string" ? payload.nonce : "";
      } else if (frame.event === "node.invoke.request") {
        if (invocationRequest !== undefined) {
          inconsistent = true;
        } else {
          invocationRequest = frame.payload;
        }
      } else if (observation && frame.id === connectId) {
        const payload = isRecord(frame.payload) ? frame.payload : {};
        if (payload.type === "hello-ok" && Number.isSafeInteger(payload.protocol)) {
          observation.helloProtocol = payload.protocol as number;
          observation.protocolError = null;
        } else if (Object.hasOwn(frame, "error")) {
          observation.protocolError = frame.error;
          observation.helloProtocol = null;
        }
      }
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.send(data, { binary: isBinary });
      }
    });
    upstream.on("close", (code, reason) => downstream.close(code, reason.toString()));
    upstream.on("error", () => downstream.terminate());
    downstream.on("close", () => upstream.close());
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("listening", resolvePromise);
    server.once("error", rejectPromise);
  });
  return {
    async captureExpectedIdentity(child: ChildProcess) {
      await captureExpectedIdentity({
        bootstrap,
        childExit: waitForExit(child),
      });
    },
    activate(value: string) {
      if (!expectedDevice || !value) {
        throw new Error("Observer cannot activate before capturing the intended node identity.");
      }
      upstreamUrl = value;
    },
    authorizeDisjointProbe() {
      if (pendingDisjointCredential) {
        throw new Error("Observer already has a pending disjoint probe credential.");
      }
      pendingDisjointCredential = randomUUID();
      return pendingDisjointCredential;
    },
    read() {
      if (!observation || inconsistent) {
        throw new Error("Observer did not capture one consistent node connection.");
      }
      return observation;
    },
    readOperation() {
      if (inconsistent) {
        throw new Error("Observer did not capture one consistent node invocation.");
      }
      return buildObservedNodeOperation(invocationRequest, invocationResult);
    },
    close: async () => {
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error) {
            rejectPromise(error);
            return;
          }
          resolvePromise();
        });
      });
    },
  };
}

function normalizeDeviceMetadata(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export async function captureExpectedIdentity(params: {
  bootstrap: Promise<void>;
  childExit: Promise<number>;
  timeoutMs?: number;
}) {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("Timed out capturing the intended node device identity."));
    }, params.timeoutMs ?? 30_000);
    timeout.unref();
  });
  try {
    await Promise.race([
      params.bootstrap,
      params.childExit.then((status) => {
        throw new Error(`Node identity bootstrap exited with status ${status}.`);
      }),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeMismatch(observation: Observation, legacyVersion?: string) {
  if (observation.clientMin !== 1 || observation.clientMax !== 2) {
    throw new Error("Disjoint client did not advertise exact protocol range 1..2.");
  }
  const error = isRecord(observation.protocolError) ? observation.protocolError : {};
  const outer = isRecord(error.details) ? error.details : {};
  const details = Object.hasOwn(outer, "code")
    ? outer
    : isRecord(outer.details)
      ? outer.details
      : {};
  if (
    legacyVersion === "2026.5.7" &&
    Object.keys(outer).length === 1 &&
    outer.expectedProtocol === 3
  ) {
    return {
      code: "PROTOCOL_MISMATCH",
      clientMinProtocol: 1,
      clientMaxProtocol: 2,
      expectedProtocol: outer.expectedProtocol,
    };
  }
  if (
    details.code !== "PROTOCOL_MISMATCH" ||
    details.clientMinProtocol !== 1 ||
    details.clientMaxProtocol !== 2 ||
    !Number.isSafeInteger(details.expectedProtocol) ||
    Number(details.expectedProtocol) <= observation.clientMax
  ) {
    throw new Error("Gateway did not return matching structured PROTOCOL_MISMATCH.");
  }
  return details;
}

export function validateObservedIdentity(observation: Observation) {
  if (
    observation.identity.role !== "node" ||
    observation.identity.mode !== "node" ||
    observation.identity.clientId !== "node-host" ||
    observation.identity.platform !== "linux"
  ) {
    throw new Error("Observed connect identity is not a Linux node-host session.");
  }
  return observation;
}

function parseFrame(data: unknown) {
  try {
    const text = Buffer.isBuffer(data)
      ? data.toString("utf8")
      : Array.isArray(data)
        ? Buffer.concat(data.map((part) => Buffer.from(part))).toString("utf8")
        : Buffer.from(data as Uint8Array).toString("utf8");
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

// This script runs as a standalone read-only mount outside workspace package resolution.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function waitForExit(child: ChildProcess): Promise<number> {
  const observed = childExitPromises.get(child);
  if (observed) {
    return observed;
  }
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  const exit = new Promise<number>((resolvePromise) => {
    child.once("close", (status) => resolvePromise(status ?? 1));
    child.once("error", () => resolvePromise(1));
  });
  childExitPromises.set(child, exit);
  return exit;
}

async function waitForExitWithin(exit: Promise<number>, timeoutMs: number) {
  return new Promise<boolean>((resolvePromise) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      resolvePromise(exited);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    void exit.then(() => finish(true));
  });
}
