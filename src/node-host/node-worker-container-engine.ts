import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveExecutableFromPathEnv } from "../infra/executable-path.js";
import { isPathInside } from "../infra/path-guards.js";
import { runExec } from "../process/exec.js";
import type { NodeWorkerContainerIdentity } from "./node-worker-launch-store.js";

export type NodeWorkerContainerEngine = {
  id: "docker" | "podman";
  command: string;
  target: string;
  env?: NodeJS.ProcessEnv;
};

type NodeWorkerContainerListing = NodeWorkerContainerIdentity & {
  gatewayNamespace: string;
  launchId: string;
};

type NodeWorkerContainerExpectedOwner = {
  bundleRoot: string;
  gatewayNamespace: string;
  launchId: string;
};

const DEFAULT_NODE_WORKER_CONTAINER_IMAGE = "node:22-slim";
// Burst launches can delay a healthy daemon's identity response; keep revalidation
// fail-closed without treating temporary daemon contention as an unavailable engine.
const CONTAINER_REVALIDATION_TIMEOUT_MS = 30_000;

const HOST_LABEL = "openclaw.node-worker.host";
const GATEWAY_LABEL = "openclaw.node-worker.gateway";
const LAUNCH_LABEL = "openclaw.node-worker.launch";
const CONTAINER_NODE_EXECUTABLE = "node";
const CONTAINER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/u;
const ENCODED_LAUNCH_PATTERN = /^[A-Za-z0-9_-]+$/u;
// `.State.Running` is false both before a container starts and after it exits.
// A created or initialized container still owns an admitted workload, so its
// launch must never be finalized or fenced as if the worker had already ended.
const OWNED_CONTAINER_STATUSES = new Set([
  "created",
  "initialized",
  "running",
  "paused",
  "restarting",
  "stopping",
]);
const ENDED_CONTAINER_STATUSES = new Set(["exited", "stopped", "dead", "removing"]);

function hostNamespace(bundleRoot: string): string {
  return createHash("sha256").update(path.resolve(bundleRoot)).digest("hex").slice(0, 32);
}

function encodeLaunchLabel(launchId: string): string {
  return Buffer.from(launchId, "utf8").toString("base64url");
}

function decodeLaunchLabel(value: string): string | undefined {
  if (!ENCODED_LAUNCH_PATTERN.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  return decoded && encodeLaunchLabel(decoded) === value ? decoded : undefined;
}

function commandErrorText(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const stderr = "stderr" in error ? error.stderr : undefined;
  return typeof stderr === "string" && stderr.trim() ? stderr.trim() : error.message;
}

function missingContainer(error: unknown): boolean {
  return /\bno such (?:object|container)\b|\bno container with (?:name|id)\b/iu.test(
    commandErrorText(error),
  );
}

async function runContainerCommand(
  engine: Pick<NodeWorkerContainerEngine, "command" | "env">,
  args: string[],
  timeoutMs = 15_000,
): Promise<string> {
  const result = await runExec(engine.command, args, {
    ...(engine.env ? { baseEnv: engine.env } : {}),
    timeoutMs,
    logOutput: false,
  });
  return result.stdout.trim();
}

async function resolveContainerEngineTarget(
  engine: Pick<NodeWorkerContainerEngine, "id" | "command" | "env">,
  options: { pinned?: boolean } = {},
): Promise<Pick<NodeWorkerContainerEngine, "target" | "env">> {
  const env = engine.env ?? process.env;
  const timeoutMs = options.pinned ? CONTAINER_REVALIDATION_TIMEOUT_MS : 5_000;
  if (engine.id === "docker") {
    const endpoint =
      env.DOCKER_HOST?.trim() ||
      (await runContainerCommand(
        engine,
        ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        5_000,
      ));
    if (!endpoint || endpoint === "<no value>") {
      throw new Error("Docker context did not report a stable daemon endpoint");
    }
    const pinnedEnv: NodeJS.ProcessEnv = { ...env, DOCKER_HOST: endpoint };
    // Context names/defaults can be repointed after startup; lifecycle commands
    // must stay bound to the exact daemon whose durable identity was admitted.
    delete pinnedEnv.DOCKER_CONTEXT;
    const frozenEnv = Object.freeze(pinnedEnv);
    const daemonId = await runContainerCommand(
      { ...engine, env: frozenEnv },
      ["info", "--format", "{{.ID}}"],
      timeoutMs,
    );
    if (!daemonId || daemonId === "<no value>") {
      throw new Error("Docker daemon did not report a stable identity");
    }
    return {
      target: createHash("sha256").update(`docker\0${daemonId}`).digest("hex"),
      env: frozenEnv,
    };
  }

  const info = await runContainerCommand(
    engine,
    ["info", "--format", "{{.Host.Hostname}}\t{{.Store.GraphRoot}}\t{{.Host.RemoteSocket.Path}}"],
    timeoutMs,
  );
  const [hostname, graphRoot, remoteSocket = "", extra] = info.split("\t");
  if (extra !== undefined || !hostname || !graphRoot || hostname === "<no value>") {
    throw new Error("Podman did not report a stable host and storage identity");
  }

  let connections: Record<string, unknown>[] = [];
  if (!options.pinned) {
    const output = await runContainerCommand(
      engine,
      ["system", "connection", "list", "--format", "json"],
      5_000,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new Error("Podman returned invalid connection metadata");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Podman returned invalid connection metadata");
    }
    connections = parsed.filter(isRecord);
  }
  const configuredHost = env.CONTAINER_HOST?.trim() ?? "";
  const configuredConnection = env.CONTAINER_CONNECTION?.trim() ?? "";
  const selected = configuredHost
    ? connections.find((connection) => connection.URI === configuredHost)
    : configuredConnection
      ? connections.find((connection) => connection.Name === configuredConnection)
      : connections.find((connection) => connection.Default === true);
  if (configuredConnection && !configuredHost && !selected) {
    throw new Error("Podman could not resolve the configured connection target");
  }
  const selectedUri =
    configuredHost ||
    (typeof selected?.URI === "string" ? selected.URI : "") ||
    (remoteSocket && remoteSocket !== "<no value>" ? `unix://${remoteSocket}` : "local");
  const selectedIdentity =
    env.CONTAINER_SSHKEY?.trim() ||
    (typeof selected?.Identity === "string" ? selected.Identity : "");
  const pinnedEnv: NodeJS.ProcessEnv = { ...env };
  if (selectedUri !== "local") {
    pinnedEnv.CONTAINER_HOST = selectedUri;
    delete pinnedEnv.CONTAINER_CONNECTION;
  }
  if (selectedIdentity) {
    pinnedEnv.CONTAINER_SSHKEY = selectedIdentity;
  }
  // Engine names are not ownership: another context/machine can answer a real
  // "no such container" while the original workload is still running elsewhere.
  return {
    target: createHash("sha256")
      .update(
        JSON.stringify([
          "podman",
          hostname,
          graphRoot,
          remoteSocket,
          selectedUri,
          selectedIdentity,
        ]),
      )
      .digest("hex"),
    env: Object.freeze(pinnedEnv),
  };
}

/** Resolve one working Docker-compatible daemon before advertising worker hosting. */
export async function resolveNodeWorkerContainerEngine(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<NodeWorkerContainerEngine> {
  const env = options.env ? Object.freeze({ ...process.env, ...options.env }) : process.env;
  const failures: string[] = [];
  for (const id of ["docker", "podman"] as const) {
    const command = resolveExecutableFromPathEnv(id, env.PATH ?? process.env.PATH ?? "", env);
    if (!command) {
      failures.push(`${id}: executable not found`);
      continue;
    }
    const unresolved = {
      id,
      command,
      ...(options.env ? { env } : {}),
    };
    try {
      const version = await runContainerCommand(
        unresolved,
        ["version", "--format", "{{.Server.Version}}"],
        5_000,
      );
      if (version && version !== "<no value>") {
        return { ...unresolved, ...(await resolveContainerEngineTarget(unresolved)) };
      }
      failures.push(`${id}: daemon did not report a server version`);
    } catch (error) {
      failures.push(`${id}: ${commandErrorText(error)}`);
    }
  }
  throw new Error(
    `nodeHost.workerRuns.isolation=container requires a working Docker-compatible engine; install and start Docker, OrbStack, or Podman, or set isolation to "none" (${failures.join("; ")})`,
  );
}

/** Create a labeled, stopped container so its durable identity exists before worker admission. */
export async function createNodeWorkerContainer(
  engine: NodeWorkerContainerEngine,
  params: {
    bundleRoot: string;
    bundleEntry: string;
    workspaceDir: string;
    gatewayNamespace: string;
    launchId: string;
    env: NodeJS.ProcessEnv;
    image?: string;
  },
): Promise<NodeWorkerContainerIdentity> {
  const bundleDir = path.dirname(params.bundleEntry);
  const namespace = hostNamespace(params.bundleRoot);
  const launchHash = createHash("sha256")
    .update(`${params.gatewayNamespace}\0${params.launchId}`)
    .digest("hex")
    .slice(0, 32);
  const containerName = `openclaw-node-worker-${namespace.slice(0, 12)}-${launchHash}`;
  const args = [
    "create",
    "--interactive",
    "--name",
    containerName,
    "--label",
    `${HOST_LABEL}=${namespace}`,
    "--label",
    `${GATEWAY_LABEL}=${params.gatewayNamespace}`,
    "--label",
    `${LAUNCH_LABEL}=${encodeLaunchLabel(params.launchId)}`,
    "--mount",
    `type=bind,source=${bundleDir},target=${bundleDir},readonly`,
    "--mount",
    `type=bind,source=${params.workspaceDir},target=${params.workspaceDir}`,
    "--workdir",
    params.workspaceDir,
  ];
  if (engine.id === "docker" && process.getuid && process.getgid) {
    args.push("--user", `${process.getuid()}:${process.getgid()}`);
  }
  const containerEnv: NodeJS.ProcessEnv = {
    ...params.env,
    PATH: CONTAINER_PATH,
    HOME: params.workspaceDir,
  };
  if (containerEnv.NODE_EXTRA_CA_CERTS) {
    let certificatePath: string;
    try {
      certificatePath = fs.realpathSync.native(containerEnv.NODE_EXTRA_CA_CERTS);
    } catch {
      throw new Error(
        "node worker container cannot access the configured NODE_EXTRA_CA_CERTS file",
      );
    }
    if (
      !isPathInside(bundleDir, certificatePath) &&
      !isPathInside(params.workspaceDir, certificatePath)
    ) {
      throw new Error(
        "node worker container cannot access NODE_EXTRA_CA_CERTS outside its admitted bundle or session workspace; place the CA certificate in the session workspace",
      );
    }
    containerEnv.NODE_EXTRA_CA_CERTS = certificatePath;
  }
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    if (containerEnv[key] !== undefined) {
      containerEnv[key] = "/tmp";
    }
  }
  if (containerEnv.NODE_COMPILE_CACHE !== undefined) {
    containerEnv.NODE_COMPILE_CACHE = "/tmp/openclaw-node-worker-compile-cache";
  }
  for (const [key, value] of Object.entries(containerEnv).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (value !== undefined) {
      args.push("--env", `${key}=${value}`);
    }
  }
  args.push(
    "--entrypoint",
    CONTAINER_NODE_EXECUTABLE,
    params.image ?? DEFAULT_NODE_WORKER_CONTAINER_IMAGE,
    params.bundleEntry,
    "--internal-worker-session",
  );
  const current = await resolveContainerEngineTarget(engine, { pinned: true });
  if (current.target !== engine.target) {
    throw new Error(
      `node worker container daemon changed since hosting startup (pinned ${engine.target}, current ${current.target}); restore the original daemon context or restart the node host`,
    );
  }
  const containerId = await runContainerCommand(engine, args, 300_000);
  if (!CONTAINER_ID_PATTERN.test(containerId)) {
    try {
      await killNodeWorkerContainer(engine, containerName, params);
    } catch (error) {
      throw new Error(
        `node worker container engine returned an invalid container identity and cleanup failed: ${commandErrorText(error)}`,
        { cause: error },
      );
    }
    throw new Error("node worker container engine returned an invalid container identity");
  }
  return { engine: engine.id, containerId, engineTarget: engine.target };
}

export function buildNodeWorkerContainerStartArgv(
  engine: NodeWorkerContainerEngine,
  containerId: string,
): string[] {
  return [engine.command, "start", "--attach", "--interactive", containerId];
}

/** Inspect the container rather than its disposable Docker client process. */
export async function inspectNodeWorkerContainer(
  engine: NodeWorkerContainerEngine,
  containerId: string,
  expected?: NodeWorkerContainerExpectedOwner,
): Promise<"live" | "dead" | "reused" | "unknown"> {
  try {
    const format = expected
      ? `{{.State.Status}}\t{{index .Config.Labels "${HOST_LABEL}"}}\t{{index .Config.Labels "${GATEWAY_LABEL}"}}\t{{index .Config.Labels "${LAUNCH_LABEL}"}}`
      : "{{.State.Status}}";
    const state = await runContainerCommand(engine, [
      "inspect",
      "--type",
      "container",
      "--format",
      format,
      containerId,
    ]);
    const [status = "", owner, gateway, launch, extra] = state.split("\t");
    if (expected) {
      if (
        extra !== undefined ||
        owner !== hostNamespace(expected.bundleRoot) ||
        gateway !== expected.gatewayNamespace ||
        launch !== encodeLaunchLabel(expected.launchId)
      ) {
        return "reused";
      }
    } else if (owner !== undefined) {
      return "unknown";
    }
    return OWNED_CONTAINER_STATUSES.has(status)
      ? "live"
      : ENDED_CONTAINER_STATUSES.has(status)
        ? "dead"
        : "unknown";
  } catch (error) {
    return missingContainer(error) ? "dead" : "unknown";
  }
}

/** Kill the authoritative container before removing its identity from the launch journal. */
export async function killNodeWorkerContainer(
  engine: NodeWorkerContainerEngine,
  containerId: string,
  expected?: NodeWorkerContainerExpectedOwner,
): Promise<void> {
  const original = await inspectNodeWorkerContainer(engine, containerId, expected);
  if (original === "reused" || original === "unknown") {
    throw new Error(
      `node worker container ownership could not be verified before removal (${original})`,
    );
  }
  try {
    await runContainerCommand(engine, ["kill", containerId]);
  } catch {
    // Created and already-exited containers cannot be killed; removal still fences both.
  }
  try {
    await runContainerCommand(engine, ["rm", "--force", containerId]);
  } catch (error) {
    if (!missingContainer(error)) {
      throw error;
    }
  }
  const remaining = await inspectNodeWorkerContainer(engine, containerId);
  if (remaining !== "dead") {
    throw new Error(`node worker container removal could not be verified (${remaining})`);
  }
}

/** List only containers owned by this node-host root, never another local host instance. */
export async function listNodeWorkerContainers(
  engine: NodeWorkerContainerEngine,
  options: { bundleRoot: string },
): Promise<NodeWorkerContainerListing[]> {
  const output = await runContainerCommand(engine, [
    "ps",
    "--all",
    "--no-trunc",
    "--filter",
    `label=${HOST_LABEL}=${hostNamespace(options.bundleRoot)}`,
    "--filter",
    `label=${GATEWAY_LABEL}`,
    "--filter",
    `label=${LAUNCH_LABEL}`,
    "--format",
    `{{.ID}}\t{{.Label "${GATEWAY_LABEL}"}}\t{{.Label "${LAUNCH_LABEL}"}}`,
  ]);
  if (!output) {
    return [];
  }
  return output
    .split("\n")
    .map((line) => {
      const [containerId, gatewayNamespace, encodedLaunch, extra] = line.split("\t");
      const launchId = encodedLaunch ? decodeLaunchLabel(encodedLaunch) : undefined;
      if (
        extra !== undefined ||
        !containerId ||
        !CONTAINER_ID_PATTERN.test(containerId) ||
        !gatewayNamespace ||
        !launchId
      ) {
        throw new Error("node worker container engine returned an invalid container listing");
      }
      return {
        engine: engine.id,
        containerId,
        engineTarget: engine.target,
        gatewayNamespace,
        launchId,
      };
    })
    .toSorted((left, right) => left.containerId.localeCompare(right.containerId));
}
