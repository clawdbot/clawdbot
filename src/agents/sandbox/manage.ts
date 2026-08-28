/**
 * CLI-facing sandbox management helpers.
 *
 * Lists and removes registered runtime and browser containers using backend manager status.
 */
import { getRuntimeConfig } from "../../config/config.js";
import { getSandboxBackendManager } from "./backend.js";
import { stopCachedBrowserBridgesForContainer } from "./browser-bridges.js";
import { dockerSandboxBackendManager } from "./docker-backend.js";
import {
  readBrowserRegistry,
  readBrowserRegistryEntry,
  readRegistryEntry,
  readRegistry,
  removeBrowserRegistryEntry,
  removeBrowserRegistryEntryIfUnchanged,
  removeRegistryEntry,
  removeRegistryEntryIfUnchanged,
  type SandboxBrowserRegistryEntry,
  type SandboxRegistryEntry,
} from "./registry.js";
import {
  resolveSandboxRuntimeActivityKey,
  withSandboxRuntimeMutations,
} from "./runtime-activity.js";
import { withSandboxScopeLocks } from "./scope-lock.js";
import { resolveSandboxAgentId } from "./shared.js";

export type SandboxContainerInfo = SandboxRegistryEntry & {
  running: boolean;
  imageMatch: boolean;
};

export type SandboxBrowserInfo = SandboxBrowserRegistryEntry & {
  running: boolean;
  imageMatch: boolean;
};

function toBrowserDockerRuntimeEntry(entry: SandboxBrowserRegistryEntry): SandboxRegistryEntry {
  return {
    ...entry,
    backendId: "docker",
    runtimeLabel: entry.containerName,
    configLabelKind: "BrowserImage",
  };
}

/** Lists registered sandbox containers with live backend status and config-label match state. */
export async function listSandboxContainers(): Promise<SandboxContainerInfo[]> {
  const config = getRuntimeConfig();
  const registry = await readRegistry();
  const results: SandboxContainerInfo[] = [];

  for (const entry of registry.entries) {
    const backendId = entry.backendId ?? "docker";
    const manager = getSandboxBackendManager(backendId);
    if (!manager) {
      results.push({
        ...entry,
        running: false,
        imageMatch: true,
      });
      continue;
    }
    const agentId = resolveSandboxAgentId(entry.sessionKey);
    const runtime = await manager.describeRuntime({
      entry,
      config,
      agentId,
    });
    results.push({
      ...entry,
      image: runtime.actualConfigLabel ?? entry.image,
      running: runtime.running,
      imageMatch: runtime.configLabelMatch,
    });
  }

  return results;
}

/** Lists registered browser sandbox containers with live Docker status. */
export async function listSandboxBrowsers(): Promise<SandboxBrowserInfo[]> {
  const config = getRuntimeConfig();
  const registry = await readBrowserRegistry();
  const results: SandboxBrowserInfo[] = [];

  for (const entry of registry.entries) {
    const agentId = resolveSandboxAgentId(entry.sessionKey);
    const runtime = await dockerSandboxBackendManager.describeRuntime({
      entry: toBrowserDockerRuntimeEntry(entry),
      config,
      agentId,
    });
    results.push({
      ...entry,
      image: runtime.actualConfigLabel ?? entry.image,
      running: runtime.running,
      imageMatch: runtime.configLabelMatch,
    });
  }

  return results;
}

/** Removes one sandbox container from its backend and registry. */
export async function removeSandboxContainer(containerName: string): Promise<void> {
  const config = getRuntimeConfig();
  const registry = await readRegistry();
  const entry = registry.entries.find((item) => item.containerName === containerName);
  if (entry) {
    const backendId = entry.backendId ?? "docker";
    const manager = getSandboxBackendManager(backendId);
    if (!manager) {
      throw new Error(
        `Sandbox backend "${backendId}" is unavailable; enable its plugin before removing this runtime.`,
      );
    }
    let removed = false;
    await withSandboxScopeLocks([entry.sessionKey], async () => {
      await withSandboxRuntimeMutations(
        [
          resolveSandboxRuntimeActivityKey(
            backendId,
            entry.containerName,
            entry.backendTarget?.key,
          ),
        ],
        async (lifecycle) => {
          const current = await readRegistryEntry(containerName);
          if (!current || current.registryGeneration !== entry.registryGeneration) {
            return;
          }
          await manager.removeRuntime({
            entry: current,
            config,
            agentId: resolveSandboxAgentId(current.sessionKey),
          });
          lifecycle.retire();
          await removeRegistryEntryIfUnchanged(current);
          removed = true;
        },
      );
    });
    if (!removed) {
      return;
    }
  }
  if (!entry) {
    await removeRegistryEntry(containerName);
  }
}

/** Removes one browser sandbox container, registry entry, and any in-process bridge server. */
export async function removeSandboxBrowserContainer(containerName: string): Promise<void> {
  const config = getRuntimeConfig();
  const registry = await readBrowserRegistry();
  const entry = registry.entries.find((item) => item.containerName === containerName);
  if (entry) {
    await withSandboxScopeLocks([entry.sessionKey], async () => {
      await withSandboxRuntimeMutations(
        [resolveSandboxRuntimeActivityKey("docker", entry.containerName)],
        async (lifecycle) => {
          const current = await readBrowserRegistryEntry(containerName);
          if (!current || current.registryGeneration !== entry.registryGeneration) {
            return;
          }
          await stopCachedBrowserBridgesForContainer(containerName);
          await dockerSandboxBackendManager.removeRuntime({
            entry: toBrowserDockerRuntimeEntry(current),
            config,
          });
          lifecycle.retire();
          await removeBrowserRegistryEntryIfUnchanged(current);
        },
      );
    });
  } else {
    await stopCachedBrowserBridgesForContainer(containerName);
    await removeBrowserRegistryEntry(containerName);
  }
}
