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

type OsFacts = Omit<OsSummary, "label"> & {
  productVersion?: string;
  runtimeLabel?: string;
  summary?: OsSummary;
};
const cachedOsFactsByKey = new Map<string, OsFacts>();

function resolveOsFacts(): OsFacts {
  const platform = os.platform();
  const release = os.release();
  const arch = os.arch();
  // Preserve the raw OS tuple identity: a product-version update alone does not
  // invalidate metadata already observed during this process.
  const cacheKey = `${platform}\0${release}\0${arch}`;
  let facts = cachedOsFactsByKey.get(cacheKey);
  if (!facts) {
    facts = { platform, arch, release };
    cachedOsFactsByKey.set(cacheKey, facts);
  }
  return facts;
}

// Startup and first-turn probes share one timeout and kill policy. spawnSync
// still waits for the child to exit after sending the kill signal.
export const DARWIN_SYSTEM_PROBE_TIMEOUT_MS = 5_000;

function readDarwinProductVersion(facts: OsFacts): string {
  if (facts.productVersion !== undefined) {
    return facts.productVersion;
  }
  const res = spawnSync("sw_vers", ["-productVersion"], {
    encoding: "utf-8",
    timeout: DARWIN_SYSTEM_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const out = normalizeOptionalString(res.stdout) ?? "";
  // Share only observed product versions; an early failed probe must not prevent
  // a later consumer from succeeding. Each label keeps its own first fallback.
  if (out) {
    facts.productVersion = out;
  }
  return out || os.release();
}

/**
 * Resolve Darwin product version via sw_vers. Kernel and product versions diverge
 * starting with macOS 26, so keep the product fact separate from the raw release.
 */
export function resolveDarwinProductVersion(): string {
  return readDarwinProductVersion(resolveOsFacts());
}

/**
 * Resolves the OS string used in agent runtime prompt metadata, without the
 * architecture suffix. The prompt renderer appends `arch` separately. Off
 * Darwin this preserves the historical `${os.type()} ${os.release()}` shape.
 */
export function resolveRuntimeOsLabel(): string {
  const facts = resolveOsFacts();
  return (facts.runtimeLabel ??=
    facts.platform === "darwin"
      ? `macOS ${readDarwinProductVersion(facts)}`
      : `${os.type()} ${facts.release}`);
}

/** Resolves a compact OS label for diagnostics, logs, and environment summaries. */
export function resolveOsSummary(): OsSummary {
  const facts = resolveOsFacts();
  if (!facts.summary) {
    const { platform, arch, release } = facts;
    const label =
      platform === "darwin"
        ? `macos ${readDarwinProductVersion(facts)}`
        : `${platform === "win32" ? "windows" : platform} ${release}`;
    facts.summary = { platform, arch, release, label: `${label} (${arch})` };
  }
  return facts.summary;
}
