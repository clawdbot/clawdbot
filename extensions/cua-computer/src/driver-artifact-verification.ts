import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DRIVER_PACKAGE = "@trycua/cua-driver";

type SupportedArtifactPlatform =
  | "linux-arm64-gnu"
  | "linux-x64-gnu"
  | "win32-arm64-msvc"
  | "win32-x64-msvc";

type DriverArtifactRecord = {
  files: Record<string, string>;
};

type CuaDriverManifest = {
  dependencies?: Record<string, string>;
  cuaDriverArtifacts?: Partial<Record<SupportedArtifactPlatform, DriverArtifactRecord>>;
};

type CuaDriverArtifactDiagnosticCode =
  | "COMPUTER_DRIVER_DIGEST_MISMATCH"
  | "COMPUTER_DRIVER_MANIFEST_INVALID"
  | "COMPUTER_DRIVER_PACKAGE_MISSING"
  | "COMPUTER_DRIVER_PLATFORM_UNSUPPORTED"
  | "COMPUTER_DRIVER_VERSION_MISMATCH";

export type CuaDriverArtifactVerification =
  | { ok: true; applicable: false }
  | { ok: true; applicable: true; version: string; platformPackage: string }
  | {
      ok: false;
      code: CuaDriverArtifactDiagnosticCode;
      diagnostic: string;
      fixHint: string;
    };

type CuaDriverArtifactInspectionOptions = {
  platform: NodeJS.Platform;
  arch: string;
  linuxLibc?: "gnu" | "musl";
  pluginManifest: unknown;
  resolvePackageJson: (packageName: string) => string | undefined;
};

function failure(
  code: CuaDriverArtifactDiagnosticCode,
  message: string,
  fixHint: string,
): CuaDriverArtifactVerification {
  return { ok: false, code, diagnostic: `${code}: ${message} Fix: ${fixHint}`, fixHint };
}

function resolveArtifactPlatform(
  platform: NodeJS.Platform,
  arch: string,
  linuxLibc: "gnu" | "musl" | undefined,
):
  | { kind: "applicable"; key: SupportedArtifactPlatform }
  | { kind: "not-applicable" }
  | { kind: "unsupported"; host: string } {
  if (platform === "linux") {
    if (linuxLibc !== "gnu" || (arch !== "arm64" && arch !== "x64")) {
      return { kind: "unsupported", host: `${platform}/${arch}/${linuxLibc ?? "unknown-libc"}` };
    }
    return { kind: "applicable", key: `linux-${arch}-gnu` };
  }
  if (platform === "win32") {
    if (arch !== "arm64" && arch !== "x64") {
      return { kind: "unsupported", host: `${platform}/${arch}` };
    }
    return { kind: "applicable", key: `win32-${arch}-msvc` };
  }
  return { kind: "not-applicable" };
}

function readJson(pathname: string): unknown {
  return JSON.parse(fs.readFileSync(pathname, "utf8"));
}

export function readPackageIdentity(pathname: string): { name?: string; version?: string } {
  const value = readJson(pathname);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  return {
    name: typeof record.name === "string" ? record.name : undefined,
    version: typeof record.version === "string" ? record.version : undefined,
  };
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function loadArtifactRecord(
  manifestValue: unknown,
  key: SupportedArtifactPlatform,
): { version: string; artifact: DriverArtifactRecord } | undefined {
  const value = manifestValue as CuaDriverManifest;
  const version = value.dependencies?.[DRIVER_PACKAGE];
  const artifact = value.cuaDriverArtifacts?.[key];
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(version) ||
    !artifact ||
    !artifact.files ||
    Object.keys(artifact.files).length === 0 ||
    Object.entries(artifact.files).some(
      ([filename, digest]) => path.basename(filename) !== filename || !isSha256(digest),
    )
  ) {
    return undefined;
  }
  return { version, artifact };
}

function hashFile(pathname: string): string {
  return createHash("sha256").update(fs.readFileSync(pathname)).digest("hex");
}

export function inspectCuaDriverArtifacts(
  options: CuaDriverArtifactInspectionOptions,
): CuaDriverArtifactVerification {
  const selected = resolveArtifactPlatform(options.platform, options.arch, options.linuxLibc);
  if (selected.kind === "not-applicable") {
    return { ok: true, applicable: false };
  }
  if (selected.kind === "unsupported") {
    const fixHint = "Run this node host on Windows x64/ARM64 or glibc-based Linux x64/ARM64.";
    return failure(
      "COMPUTER_DRIVER_PLATFORM_UNSUPPORTED",
      `the pinned CUA Driver SDK has no native package for ${selected.host}.`,
      fixHint,
    );
  }

  let accepted: ReturnType<typeof loadArtifactRecord>;
  try {
    accepted = loadArtifactRecord(options.pluginManifest, selected.key);
  } catch {
    accepted = undefined;
  }
  if (!accepted) {
    const fixHint = "Reinstall OpenClaw from a complete official package.";
    return failure(
      "COMPUTER_DRIVER_MANIFEST_INVALID",
      `the cua-computer artifact record for ${selected.key} is missing or invalid.`,
      fixHint,
    );
  }

  const platformPackage = `${DRIVER_PACKAGE}-${selected.key}`;
  const sdkManifestPath = options.resolvePackageJson(DRIVER_PACKAGE);
  const platformManifestPath = options.resolvePackageJson(platformPackage);
  if (!sdkManifestPath || !platformManifestPath) {
    const missing = sdkManifestPath ? platformPackage : DRIVER_PACKAGE;
    const fixHint = `Reinstall OpenClaw on this node host so ${DRIVER_PACKAGE} ${accepted.version} and its native platform package are installed together.`;
    return failure(
      "COMPUTER_DRIVER_PACKAGE_MISSING",
      `${missing} ${accepted.version} is not installed.`,
      fixHint,
    );
  }

  let sdkIdentity: ReturnType<typeof readPackageIdentity>;
  let platformIdentity: ReturnType<typeof readPackageIdentity>;
  try {
    sdkIdentity = readPackageIdentity(sdkManifestPath);
    platformIdentity = readPackageIdentity(platformManifestPath);
  } catch {
    const fixHint =
      "Reinstall OpenClaw on this node host; do not repair native package files by hand.";
    return failure(
      "COMPUTER_DRIVER_PACKAGE_MISSING",
      "the resolved CUA Driver package metadata cannot be read.",
      fixHint,
    );
  }
  if (
    sdkIdentity.name !== DRIVER_PACKAGE ||
    platformIdentity.name !== platformPackage ||
    sdkIdentity.version !== accepted.version ||
    platformIdentity.version !== accepted.version
  ) {
    const observed = `${sdkIdentity.name ?? "unknown"}@${sdkIdentity.version ?? "unknown"} + ${platformIdentity.name ?? "unknown"}@${platformIdentity.version ?? "unknown"}`;
    const fixHint = `Reinstall or update OpenClaw on this node host so both CUA Driver packages resolve to ${accepted.version}.`;
    return failure(
      "COMPUTER_DRIVER_VERSION_MISMATCH",
      `expected ${DRIVER_PACKAGE} and ${platformPackage} ${accepted.version}, resolved ${observed}.`,
      fixHint,
    );
  }

  const packageDir = path.dirname(platformManifestPath);
  for (const [filename, expectedDigest] of Object.entries(accepted.artifact.files).toSorted(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const pathname = path.join(packageDir, filename);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(pathname);
    } catch {
      const fixHint = `Reinstall OpenClaw on this node host to restore ${platformPackage} ${accepted.version}.`;
      return failure(
        "COMPUTER_DRIVER_PACKAGE_MISSING",
        `${platformPackage} is missing ${filename}.`,
        fixHint,
      );
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      const fixHint = "Reinstall OpenClaw; the native driver files must be regular package files.";
      return failure(
        "COMPUTER_DRIVER_DIGEST_MISMATCH",
        `${platformPackage}/${filename} is not a regular file.`,
        fixHint,
      );
    }
    let actualDigest: string;
    try {
      actualDigest = hashFile(pathname);
    } catch {
      const fixHint = `Reinstall OpenClaw on this node host to restore ${platformPackage} ${accepted.version}.`;
      return failure(
        "COMPUTER_DRIVER_PACKAGE_MISSING",
        `${platformPackage}/${filename} cannot be read.`,
        fixHint,
      );
    }
    if (actualDigest !== expectedDigest) {
      const fixHint =
        "Reinstall OpenClaw; do not run or replace the mismatched native package files.";
      return failure(
        "COMPUTER_DRIVER_DIGEST_MISMATCH",
        `${platformPackage}/${filename} does not match the accepted ${accepted.version} digest.`,
        fixHint,
      );
    }
  }

  return { ok: true, applicable: true, version: accepted.version, platformPackage };
}
