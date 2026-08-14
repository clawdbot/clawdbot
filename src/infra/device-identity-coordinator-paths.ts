import path from "node:path";
import { resolveGatewayLockDir } from "../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";

function resolveDeviceIdentityCoordinatorFilename(databasePath: string): string {
  const canonicalPath = resolvePathViaExistingAncestorSync(databasePath);
  const databaseHash = sha256HexPrefixCore(canonicalPath, 8);
  return `device-identity.${databaseHash}.lock.sqlite`;
}

export function resolveDeviceIdentityCoordinatorPath(
  databasePath: string,
  lockDir: string,
): string {
  return path.join(lockDir, resolveDeviceIdentityCoordinatorFilename(databasePath));
}

export function resolveDeviceIdentityCoordinatorPaths(params: {
  databasePath: string;
  stateDir: string;
  temporaryDirectory: string;
  uid: number | undefined;
}): string[] {
  const suffix = params.uid === undefined ? "openclaw" : `openclaw-${params.uid}`;
  const filename = resolveDeviceIdentityCoordinatorFilename(params.databasePath);
  const canonicalStateDir = resolvePathViaExistingAncestorSync(params.stateDir);
  const orderedPaths = [
    path.join(path.resolve(params.temporaryDirectory), suffix, filename),
    path.join(resolveGatewayLockDir(canonicalStateDir, params.uid), filename),
  ];
  const seen = new Set<string>();
  return orderedPaths.filter((coordinatorPath) => {
    const canonicalPath = resolvePathViaExistingAncestorSync(coordinatorPath);
    if (seen.has(canonicalPath)) {
      return false;
    }
    seen.add(canonicalPath);
    return true;
  });
}
