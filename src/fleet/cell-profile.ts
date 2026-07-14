import crypto from "node:crypto";
import path from "node:path";

export type FleetContainerRuntimeName = "docker" | "podman";

export const DEFAULT_FLEET_IMAGE = "ghcr.io/openclaw/openclaw:latest";
export const FLEET_BASE_PORT = 19_100;
export const FLEET_GATEWAY_PORT = 18_789;
const FLEET_CONTAINER_HOME = "/home/node";
export const FLEET_CONTAINER_STATE_DIR = "/home/node/.openclaw";
export const FLEET_CONTAINER_AUTH_SECRET_DIR = "/home/node/.config/openclaw";
export const FLEET_TENANT_LABEL = "openclaw.fleet.tenant";
export const FLEET_OWNER_LABEL = "openclaw.fleet.owner";
export const FLEET_ATTEMPT_LABEL = "openclaw.fleet.attempt";
export const FLEET_ENV_KEYS_LABEL = "openclaw.fleet.env-keys";
export const FLEET_DISK_LIMIT_LABEL = "openclaw.fleet.disk-limit";
const FLEET_MANAGED_ENV_KEYS = [
  "HOME",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_WORKSPACE_DIR",
  "OPENCLAW_GATEWAY_TOKEN",
] as const;

const FLEET_TENANT_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_TCP_PORT = 65_535;
const RESERVED_ENV_KEYS = new Set<string>(FLEET_MANAGED_ENV_KEYS);

function hasInvalidEnvironmentFileValue(value: string): boolean {
  return value.includes("\n") || value.includes("\r") || value.includes("\u0000");
}

export interface CellContainerProfile {
  tenantId: string;
  containerName: string;
  networkName: string;
  image: string;
  runtime: FleetContainerRuntimeName;
  hostPort: number;
  dataDir: string;
  authSecretDir: string;
  ownerId: string;
  attemptId: string;
  memory: string;
  cpus: string;
  diskSize?: string;
  pidsLimit: number;
  environment: Readonly<Record<string, string>>;
  containerUser?:
    | { mode: "numeric"; uid: number; gid: number }
    | { mode: "podman-keep-id"; uid: number; gid: number };
  selinuxRelabel: boolean;
}

type CellContainerArgOptions = {
  environmentFile: string;
};

export function validateTenantId(tenantId: string): string {
  if (!FLEET_TENANT_PATTERN.test(tenantId)) {
    throw new Error(
      "Invalid tenant id. Use 1-40 lowercase letters, digits, or hyphens; start and end with a letter or digit.",
    );
  }
  return tenantId;
}

export function validateFleetImage(image: string): string {
  const normalized = image.trim();
  if (!normalized) {
    throw new Error("Fleet container image must not be empty.");
  }
  if (normalized.startsWith("-")) {
    throw new Error("Fleet container image must not begin with '-'.");
  }
  return normalized;
}

export function validateDiskSize(value: string): string {
  const normalized = value.trim();
  const numeric = Number.parseFloat(normalized);
  if (
    !/^[0-9]+(?:\.[0-9]+)?(?:b|k|kb|m|mb|g|gb|t|tb)?$/iu.test(normalized) ||
    !Number.isFinite(numeric) ||
    numeric <= 0
  ) {
    throw new Error("--disk must be a positive size such as 10g, 512m, or 1024.");
  }
  return normalized;
}

function validateHostPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > MAX_TCP_PORT) {
    throw new Error("Host port must be an integer from 1 to 65535.");
  }
  return port;
}

export function allocateHostPort(usedPorts: Iterable<number>, requestedPort?: number): number {
  const used = new Set(usedPorts);
  if (requestedPort !== undefined) {
    const port = validateHostPort(requestedPort);
    if (used.has(port)) {
      throw new Error(`Host port ${port} is already allocated to another fleet cell.`);
    }
    return port;
  }

  for (let port = FLEET_BASE_PORT; port <= MAX_TCP_PORT; port += 1) {
    if (!used.has(port)) {
      return port;
    }
  }
  throw new Error(`No free fleet host ports remain from ${FLEET_BASE_PORT} to ${MAX_TCP_PORT}.`);
}

export function parseEnvAssignments(values: string[]): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const assignment of values) {
    const separator = assignment.indexOf("=");
    if (separator <= 0) {
      throw new Error("Invalid --env value; expected KEY=VAL.");
    }
    const key = assignment.slice(0, separator);
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new Error("Invalid --env key; use letters, digits, and underscores.");
    }
    if (RESERVED_ENV_KEYS.has(key)) {
      throw new Error(`--env cannot override fleet-managed variable ${key}.`);
    }
    environment[key] = assignment.slice(separator + 1);
  }
  return environment;
}

export function buildCellEnvironment(
  token: string,
  userEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  if (hasInvalidEnvironmentFileValue(token)) {
    throw new Error("Gateway token must not contain line breaks or null bytes.");
  }
  for (const key of Object.keys(userEnv)) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid cell environment key: ${key}`);
    }
    if (RESERVED_ENV_KEYS.has(key)) {
      throw new Error(`Cell environment cannot override fleet-managed variable ${key}.`);
    }
    if (hasInvalidEnvironmentFileValue(userEnv[key] ?? "")) {
      throw new Error(`Cell environment value for ${key} must be one line.`);
    }
  }
  return {
    HOME: FLEET_CONTAINER_HOME,
    OPENCLAW_HOME: FLEET_CONTAINER_HOME,
    OPENCLAW_STATE_DIR: FLEET_CONTAINER_STATE_DIR,
    OPENCLAW_CONFIG_PATH: `${FLEET_CONTAINER_STATE_DIR}/openclaw.json`,
    OPENCLAW_WORKSPACE_DIR: `${FLEET_CONTAINER_STATE_DIR}/workspace`,
    OPENCLAW_GATEWAY_TOKEN: token,
    ...userEnv,
  };
}

export function cellContainerName(tenantId: string): string {
  return `openclaw-cell-${validateTenantId(tenantId)}`;
}

export function cellNetworkName(tenantId: string): string {
  return `${cellContainerName(tenantId)}-net`;
}

export function cellDataDir(stateDir: string, tenantId: string): string {
  return path.join(stateDir, "fleet", "cells", validateTenantId(tenantId));
}

export function cellAuthSecretDir(stateDir: string, tenantId: string): string {
  return path.join(stateDir, "fleet", "auth-profile-secrets", validateTenantId(tenantId));
}

export function cellOwnerId(dataDir: string): string {
  return crypto.createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 32);
}

export function validateCellContainerProfile(profile: CellContainerProfile): void {
  validateTenantId(profile.tenantId);
  validateHostPort(profile.hostPort);
  if (profile.containerName !== cellContainerName(profile.tenantId)) {
    throw new Error(`Fleet container name must be ${cellContainerName(profile.tenantId)}.`);
  }
  if (profile.networkName !== cellNetworkName(profile.tenantId)) {
    throw new Error(`Fleet network name must be ${cellNetworkName(profile.tenantId)}.`);
  }
  if (validateFleetImage(profile.image) !== profile.image) {
    throw new Error("Fleet container image must not have surrounding whitespace.");
  }
  if (!profile.dataDir.trim()) {
    throw new Error("Fleet cell data directory must not be empty.");
  }
  if (!profile.authSecretDir.trim()) {
    throw new Error("Fleet cell auth-secret directory must not be empty.");
  }
  if (profile.ownerId !== cellOwnerId(profile.dataDir)) {
    throw new Error("Fleet cell owner id does not match its data directory.");
  }
  if (!/^[a-f0-9]{32}$/u.test(profile.attemptId)) {
    throw new Error("Fleet cell attempt id must be 32 lowercase hexadecimal characters.");
  }
  if (!profile.memory.trim()) {
    throw new Error("Fleet cell memory limit must not be empty.");
  }
  if (!profile.cpus.trim()) {
    throw new Error("Fleet cell CPU limit must not be empty.");
  }
  if (profile.diskSize !== undefined && validateDiskSize(profile.diskSize) !== profile.diskSize) {
    throw new Error("Fleet cell --disk limit must not have surrounding whitespace.");
  }
  const cpus = Number(profile.cpus);
  if (!Number.isFinite(cpus) || cpus <= 0) {
    throw new Error("Fleet cell CPU limit must be a positive number.");
  }
  if (!Number.isInteger(profile.pidsLimit) || profile.pidsLimit < 1) {
    throw new Error("Fleet cell PID limit must be a positive integer.");
  }
  if (profile.containerUser) {
    if (
      !Number.isInteger(profile.containerUser.uid) ||
      profile.containerUser.uid < 0 ||
      !Number.isInteger(profile.containerUser.gid) ||
      profile.containerUser.gid < 0
    ) {
      throw new Error("Container uid and gid must be non-negative integers.");
    }
    if (profile.containerUser.mode === "podman-keep-id" && profile.runtime !== "podman") {
      throw new Error("keep-id user mapping requires Podman.");
    }
  }
  for (const [key, value] of Object.entries(profile.environment)) {
    if (!ENV_KEY_PATTERN.test(key) || hasInvalidEnvironmentFileValue(value)) {
      throw new Error(`Invalid fleet cell environment entry: ${key}`);
    }
  }
}

function buildCellContainerArgs(
  profile: CellContainerProfile,
  operation: "run" | "create",
  options: CellContainerArgOptions,
): string[] {
  validateCellContainerProfile(profile);
  if (!options.environmentFile.trim()) {
    throw new Error("Fleet cell environment file path must not be empty.");
  }
  const containerUserArgs = profile.containerUser
    ? [
        ...(profile.containerUser.mode === "podman-keep-id" ? ["--userns=keep-id"] : []),
        "--user",
        `${profile.containerUser.uid}:${profile.containerUser.gid}`,
      ]
    : [];
  const userEnvironmentKeys = Object.keys(profile.environment)
    .filter((key) => !RESERVED_ENV_KEYS.has(key))
    .toSorted();
  const mountSuffix = profile.selinuxRelabel ? ":Z" : "";

  return [
    operation,
    ...(operation === "run" ? ["-d"] : []),
    "--name",
    profile.containerName,
    "--label",
    `${FLEET_TENANT_LABEL}=${profile.tenantId}`,
    "--label",
    `${FLEET_OWNER_LABEL}=${profile.ownerId}`,
    "--label",
    `${FLEET_ATTEMPT_LABEL}=${profile.attemptId}`,
    "--label",
    `${FLEET_ENV_KEYS_LABEL}=${userEnvironmentKeys.join(",")}`,
    // Podman inspect has no HostConfig.StorageOpt (verified live), so this label
    // is the canonical carrier that lets upgrade/restore replay the disk limit.
    ...(profile.diskSize ? ["--label", `${FLEET_DISK_LIMIT_LABEL}=${profile.diskSize}`] : []),
    "--init",
    ...containerUserArgs,
    // The official image runs a plain Node process, so the cell needs no Linux capabilities.
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(profile.pidsLimit),
    "--memory",
    profile.memory,
    "--cpus",
    profile.cpus,
    ...(profile.diskSize ? ["--storage-opt", `size=${profile.diskSize}`] : []),
    "--restart",
    "unless-stopped",
    "--network",
    profile.networkName,
    "-p",
    `127.0.0.1:${profile.hostPort}:${FLEET_GATEWAY_PORT}`,
    "--volume",
    `${profile.dataDir}:${FLEET_CONTAINER_STATE_DIR}${mountSuffix}`,
    "--volume",
    `${profile.authSecretDir}:${FLEET_CONTAINER_AUTH_SECRET_DIR}${mountSuffix}`,
    "--env-file",
    options.environmentFile,
    profile.image,
    "node",
    "dist/index.js",
    "gateway",
    "--bind",
    "lan",
    "--port",
    String(FLEET_GATEWAY_PORT),
  ];
}

export function buildCellRunArgs(
  profile: CellContainerProfile,
  options: CellContainerArgOptions,
): string[] {
  return buildCellContainerArgs(profile, "run", options);
}

export function buildCellCreateArgs(
  profile: CellContainerProfile,
  options: CellContainerArgOptions,
): string[] {
  return buildCellContainerArgs(profile, "create", options);
}
