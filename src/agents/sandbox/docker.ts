/**
 * Low-level Docker command helpers for sandbox runtimes.
 *
 * Wraps Docker spawn, environment sanitization, container inspection, creation, and exec behavior.
 */
import { createAbortError } from "../../infra/abort-signal.js";
import { toErrorObject } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isPlainCommandExitFailure, spawnCommand } from "../../process/exec.js";
import { sanitizeEnvVars, sanitizeExplicitSandboxEnvVars } from "./sanitize-env-vars.js";

type ExecDockerRawOptions = {
  allowFailure?: boolean;
  input?: Buffer | string;
  signal?: AbortSignal;
};

export type ExecDockerRawResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
};

type ExecDockerRawError = Error & {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
};

export async function execDockerRaw(
  args: string[],
  opts?: ExecDockerRawOptions,
): Promise<ExecDockerRawResult> {
  let result;
  try {
    result = await spawnCommand(["docker", ...args], {
      cancelSignal: opts?.signal,
      encoding: "buffer",
      input: opts?.input ?? Buffer.alloc(0),
      maxBuffer: SANDBOX_COMMAND_MAX_BUFFER_BYTES,
      reject: false,
      stripFinalNewline: false,
    });
  } catch (error) {
    if (opts?.signal?.aborted) {
      throw createAbortError("Aborted");
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw Object.assign(
        new Error(
          'Sandbox mode requires Docker, but the "docker" command was not found in PATH. Install Docker (and ensure "docker" is available), or set `agents.defaults.sandbox.mode=off` to disable sandboxing.',
        ),
        { code: "INVALID_CONFIG", cause: error },
      );
    }
    throw error;
  }
  if (opts?.signal?.aborted || result.isCanceled) {
    throw createAbortError("Aborted");
  }
  if (result.failed && !isPlainCommandExitFailure(result)) {
    if (result.code === "ENOENT") {
      throw Object.assign(
        new Error(
          'Sandbox mode requires Docker, but the "docker" command was not found in PATH. Install Docker (and ensure "docker" is available), or set `agents.defaults.sandbox.mode=off` to disable sandboxing.',
        ),
        { code: "INVALID_CONFIG", cause: result },
      );
    }
    throw toErrorObject(result, "Docker command execution failed");
  }
  const stdout = Buffer.from(result.stdout);
  const stderr = Buffer.from(result.stderr);
  const exitCode = result.exitCode ?? (result.failed ? 1 : 0);
  if (exitCode !== 0 && !opts?.allowFailure) {
    const message = stderr.length > 0 ? stderr.toString("utf8").trim() : "";
    const error: ExecDockerRawError = Object.assign(
      new Error(message || `docker ${args.join(" ")} failed`),
      { code: exitCode, stdout, stderr },
    );
    throw error;
  }
  return { stdout, stderr, code: exitCode };
}

import { markOpenClawExecEnv } from "../../infra/openclaw-exec-env.js";
import {
  computeSandboxConfigHash,
  SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH,
} from "./config-hash.js";
import {
  DEFAULT_SANDBOX_IMAGE,
  SANDBOX_COMMAND_MAX_BUFFER_BYTES,
  SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
} from "./constants.js";
import { handleHotSandboxConfigMismatch } from "./current-config.js";
import { readRegistryEntry, updateRegistry } from "./registry.js";
import { resolveSandboxScopeKey, slugifySessionKey } from "./shared.js";
import type { SandboxConfig, SandboxDockerConfig, SandboxWorkspaceAccess } from "./types.js";
import { validateSandboxSecurity } from "./validate-sandbox-security.js";
import {
  appendReadOnlyWorkspaceSkillMountArgs,
  appendWorkspaceMountArgs,
  formatReadOnlyWorkspaceSkillMountHashState,
  resolveReadOnlyWorkspaceSkillMounts,
  SANDBOX_MOUNT_FORMAT_VERSION,
  type ReadOnlyWorkspaceSkillMount,
} from "./workspace-mounts.js";

const log = createSubsystemLogger("docker");

const HOT_CONTAINER_WINDOW_MS = 5 * 60 * 1000;

type ExecDockerOptions = ExecDockerRawOptions;

function envRecordsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left).toSorted(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  const rightEntries = Object.entries(right).toSorted(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  return leftEntries.every(([key, value], index) => {
    const rightEntry = rightEntries[index];
    return rightEntry?.[0] === key && rightEntry[1] === value;
  });
}

export function resolveDockerEnvPolicyEpoch(env: Record<string, string | undefined> | undefined) {
  const explicitEnv = env ?? {};
  const previousAllowed = sanitizeEnvVars(explicitEnv).allowed;
  const currentAllowed = sanitizeExplicitSandboxEnvVars(explicitEnv).allowed;
  return envRecordsEqual(previousAllowed, currentAllowed)
    ? undefined
    : SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH;
}

export async function execDocker(args: string[], opts?: ExecDockerOptions) {
  const result = await execDockerRaw(args, opts);
  return {
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    code: result.code,
  };
}

export async function readDockerContainerLabel(
  containerName: string,
  label: string,
): Promise<string | null> {
  const result = await execDocker(
    ["inspect", "-f", `{{ index .Config.Labels "${label}" }}`, containerName],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    return null;
  }
  const raw = result.stdout.trim();
  if (!raw || raw === "<no value>") {
    return null;
  }
  return raw;
}

export async function readDockerContainerEnvVar(
  containerName: string,
  envVar: string,
): Promise<string | null> {
  const result = await execDocker(
    ["inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", containerName],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    return null;
  }
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith(`${envVar}=`)) {
      return line.slice(envVar.length + 1);
    }
  }
  return null;
}

export async function readDockerPort(containerName: string, port: number) {
  const result = await execDocker(["port", containerName, `${port}/tcp`], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    return null;
  }
  const line = result.stdout.trim().split(/\r?\n/)[0] ?? "";
  const match = line.match(/:(\d+)\s*$/);
  if (!match) {
    return null;
  }
  const mapped = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(mapped) ? mapped : null;
}

const DOCKER_DAEMON_UNAVAILABLE_MARKERS = [
  "cannot connect to the docker daemon",
  "dial unix",
  "docker daemon is not running",
  "connection refused",
];

export function isDockerDaemonUnavailable(stderr: string): boolean {
  return DOCKER_DAEMON_UNAVAILABLE_MARKERS.some((marker) => stderr.toLowerCase().includes(marker));
}

export function formatDockerDaemonUnavailableError(stderr: string): string {
  const detail = stderr.trim();
  return [
    "Sandbox mode requires Docker, but the Docker daemon is not available.",
    "Start Docker, or set `agents.defaults.sandbox.mode=off` to disable sandboxing.",
    detail ? `Docker said: ${detail}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join(" ");
}

async function inspectDockerImage(image: string): Promise<"exists" | "missing"> {
  const result = await execDocker(["image", "inspect", image], {
    allowFailure: true,
  });
  if (result.code === 0) {
    return "exists";
  }
  const stderr = result.stderr.trim();
  if (stderr.toLowerCase().includes("no such image")) {
    return "missing";
  }
  if (isDockerDaemonUnavailable(stderr)) {
    throw new Error(formatDockerDaemonUnavailableError(stderr));
  }
  throw new Error(`Failed to inspect sandbox image: ${stderr}`);
}

export async function ensureDockerImage(image: string) {
  const imageState = await inspectDockerImage(image);
  if (imageState === "exists") {
    return;
  }
  if (image === DEFAULT_SANDBOX_IMAGE) {
    throw new Error(
      `Sandbox image not found: ${image}. Build it with scripts/sandbox-setup.sh before enabling Docker sandboxing. The default image includes python3 for sandbox write/edit helpers; OpenClaw will not substitute plain debian:bookworm-slim.`,
    );
  }
  throw new Error(`Sandbox image not found: ${image}. Build or pull it first.`);
}

export async function dockerContainerState(name: string) {
  const result = await execDocker(["inspect", "-f", "{{.State.Running}}", name], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    return { exists: false, running: false };
  }
  return { exists: true, running: result.stdout.trim() === "true" };
}

function normalizeDockerLimit(value?: string | number) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeFiniteDockerNumber(value: unknown, min: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, value) : undefined;
}

function formatUlimitValue(
  name: string,
  value: string | number | { soft?: number; hard?: number },
) {
  if (!name.trim()) {
    return null;
  }
  if (typeof value === "number") {
    const normalized = normalizeFiniteDockerNumber(value, 0);
    return normalized === undefined ? null : `${name}=${normalized}`;
  }
  if (typeof value === "string") {
    const raw = value.trim();
    return raw ? `${name}=${raw}` : null;
  }
  const soft = normalizeFiniteDockerNumber(value.soft, 0);
  const hard = normalizeFiniteDockerNumber(value.hard, 0);
  if (soft === undefined && hard === undefined) {
    return null;
  }
  if (soft === undefined) {
    return `${name}=${hard}`;
  }
  if (hard === undefined) {
    return `${name}=${soft}`;
  }
  return `${name}=${soft}:${hard}`;
}

export function buildSandboxCreateArgs(params: {
  name: string;
  cfg: SandboxDockerConfig;
  scopeKey: string;
  createdAtMs?: number;
  labels?: Record<string, string>;
  configHash?: string;
  includeBinds?: boolean;
  bindSourceRoots?: string[];
  allowSourcesOutsideAllowedRoots?: boolean;
  allowReservedContainerTargets?: boolean;
  allowContainerNamespaceJoin?: boolean;
}) {
  // Runtime security validation: blocks dangerous bind mounts, network modes, and profiles.
  validateSandboxSecurity({
    ...params.cfg,
    allowedSourceRoots: params.bindSourceRoots,
    allowSourcesOutsideAllowedRoots:
      params.allowSourcesOutsideAllowedRoots ??
      params.cfg.dangerouslyAllowExternalBindSources === true,
    allowReservedContainerTargets:
      params.allowReservedContainerTargets ??
      params.cfg.dangerouslyAllowReservedContainerTargets === true,
    dangerouslyAllowContainerNamespaceJoin:
      params.allowContainerNamespaceJoin ??
      params.cfg.dangerouslyAllowContainerNamespaceJoin === true,
  });

  const createdAtMs = params.createdAtMs ?? Date.now();
  const args = ["create", "--name", params.name];
  // Docker's init owns PID 1 so orphaned children from long-running tool and
  // browser workloads are reaped instead of accumulating against pidsLimit.
  args.push("--init");
  args.push("--label", "openclaw.sandbox=1");
  args.push("--label", `openclaw.sessionKey=${params.scopeKey}`);
  args.push("--label", `openclaw.createdAtMs=${createdAtMs}`);
  args.push("--label", `openclaw.mountFormatVersion=${SANDBOX_MOUNT_FORMAT_VERSION}`);
  args.push("--label", `openclaw.createArgsEpoch=${SANDBOX_DOCKER_CREATE_ARGS_EPOCH}`);
  if (params.configHash) {
    args.push("--label", `openclaw.configHash=${params.configHash}`);
  }
  for (const [key, value] of Object.entries(params.labels ?? {})) {
    if (key && value) {
      args.push("--label", `${key}=${value}`);
    }
  }
  if (params.cfg.readOnlyRoot) {
    args.push("--read-only");
  }
  for (const entry of params.cfg.tmpfs) {
    args.push("--tmpfs", entry);
  }
  if (params.cfg.network) {
    args.push("--network", params.cfg.network);
  }
  if (params.cfg.user) {
    args.push("--user", params.cfg.user);
  }
  const envSanitization = sanitizeExplicitSandboxEnvVars(params.cfg.env ?? {});
  if (envSanitization.blocked.length > 0) {
    log.warn(
      `Blocked invalid configured sandbox environment variables: ${envSanitization.blocked.join(", ")}`,
    );
  }
  if (envSanitization.warnings.length > 0) {
    log.warn(
      `Suspicious configured sandbox environment variables: ${envSanitization.warnings.join(", ")}`,
    );
  }
  for (const [key, value] of Object.entries(markOpenClawExecEnv(envSanitization.allowed))) {
    args.push("--env", `${key}=${value}`);
  }
  for (const cap of params.cfg.capDrop) {
    args.push("--cap-drop", cap);
  }
  args.push("--security-opt", "no-new-privileges");
  if (params.cfg.seccompProfile) {
    args.push("--security-opt", `seccomp=${params.cfg.seccompProfile}`);
  }
  if (params.cfg.apparmorProfile) {
    args.push("--security-opt", `apparmor=${params.cfg.apparmorProfile}`);
  }
  for (const entry of params.cfg.dns ?? []) {
    if (entry.trim()) {
      args.push("--dns", entry);
    }
  }
  for (const entry of params.cfg.extraHosts ?? []) {
    if (entry.trim()) {
      args.push("--add-host", entry);
    }
  }
  const pidsLimit = normalizeFiniteDockerNumber(params.cfg.pidsLimit, 0);
  if (pidsLimit !== undefined && pidsLimit > 0) {
    args.push("--pids-limit", String(pidsLimit));
  }
  const memory = normalizeDockerLimit(params.cfg.memory);
  if (memory) {
    args.push("--memory", memory);
  }
  const memorySwap = normalizeDockerLimit(params.cfg.memorySwap);
  if (memorySwap) {
    args.push("--memory-swap", memorySwap);
  }
  const cpus = normalizeFiniteDockerNumber(params.cfg.cpus, 0);
  if (cpus !== undefined && cpus > 0) {
    args.push("--cpus", String(cpus));
  }
  const gpus = params.cfg.gpus?.trim();
  if (gpus) {
    args.push("--gpus", gpus);
  }
  for (const [name, value] of Object.entries(params.cfg.ulimits ?? {})) {
    const formatted = formatUlimitValue(name, value);
    if (formatted) {
      args.push("--ulimit", formatted);
    }
  }
  if (params.includeBinds !== false && params.cfg.binds?.length) {
    for (const bind of params.cfg.binds) {
      args.push("-v", bind);
    }
  }
  return args;
}

function appendCustomBinds(args: string[], cfg: SandboxDockerConfig): void {
  if (!cfg.binds?.length) {
    return;
  }
  for (const bind of cfg.binds) {
    args.push("-v", bind);
  }
}

async function createSandboxContainer(params: {
  name: string;
  cfg: SandboxDockerConfig;
  workspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  scopeKey: string;
  configHash?: string;
  readOnlyWorkspaceSkillMounts: readonly ReadOnlyWorkspaceSkillMount[];
}) {
  const { name, cfg, workspaceDir, scopeKey } = params;
  await ensureDockerImage(cfg.image);

  const args = buildSandboxCreateArgs({
    name,
    cfg,
    scopeKey,
    configHash: params.configHash,
    includeBinds: false,
    bindSourceRoots: [workspaceDir, params.agentWorkspaceDir],
  });
  args.push("--workdir", cfg.workdir);
  appendWorkspaceMountArgs({
    args,
    workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    workdir: cfg.workdir,
    workspaceAccess: params.workspaceAccess,
    readOnlyWorkspaceSkillMounts: params.readOnlyWorkspaceSkillMounts,
    includeReadOnlyWorkspaceSkillMounts: false,
  });
  appendCustomBinds(args, cfg);
  appendReadOnlyWorkspaceSkillMountArgs({
    args,
    readOnlyWorkspaceSkillMounts: params.readOnlyWorkspaceSkillMounts,
  });
  args.push(cfg.image, "sleep", "infinity");

  await execDocker(args);
  await execDocker(["start", name]);

  if (cfg.setupCommand?.trim()) {
    await execDocker(["exec", "-i", name, "/bin/sh", "-lc", cfg.setupCommand]);
  }
}

async function readContainerConfigHash(containerName: string): Promise<string | null> {
  return await readDockerContainerLabel(containerName, "openclaw.configHash");
}

export async function ensureSandboxContainer(params: {
  sessionKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  cfg: SandboxConfig;
  requireCurrentConfig?: boolean;
}) {
  const scopeKey = resolveSandboxScopeKey(params.cfg.scope, params.sessionKey);
  const slug = params.cfg.scope === "shared" ? "shared" : slugifySessionKey(scopeKey);
  const name = `${params.cfg.docker.containerPrefix}${slug}`;
  const containerName = name.slice(0, 63);
  const readOnlyWorkspaceSkillMounts = resolveReadOnlyWorkspaceSkillMounts({
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    workdir: params.cfg.docker.workdir,
    workspaceAccess: params.cfg.workspaceAccess,
  });
  const expectedHash = computeSandboxConfigHash({
    docker: params.cfg.docker,
    dockerEnvPolicyEpoch: resolveDockerEnvPolicyEpoch(params.cfg.docker.env),
    workspaceAccess: params.cfg.workspaceAccess,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    readOnlyWorkspaceSkillMounts: formatReadOnlyWorkspaceSkillMountHashState(
      readOnlyWorkspaceSkillMounts,
    ),
  });
  const now = Date.now();
  const state = await dockerContainerState(containerName);
  let hasContainer = state.exists;
  let running = state.running;
  let currentHash: string | null = null;
  let hashMismatch = false;
  let registryEntry:
    | {
        lastUsedAtMs: number;
        configHash?: string;
      }
    | undefined;
  if (hasContainer) {
    registryEntry = (await readRegistryEntry(containerName)) ?? undefined;
    currentHash = await readContainerConfigHash(containerName);
    if (!currentHash) {
      currentHash = registryEntry?.configHash ?? null;
    }
    hashMismatch = !currentHash || currentHash !== expectedHash;
    if (hashMismatch) {
      const lastUsedAtMs = registryEntry?.lastUsedAtMs;
      const isHot =
        running &&
        (typeof lastUsedAtMs !== "number" || now - lastUsedAtMs < HOT_CONTAINER_WINDOW_MS);
      if (isHot) {
        handleHotSandboxConfigMismatch({
          containerName,
          scope: params.cfg.scope,
          sessionKey: scopeKey,
          ...(params.requireCurrentConfig !== undefined
            ? { requireCurrentConfig: params.requireCurrentConfig }
            : {}),
        });
      } else {
        await execDocker(["rm", "-f", containerName], { allowFailure: true });
        hasContainer = false;
        running = false;
      }
    }
  }
  if (!hasContainer) {
    await createSandboxContainer({
      name: containerName,
      cfg: params.cfg.docker,
      workspaceDir: params.workspaceDir,
      workspaceAccess: params.cfg.workspaceAccess,
      agentWorkspaceDir: params.agentWorkspaceDir,
      skillsWorkspaceDir: params.skillsWorkspaceDir,
      scopeKey,
      configHash: expectedHash,
      readOnlyWorkspaceSkillMounts,
    });
  } else if (!running) {
    await execDocker(["start", containerName]);
  }
  await updateRegistry({
    containerName,
    backendId: "docker",
    runtimeLabel: containerName,
    sessionKey: scopeKey,
    createdAtMs: now,
    lastUsedAtMs: now,
    image: params.cfg.docker.image,
    configLabelKind: "Image",
    configHash: hashMismatch && running ? (currentHash ?? undefined) : expectedHash,
  });
  return containerName;
}
