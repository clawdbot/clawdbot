import { spawn } from "node:child_process";

import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants.js";
import { readRegistry, updateRegistry } from "./registry.js";
import { computeSandboxConfigHash } from "./config-hash.js";
import { resolveSandboxAgentId, resolveSandboxScopeKey, slugifySessionKey } from "./shared.js";
import type { SandboxConfig, SandboxDockerConfig, SandboxWorkspaceAccess } from "./types.js";

const HOT_CONTAINER_WINDOW_MS = 5 * 60 * 1000;

export function execDocker(args: string[], opts?: { allowFailure?: boolean }) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !opts?.allowFailure) {
        reject(new Error(stderr.trim() || `docker ${args.join(" ")} failed`));
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });
  });
}

export async function readDockerPort(containerName: string, port: number) {
  const result = await execDocker(["port", containerName, `${port}/tcp`], {
    allowFailure: true,
  });
  if (result.code !== 0) return null;
  const line = result.stdout.trim().split(/\r?\n/)[0] ?? "";
  const match = line.match(/:(\d+)\s*$/);
  if (!match) return null;
  const mapped = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(mapped) ? mapped : null;
}

async function dockerImageExists(image: string) {
  const result = await execDocker(["image", "inspect", image], {
    allowFailure: true,
  });
  if (result.code === 0) return true;
  const stderr = result.stderr.trim();
  if (stderr.includes("No such image")) {
    return false;
  }
  throw new Error(`Failed to inspect sandbox image: ${stderr}`);
}

export async function ensureDockerImage(image: string) {
  const exists = await dockerImageExists(image);
  if (exists) return;
  if (image === DEFAULT_SANDBOX_IMAGE) {
    await execDocker(["pull", "debian:bookworm-slim"]);
    await execDocker(["tag", "debian:bookworm-slim", DEFAULT_SANDBOX_IMAGE]);
    return;
  }
  throw new Error(`Sandbox image not found: ${image}. Build or pull it first.`);
}

export async function dockerContainerState(name: string) {
  const result = await execDocker(["inspect", "-f", "{{.State.Running}}", name], {
    allowFailure: true,
  });
  if (result.code !== 0) return { exists: false, running: false };
  return { exists: true, running: result.stdout.trim() === "true" };
}

function normalizeDockerLimit(value?: string | number) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function formatUlimitValue(
  name: string,
  value: string | number | { soft?: number; hard?: number },
) {
  if (!name.trim()) return null;
  if (typeof value === "number" || typeof value === "string") {
    const raw = String(value).trim();
    return raw ? `${name}=${raw}` : null;
  }
  const soft = typeof value.soft === "number" ? Math.max(0, value.soft) : undefined;
  const hard = typeof value.hard === "number" ? Math.max(0, value.hard) : undefined;
  if (soft === undefined && hard === undefined) return null;
  if (soft === undefined) return `${name}=${hard}`;
  if (hard === undefined) return `${name}=${soft}`;
  return `${name}=${soft}:${hard}`;
}

export function buildSandboxCreateArgs(params: {
  name: string;
  cfg: SandboxDockerConfig;
  scopeKey: string;
  createdAtMs?: number;
  labels?: Record<string, string>;
  configHash?: string;
}) {
  const createdAtMs = params.createdAtMs ?? Date.now();
  const args = ["create", "--name", params.name];
  args.push("--label", "moltbot.sandbox=1");
  args.push("--label", `moltbot.sessionKey=${params.scopeKey}`);
  args.push("--label", `moltbot.createdAtMs=${createdAtMs}`);
  if (params.configHash) {
    args.push("--label", `moltbot.configHash=${params.configHash}`);
  }
  for (const [key, value] of Object.entries(params.labels ?? {})) {
    if (key && value) args.push("--label", `${key}=${value}`);
  }
  if (params.cfg.readOnlyRoot) args.push("--read-only");
  for (const entry of params.cfg.tmpfs) {
    args.push("--tmpfs", entry);
  }
  if (params.cfg.network) args.push("--network", params.cfg.network);
  if (params.cfg.user) args.push("--user", params.cfg.user);
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
    if (entry.trim()) args.push("--dns", entry);
  }
  for (const entry of params.cfg.extraHosts ?? []) {
    if (entry.trim()) args.push("--add-host", entry);
  }
  if (typeof params.cfg.pidsLimit === "number" && params.cfg.pidsLimit > 0) {
    args.push("--pids-limit", String(params.cfg.pidsLimit));
  }
  const memory = normalizeDockerLimit(params.cfg.memory);
  if (memory) args.push("--memory", memory);
  const memorySwap = normalizeDockerLimit(params.cfg.memorySwap);
  if (memorySwap) args.push("--memory-swap", memorySwap);
  if (typeof params.cfg.cpus === "number" && params.cfg.cpus > 0) {
    args.push("--cpus", String(params.cfg.cpus));
  }
  for (const [name, value] of Object.entries(params.cfg.ulimits ?? {}) as Array<
    [string, string | number | { soft?: number; hard?: number }]
  >) {
    const formatted = formatUlimitValue(name, value);
    if (formatted) args.push("--ulimit", formatted);
  }
  if (params.cfg.binds?.length) {
    for (const bind of params.cfg.binds) {
      args.push("-v", bind);
    }
  }
  return args;
}

async function createSandboxContainer(params: {
  name: string;
  cfg: SandboxDockerConfig;
  workspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  agentWorkspaceDir: string;
  scopeKey: string;
  configHash?: string;
}) {
  const { name, cfg, workspaceDir, scopeKey } = params;
  await ensureDockerImage(cfg.image);

  const args = buildSandboxCreateArgs({
    name,
    cfg,
    scopeKey,
    configHash: params.configHash,
  });
  args.push("--workdir", cfg.workdir);
  const mainMountSuffix =
    params.workspaceAccess === "ro" && workspaceDir === params.agentWorkspaceDir ? ":ro" : "";
  args.push("-v", `${workspaceDir}:${cfg.workdir}${mainMountSuffix}`);
  if (params.workspaceAccess !== "none" && workspaceDir !== params.agentWorkspaceDir) {
    const agentMountSuffix = params.workspaceAccess === "ro" ? ":ro" : "";
    args.push(
      "-v",
      `${params.agentWorkspaceDir}:${SANDBOX_AGENT_WORKSPACE_MOUNT}${agentMountSuffix}`,
    );
  }
  args.push(cfg.image, "sleep", "infinity");

  await execDocker(args);
  await execDocker(["start", name]);

  if (cfg.setupCommand?.trim()) {
    await execDocker(["exec", "-i", name, "sh", "-lc", cfg.setupCommand]);
  }
}

async function readContainerConfigHash(containerName: string): Promise<string | null> {
  const result = await execDocker(
    ["inspect", "-f", '{{ index .Config.Labels "moltbot.configHash" }}', containerName],
    { allowFailure: true },
  );
  if (result.code !== 0) return null;
  const raw = result.stdout.trim();
  if (!raw || raw === "<no value>") return null;
  return raw;
}

function formatSandboxRecreateHint(params: { scope: SandboxConfig["scope"]; sessionKey: string }) {
  if (params.scope === "session") {
    return formatCliCommand(`moltbot sandbox recreate --session ${params.sessionKey}`);
  }
  if (params.scope === "agent") {
    const agentId = resolveSandboxAgentId(params.sessionKey) ?? "main";
    return formatCliCommand(`moltbot sandbox recreate --agent ${agentId}`);
  }
  return formatCliCommand("moltbot sandbox recreate --all");
}

export async function ensureSandboxContainer(params: {
  sessionKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  cfg: SandboxConfig;
}) {
  const scopeKey = resolveSandboxScopeKey(params.cfg.scope, params.sessionKey);
  const slug = params.cfg.scope === "shared" ? "shared" : slugifySessionKey(scopeKey);
  const name = `${params.cfg.docker.containerPrefix}${slug}`;
  const containerName = name.slice(0, 63);
  const expectedHash = computeSandboxConfigHash({
    docker: params.cfg.docker,
    workspaceAccess: params.cfg.workspaceAccess,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
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
    const registry = await readRegistry();
    registryEntry = registry.entries.find((entry) => entry.containerName === containerName);
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
        const hint = formatSandboxRecreateHint({ scope: params.cfg.scope, sessionKey: scopeKey });
        defaultRuntime.log(
          `Sandbox config changed for ${containerName} (recently used). Recreate to apply: ${hint}`,
        );
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
      scopeKey,
      configHash: expectedHash,
    });
  } else if (!running) {
    await execDocker(["start", containerName]);
  }
  await updateRegistry({
    containerName,
    sessionKey: scopeKey,
    createdAtMs: now,
    lastUsedAtMs: now,
    image: params.cfg.docker.image,
    configHash: hashMismatch && running ? (currentHash ?? undefined) : expectedHash,
  });
  return containerName;
}
