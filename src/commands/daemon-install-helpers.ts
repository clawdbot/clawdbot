import os from "node:os";
import path from "node:path";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { formatCliCommand } from "../cli/command-format.js";
import { collectDurableServiceEnvVars } from "../config/state-dir-dotenv.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveGatewayLaunchAgentLabel } from "../daemon/constants.js";
import { resolveGatewayStateDir } from "../daemon/paths.js";
import {
  OPENCLAW_WRAPPER_ENV_KEY,
  resolveGatewayProgramArguments,
  resolveOpenClawWrapperPath,
} from "../daemon/program-args.js";
import { buildServiceEnvironment } from "../daemon/service-env.js";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";
import {
  emitDaemonInstallRuntimeWarning,
  resolveDaemonInstallRuntimeInputs,
  resolveDaemonNodeBinDir,
} from "./daemon-install-plan.shared.js";
import type { DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

export { resolveGatewayDevMode } from "./daemon-install-plan.shared.js";

export type GatewayInstallPlan = {
  programArguments: string[];
  workingDirectory?: string;
  environment: Record<string, string | undefined>;
};

const MANAGED_SERVICE_ENV_KEYS_VAR = "OPENCLAW_SERVICE_MANAGED_ENV_KEYS";

let daemonInstallAuthProfileSourceRuntimePromise:
  | Promise<typeof import("./daemon-install-auth-profiles-source.runtime.js")>
  | undefined;
let daemonInstallAuthProfileStoreRuntimePromise:
  | Promise<typeof import("./daemon-install-auth-profiles-store.runtime.js")>
  | undefined;

function loadDaemonInstallAuthProfileSourceRuntime() {
  daemonInstallAuthProfileSourceRuntimePromise ??=
    import("./daemon-install-auth-profiles-source.runtime.js");
  return daemonInstallAuthProfileSourceRuntimePromise;
}

function loadDaemonInstallAuthProfileStoreRuntime() {
  daemonInstallAuthProfileStoreRuntimePromise ??=
    import("./daemon-install-auth-profiles-store.runtime.js");
  return daemonInstallAuthProfileStoreRuntimePromise;
}

async function collectAuthProfileServiceEnvVars(params: {
  env: Record<string, string | undefined>;
  authStore?: AuthProfileStore;
  warn?: DaemonInstallWarnFn;
}): Promise<Record<string, string>> {
  let authStore = params.authStore;
  if (!authStore) {
    // Keep the daemon install cold path cheap when there is no auth store to read.
    const { hasAnyAuthProfileStoreSource } = await loadDaemonInstallAuthProfileSourceRuntime();
    if (!hasAnyAuthProfileStoreSource()) {
      return {};
    }
    const { loadAuthProfileStoreForSecretsRuntime } =
      await loadDaemonInstallAuthProfileStoreRuntime();
    authStore = loadAuthProfileStoreForSecretsRuntime();
  }
  if (!authStore) {
    return {};
  }
  const entries: Record<string, string> = {};

  for (const credential of Object.values(authStore.profiles)) {
    const ref =
      credential.type === "api_key"
        ? credential.keyRef
        : credential.type === "token"
          ? credential.tokenRef
          : undefined;
    if (!ref || ref.source !== "env") {
      continue;
    }
    const key = normalizeEnvVarKey(ref.id, { portable: true });
    if (!key) {
      continue;
    }
    if (isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key)) {
      params.warn?.(
        `Auth profile env ref "${key}" blocked by host-env security policy`,
        "Auth profile",
      );
      continue;
    }
    const value = params.env[key]?.trim();
    if (!value) {
      continue;
    }
    entries[key] = value;
  }

  return entries;
}

function mergeServicePath(
  nextPath: string | undefined,
  existingPath: string | undefined,
  tmpDir: string | undefined,
): string | undefined {
  const segments: string[] = [];
  const seen = new Set<string>();
  const normalizedTmpDirs = [tmpDir, os.tmpdir()]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));
  const shouldPreservePathSegment = (segment: string) => {
    if (!path.isAbsolute(segment)) {
      return false;
    }
    const resolved = path.resolve(segment);
    return !normalizedTmpDirs.some(
      (tmpRoot) => resolved === tmpRoot || resolved.startsWith(`${tmpRoot}${path.sep}`),
    );
  };
  const addPath = (value: string | undefined, options?: { preserve?: boolean }) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      return;
    }
    for (const segment of value.split(path.delimiter)) {
      const trimmed = segment.trim();
      if (options?.preserve && !shouldPreservePathSegment(trimmed)) {
        continue;
      }
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      segments.push(trimmed);
    }
  };
  addPath(nextPath);
  addPath(existingPath, { preserve: true });
  return segments.length > 0 ? segments.join(path.delimiter) : undefined;
}

function readManagedServiceEnvKeys(
  existingEnvironment: Record<string, string | undefined> | undefined,
): Set<string> {
  if (!existingEnvironment) {
    return new Set();
  }
  for (const [rawKey, rawValue] of Object.entries(existingEnvironment)) {
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key || key.toUpperCase() !== MANAGED_SERVICE_ENV_KEYS_VAR) {
      continue;
    }
    return new Set(
      rawValue?.split(",").flatMap((value) => {
        const normalized = normalizeEnvVarKey(value, { portable: true });
        return normalized ? [normalized.toUpperCase()] : [];
      }) ?? [],
    );
  }
  return new Set();
}

function formatManagedServiceEnvKeys(
  managedEnvironment: Record<string, string | undefined>,
): string | undefined {
  const keys = Object.keys(managedEnvironment)
    .flatMap((key) => {
      const normalized = normalizeEnvVarKey(key, { portable: true });
      return normalized ? [normalized.toUpperCase()] : [];
    })
    .toSorted();
  return keys.length > 0 ? keys.join(",") : undefined;
}

function collectPreservedExistingServiceEnvVars(
  existingEnvironment: Record<string, string | undefined> | undefined,
  managedServiceEnvKeys: Set<string>,
): Record<string, string | undefined> {
  if (!existingEnvironment) {
    return {};
  }
  const preserved: Record<string, string | undefined> = {};
  for (const [rawKey, rawValue] of Object.entries(existingEnvironment)) {
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key) {
      continue;
    }
    const upper = key.toUpperCase();
    if (
      upper === "HOME" ||
      upper === "PATH" ||
      upper === "TMPDIR" ||
      upper.startsWith("OPENCLAW_")
    ) {
      continue;
    }
    if (managedServiceEnvKeys.has(upper)) {
      continue;
    }
    if (isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key)) {
      continue;
    }
    const value = rawValue?.trim();
    if (!value) {
      continue;
    }
    preserved[key] = value;
  }
  return preserved;
}

function resolveGatewayInstallWorkingDirectory(params: {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  workingDirectory: string | undefined;
}): string | undefined {
  if (params.workingDirectory) {
    return params.workingDirectory;
  }
  if (params.platform !== "darwin") {
    return undefined;
  }
  return resolveGatewayStateDir(params.env);
}

async function buildGatewayInstallEnvironment(params: {
  env: Record<string, string | undefined>;
  config?: OpenClawConfig;
  authStore?: AuthProfileStore;
  warn?: DaemonInstallWarnFn;
  serviceEnvironment: Record<string, string | undefined>;
  existingEnvironment?: Record<string, string | undefined>;
}): Promise<Record<string, string | undefined>> {
  const managedEnvironment: Record<string, string | undefined> = {
    ...collectDurableServiceEnvVars({
      env: params.env,
      config: params.config,
    }),
    ...(await collectAuthProfileServiceEnvVars({
      env: params.env,
      authStore: params.authStore,
      warn: params.warn,
    })),
  };
  const environment: Record<string, string | undefined> = {
    ...collectPreservedExistingServiceEnvVars(
      params.existingEnvironment,
      readManagedServiceEnvKeys(params.existingEnvironment),
    ),
    ...managedEnvironment,
  };
  Object.assign(environment, params.serviceEnvironment);
  const mergedPath = mergeServicePath(
    params.serviceEnvironment.PATH,
    params.existingEnvironment?.PATH,
    params.serviceEnvironment.TMPDIR,
  );
  if (mergedPath) {
    environment.PATH = mergedPath;
  }
  const managedServiceEnvKeys = formatManagedServiceEnvKeys(managedEnvironment);
  if (managedServiceEnvKeys) {
    environment[MANAGED_SERVICE_ENV_KEYS_VAR] = managedServiceEnvKeys;
  }
  return environment;
}

export async function buildGatewayInstallPlan(params: {
  env: Record<string, string | undefined>;
  port: number;
  runtime: GatewayDaemonRuntime;
  existingEnvironment?: Record<string, string | undefined>;
  devMode?: boolean;
  nodePath?: string;
  wrapperPath?: string;
  platform?: NodeJS.Platform;
  warn?: DaemonInstallWarnFn;
  /** Full config to extract env vars from (env vars + inline env keys). */
  config?: OpenClawConfig;
  authStore?: AuthProfileStore;
}): Promise<GatewayInstallPlan> {
  const platform = params.platform ?? process.platform;
  const { devMode, nodePath } = await resolveDaemonInstallRuntimeInputs({
    env: params.env,
    runtime: params.runtime,
    devMode: params.devMode,
    nodePath: params.nodePath,
  });
  const wrapperPath = await resolveOpenClawWrapperPath(
    params.wrapperPath ?? params.env[OPENCLAW_WRAPPER_ENV_KEY],
  );
  const serviceInputEnv: Record<string, string | undefined> = wrapperPath
    ? { ...params.env, [OPENCLAW_WRAPPER_ENV_KEY]: wrapperPath }
    : params.env;
  const { programArguments, workingDirectory } = await resolveGatewayProgramArguments({
    port: params.port,
    dev: devMode,
    runtime: params.runtime,
    nodePath,
    wrapperPath,
  });
  await emitDaemonInstallRuntimeWarning({
    env: params.env,
    runtime: params.runtime,
    programArguments,
    warn: params.warn,
    title: "Gateway runtime",
  });
  const serviceEnvironment = buildServiceEnvironment({
    env: serviceInputEnv,
    port: params.port,
    launchdLabel:
      platform === "darwin"
        ? resolveGatewayLaunchAgentLabel(serviceInputEnv.OPENCLAW_PROFILE)
        : undefined,
    platform,
    extraPathDirs: resolveDaemonNodeBinDir(nodePath),
  });

  // Lowest to highest: preserved custom vars, durable config, auth env refs, generated service env.
  return {
    programArguments,
    workingDirectory: resolveGatewayInstallWorkingDirectory({
      env: serviceInputEnv,
      platform,
      workingDirectory,
    }),
    environment: await buildGatewayInstallEnvironment({
      env: serviceInputEnv,
      config: params.config,
      authStore: params.authStore,
      warn: params.warn,
      serviceEnvironment,
      existingEnvironment: params.existingEnvironment,
    }),
  };
}

export function gatewayInstallErrorHint(platform = process.platform): string {
  return platform === "win32"
    ? "Tip: native Windows now falls back to a per-user Startup-folder login item when Scheduled Task creation is denied; if install still fails, rerun from an elevated PowerShell or skip service install."
    : `Tip: rerun \`${formatCliCommand("openclaw gateway install")}\` after fixing the error.`;
}
