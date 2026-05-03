import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { formatCliCommand } from "../cli/command-format.js";
import { collectDurableServiceEnvVars } from "../config/state-dir-dotenv.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveGatewayLaunchAgentLabel } from "../daemon/constants.js";
import { resolveGatewayStateDir } from "../daemon/paths.js";
import {
  OPENCLAW_WRAPPER_ENV_KEY,
  resolveGatewayProgramArguments,
  resolveOpenClawWrapperPath,
} from "../daemon/program-args.js";
import { buildServiceEnvironment } from "../daemon/service-env.js";
import {
  formatManagedServiceEnvKeys,
  readManagedServiceEnvKeysFromEnvironment,
  writeManagedServiceEnvKeysToEnvironment,
} from "../daemon/service-managed-env.js";
import { isNonMinimalServicePathEntry } from "../daemon/service-path-policy.js";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";
import { discoverConfigSecretTargets } from "../secrets/target-registry.js";
import {
  emitDaemonInstallRuntimeWarning,
  resolveDaemonInstallRuntimeInputs,
  resolveDaemonNodeBinDir,
} from "./daemon-install-plan.shared.js";
import type { DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

export { resolveGatewayDevMode } from "./daemon-install-plan.shared.js";

type GatewayInstallPlan = {
  programArguments: string[];
  workingDirectory?: string;
  environment: Record<string, string | undefined>;
};

let daemonInstallAuthProfileSourceRuntimePromise:
  | Promise<typeof import("./daemon-install-auth-profiles-source.runtime.js")>
  | undefined;
let daemonInstallAuthProfileStoreRuntimePromise:
  | Promise<typeof import("./daemon-install-auth-profiles-store.runtime.js")>
  | undefined;

const NON_PERSISTED_CONFIG_SECRET_ENV_TARGET_IDS = new Set([
  "gateway.auth.password",
  "gateway.auth.token",
]);

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

function collectConfigSecretRefServiceEnvVars(params: {
  env: Record<string, string | undefined>;
  config?: OpenClawConfig;
  durableEnvironment: Record<string, string | undefined>;
  warn?: DaemonInstallWarnFn;
}): Record<string, string> {
  if (!params.config) {
    return {};
  }
  const entries: Record<string, string> = {};
  for (const target of discoverConfigSecretTargets(params.config)) {
    if (!target.entry.includeInPlan) {
      continue;
    }
    if (NON_PERSISTED_CONFIG_SECRET_ENV_TARGET_IDS.has(target.entry.id)) {
      continue;
    }
    const { ref } = resolveSecretInputRef({
      value: target.value,
      refValue: target.refValue,
      defaults: params.config.secrets?.defaults,
    });
    if (!ref || ref.source !== "env") {
      continue;
    }
    const key = normalizeEnvVarKey(ref.id, { portable: true });
    if (!key) {
      params.warn?.(
        `Config SecretRef env id "${ref.id}" is not portable and was not added to the service environment`,
        "Config SecretRef",
      );
      continue;
    }
    if (isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key)) {
      params.warn?.(
        `Config SecretRef env ref "${key}" blocked by host-env security policy`,
        "Config SecretRef",
      );
      continue;
    }
    if (Object.hasOwn(params.durableEnvironment, key)) {
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

function collectExecSecretRefPassEnvServiceEnvVars(params: {
  env: Record<string, string | undefined>;
  config?: OpenClawConfig;
  durableEnvironment: Record<string, string | undefined>;
  warn?: DaemonInstallWarnFn;
}): Record<string, string> {
  if (!params.config) {
    return {};
  }
  const entries: Record<string, string> = {};
  for (const target of discoverConfigSecretTargets(params.config)) {
    if (!target.entry.includeInPlan) {
      continue;
    }
    const { ref } = resolveSecretInputRef({
      value: target.value,
      refValue: target.refValue,
      defaults: params.config.secrets?.defaults,
    });
    if (!ref || ref.source !== "exec") {
      continue;
    }
    const provider = params.config.secrets?.providers?.[ref.provider];
    if (!provider || provider.source !== "exec") {
      continue;
    }
    for (const rawKey of provider.passEnv ?? []) {
      const key = normalizeEnvVarKey(rawKey, { portable: true });
      if (!key) {
        params.warn?.(
          `Exec SecretRef passEnv id "${rawKey}" is not portable and was not added to the service environment`,
          "Config SecretRef",
        );
        continue;
      }
      if (isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key)) {
        params.warn?.(
          `Exec SecretRef passEnv ref "${key}" blocked by host-env security policy`,
          "Config SecretRef",
        );
        continue;
      }
      if (Object.hasOwn(params.durableEnvironment, key)) {
        continue;
      }
      const value = params.env[key]?.trim();
      if (!value) {
        continue;
      }
      entries[key] = value;
    }
  }
  return entries;
}

function mergeServicePath(
  nextPath: string | undefined,
  existingPath: string | undefined,
  tmpDir: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const segments: string[] = [];
  const seen = new Set<string>();
  const normalizedTmpDirs = [tmpDir, os.tmpdir()]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));
  const realTmpDirs = normalizedTmpDirs.map((tmpRoot) => {
    try {
      return path.normalize(fs.realpathSync.native(tmpRoot));
    } catch {
      return tmpRoot;
    }
  });
  const isSameOrChildPath = (candidate: string, parent: string) =>
    candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
  const isUnsafeProcPath = (candidate: string) =>
    candidate === `${path.sep}proc` || candidate.startsWith(`${path.sep}proc${path.sep}`);
  const realpathExistingPath = (candidate: string): string | undefined => {
    const parts: string[] = [];
    let current = candidate;
    while (current && current !== path.dirname(current)) {
      try {
        const realCurrent = path.normalize(fs.realpathSync.native(current));
        return path.normalize(path.join(realCurrent, ...parts.toReversed()));
      } catch {
        parts.push(path.basename(current));
        current = path.dirname(current);
      }
    }
    try {
      return path.normalize(path.join(fs.realpathSync.native(current), ...parts.toReversed()));
    } catch {
      return undefined;
    }
  };
  const normalizePreservedPathSegment = (segment: string): string | undefined => {
    if (!path.isAbsolute(segment)) {
      return undefined;
    }
    const normalized = path.normalize(segment);
    if (isUnsafeProcPath(normalized)) {
      return undefined;
    }
    const cwd = path.resolve(process.cwd());
    if (isSameOrChildPath(normalized, cwd)) {
      return undefined;
    }
    try {
      const realSegment = realpathExistingPath(normalized);
      const realCwd = path.normalize(fs.realpathSync.native(cwd));
      if (realSegment && isSameOrChildPath(realSegment, realCwd)) {
        return undefined;
      }
    } catch {
      // Legacy PATH entries may no longer exist; keep filtering best-effort.
    }
    return normalized;
  };
  const shouldPreserveNormalizedPathSegment = (segment: string) => {
    if (isNonMinimalServicePathEntry(segment, platform)) {
      return false;
    }
    const resolved = path.resolve(segment);
    const realResolved = realpathExistingPath(resolved) ?? resolved;
    return ![...normalizedTmpDirs, ...realTmpDirs].some(
      (tmpRoot) => isSameOrChildPath(resolved, tmpRoot) || isSameOrChildPath(realResolved, tmpRoot),
    );
  };
  const addPath = (value: string | undefined, options?: { preserve?: boolean }) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      return;
    }
    for (const segment of value.split(path.delimiter)) {
      const trimmed = segment.trim();
      const candidate = options?.preserve ? normalizePreservedPathSegment(trimmed) : trimmed;
      if (options?.preserve && (!candidate || !shouldPreserveNormalizedPathSegment(candidate))) {
        continue;
      }
      if (!candidate || seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      segments.push(candidate);
    }
  };
  addPath(nextPath);
  if (platform !== "darwin") {
    addPath(existingPath, { preserve: true });
  }
  return segments.length > 0 ? segments.join(path.delimiter) : undefined;
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
  platform: NodeJS.Platform;
}): Promise<Record<string, string | undefined>> {
  const durableEnvironment = collectDurableServiceEnvVars({
    env: params.env,
    config: params.config,
  });
  const configSecretRefEnvironment = collectConfigSecretRefServiceEnvVars({
    env: params.env,
    config: params.config,
    durableEnvironment,
    warn: params.warn,
  });
  const execSecretRefPassEnvEnvironment = collectExecSecretRefPassEnvServiceEnvVars({
    env: params.env,
    config: params.config,
    durableEnvironment,
    warn: params.warn,
  });
  const authProfileEnvironment = await collectAuthProfileServiceEnvVars({
    env: params.env,
    authStore: params.authStore,
    warn: params.warn,
  });
  const environment: Record<string, string | undefined> = {
    ...collectPreservedExistingServiceEnvVars(
      params.existingEnvironment,
      readManagedServiceEnvKeysFromEnvironment(params.existingEnvironment),
    ),
    ...durableEnvironment,
    ...configSecretRefEnvironment,
    ...execSecretRefPassEnvEnvironment,
    ...authProfileEnvironment,
  };
  const managedServiceEnvKeys = formatManagedServiceEnvKeys(durableEnvironment, {
    omitKeys: Object.keys(params.serviceEnvironment),
  });
  writeManagedServiceEnvKeysToEnvironment(environment, managedServiceEnvKeys);
  Object.assign(environment, params.serviceEnvironment);
  const mergedPath = mergeServicePath(
    params.serviceEnvironment.PATH,
    params.existingEnvironment?.PATH,
    params.serviceEnvironment.TMPDIR,
    params.platform,
  );
  if (mergedPath) {
    environment.PATH = mergedPath;
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
      platform,
    }),
  };
}

export function gatewayInstallErrorHint(platform = process.platform): string {
  return platform === "win32"
    ? "Tip: native Windows now falls back to a per-user Startup-folder login item when Scheduled Task creation is denied; if install still fails, rerun from an elevated PowerShell or skip service install."
    : `Tip: rerun \`${formatCliCommand("openclaw gateway install")}\` after fixing the error.`;
}
