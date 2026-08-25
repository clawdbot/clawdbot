import { markOpenClawExecEnv } from "../../infra/openclaw-exec-env.js";
/**
 * Low-level Docker command helpers for sandbox runtimes.
 *
 * Wraps Docker spawn, environment sanitization, container inspection, creation, and exec behavior.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { computeSandboxConfigHash } from "./config-hash.js";
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./constants.js";
import {
  resolveSandboxContainerActivityKey,
  withSandboxContainerMutation,
} from "./container-activity.js";
import {
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  execContainerRaw,
  type ExecContainerRawOptions,
  type ExecDockerRawResult,
  type SandboxContainerEngine,
  type SandboxContainerEngineTarget,
} from "./container-engine.js";
import { handleHotSandboxConfigMismatch } from "./current-config.js";
import {
  assertPodmanSandboxTarget,
  bindPodmanSandboxEngine,
  resolvePodmanSandboxConfigHash,
  resolvePodmanSandboxContainerPrefix,
  resolvePodmanSandboxCreatePolicy,
  resolvePodmanSandboxRuntimeInfo,
  type PodmanSandboxRuntimeInfo,
} from "./podman-runtime.js";
import { readRegistryEntry, removeRegistryEntry, updateRegistry } from "./registry.js";
import {
  resolveDockerEnvPolicyEpoch,
  sanitizeExplicitSandboxEnvVars,
} from "./sanitize-env-vars.js";
import { buildSandboxContainerName, slugifySessionKey } from "./shared.js";
import type { SandboxConfig, SandboxDockerConfig, SandboxWorkspaceAccess } from "./types.js";
import { validateSandboxSecurity } from "./validate-sandbox-security.js";
import {
  appendReadOnlyWorkspaceSkillMountArgs,
  appendWorkspaceMountArgs,
  filterBindsConflictingWithProtectedMounts,
  formatReadOnlyWorkspaceSkillMountHashState,
  resolveReadOnlyWorkspaceSkillMounts,
  resolveProtectedSkillMountContainerPaths,
  SANDBOX_MOUNT_FORMAT_VERSION,
  type ReadOnlyWorkspaceSkillMount,
} from "./workspace-mounts.js";

export {
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  execContainerRaw,
  PODMAN_SANDBOX_ENGINE,
} from "./container-engine.js";
export type {
  ExecDockerRawResult,
  SandboxContainerEngine,
  SandboxContainerEngineTarget,
} from "./container-engine.js";
export {
  bindPodmanSandboxEngine,
  resolvePodmanSandboxRuntimeInfo,
  validateSandboxContainerEngineTarget,
} from "./podman-runtime.js";
export type { PodmanSandboxRuntimeInfo } from "./podman-runtime.js";
export { resolveDockerEnvPolicyEpoch } from "./sanitize-env-vars.js";

type ExecDockerRawOptions = ExecContainerRawOptions;

export async function execDockerRaw(
  args: string[],
  opts?: ExecDockerRawOptions,
): Promise<ExecDockerRawResult> {
  return await execContainerRaw(DOCKER_SANDBOX_ENGINE, args, opts);
}

const log = createSubsystemLogger("docker");

const HOT_CONTAINER_WINDOW_MS = 5 * 60 * 1000;
const sandboxContainerLifecycleQueue = new KeyedAsyncQueue();

type ExecDockerOptions = ExecDockerRawOptions;

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
  return await readContainerLabel(DOCKER_SANDBOX_ENGINE, containerName, label);
}

export async function readContainerLabel(
  engine: SandboxContainerEngine,
  containerName: string,
  label: string,
): Promise<string | null> {
  const result = await execContainer(
    engine,
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

async function inspectContainerImage(
  engine: SandboxContainerEngine,
  image: string,
): Promise<"exists" | "missing"> {
  const result = await execContainer(engine, ["image", "inspect", image], {
    allowFailure: true,
  });
  if (result.code === 0) {
    return "exists";
  }
  const stderr = result.stderr.trim();
  const imageMissing =
    engine.id === "docker"
      ? stderr.toLowerCase().includes("no such image")
      : /no such image|image not known|image .* not found/iu.test(stderr);
  if (imageMissing) {
    return "missing";
  }
  if (engine.id === "docker" && isDockerDaemonUnavailable(stderr)) {
    throw new Error(formatDockerDaemonUnavailableError(stderr));
  }
  if (engine.id === "docker") {
    throw new Error(`Failed to inspect sandbox image: ${stderr}`);
  }
  throw new Error(`Failed to inspect sandbox image with ${engine.displayName}: ${stderr}`);
}

export async function ensureDockerImage(image: string) {
  await ensureContainerImage(DOCKER_SANDBOX_ENGINE, image);
}

export async function ensureContainerImage(engine: SandboxContainerEngine, image: string) {
  const imageState = await inspectContainerImage(engine, image);
  if (imageState === "exists") {
    return;
  }
  if (image === DEFAULT_SANDBOX_IMAGE) {
    if (engine.id === "docker") {
      throw new Error(
        `Sandbox image not found: ${image}. Build it with scripts/sandbox-setup.sh before enabling Docker sandboxing. The default image includes python3 for sandbox write/edit helpers; OpenClaw will not substitute plain debian:bookworm-slim.`,
      );
    }
    throw new Error(
      `Sandbox image not found in ${engine.displayName}: ${image}. Build it with podman build -t ${image} -f scripts/docker/sandbox/Dockerfile . before enabling container sandboxing. The default image includes python3 for sandbox write/edit helpers; OpenClaw will not substitute plain debian:bookworm-slim.`,
    );
  }
  if (engine.id === "docker") {
    throw new Error(`Sandbox image not found: ${image}. Build or pull it first.`);
  }
  throw new Error(
    `Sandbox image not found in ${engine.displayName}: ${image}. Build or pull it first.`,
  );
}

export async function dockerContainerState(name: string) {
  return await containerState(DOCKER_SANDBOX_ENGINE, name);
}

export async function containerState(engine: SandboxContainerEngine, name: string) {
  const result = await execContainer(engine, ["inspect", "-f", "{{.State.Running}}", name], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    return { exists: false, running: false };
  }
  return { exists: true, running: result.stdout.trim() === "true" };
}

function isPodmanContainerNotFound(stderr: string): boolean {
  // Target changes are destructive only after Podman confirms absence. Treat
  // connection and authorization failures as unknown so the old runtime stays registered.
  return (
    /no such container/iu.test(stderr) ||
    /no container with name or id .* found/iu.test(stderr) ||
    /container .* does not exist/iu.test(stderr)
  );
}

async function recordedPodmanContainerState(engine: SandboxContainerEngine, name: string) {
  const result = await execContainer(engine, ["inspect", "-f", "{{.State.Running}}", name], {
    allowFailure: true,
  });
  if (result.code === 0) {
    return { exists: true, running: result.stdout.trim() === "true" };
  }
  if (isPodmanContainerNotFound(result.stderr)) {
    return { exists: false, running: false };
  }
  const detail = result.stderr.trim();
  throw Object.assign(
    new Error(
      detail
        ? `Unable to inspect recorded Podman sandbox runtime ${name}: ${detail}`
        : `Unable to inspect recorded Podman sandbox runtime ${name} (exit ${result.code})`,
    ),
    { code: result.code },
  );
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
  // The container engine's init owns PID 1 so orphaned children from long-running
  // tool and browser workloads are reaped instead of accumulating against pidsLimit.
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
  engine: SandboxContainerEngine;
  name: string;
  cfg: SandboxDockerConfig;
  dockerTmpfsSource: SandboxConfig["dockerTmpfsSource"];
  workspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  scopeKey: string;
  configHash?: string;
  readOnlyWorkspaceSkillMounts: readonly ReadOnlyWorkspaceSkillMount[];
  podmanRuntimeInfo?: PodmanSandboxRuntimeInfo;
}) {
  const { engine, name, cfg, workspaceDir, scopeKey } = params;
  const podmanPolicy =
    engine.id === "podman" && params.podmanRuntimeInfo
      ? resolvePodmanSandboxCreatePolicy({
          cfg,
          dockerTmpfsSource: params.dockerTmpfsSource,
          workspaceDir,
          workspaceAccess: params.workspaceAccess,
          agentWorkspaceDir: params.agentWorkspaceDir,
          readOnlyWorkspaceSkillMounts: params.readOnlyWorkspaceSkillMounts,
          runtimeInfo: params.podmanRuntimeInfo,
        })
      : undefined;
  const createCfg = podmanPolicy?.cfg ?? cfg;
  await ensureContainerImage(engine, cfg.image);

  const args = buildSandboxCreateArgs({
    name,
    cfg: createCfg,
    scopeKey,
    configHash: params.configHash,
    includeBinds: false,
    bindSourceRoots: [workspaceDir, params.agentWorkspaceDir],
  });
  if (podmanPolicy) {
    args.push(...podmanPolicy.extraCreateArgs);
  }
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
  // Protected skill overlays are authoritative. Remove exact destination
  // collisions before Docker or Podman sees duplicate mount arguments.
  const protectedPaths = resolveProtectedSkillMountContainerPaths(
    params.readOnlyWorkspaceSkillMounts,
  );
  let safeBinds = cfg.binds;
  if (protectedPaths.size > 0 && cfg.binds?.length) {
    safeBinds = filterBindsConflictingWithProtectedMounts(cfg.binds, protectedPaths);
    const skipped = cfg.binds.filter((b) => !safeBinds!.includes(b));
    for (const bind of skipped) {
      log.warn(
        `sandbox: skipping user bind "${bind}" — container path conflicts with a protected read-only skill mount`,
      );
    }
  }
  appendCustomBinds(args, safeBinds ? { ...cfg, binds: safeBinds } : cfg);
  appendReadOnlyWorkspaceSkillMountArgs({
    args,
    readOnlyWorkspaceSkillMounts: params.readOnlyWorkspaceSkillMounts,
  });
  args.push(cfg.image, "sleep", "infinity");

  await execContainer(engine, args);
  await execContainer(engine, ["start", name]);

  if (cfg.setupCommand?.trim()) {
    await execContainer(engine, ["exec", "-i", name, "/bin/sh", "-lc", cfg.setupCommand]);
  }
}

async function readContainerConfigHash(
  engine: SandboxContainerEngine,
  containerName: string,
): Promise<string | null> {
  return await readContainerLabel(engine, containerName, "openclaw.configHash");
}

type EnsureSandboxContainerParams = {
  engine?: SandboxContainerEngine;
  podmanTarget?: SandboxContainerEngineTarget;
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  cfg: SandboxConfig;
  requireCurrentConfig?: boolean;
};

export async function ensureSandboxContainer(params: EnsureSandboxContainerParams) {
  const engine = params.engine ?? DOCKER_SANDBOX_ENGINE;
  const slug = params.cfg.scope === "shared" ? "shared" : slugifySessionKey(params.scopeKey);
  const prefix =
    engine.id === "podman"
      ? resolvePodmanSandboxContainerPrefix(params.cfg.docker.containerPrefix)
      : params.cfg.docker.containerPrefix;
  const containerName = buildSandboxContainerName(prefix, slug);

  // Independent agent runs can converge on one container resource. Serialize the
  // full lifecycle so followers re-read state after create, start, or replace.
  return await sandboxContainerLifecycleQueue.enqueue(containerName, async () => {
    return await ensureSandboxContainerLifecycle(params, containerName);
  });
}

async function ensureSandboxContainerLifecycle(
  params: EnsureSandboxContainerParams,
  containerName: string,
) {
  const configuredEngine = params.engine ?? DOCKER_SANDBOX_ENGINE;
  const podmanRuntimeInfo =
    configuredEngine.id === "podman" ? await resolvePodmanSandboxRuntimeInfo() : undefined;
  if (podmanRuntimeInfo) {
    assertPodmanSandboxTarget(params.podmanTarget, podmanRuntimeInfo.target);
  }
  const engine = podmanRuntimeInfo
    ? bindPodmanSandboxEngine(podmanRuntimeInfo.target)
    : configuredEngine;
  let existingRegistryEntry = await readRegistryEntry(containerName);
  if (engine.id === "podman" && existingRegistryEntry) {
    if (!existingRegistryEntry.backendTarget) {
      throw Object.assign(
        new Error(
          `Podman sandbox runtime ${containerName} has no recorded engine target. Remove that unshipped runtime manually before recreating it.`,
        ),
        { code: "INVALID_CONFIG" },
      );
    }
    try {
      assertPodmanSandboxTarget(existingRegistryEntry.backendTarget, podmanRuntimeInfo!.target);
    } catch (error) {
      if (existingRegistryEntry.backendTarget.globalArgs.length === 0) {
        throw error;
      }
      const recordedEngine = bindPodmanSandboxEngine(existingRegistryEntry.backendTarget);
      const recordedState = await recordedPodmanContainerState(recordedEngine, containerName);
      if (recordedState.exists) {
        throw error;
      }
      // A removed or replaced Podman target can leave registry metadata behind.
      // Drop it only after the recorded target no longer exposes the runtime.
      await removeRegistryEntry(containerName);
      existingRegistryEntry = null;
    }
  }
  const readOnlyWorkspaceSkillMounts = resolveReadOnlyWorkspaceSkillMounts({
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    workdir: params.cfg.docker.workdir,
    workspaceAccess: params.cfg.workspaceAccess,
  });
  const genericConfigHash = computeSandboxConfigHash({
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
  const expectedHash =
    engine.id === "podman"
      ? resolvePodmanSandboxConfigHash({
          genericConfigHash,
          configuredUser: Boolean(params.cfg.docker.user),
          dockerTmpfsSource: params.cfg.dockerTmpfsSource,
        })
      : genericConfigHash;
  const now = Date.now();
  const createContainer = async () =>
    await createSandboxContainer({
      engine,
      name: containerName,
      cfg: params.cfg.docker,
      dockerTmpfsSource: params.cfg.dockerTmpfsSource,
      workspaceDir: params.workspaceDir,
      workspaceAccess: params.cfg.workspaceAccess,
      agentWorkspaceDir: params.agentWorkspaceDir,
      skillsWorkspaceDir: params.skillsWorkspaceDir,
      scopeKey: params.scopeKey,
      configHash: expectedHash,
      readOnlyWorkspaceSkillMounts,
      podmanRuntimeInfo,
    });
  const state = await containerState(engine, containerName);
  const hasContainer = state.exists;
  let running = state.running;
  let currentHash: string | null = null;
  let hashMismatch = false;
  const registryEntry = existingRegistryEntry ?? undefined;
  if (hasContainer) {
    currentHash = await readContainerConfigHash(engine, containerName);
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
          sessionKey: params.scopeKey,
          ...(params.requireCurrentConfig !== undefined
            ? { requireCurrentConfig: params.requireCurrentConfig }
            : {}),
        });
      } else {
        await withSandboxContainerMutation(
          resolveSandboxContainerActivityKey(engine, containerName, podmanRuntimeInfo?.target),
          async () => {
            await execContainer(engine, ["rm", "-f", containerName], { allowFailure: true });
            await createContainer();
          },
        );
        hashMismatch = false;
        running = true;
      }
    }
  }
  if (!hasContainer) {
    await createContainer();
  } else if (!running) {
    await execContainer(engine, ["start", containerName]);
  }
  await updateRegistry({
    containerName,
    backendId: engine.id,
    ...(podmanRuntimeInfo ? { backendTarget: podmanRuntimeInfo.target } : {}),
    runtimeLabel: containerName,
    sessionKey: params.scopeKey,
    createdAtMs: now,
    lastUsedAtMs: now,
    image: params.cfg.docker.image,
    configLabelKind: "Image",
    configHash: hashMismatch && running ? (currentHash ?? undefined) : expectedHash,
  });
  return containerName;
}
