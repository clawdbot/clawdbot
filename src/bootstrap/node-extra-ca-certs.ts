// Resolves additional CA certificate settings for Node child processes.
import fs from "node:fs";
import { matchesVersionManagerPath } from "../shared/version-manager-path.js";

const LINUX_CA_BUNDLE_PATHS = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
] as const;

export type EnvMap = Record<string, string | undefined>;
type AccessSyncFn = (path: string, mode?: number) => void;

export function resolveAutoNodeExtraCaCerts(
  params: {
    env?: EnvMap;
    platform?: NodeJS.Platform;
    execPath?: string;
    accessSync?: AccessSyncFn;
  } = {},
): string | undefined {
  const env = params.env ?? process.env;
  if (env.NODE_EXTRA_CA_CERTS?.trim()) {
    return undefined;
  }

  const platform = params.platform ?? process.platform;
  const execPath = params.execPath ?? process.execPath;
  if (platform !== "linux") {
    return undefined;
  }

  // Version-manager Node may not inherit system CAs; supply NODE_EXTRA_CA_CERTS.
  const isVersionManagerRuntime =
    Boolean(env.NVM_DIR?.trim()) || matchesVersionManagerPath(execPath, "linux-ca");
  if (!isVersionManagerRuntime) {
    return undefined;
  }

  const accessSync = params.accessSync ?? fs.accessSync.bind(fs);
  for (const candidate of LINUX_CA_BUNDLE_PATHS) {
    try {
      accessSync(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}
