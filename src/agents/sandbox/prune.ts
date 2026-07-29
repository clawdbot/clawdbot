/**
 * Sandbox registry pruning.
 *
 * Removes stale runtime containers and browser bridges on a best-effort schedule.
 */
import { getRuntimeConfig } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import { asDateTimestampMs } from "../../shared/number-coercion.js";
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
import type { SandboxConfig } from "./types.js";

let lastPruneAtMs = 0;

type PruneableRegistryEntry = Pick<
  SandboxRegistryEntry,
  "containerName" | "backendId" | "createdAtMs" | "lastUsedAtMs"
>;

function shouldPruneSandboxEntry(cfg: SandboxConfig, now: number, entry: PruneableRegistryEntry) {
  const idleHours = cfg.prune.idleHours;
  const maxAgeDays = cfg.prune.maxAgeDays;
  if (idleHours === 0 && maxAgeDays === 0) {
    return false;
  }
  const nowMs = asDateTimestampMs(now) ?? 0;
  const lastUsedAtMs = asDateTimestampMs(entry.lastUsedAtMs) ?? 0;
  const createdAtMs = asDateTimestampMs(entry.createdAtMs) ?? 0;
  const idleMs = nowMs - lastUsedAtMs;
  const ageMs = nowMs - createdAtMs;
  return (
    (idleHours > 0 && idleMs > idleHours * 60 * 60 * 1000) ||
    (maxAgeDays > 0 && ageMs > maxAgeDays * 24 * 60 * 60 * 1000)
  );
}

/** Removes expired registry entries and their backing runtime resources. */
async function pruneSandboxRegistryEntries<TEntry extends SandboxRegistryEntry>(params: {
  cfg: SandboxConfig;
  read: () => Promise<{ entries: TEntry[] }>;
  remove: (containerName: string) => Promise<void>;
  removeRuntime: (entry: TEntry) => Promise<void>;
  beforeRemove?: (entry: TEntry) => Promise<void>;
}) {
  const now = Date.now();
  if (params.cfg.prune.idleHours === 0 && params.cfg.prune.maxAgeDays === 0) {
    return;
  }
  const registry = await params.read();
  for (const entry of registry.entries) {
    if (!shouldPruneSandboxEntry(params.cfg, now, entry)) {
      continue;
    }
    try {
      await params.beforeRemove?.(entry);
      await params.removeRuntime(entry);
      await params.remove(entry.containerName);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error);
      defaultRuntime.error?.(
        `Sandbox prune failed to remove ${entry.containerName}: ${message ?? "unknown error"}`,
      );
    }
  }
}

/** Prunes ordinary sandbox runtime containers from the configured backend manager. */
async function pruneSandboxContainers(cfg: SandboxConfig) {
  const config = getRuntimeConfig();
  await pruneSandboxRegistryEntries<SandboxRegistryEntry>({
    cfg,
    read: readRegistry,
    remove: removeRegistryEntry,
    removeRuntime: async (entry) => {
      const manager = getSandboxBackendManager(entry.backendId ?? "docker");
      await manager?.removeRuntime({
        entry,
        config,
      });
    },
  });
}

/** Prunes browser bridge containers and closes matching in-process bridge servers. */
async function pruneSandboxBrowsers(cfg: SandboxConfig) {
  const config = getRuntimeConfig();
  await pruneSandboxRegistryEntries<
    SandboxBrowserRegistryEntry & {
      backendId?: string;
      runtimeLabel?: string;
      configLabelKind?: string;
    }
  >({
    cfg,
    read: readBrowserRegistry,
    remove: removeBrowserRegistryEntry,
    removeRuntime: async (entry) => {
      await dockerSandboxBackendManager.removeRuntime({
        entry: {
          ...entry,
          backendId: "docker",
          runtimeLabel: entry.containerName,
          configLabelKind: "Image",
        },
        config,
      });
    },
    beforeRemove: async (entry) => {
      await stopCachedBrowserBridgesForContainer(entry.containerName);
    },
  });
}

/** Runs sandbox pruning at most once per throttle window. */
export async function maybePruneSandboxes(cfg: SandboxConfig) {
  const now = Date.now();
  if (now - lastPruneAtMs < 5 * 60 * 1000) {
    return;
  }
  lastPruneAtMs = now;
  try {
    await pruneSandboxContainers(cfg);
    await pruneSandboxBrowsers(cfg);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error);
    defaultRuntime.error?.(`Sandbox prune failed: ${message ?? "unknown error"}`);
  }
}
