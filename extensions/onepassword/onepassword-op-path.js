import path from "node:path";
import { pluginSecretRefSetup } from "openclaw/plugin-sdk/secret-ref-runtime";

function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

const { isTrustedPathPolicyError, resolveTrustedExecutablePath } = pluginSecretRefSetup;

export class OnePasswordCliPathTrustError extends Error {}

export async function resolveTrustedOnePasswordCli(options = {}) {
  const configuredPath = options.configuredPath?.trim();
  if (configuredPath && !path.isAbsolute(configuredPath)) {
    throw new Error(`1Password CLI path must be absolute: ${configuredPath}`);
  }
  const executable = process.platform === "win32" ? "op.exe" : "op";
  const candidates = configuredPath
    ? [configuredPath]
    : (options.pathEnv ?? process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.resolve(directory, executable));
  let unsafeError;
  for (const candidate of candidates) {
    try {
      return await resolveTrustedExecutablePath(candidate);
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
        continue;
      }
      if (!isTrustedPathPolicyError(error)) {
        throw error;
      }
      unsafeError = new OnePasswordCliPathTrustError(
        `Refusing unsafe 1Password CLI path "${candidate}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
      if (configuredPath) {
        throw unsafeError;
      }
    }
  }
  if (unsafeError) {
    throw unsafeError;
  }
  return undefined;
}
