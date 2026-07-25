import { existsSync } from "node:fs";
import path from "node:path";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import type { NativeHookRelayEvent, NativeHookRelayProvider } from "./native-hook-relay-types.js";
import {
  normalizeOptionalPositiveInteger,
  normalizePositiveInteger,
  shellQuoteArgs,
} from "./native-hook-relay-utils.js";

export const DEFAULT_RELAY_TIMEOUT_MS = 5_000;
const NATIVE_HOOK_RELAY_MAX_OLD_SPACE_MIB = 64;

function resolveNativeHookRelayNicePrefix(value: number | false | undefined): string[] {
  if (process.platform === "win32" || value === false || value === undefined) {
    return [];
  }
  const nice = normalizePositiveInteger(value, 0);
  if (nice <= 0) {
    return [];
  }
  return ["nice", "-n", String(nice)];
}

export function resolveNativeHookRelayCommandTimeoutMs(
  configuredTimeoutMs: number | undefined,
  overrideTimeoutMs: number | undefined,
): number | undefined {
  const configured = normalizeOptionalPositiveInteger(configuredTimeoutMs);
  const override = normalizeOptionalPositiveInteger(overrideTimeoutMs);
  if (configured === undefined) {
    return override;
  }
  if (override === undefined) {
    return configured;
  }
  return Math.min(configured, override);
}

export function buildNativeHookRelayCommand(params: {
  provider: NativeHookRelayProvider;
  relayId: string;
  generation?: string;
  event: NativeHookRelayEvent;
  preToolUseUnavailable?: "noop";
  timeoutMs?: number;
  executable?: string;
  nice?: number | false;
  nodeExecutable?: string;
}): string {
  return buildNativeHookRelayCommandWithStateDatabase(params);
}

export function buildNativeHookRelayCommandWithStateDatabase(params: {
  provider: NativeHookRelayProvider;
  relayId: string;
  stateDbPath?: string;
  stateSchemaVersion?: number;
  generation?: string;
  event: NativeHookRelayEvent;
  preToolUseUnavailable?: "noop";
  timeoutMs?: number;
  executable?: string;
  nice?: number | false;
  nodeExecutable?: string;
}): string {
  const timeoutMs = normalizePositiveInteger(params.timeoutMs, DEFAULT_RELAY_TIMEOUT_MS);
  const cliPathOverride = process.env.OPENCLAW_CLI_PATH?.trim();
  const fastExecutable =
    params.executable === undefined && !cliPathOverride && params.stateDbPath
      ? resolveOpenClawNativeHookRelayExecutable()
      : undefined;
  const executable = fastExecutable ?? params.executable ?? resolveOpenClawCliExecutable();
  const argv = fastExecutable
    ? [
        params.nodeExecutable ?? process.execPath,
        `--max-old-space-size=${NATIVE_HOOK_RELAY_MAX_OLD_SPACE_MIB}`,
        "--disable-warning=ExperimentalWarning",
        fastExecutable,
      ]
    : executable === "openclaw"
      ? ["openclaw"]
      : [params.nodeExecutable ?? process.execPath, executable];
  const nicePrefix = resolveNativeHookRelayNicePrefix(params.nice);
  const command = shellQuoteArgs([
    ...nicePrefix,
    ...argv,
    ...(fastExecutable ? [] : ["hooks", "relay"]),
    "--provider",
    params.provider,
    "--relay-id",
    params.relayId,
    ...(params.stateDbPath ? ["--state-db", params.stateDbPath] : []),
    ...(fastExecutable && params.stateSchemaVersion !== undefined
      ? ["--state-schema-version", String(params.stateSchemaVersion)]
      : []),
    ...(params.generation ? ["--generation", params.generation] : []),
    "--event",
    params.event,
    ...(params.event === "pre_tool_use" && params.preToolUseUnavailable
      ? ["--pre-tool-use-unavailable", params.preToolUseUnavailable]
      : []),
    "--timeout",
    String(timeoutMs),
  ]);
  // Codex kills the shell process when a hook times out. Replace that shell so
  // the timeout targets this relay instead of leaving its Node child behind.
  return process.platform === "win32" ? command : `exec ${command}`;
}

function resolveOpenClawNativeHookRelayExecutable(): string | undefined {
  const packageRoot = resolveOpenClawPackageRootSync({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (!packageRoot) {
    return undefined;
  }
  const candidate = path.join(packageRoot, "dist", "native-hook-relay-entry.js");
  return existsSync(candidate) ? candidate : undefined;
}

function resolveOpenClawCliExecutable(): string {
  const envPath = process.env.OPENCLAW_CLI_PATH?.trim();
  if (envPath && existsSync(envPath)) {
    return envPath;
  }
  const packageRoot = resolveOpenClawPackageRootSync({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (packageRoot) {
    for (const candidate of [
      path.join(packageRoot, "openclaw.mjs"),
      path.join(packageRoot, "dist", "entry.js"),
      path.join(packageRoot, "scripts", "run-node.mjs"),
    ]) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  const argvEntry = process.argv[1];
  if (argvEntry) {
    const resolved = path.resolve(argvEntry);
    if (existsSync(resolved)) {
      return resolved;
    }
  }
  throw new Error("Cannot resolve OpenClaw CLI executable path for native hook relay");
}
