import path from "node:path";
/**
 * Docker sandbox backend implementation.
 *
 * Creates/reuses Docker containers and exposes backend-neutral exec and shell-command handles.
 */
import { buildDockerExecArgs } from "../bash-tools.shared.js";
import type { SandboxBackendCommandParams } from "./backend-handle.types.js";
import type {
  CreateSandboxBackendParams,
  SandboxBackendHandle,
  SandboxBackendManager,
} from "./backend.types.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  containerState,
  bindPodmanSandboxEngine,
  DOCKER_SANDBOX_ENGINE,
  ensureSandboxContainer,
  execContainer,
  execContainerRaw,
  PODMAN_SANDBOX_ENGINE,
  resolvePodmanSandboxRuntimeInfo,
  type SandboxContainerEngine,
  type SandboxContainerEngineTarget,
  validateSandboxContainerEngineTarget,
} from "./docker.js";
import { hashTextSha256 } from "./hash.js";
import type { SandboxRegistryEntry } from "./registry.js";
import { createRemoteShellSandboxFsBridge } from "./remote-fs-bridge.js";

type ContainerFsCleanupLocator = {
  version: 1;
  backend: "docker" | "podman";
  containerId: string;
  ingressRoot: string;
  target?: SandboxContainerEngineTarget;
};

function readContainerFsCleanupLocator(
  value: unknown,
  expectedBackend: "docker" | "podman",
): ContainerFsCleanupLocator {
  const locator = value as Partial<ContainerFsCleanupLocator> | undefined;
  const target = locator?.target;
  if (
    locator?.version !== 1 ||
    locator.backend !== expectedBackend ||
    typeof locator.containerId !== "string" ||
    !/^[0-9a-f]{64}$/u.test(locator.containerId) ||
    typeof locator.ingressRoot !== "string" ||
    !/^\/tmp\/openclaw-attachment-ingress\/[0-9a-f]{32}$/u.test(locator.ingressRoot) ||
    (target !== undefined &&
      (typeof target.key !== "string" ||
        !target.key.trim() ||
        !Array.isArray(target.globalArgs) ||
        target.globalArgs.some((arg) => typeof arg !== "string")))
  ) {
    throw new Error(`Invalid ${expectedBackend} attachment cleanup locator`);
  }
  return {
    version: 1,
    backend: expectedBackend,
    containerId: locator.containerId,
    ingressRoot: locator.ingressRoot,
    ...(target ? { target: { key: target.key, globalArgs: [...target.globalArgs] } } : {}),
  };
}

function createContainerCleanupFsBridge(params: {
  engine: SandboxContainerEngine;
  locator: ContainerFsCleanupLocator;
  runtimeId: string;
  workspaceDir: string;
  allowMissingRuntimeOnRemove?: boolean;
}) {
  const bridge = createRemoteShellSandboxFsBridge({
    sandbox: {
      workspaceDir: params.workspaceDir,
      agentWorkspaceDir: params.workspaceDir,
      workspaceAccess: "rw",
      containerName: params.runtimeId,
      containerWorkdir: params.locator.ingressRoot,
      docker: { binds: [] },
    },
    runtime: {
      remoteWorkspaceDir: params.locator.ingressRoot,
      remoteAgentWorkspaceDir: params.locator.ingressRoot,
      runRemoteShellScript: async (command) =>
        await runContainerSandboxShellCommand({
          engine: params.engine,
          containerName: params.locator.containerId,
          podmanTarget: params.locator.target,
          ...command,
        }),
    },
  });
  if (params.allowMissingRuntimeOnRemove) {
    const remove = bridge.remove.bind(bridge);
    bridge.remove = async (removeParams) => {
      const inspected = await execContainer(
        params.engine,
        ["inspect", "-f", "{{.Id}}", params.locator.containerId],
        { allowFailure: true },
      );
      if (inspected.code !== 0) {
        const detail = inspected.stderr.trim() || inspected.stdout.trim();
        if (
          /No such (container|object)|no container with name or id .* found|does not exist/iu.test(
            detail,
          )
        ) {
          return;
        }
        throw new Error(
          `Failed to verify ${params.engine.displayName} attachment runtime: ${detail || `exit ${inspected.code}`}`,
        );
      }
      if (inspected.stdout.trim() !== params.locator.containerId) {
        throw new Error(`${params.engine.displayName} attachment runtime identity changed`);
      }
      await remove(removeParams);
    };
  }
  return bridge;
}

function resolveConfiguredDockerRuntimeImage(params: {
  config: CreateSandboxBackendParams["cfg"] | import("../../config/config.js").OpenClawConfig;
  agentId?: string;
  configLabelKind?: string;
}): string {
  const sandboxCfg = resolveSandboxConfigForAgent(params.config, params.agentId);
  switch (params.configLabelKind) {
    case "BrowserImage":
      return sandboxCfg.browser.image;
    default:
      return sandboxCfg.docker.image;
  }
}

async function createContainerSandboxBackend(
  engine: SandboxContainerEngine,
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  if (engine.id === "podman" && params.cfg.browser.enabled) {
    throw new Error(
      "Podman sandboxing does not support browser sandboxes. Install Docker and select the docker backend, or disable sandbox.browser.enabled.",
    );
  }
  const podmanTarget =
    engine.id === "podman" ? (await resolvePodmanSandboxRuntimeInfo()).target : undefined;
  const boundEngine = podmanTarget ? bindPodmanSandboxEngine(podmanTarget) : engine;
  const containerName = await ensureSandboxContainer({
    engine: boundEngine,
    ...(podmanTarget ? { podmanTarget } : {}),
    scopeKey: params.scopeKey,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    cfg: params.cfg,
    ...(params.requireCurrentConfig !== undefined
      ? { requireCurrentConfig: params.requireCurrentConfig }
      : {}),
  });
  return createContainerSandboxBackendHandle({
    engine: boundEngine,
    containerName,
    workdir: params.cfg.docker.workdir,
    env: params.cfg.docker.env,
    image: params.cfg.docker.image,
    podmanTarget,
  });
}

export async function createDockerSandboxBackend(
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  return await createContainerSandboxBackend(DOCKER_SANDBOX_ENGINE, params);
}

export async function createPodmanSandboxBackend(
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  return await createContainerSandboxBackend(PODMAN_SANDBOX_ENGINE, params);
}

function createContainerSandboxBackendHandle(params: {
  engine: SandboxContainerEngine;
  containerName: string;
  workdir: string;
  env?: Record<string, string>;
  image: string;
  podmanTarget?: SandboxContainerEngineTarget;
}): SandboxBackendHandle {
  return {
    id: params.engine.id,
    runtimeId: params.containerName,
    runtimeLabel: params.containerName,
    workdir: params.workdir,
    env: params.env,
    configLabel: params.image,
    configLabelKind: "Image",
    capabilities: {
      browser: params.engine.id === "docker",
      workspaceMutationVisibility: "shared-host",
    },
    async buildExecSpec({ command, workdir, env, usePty }) {
      await validateSandboxContainerEngineTarget(params.engine, params.podmanTarget);
      return {
        argv: [
          params.engine.command,
          ...(params.engine.globalArgs ?? []),
          ...buildDockerExecArgs({
            containerName: params.containerName,
            command,
            workdir: workdir ?? params.workdir,
            env,
            tty: usePty,
          }),
        ],
        env: process.env,
        stdinMode: usePty ? "pipe-open" : "pipe-closed",
      };
    },
    runShellCommand(command) {
      return runContainerSandboxShellCommand({
        engine: params.engine,
        containerName: params.containerName,
        podmanTarget: params.podmanTarget,
        ...command,
      });
    },
  };
}

async function runContainerSandboxShellCommand(
  params: {
    engine: SandboxContainerEngine;
    containerName: string;
    podmanTarget?: SandboxContainerEngineTarget;
  } & SandboxBackendCommandParams,
) {
  await validateSandboxContainerEngineTarget(params.engine, params.podmanTarget);
  const dockerArgs = [
    "exec",
    "-i",
    params.containerName,
    "sh",
    "-c",
    params.script,
    "openclaw-sandbox-fs",
  ];
  if (params.args?.length) {
    dockerArgs.push(...params.args);
  }
  return execContainerRaw(params.engine, dockerArgs, {
    input: params.stdin,
    allowFailure: params.allowFailure,
    signal: params.signal,
  });
}

export function runDockerSandboxShellCommand(
  params: {
    containerName: string;
  } & SandboxBackendCommandParams,
) {
  return runContainerSandboxShellCommand({
    engine: DOCKER_SANDBOX_ENGINE,
    ...params,
  });
}

function createContainerSandboxBackendManager(
  engine: SandboxContainerEngine,
): SandboxBackendManager {
  const resolvePodmanTarget = (entry: SandboxRegistryEntry) => {
    if (engine.id !== "podman") {
      return undefined;
    }
    if (entry.backendTarget) {
      return entry.backendTarget;
    }
    throw Object.assign(
      new Error(
        `Podman sandbox runtime ${entry.containerName} has no recorded engine target. Remove that unshipped runtime manually before managing it.`,
      ),
      { code: "INVALID_CONFIG" },
    );
  };
  return {
    async prepareAttachmentIngress({ runtimeId, sessionKey, workspaceDir }) {
      const target =
        engine.id === "podman" ? (await resolvePodmanSandboxRuntimeInfo()).target : undefined;
      await validateSandboxContainerEngineTarget(engine, target);
      const runtimeEngine = target ? bindPodmanSandboxEngine(target) : engine;
      const inspected = await execContainer(runtimeEngine, ["inspect", "-f", "{{.Id}}", runtimeId]);
      const ingressRoot = path.posix.join(
        "/tmp/openclaw-attachment-ingress",
        hashTextSha256(sessionKey).slice(0, 32),
      );
      const locator = readContainerFsCleanupLocator(
        {
          version: 1,
          backend: engine.id,
          containerId: inspected.stdout.trim(),
          ingressRoot,
          ...(target ? { target } : {}),
        },
        engine.id,
      );
      return {
        workspaceDir,
        sandboxAttachmentsRootDir: path.posix.join(ingressRoot, ".openclaw", "attachments"),
        sandboxFsBridge: createContainerCleanupFsBridge({
          engine: runtimeEngine,
          locator,
          runtimeId,
          workspaceDir,
        }),
        cleanupLocator: locator,
        cleanupContainerWorkspaceDir: ingressRoot,
      };
    },
    async createFsCleanupBridge({
      runtimeId,
      workspaceDir,
      containerWorkspaceDir,
      locator: rawLocator,
    }) {
      const locator = readContainerFsCleanupLocator(rawLocator, engine.id);
      if (path.posix.normalize(containerWorkspaceDir) !== locator.ingressRoot) {
        return null;
      }
      await validateSandboxContainerEngineTarget(engine, locator.target);
      const runtimeEngine = locator.target ? bindPodmanSandboxEngine(locator.target) : engine;
      return createContainerCleanupFsBridge({
        engine: runtimeEngine,
        locator,
        runtimeId,
        workspaceDir,
        allowMissingRuntimeOnRemove: true,
      });
    },
    async describeRuntime({ entry, config, agentId }) {
      const podmanTarget = resolvePodmanTarget(entry);
      await validateSandboxContainerEngineTarget(engine, podmanTarget);
      const runtimeEngine = podmanTarget ? bindPodmanSandboxEngine(podmanTarget) : engine;
      const state = await containerState(runtimeEngine, entry.containerName);
      let actualConfigLabel = entry.image;
      let actualImageId: string | undefined;
      if (state.exists) {
        try {
          const result = await execContainer(
            runtimeEngine,
            [
              "inspect",
              "-f",
              runtimeEngine.id === "podman" ? "{{.ImageName}}\t{{.Image}}" : "{{.Config.Image}}",
              entry.containerName,
            ],
            { allowFailure: true },
          );
          if (result.code === 0) {
            const inspected = result.stdout.trim();
            if (runtimeEngine.id === "podman") {
              const [imageName, imageId] = inspected.split("\t", 2);
              actualConfigLabel = imageName || actualConfigLabel;
              actualImageId = imageId;
            } else {
              actualConfigLabel = inspected || actualConfigLabel;
            }
          }
        } catch {
          // ignore inspect failures
        }
      }
      const configuredImage = resolveConfiguredDockerRuntimeImage({
        config,
        agentId,
        configLabelKind: entry.configLabelKind,
      });
      let configLabelMatch = actualConfigLabel === configuredImage;
      if (runtimeEngine.id === "podman" && !configLabelMatch && actualImageId) {
        try {
          const result = await execContainer(
            runtimeEngine,
            ["image", "inspect", "-f", "{{.Id}}", configuredImage],
            { allowFailure: true },
          );
          if (result.code === 0) {
            const normalizeImageId = (value: string) => value.trim().replace(/^sha256:/u, "");
            configLabelMatch = normalizeImageId(actualImageId) === normalizeImageId(result.stdout);
          }
        } catch {
          // Keep the name comparison result when image inspection fails.
        }
      }
      return {
        running: state.running,
        actualConfigLabel,
        configLabelMatch,
      };
    },
    async removeRuntime({ entry }) {
      const podmanTarget = resolvePodmanTarget(entry);
      await validateSandboxContainerEngineTarget(engine, podmanTarget);
      const runtimeEngine = podmanTarget ? bindPodmanSandboxEngine(podmanTarget) : engine;
      const result = await execContainer(runtimeEngine, ["rm", "-f", entry.containerName], {
        allowFailure: true,
      });
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
        if (/No such (container|object)|does not exist/iu.test(detail)) {
          return;
        }
        throw new Error(
          `Failed to remove ${engine.displayName} sandbox runtime ${entry.containerName}: ${detail}`,
        );
      }
    },
  };
}

export const dockerSandboxBackendManager =
  createContainerSandboxBackendManager(DOCKER_SANDBOX_ENGINE);
export const podmanSandboxBackendManager =
  createContainerSandboxBackendManager(PODMAN_SANDBOX_ENGINE);
