import fs from "node:fs";
import path from "node:path";
import { replaceFileAtomic } from "../infra/replace-file.js";
import { isRecord } from "../utils.js";
import { stampConfigWriteMetadata } from "./io.meta.js";
import { hashConfigRaw, parseConfigJson5, resolveConfigSnapshotHash } from "./io.read-helpers.js";
import type { ConfigWriteOptions } from "./io.types.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import { resolveStateDir } from "./paths.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

export function assertBaseSnapshotStillCurrent(
  snapshot: ConfigFileSnapshot,
  configPath: string,
  ioFs: typeof fs,
): void {
  if (snapshot.path !== configPath) {
    throw new ConfigMutationConflictError("config path changed since last load", {
      currentHash: null,
      retryable: false,
    });
  }
  // Unreadable snapshots cannot be re-read; destructive guards reject them later.
  if (snapshot.readError) {
    return;
  }
  const expectedHash = resolveConfigSnapshotHash(snapshot);
  let currentRaw: string | null = null;
  let currentExists = true;
  try {
    currentRaw = ioFs.readFileSync(configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
    currentExists = false;
  }
  const currentHash = currentExists ? hashConfigRaw(currentRaw) : null;
  if (
    currentExists !== snapshot.exists ||
    (currentExists && expectedHash !== null && currentHash !== expectedHash)
  ) {
    throw new ConfigMutationConflictError("config changed since last load", { currentHash });
  }
}

export async function tightenStateDirPermissionsIfNeeded(params: {
  configPath: string;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  fsModule: typeof fs;
}): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const stateDir = resolveStateDir(params.env, params.homedir);
  const configDir = path.dirname(params.configPath);
  if (path.resolve(configDir) !== path.resolve(stateDir)) {
    return;
  }
  try {
    const stat = await params.fsModule.promises.stat(configDir);
    if ((stat.mode & 0o077) !== 0) {
      await params.fsModule.promises.chmod(configDir, 0o700);
    }
  } catch {
    // Best-effort hardening only; the config write must still proceed.
  }
}

export async function rollbackConfigFileWriteIfUnchanged(params: {
  configPath: string;
  previousSnapshot: ConfigFileSnapshot;
  committedHash: string;
  fsModule: typeof fs;
}): Promise<boolean> {
  let currentRaw: string | null = null;
  try {
    currentRaw = await params.fsModule.promises.readFile(params.configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
  if (hashConfigRaw(currentRaw) !== params.committedHash) {
    return false;
  }
  if (params.previousSnapshot.exists && typeof params.previousSnapshot.raw === "string") {
    await replaceFileAtomic({
      filePath: params.configPath,
      content: params.previousSnapshot.raw,
      dirMode: 0o700,
      mode: 0o600,
      tempPrefix: path.basename(params.configPath),
      copyFallbackOnPermissionError: true,
      fileSystem: params.fsModule,
    });
    return true;
  }
  if (params.previousSnapshot.exists) {
    return false;
  }
  try {
    await params.fsModule.promises.unlink(params.configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
  return true;
}

function normalizeStatNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeStatId(value: number | bigint | null | undefined): string | null {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

export function resolveConfigStatMetadata(stat: fs.Stats | null): {
  dev: string | null;
  ino: string | null;
  mode: number | null;
  nlink: number | null;
  uid: number | null;
  gid: number | null;
} {
  return {
    dev: normalizeStatId(stat?.dev ?? null),
    ino: normalizeStatId(stat?.ino ?? null),
    mode: normalizeStatNumber(stat ? stat.mode & 0o777 : null),
    nlink: normalizeStatNumber(stat?.nlink ?? null),
    uid: normalizeStatNumber(stat?.uid ?? null),
    gid: normalizeStatNumber(stat?.gid ?? null),
  };
}

export function resolveConfigWriteSuspiciousReasons(params: {
  existsBefore: boolean;
  unreadableBefore: boolean;
  sizeBaselineBytes: number | null;
  nextBytes: number | null;
  hasMetaBefore: boolean;
  gatewayModeBefore: string | null;
  gatewayModeAfter: string | null;
}): string[] {
  const reasons: string[] = [];
  if (!params.existsBefore) {
    return reasons;
  }
  if (params.unreadableBefore) {
    reasons.push("unreadable-config-before-write");
  }
  if (
    typeof params.sizeBaselineBytes === "number" &&
    typeof params.nextBytes === "number" &&
    params.sizeBaselineBytes >= 512 &&
    params.nextBytes < Math.floor(params.sizeBaselineBytes * 0.5)
  ) {
    reasons.push(`size-drop:${params.sizeBaselineBytes}->${params.nextBytes}`);
  }
  if (!params.hasMetaBefore) {
    reasons.push("missing-meta-before-write");
  }
  if (params.gatewayModeBefore && !params.gatewayModeAfter) {
    reasons.push("gateway-mode-removed");
  }
  return reasons;
}

export function resolveConfigWriteBlockingReasons(
  suspicious: string[],
  options: Pick<ConfigWriteOptions, "allowConfigSizeDrop"> = {},
): string[] {
  return suspicious.filter(
    (reason) =>
      reason === "unreadable-config-before-write" ||
      (reason.startsWith("size-drop:") && options.allowConfigSizeDrop !== true) ||
      reason === "gateway-mode-removed",
  );
}

export function formatConfigArtifactTimestamp(ts: string): string {
  return ts.replaceAll(":", "-").replaceAll(".", "-");
}

export function stampConfigVersion(
  cfg: OpenClawConfig,
  version?: string,
  previousConfig?: unknown,
): OpenClawConfig {
  return stampConfigWriteMetadata(cfg, new Date().toISOString(), version, previousConfig);
}

export function resolveConfigSizeBaselineBytes(params: {
  raw: string | null;
  json5: { parse: (value: string) => unknown };
  lastTouchedVersionOverride?: string;
}): number | null {
  if (params.raw === null) {
    return null;
  }
  const rawBytes = Buffer.byteLength(params.raw, "utf-8");
  const parsed = parseConfigJson5(params.raw, params.json5);
  if (!parsed.ok || !isRecord(parsed.parsed)) {
    return rawBytes;
  }
  const canonical = JSON.stringify(
    stampConfigVersion(parsed.parsed as OpenClawConfig, params.lastTouchedVersionOverride),
    null,
    2,
  )
    .trimEnd()
    .concat("\n");
  return Buffer.byteLength(canonical, "utf-8");
}
