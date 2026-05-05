import fsSync from "node:fs";
import path from "node:path";
import { openBoundaryFileSync } from "./boundary-file-read.js";

export function expectedIntegrityForUpdate(
  spec: string | undefined,
  integrity: string | undefined,
): string | undefined {
  if (!integrity || !spec) {
    return undefined;
  }
  const value = spec.trim();
  if (!value) {
    return undefined;
  }
  const at = value.lastIndexOf("@");
  if (at <= 0 || at >= value.length - 1) {
    return undefined;
  }
  const version = value.slice(at + 1).trim();
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    return undefined;
  }
  return integrity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInstalledPackageManifest(dir: string): Record<string, unknown> | undefined {
  const manifestPath = path.join(dir, "package.json");
  const opened = openBoundaryFileSync({
    absolutePath: manifestPath,
    rootPath: dir,
    boundaryLabel: "installed package directory",
  });
  if (!opened.ok) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fsSync.readFileSync(opened.fd, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  } finally {
    fsSync.closeSync(opened.fd);
  }
}

export async function readInstalledPackageVersion(dir: string): Promise<string | undefined> {
  const manifest = readInstalledPackageManifest(dir);
  return typeof manifest?.version === "string" ? manifest.version : undefined;
}

export function installedPackageNeedsOpenClawPeerLinkRepair(dir: string): boolean {
  const manifest = readInstalledPackageManifest(dir);
  const peerDependencies = isRecord(manifest?.peerDependencies) ? manifest.peerDependencies : {};
  if (!Object.hasOwn(peerDependencies, "openclaw")) {
    return false;
  }

  try {
    fsSync.statSync(path.join(dir, "node_modules", "openclaw"));
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}
