// Collects operating system summary facts for diagnostics.
import { spawnSync } from "node:child_process";
import os from "node:os";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

type OsSummary = {
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  label: string;
};

const cachedOsSummaryByKey = new Map<string, OsSummary>();
const cachedRuntimeOsLabelByKey = new Map<string, string>();

// These synchronous probes run during both gateway startup and first-turn prompt
// preparation, so keep one hard bound for every macOS system metadata lookup.
export const DARWIN_SYSTEM_PROBE_TIMEOUT_MS = 5_000;

/**
 * Resolve Darwin product version via sw_vers.
 *
 * Darwin kernel version and macOS product version are no longer in sync starting
 * with macOS 26 (Tahoe), where Darwin 25.x maps to macOS 26.x instead of the
 * historical Darwin N → macOS N+9 formula. Prefer sw_vers over os.release() on
 * macOS to avoid stale mappings.
 */
export function resolveDarwinProductVersion(): string {
  const res = spawnSync("sw_vers", ["-productVersion"], {
    encoding: "utf-8",
    timeout: DARWIN_SYSTEM_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const out = normalizeOptionalString(res.stdout) ?? "";
  return out || os.release();
}

/**
 * Resolves the OS string used in agent runtime prompt metadata, without the
 * architecture suffix. The prompt renderer appends `arch` separately. Off
 * Darwin this preserves the historical `${os.type()} ${os.release()}` shape.
 */
export function resolveRuntimeOsLabel(): string {
  const platform = os.platform();
  const release = os.release();
  const arch = os.arch();
  const cacheKey = `${platform}\0${release}\0${arch}`;
  const cached = cachedRuntimeOsLabelByKey.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const label =
    platform === "darwin" ? `macOS ${resolveDarwinProductVersion()}` : `${os.type()} ${release}`;
  cachedRuntimeOsLabelByKey.set(cacheKey, label);
  return label;
}

/** Resolves a compact OS label for diagnostics, logs, and environment summaries. */
export function resolveOsSummary(): OsSummary {
  const platform = os.platform();
  const rawRelease = os.release();
  const arch = os.arch();
  // Cache key uses raw os.release() (stable per kernel) so sw_vers drift across
  // minor macOS updates does not invalidate the cache.
  const cacheKey = `${platform}\0${rawRelease}\0${arch}`;
  const cached = cachedOsSummaryByKey.get(cacheKey);
  if (cached) {
    return cached;
  }
  const release = rawRelease;
  const label = (() => {
    if (platform === "darwin") {
      const productVersion = resolveDarwinProductVersion();
      return `macos ${productVersion} (${arch})`;
    }
    if (platform === "win32") {
      return `windows ${release} (${arch})`;
    }
    return `${platform} ${release} (${arch})`;
  })();
  const summary = { platform, arch, release, label };
  cachedOsSummaryByKey.set(cacheKey, summary);
  return summary;
}
