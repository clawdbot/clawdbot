import fs from "node:fs";

/**
 * Detect whether the current process is running inside a container
 * (Docker, Podman, or Kubernetes).
 *
 * Uses two reliable heuristics:
 * - Presence of common container sentinel files.
 * - Container-related entries in /proc/1/cgroup.
 *
 * The result is cached after the first call so filesystem access happens at
 * most once per process lifetime.
 */
let containerEnvironmentCache: boolean | undefined;

export function isContainerEnvironment(): boolean {
  if (containerEnvironmentCache !== undefined) {
    return containerEnvironmentCache;
  }
  containerEnvironmentCache = detectContainerEnvironment();
  return containerEnvironmentCache;
}

function detectContainerEnvironment(): boolean {
  if (process.env.FLY_MACHINE_ID?.trim() && process.env.FLY_APP_NAME?.trim()) {
    return true;
  }

  for (const sentinelPath of ["/.dockerenv", "/run/.containerenv", "/var/run/.containerenv"]) {
    try {
      fs.accessSync(sentinelPath, fs.constants.F_OK);
      return true;
    } catch {
      // Not present; try the next signal.
    }
  }

  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    if (
      /\/docker\/|cri-containerd-[0-9a-f]|containerd\/[0-9a-f]{64}|\/kubepods[/.]|\blxc\b/.test(
        cgroup,
      )
    ) {
      return true;
    }
  } catch {
    // /proc may not exist on non-Linux platforms.
  }

  return false;
}

/** @internal test helper */
export function __resetContainerEnvironmentCacheForTest(): void {
  containerEnvironmentCache = undefined;
}
