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
  uid: number | undefined;
}): string[] {
  // The process-temp bridge existed only in v2026.8.1-beta.2; current runtimes
  // use the state-local identity lock behind the shared lifecycle coordinator.
  const canonicalStateDir = resolvePathViaExistingAncestorSync(params.stateDir);
  return [
    path.join(
      resolveGatewayLockDir(canonicalStateDir, params.uid),
      resolveDeviceIdentityCoordinatorFilename(params.databasePath),
    ),
  ];
}
