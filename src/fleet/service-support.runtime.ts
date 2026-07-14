import fs from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";
import { FsSafeError, root as fsSafeRoot } from "../infra/fs-safe.js";
import { replaceFileAtomic } from "../infra/replace-file.js";
import { isRecord } from "../utils.js";
import {
  buildCellEnvironment,
  cellAuthSecretDir,
  cellNetworkName,
  cellOwnerId,
  FLEET_ATTEMPT_LABEL,
  FLEET_DISK_LIMIT_LABEL,
  FLEET_ENV_KEYS_LABEL,
  FLEET_OWNER_LABEL,
  FLEET_TENANT_LABEL,
  parseEnvAssignments,
  validateTenantId,
  type CellContainerProfile,
  type FleetContainerRuntimeName,
} from "./cell-profile.js";
import type {
  FleetContainerInspectResult,
  FleetContainerRuntime,
  FleetNetworkInspectResult,
} from "./containers.runtime.js";
import {
  acquireFleetCellOperation,
  getFleetCell,
  type FleetCellOperationName,
  type FleetCellRecord,
} from "./registry.js";

const CELL_CONFIG_FILENAME = "openclaw.json";
const HEALTH_TIMEOUT_MS = 1_000;
const CELL_CONFIG_MAX_BYTES = 4 * 1024 * 1024;
const FLEET_OPERATION_HEARTBEAT_MS = 60_000;

type FleetHealthResult =
  | { status: "ok"; url: string; httpStatus: number }
  | { status: "failed"; url: string; error: string; httpStatus?: number }
  | { status: "skipped"; url: string; reason: string };

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  return requiredRecord(value, label);
}

function readAllowedOrigins(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((origin) => typeof origin === "string")) {
    throw new Error("gateway.controlUi.allowedOrigins must be an array of strings.");
  }
  return value;
}

async function ensurePrivateDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to use non-directory fleet data path: ${dir}`);
  }
  await fs.chmod(dir, 0o700);
}

export async function prepareCellDirectories(
  record: FleetCellRecord,
  authSecretDir: string,
  owner?: { uid: number; gid: number },
): Promise<void> {
  await Promise.all([
    ensurePrivateDirectory(record.dataDir),
    ensurePrivateDirectory(authSecretDir),
  ]);
  if (owner) {
    await Promise.all([
      fs.chown(record.dataDir, owner.uid, owner.gid),
      fs.chown(authSecretDir, owner.uid, owner.gid),
    ]);
  }
}

export async function prepareCellConfig(
  record: FleetCellRecord,
  owner?: { uid: number; gid: number },
): Promise<void> {
  const configPath = path.join(record.dataDir, CELL_CONFIG_FILENAME);
  let rootConfig: Record<string, unknown>;
  const cellRoot = await fsSafeRoot(record.dataDir, {
    hardlinks: "reject",
    maxBytes: CELL_CONFIG_MAX_BYTES,
    nonBlockingRead: true,
    symlinks: "reject",
  });
  try {
    const read = await cellRoot.read(CELL_CONFIG_FILENAME);
    rootConfig = requiredRecord(JSON5.parse(read.buffer.toString("utf8")), "Cell config");
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") {
      rootConfig = {};
    } else if (error instanceof FsSafeError) {
      throw new Error(`Refusing to read unsafe cell config: ${configPath}`, { cause: error });
    } else {
      throw error;
    }
  }

  const gateway = optionalRecord(rootConfig.gateway, "gateway");
  const auth = optionalRecord(gateway.auth, "gateway.auth");
  const controlUi = optionalRecord(gateway.controlUi, "gateway.controlUi");
  const nextAuth: Record<string, unknown> = { ...auth, mode: "token" };
  delete nextAuth.token;
  const origins = new Set(readAllowedOrigins(controlUi.allowedOrigins));
  origins.add(`http://localhost:${record.hostPort}`);
  origins.add(`http://127.0.0.1:${record.hostPort}`);

  const nextConfig = {
    ...rootConfig,
    gateway: {
      ...gateway,
      mode: "local",
      bind: "lan",
      auth: nextAuth,
      controlUi: {
        ...controlUi,
        allowedOrigins: [...origins],
      },
    },
  };
  await replaceFileAtomic({
    filePath: configPath,
    content: `${JSON.stringify(nextConfig, null, 2)}\n`,
    dirMode: 0o700,
    mode: 0o600,
    tempPrefix: CELL_CONFIG_FILENAME,
    copyFallbackOnPermissionError: true,
  });
  if (owner) {
    await fs.chown(configPath, owner.uid, owner.gid);
  }
}

export type HostIdentity = { uid: number; gid: number };

export function readHostIdentity(
  getuid: () => number | undefined,
  getgid: () => number | undefined,
): HostIdentity | undefined {
  const uid = getuid();
  const gid = getgid();
  if (uid === undefined || gid === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error("Host uid and gid must be non-negative integers.");
  }
  return { uid, gid };
}

export async function resolveContainerUser(params: {
  runtime: FleetContainerRuntimeName;
  containers: FleetContainerRuntime;
  hostIdentity: HostIdentity | undefined;
  user?: string;
}): Promise<CellContainerProfile["containerUser"]> {
  const match = params.user?.match(/^(\d+):(\d+)$/u);
  if (match) {
    const uid = Number(match[1]);
    const gid = Number(match[2]);
    return params.runtime === "podman"
      ? { mode: "podman-keep-id", uid, gid }
      : { mode: "numeric", uid, gid };
  }
  if (!params.hostIdentity) {
    return undefined;
  }
  if (params.runtime === "podman") {
    return params.hostIdentity.uid === 0
      ? undefined
      : { mode: "podman-keep-id", ...params.hostIdentity };
  }
  if (await params.containers.isDockerRootless()) {
    // Root in a rootless Docker user namespace maps to the invoking host user, not host root.
    return { mode: "numeric", uid: 0, gid: 0 };
  }
  return params.hostIdentity.uid === 0 ? undefined : { mode: "numeric", ...params.hostIdentity };
}

export async function detectHostSelinux(): Promise<boolean> {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    await fs.access("/sys/fs/selinux");
    return true;
  } catch {
    return false;
  }
}

export function inspectionState(
  record: FleetCellRecord,
  inspection: FleetContainerInspectResult,
): string {
  if (inspection.kind !== "ok") {
    return inspection.state;
  }
  return inspection.labels[FLEET_TENANT_LABEL] === record.tenantId &&
    inspection.labels[FLEET_OWNER_LABEL] === cellOwnerId(record.dataDir)
    ? inspection.state
    : "unknown";
}

export function assertManagedInspection(
  record: FleetCellRecord,
  inspection: FleetContainerInspectResult,
): Extract<FleetContainerInspectResult, { kind: "ok" }> {
  if (inspection.kind === "missing") {
    throw new Error(`Fleet container is missing for tenant ${record.tenantId}.`);
  }
  if (inspection.kind === "unavailable") {
    throw new Error(
      `Cannot inspect ${record.runtime} container for tenant ${record.tenantId}: ${inspection.error}`,
    );
  }
  if (
    inspection.labels[FLEET_TENANT_LABEL] !== record.tenantId ||
    inspection.labels[FLEET_OWNER_LABEL] !== cellOwnerId(record.dataDir)
  ) {
    throw new Error(
      `Refusing to manage ${record.containerName}: fleet ownership labels do not match tenant ${record.tenantId}.`,
    );
  }
  return inspection;
}

export async function probeCellHealth(params: {
  port: number;
  fetchImpl: typeof fetch;
}): Promise<FleetHealthResult> {
  const url = `http://127.0.0.1:${params.port}/healthz`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  let response: Response | undefined;
  try {
    response = await params.fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.ok) {
      return { status: "ok", url, httpStatus: response.status };
    }
    return {
      status: "failed",
      url,
      httpStatus: response.status,
      error: `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      status: "failed",
      url,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
    await response?.body?.cancel().catch(() => undefined);
  }
}

export async function resolvePurgeTarget(
  rootDir: string,
  targetDir: string,
  tenantId: string,
): Promise<string | undefined> {
  const expectedTarget = path.resolve(rootDir, tenantId);
  if (path.resolve(targetDir) !== expectedTarget) {
    throw new Error(`Refusing to purge data outside its fleet-owned directory: ${targetDir}`);
  }
  let targetStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    targetStat = await fs.lstat(expectedTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (targetStat.isSymbolicLink()) {
    throw new Error(`Refusing to purge a symlinked fleet tenant directory: ${targetDir}`);
  }
  const root = await fs.realpath(rootDir);
  const target = await fs.realpath(targetDir);
  const relative = path.relative(root, target);
  // Require the exact real tenant leaf; an in-root sibling symlink could otherwise delete another cell.
  if (
    target !== path.join(root, tenantId) ||
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Refusing to purge data outside its fleet-owned directory: ${targetDir}`);
  }
  return target;
}

export function requireCell(env: NodeJS.ProcessEnv, tenant: string): FleetCellRecord {
  const tenantId = validateTenantId(tenant);
  const record = getFleetCell(env, tenantId);
  if (!record) {
    throw new Error(`Fleet cell not found: ${tenantId}`);
  }
  return record;
}

export function assertCurrentReservation(env: NodeJS.ProcessEnv, expected: FleetCellRecord): void {
  const current = getFleetCell(env, expected.tenantId);
  if (
    !current ||
    current.createdAtMs !== expected.createdAtMs ||
    current.image !== expected.image ||
    current.runtime !== expected.runtime ||
    current.hostPort !== expected.hostPort ||
    current.containerName !== expected.containerName ||
    current.dataDir !== expected.dataDir
  ) {
    throw new Error(`Fleet create reservation changed while provisioning ${expected.tenantId}.`);
  }
}

function requirePositiveResource(
  value: string,
  label: string,
  context: "upgrade" | "restore" = "upgrade",
): string {
  const parsed = Number(value);
  if (!value.trim() || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Cannot ${context} cell: inspected ${label} limit is missing or invalid.`);
  }
  return value;
}

export function requireInspectedGatewayToken(
  inspection: Extract<FleetContainerInspectResult, { kind: "ok" }>,
  context: "upgrade" | "restore",
): string {
  const gatewayCredential = inspection.environment.OPENCLAW_GATEWAY_TOKEN;
  if (!gatewayCredential) {
    throw new Error(`Cannot ${context} cell: existing container has no Gateway token environment.`);
  }
  return gatewayCredential;
}

export function requireInspectedAttemptId(
  inspection: Extract<FleetContainerInspectResult, { kind: "ok" }>,
  context: "upgrade" | "restore",
): string {
  const attemptId = inspection.labels[FLEET_ATTEMPT_LABEL];
  if (!attemptId || !/^[a-f0-9]{32}$/u.test(attemptId)) {
    throw new Error(`Cannot ${context} cell: container attempt label is missing or invalid.`);
  }
  return attemptId;
}

function requirePidsLimit(
  value: number | undefined,
  context: "upgrade" | "restore" = "upgrade",
): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Cannot ${context} cell: inspected PID limit is missing or invalid.`);
  }
  return value;
}

function rebuildInspectedEnvironment(
  environment: Readonly<Record<string, string>>,
  labels: Readonly<Record<string, string>>,
  token: string,
  context: "upgrade" | "restore" = "upgrade",
): Record<string, string> {
  const encodedKeys = labels[FLEET_ENV_KEYS_LABEL];
  if (encodedKeys === undefined) {
    throw new Error(`Cannot ${context} cell: user environment provenance label is missing.`);
  }
  const keys = encodedKeys ? encodedKeys.split(",") : [];
  if (new Set(keys).size !== keys.length || keys.toSorted().join(",") !== encodedKeys) {
    throw new Error(`Cannot ${context} cell: user environment provenance label is invalid.`);
  }
  const assignments = keys.map((key) => {
    const value = environment[key];
    if (value === undefined) {
      throw new Error(`Cannot ${context} cell: inspected environment is missing ${key}.`);
    }
    return `${key}=${value}`;
  });
  return buildCellEnvironment(token, parseEnvAssignments(assignments));
}

export function buildProfileBaseFromInspection(params: {
  record: FleetCellRecord;
  stateDir: string;
  inspection: Extract<FleetContainerInspectResult, { kind: "ok" }>;
  containerUser: CellContainerProfile["containerUser"];
  selinuxRelabel: boolean;
  token: string;
  context: "upgrade" | "restore";
}): Omit<CellContainerProfile, "image" | "attemptId"> {
  return {
    tenantId: params.record.tenantId,
    containerName: params.record.containerName,
    networkName: cellNetworkName(params.record.tenantId),
    runtime: params.record.runtime,
    hostPort: params.record.hostPort,
    dataDir: params.record.dataDir,
    authSecretDir: cellAuthSecretDir(params.stateDir, params.record.tenantId),
    ownerId: cellOwnerId(params.record.dataDir),
    memory: requirePositiveResource(params.inspection.memory, "memory", params.context),
    cpus: requirePositiveResource(params.inspection.cpus, "CPU", params.context),
    pidsLimit: requirePidsLimit(params.inspection.pidsLimit, params.context),
    // Replay the disk limit from the fleet-owned label, not HostConfig.StorageOpt:
    // Podman's inspect schema has no StorageOpt field (verified live), so relying
    // on it would silently drop a Podman cell's quota on upgrade/restore.
    ...(params.inspection.labels[FLEET_DISK_LIMIT_LABEL] !== undefined
      ? { diskSize: params.inspection.labels[FLEET_DISK_LIMIT_LABEL] }
      : {}),
    environment: rebuildInspectedEnvironment(
      params.inspection.environment,
      params.inspection.labels,
      params.token,
      params.context,
    ),
    ...(params.containerUser ? { containerUser: params.containerUser } : {}),
    selinuxRelabel: params.selinuxRelabel,
  };
}

export async function verifyReplacementHealthy(params: {
  containers: FleetContainerRuntime;
  record: FleetCellRecord;
  attemptId: string;
  fetchImpl: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  checkpoint: () => void;
  timeoutMs: number;
  pollMs: number;
  context: "upgrade" | "restore" | "create";
}): Promise<void> {
  const deadline = params.now() + params.timeoutMs;
  for (;;) {
    const replacement = await params.containers.inspect(
      params.record.runtime,
      params.record.containerName,
    );
    if (
      replacement.kind !== "ok" ||
      replacement.labels[FLEET_ATTEMPT_LABEL] !== params.attemptId ||
      !replacement.running
    ) {
      throw new Error(
        replacement.kind === "ok"
          ? `Replacement cell container is not running after ${params.context}.`
          : `Replacement cell container could not be verified after ${params.context}.`,
      );
    }
    const health = await probeCellHealth({
      port: params.record.hostPort,
      fetchImpl: params.fetchImpl,
    });
    if (health.status === "ok") {
      return;
    }
    if (params.now() >= deadline) {
      throw new Error(`Replacement cell container did not become healthy after ${params.context}.`);
    }
    params.checkpoint();
    await params.sleep(params.pollMs);
  }
}

export async function cleanupFailedCreateContainer(
  record: FleetCellRecord,
  containers: FleetContainerRuntime,
  attemptId: string,
  checkpoint: () => void,
): Promise<boolean> {
  const inspection = await containers.inspect(record.runtime, record.containerName);
  if (inspection.kind === "missing") {
    return true;
  }
  if (inspection.kind === "unavailable") {
    return false;
  }
  const tenantLabel = inspection.labels[FLEET_TENANT_LABEL];
  const ownerLabel = inspection.labels[FLEET_OWNER_LABEL];
  // Fleet always labels what it creates, so a container without fleet labels (or with
  // another owner's labels) is foreign: leave it untouched but release the reservation,
  // otherwise a name collision strands a tenant no fleet command can recover.
  if (tenantLabel !== record.tenantId || ownerLabel !== cellOwnerId(record.dataDir)) {
    return true;
  }
  if (inspection.labels[FLEET_ATTEMPT_LABEL] !== attemptId) {
    return false;
  }
  checkpoint();
  await containers.remove(record.runtime, record.containerName, true);
  return (await containers.inspect(record.runtime, record.containerName)).kind === "missing";
}

export async function cleanupFailedCreateNetwork(
  record: FleetCellRecord,
  containers: FleetContainerRuntime,
  attemptId: string,
  checkpoint: () => void,
): Promise<boolean> {
  const networkName = cellNetworkName(record.tenantId);
  const inspection = await containers.inspectNetwork(record.runtime, networkName);
  if (inspection.kind === "missing") {
    return true;
  }
  if (inspection.kind === "unavailable") {
    return false;
  }
  const tenantLabel = inspection.labels[FLEET_TENANT_LABEL];
  const ownerLabel = inspection.labels[FLEET_OWNER_LABEL];
  // Same foreign-resource rule as cleanupFailedCreateContainer: unlabeled or
  // other-owner networks are never fleet's to delete, but must not pin the reservation.
  if (tenantLabel !== record.tenantId || ownerLabel !== cellOwnerId(record.dataDir)) {
    return true;
  }
  if (
    inspection.labels[FLEET_ATTEMPT_LABEL] !== attemptId ||
    inspection.attachedContainers.length > 0
  ) {
    return false;
  }
  checkpoint();
  await containers.removeNetwork(record.runtime, networkName);
  return (await containers.inspectNetwork(record.runtime, networkName)).kind === "missing";
}

function inspectionHasFleetOwner(
  record: FleetCellRecord,
  inspection: Extract<FleetContainerInspectResult, { kind: "ok" }>,
): boolean {
  return (
    inspection.labels[FLEET_TENANT_LABEL] === record.tenantId &&
    inspection.labels[FLEET_OWNER_LABEL] === cellOwnerId(record.dataDir)
  );
}

export function assertManagedNetwork(
  record: FleetCellRecord,
  inspection: FleetNetworkInspectResult,
): Extract<FleetNetworkInspectResult, { kind: "ok" }> {
  if (inspection.kind === "missing") {
    throw new Error(`Fleet network is missing for tenant ${record.tenantId}.`);
  }
  if (inspection.kind === "unavailable") {
    throw new Error(
      `Cannot inspect ${record.runtime} network for tenant ${record.tenantId}: ${inspection.error}`,
    );
  }
  if (
    inspection.labels[FLEET_TENANT_LABEL] !== record.tenantId ||
    inspection.labels[FLEET_OWNER_LABEL] !== cellOwnerId(record.dataDir)
  ) {
    throw new Error(
      `Refusing to manage ${cellNetworkName(record.tenantId)}: fleet ownership labels do not match tenant ${record.tenantId}.`,
    );
  }
  const unexpectedAttachments = inspection.attachedContainers.filter(
    (container) => container.name !== record.containerName,
  );
  if (unexpectedAttachments.length > 0 || inspection.attachedContainers.length > 1) {
    throw new Error(
      `Refusing to manage ${cellNetworkName(record.tenantId)}: unexpected containers are attached.`,
    );
  }
  return inspection;
}

export async function restorePreviousCell(params: {
  record: FleetCellRecord;
  containers: FleetContainerRuntime;
  oldProfile: CellContainerProfile;
  previousAttemptId: string;
  nextAttemptId: string;
  wasRunning: boolean;
  checkpoint: () => void;
}): Promise<void> {
  const current = await params.containers.inspect(
    params.record.runtime,
    params.record.containerName,
  );
  if (current.kind === "unavailable") {
    throw new Error(current.error);
  }
  if (current.kind === "ok") {
    if (!inspectionHasFleetOwner(params.record, current)) {
      throw new Error("container ownership changed during upgrade recovery");
    }
    const currentAttemptId = current.labels[FLEET_ATTEMPT_LABEL];
    if (currentAttemptId === params.previousAttemptId) {
      if (current.running !== params.wasRunning) {
        params.checkpoint();
        await params.containers[current.running ? "stop" : "start"](
          params.record.runtime,
          params.record.containerName,
        );
      }
      return;
    }
    if (currentAttemptId !== params.nextAttemptId) {
      throw new Error("container generation changed during upgrade recovery");
    }
    params.checkpoint();
    await params.containers.remove(params.record.runtime, params.record.containerName, true);
  }
  params.checkpoint();
  await params.containers.run(params.oldProfile, params.wasRunning);
}

export async function withFleetCellOperation<T>(params: {
  env: NodeJS.ProcessEnv;
  tenantId: string;
  operationName: FleetCellOperationName;
  operation: (checkpoint: () => void) => Promise<T>;
}): Promise<T> {
  const lease = acquireFleetCellOperation({
    env: params.env,
    tenantId: params.tenantId,
    operation: params.operationName,
  });
  let heartbeatError: unknown;
  const checkpoint = () => {
    try {
      lease.heartbeat();
      heartbeatError = undefined;
    } catch (error) {
      heartbeatError = error;
      throw error;
    }
  };
  const heartbeat = setInterval(() => {
    try {
      lease.heartbeat();
      heartbeatError = undefined;
    } catch (error) {
      heartbeatError = error;
    }
  }, FLEET_OPERATION_HEARTBEAT_MS);
  heartbeat.unref();
  let result: T;
  try {
    result = await params.operation(checkpoint);
    if (heartbeatError) {
      checkpoint();
    } else {
      lease.heartbeat();
    }
  } catch (error) {
    clearInterval(heartbeat);
    try {
      lease.release();
    } catch {
      // Preserve the operation or fencing error; a release failure is secondary.
    }
    throw error;
  }
  clearInterval(heartbeat);
  lease.release();
  return result;
}
