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
  readRegistry,
  removeBrowserRegistryEntry,
  removeRegistryEntry,
  type SandboxBrowserRegistryEntry,
  type SandboxRegistryEntry,
} from "./registry.js";
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
    const manager = getSandboxBackendManager(entry.backendId ?? "docker");
    await manager?.removeRuntime({
      entry,
      config,
      agentId: resolveSandboxAgentId(entry.sessionKey),
    });
  }
  await removeRegistryEntry(containerName);
}

/** Removes one browser sandbox container, registry entry, and any in-process bridge server. */
export async function removeSandboxBrowserContainer(containerName: string): Promise<void> {
  const config = getRuntimeConfig();
  const registry = await readBrowserRegistry();
  const entry = registry.entries.find((item) => item.containerName === containerName);
  await stopCachedBrowserBridgesForContainer(containerName);
  if (entry) {
    await dockerSandboxBackendManager.removeRuntime({
      entry: toBrowserDockerRuntimeEntry(entry),
      config,
    });
  }
  await removeBrowserRegistryEntry(containerName);
}
