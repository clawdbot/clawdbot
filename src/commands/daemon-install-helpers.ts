// Gateway daemon install plan builder, including service env and SecretRef passthrough policy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { formatCliCommand } from "../cli/command-format.js";
import { collectDurableServiceEnvVarSources } from "../config/state-dir-dotenv.js";
import type { OpenClawConfig } from "../config/types.js";
import { coerceSecretRef, resolveSecretInputRef, type SecretRef } from "../config/types.secrets.js";
import { resolveGatewayLaunchAgentLabel } from "../daemon/constants.js";
import { resolveGatewayStateDir, resolveGatewayTaskScriptPath } from "../daemon/paths.js";
import {
  OPENCLAW_WRAPPER_ENV_KEY,
  resolveGatewayProgramArguments,
  resolveOpenClawWrapperPath,
} from "../daemon/program-args.js";
import {
  addServiceEnvPlanEntries,
  compactServiceEnvPlanValueSources,
  createMutableServiceEnvPlan,
} from "../daemon/service-env-plan.js";
import { applyManagedServiceEnvRenderPolicy } from "../daemon/service-env-render-policy.js";
import { buildServiceEnvironment } from "../daemon/service-env.js";
import {
  formatManagedServiceEnvKeys,
  hasEnvironmentFileSource,
  readEnvironmentValueSource,
  readManagedServiceEnvKeysFromEnvironment,
} from "../daemon/service-managed-env.js";
import { isNonMinimalServicePathEntry } from "../daemon/service-path-policy.js";
import type { GatewayServiceEnvironmentValueSource } from "../daemon/service-types.js";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRegistry,
} from "../plugins/manifest-registry.js";
import {
  isPluginIntegrationSecretProviderConfig,
  resolveSecretProviderIntegrationConfig,
} from "../secrets/provider-integrations.js";
import { collectPluginConfigAssignments } from "../secrets/runtime-config-collectors-plugins.js";
import { createResolverContext } from "../secrets/runtime-shared.js";
import { discoverConfigSecretTargets } from "../secrets/target-registry.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import {
  emitDaemonInstallRuntimeWarning,
  resolveDaemonInstallRuntimeInputs,
  resolveDaemonServicePathDirs,
} from "./daemon-install-plan.shared.js";
import type { DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

type GatewayInstallPlan = {
  programArguments: string[];
  workingDirectory?: string;
  environment: Record<string, string | undefined>;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
};

const NON_PERSISTED_CONFIG_SECRET_ENV_TARGET_IDS = new Set([
  "gateway.auth.password",
  "gateway.auth.token",
]);
const EXEC_SECRET_REF_PASS_ENV_ALLOWED_OVERRIDE_ONLY_KEYS = new Set(["HOME"]);

function configContainsSecretRef(config: OpenClawConfig | undefined): boolean {
  if (!config) {
    return false;
  }
  const pending: unknown[] = [config];
  const seen = new Set<object>();
  const defaults = config.secrets?.defaults;
  while (pending.length > 0) {
    const value = pending.pop();
    if (coerceSecretRef(value, defaults)) {
      return true;
    }
    if (!value || typeof value !== "object" || seen.has(value)) {
      continue;
    }
    seen.add(value);
    pending.push(...Object.values(value));
  }
  return false;
}

function isBlockedExecSecretRefPassEnvKey(key: string): boolean {
  if (isDangerousHostEnvVarName(key)) {
    return true;
  }
  if (!isDangerousHostEnvOverrideVarName(key)) {
    return false;
  }
  return !EXEC_SECRET_REF_PASS_ENV_ALLOWED_OVERRIDE_ONLY_KEYS.has(key.toUpperCase());
}

const loadDaemonInstallAuthProfileSourceRuntime = createLazyPromise(
  () => import("./daemon-install-auth-profiles-source.runtime.js"),
  { cacheRejections: true },
);

const loadDaemonInstallAuthProfileStoreRuntime = createLazyPromise(
  () => import("./daemon-install-auth-profiles-store.runtime.js"),
  { cacheRejections: true },
);

async function resolveAuthProfileStoreForServiceEnv(
  authStore: AuthProfileStore | undefined,
): Promise<AuthProfileStore | undefined> {
  if (authStore) {
    return authStore;
  }
  // Keep the daemon install cold path cheap when there is no auth store to read.
  const { hasAnyAuthProfileStoreSource } = await loadDaemonInstallAuthProfileSourceRuntime();
  if (!hasAnyAuthProfileStoreSource()) {
    return undefined;
  }
  const { loadAuthProfileStoreForSecretsRuntime } =
    await loadDaemonInstallAuthProfileStoreRuntime();
  return loadAuthProfileStoreForSecretsRuntime();
}

function collectAuthProfileSecretRefs(authStore: AuthProfileStore | undefined): SecretRef[] {
  if (!authStore) {
    return [];
  }
  const refs: SecretRef[] = [];
  for (const credential of Object.values(authStore.profiles)) {
    const ref =
      credential.type === "api_key"
        ? credential.keyRef
        : credential.type === "token"
          ? credential.tokenRef
          : undefined;
    if (ref) {
      refs.push(ref);
    }
  }
  return refs;
}

function collectAuthProfileServiceEnvVars(params: {
  env: Record<string, string | undefined>;
  authStore?: AuthProfileStore;
  warn?: DaemonInstallWarnFn;
}): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const ref of collectAuthProfileSecretRefs(params.authStore)) {
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

type ExecSecretRefPassEnvSource = {
  ref: SecretRef;
  warningTitle: "Config SecretRef" | "Auth profile" | "Plugin config SecretRef";
};

function collectConfigSecretRefServiceEnvSources(params: {
  env: Record<string, string | undefined>;
  config?: OpenClawConfig;
  configContainsSecretRef: boolean;
  stateDirDotEnvEnvironment: Record<string, string | undefined>;
  warn?: DaemonInstallWarnFn;
}): { keys: string[]; environment: Record<string, string> } {
  const keys = new Set<string>();
  const environment: Record<string, string> = {};
  if (!params.config || !params.configContainsSecretRef) {
    return { keys: [], environment };
  }
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
    keys.add(key.toUpperCase());
    if (Object.hasOwn(params.stateDirDotEnvEnvironment, key)) {
      continue;
    }
    const value = params.env[key]?.trim();
    if (!value) {
      continue;
    }
    environment[key] = value;
  }
  return { keys: [...keys], environment };
}

function collectExecSecretRefPassEnvServiceEnvVars(params: {
  env: Record<string, string | undefined>;
  config?: OpenClawConfig;
  configContainsSecretRef: boolean;
  authStore?: AuthProfileStore;
  durableEnvironment: Record<string, string | undefined>;
  warn?: DaemonInstallWarnFn;
}): Record<string, string> {
  if (!params.config) {
    return {};
  }
  const entries: Record<string, string> = {};
  let manifestRegistry: Pick<PluginManifestRegistry, "plugins"> | undefined;
  const sources: ExecSecretRefPassEnvSource[] = [];
  if (params.configContainsSecretRef) {
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
      sources.push({ ref, warningTitle: "Config SecretRef" });
    }
  }
  for (const ref of collectAuthProfileSecretRefs(params.authStore)) {
    if (ref.source === "exec") {
      sources.push({ ref, warningTitle: "Auth profile" });
    }
  }
  if (params.configContainsSecretRef) {
    for (const ref of collectPluginConfigSecretRefs({
      env: params.env,
      config: params.config,
    })) {
      if (ref.source === "exec") {
        sources.push({ ref, warningTitle: "Plugin config SecretRef" });
      }
    }
  }
  for (const { ref, warningTitle } of sources) {
    const provider = params.config.secrets?.providers?.[ref.provider];
    if (!provider || provider.source !== "exec") {
      continue;
    }
    const execProvider = isPluginIntegrationSecretProviderConfig(provider)
      ? (() => {
          manifestRegistry ??= loadPluginManifestRegistry({
            config: params.config,
            env: params.env,
          });
          const resolved = resolveSecretProviderIntegrationConfig({
            manifestRegistry,
            providerAlias: ref.provider,
            providerConfig: provider,
            config: params.config,
            env: params.env,
          });
          if (!resolved.ok) {
            params.warn?.(
              `Exec SecretRef plugin provider "${ref.provider}" could not be resolved for service environment planning: ${resolved.reason}`,
              warningTitle,
            );
            return undefined;
          }
          return resolved.providerConfig;
        })()
      : provider;
    if (!execProvider) {
      continue;
    }
    for (const rawKey of execProvider.passEnv ?? []) {
      const key = normalizeEnvVarKey(rawKey, { portable: true });
      if (!key) {
        params.warn?.(
          `Exec SecretRef passEnv id "${rawKey}" is not portable and was not added to the service environment`,
          warningTitle,
        );
        continue;
      }
      if (isBlockedExecSecretRefPassEnvKey(key)) {
        params.warn?.(
          `Exec SecretRef passEnv ref "${key}" blocked by host-env security policy`,
          warningTitle,
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

function collectPluginConfigSecretRefs(params: {
  env: Record<string, string | undefined>;
  config: OpenClawConfig;
}): SecretRef[] {
  const context = createResolverContext({
    sourceConfig: params.config,
    env: params.env as NodeJS.ProcessEnv,
  });
  collectPluginConfigAssignments({
    config: params.config,
    defaults: params.config.secrets?.defaults,
    context,
  });
  return context.assignments.map((assignment) => assignment.ref);
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

// Operator opt-in env vars that should survive service regeneration even though
// they share the OPENCLAW_ prefix that is otherwise stripped from preserved
// environments. These represent intentional, user-placed configuration on the
// service definition that the install/repair flow should not silently revert.
const PRESERVED_OPENCLAW_OPERATOR_OPT_IN_ENV_KEYS = new Set([
  "OPENCLAW_CLI_CONTAINER_BYPASS",
  "OPENCLAW_CONTAINER_HINT",
]);

/** Preserve safe operator-owned env vars from an existing service definition. */
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
      (upper.startsWith("OPENCLAW_") && !PRESERVED_OPENCLAW_OPERATOR_OPT_IN_ENV_KEYS.has(upper))
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

function collectExistingEnvironmentFileManagedServiceEnvVars(params: {
  existingEnvironment: Record<string, string | undefined> | undefined;
  existingEnvironmentValueSources?: Record<
    string,
    GatewayServiceEnvironmentValueSource | undefined
  >;
  configSecretRefKeys: ReadonlySet<string>;
}): Record<string, string | undefined> {
  if (!params.existingEnvironment || params.configSecretRefKeys.size === 0) {
    return {};
  }
  const preserved: Record<string, string | undefined> = {};
  for (const [rawKey, rawValue] of Object.entries(params.existingEnvironment)) {
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key) {
      continue;
    }
    const normalizedKey = key.toUpperCase();
    if (!params.configSecretRefKeys.has(normalizedKey)) {
      continue;
    }
    if (isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key)) {
      continue;
    }
    const source = readEnvironmentValueSource(
      params.existingEnvironmentValueSources,
      normalizedKey,
    );
    if (!hasEnvironmentFileSource(source)) {
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

function omitEnvironmentEntriesShadowedBy(
  entries: Record<string, string | undefined>,
  shadowEntries: Array<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const shadowKeys = new Set(
    shadowEntries.flatMap((environment) =>
      Object.keys(environment).flatMap((key) => {
        const normalized = normalizeEnvVarKey(key, { portable: true })?.toUpperCase();
        return normalized ? [normalized] : [];
      }),
    ),
  );
  return Object.fromEntries(
    Object.entries(entries).filter(([key]) => {
      const normalized = normalizeEnvVarKey(key, { portable: true })?.toUpperCase();
      return !normalized || !shadowKeys.has(normalized);
    }),
  );
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
  existingEnvironmentValueSources?: Record<
    string,
    GatewayServiceEnvironmentValueSource | undefined
  >;
  platform: NodeJS.Platform;
}): Promise<{
  environment: Record<string, string | undefined>;
  environmentValueSources: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
}> {
  const { stateDirDotEnvEnvironment, configEnvironment, durableEnvironment } =
    collectDurableServiceEnvVarSources({
      env: params.env,
      config: params.config,
    });
  // Full target discovery materializes plugin metadata; configs without refs do not need it.
  const containsConfigSecretRef = configContainsSecretRef(params.config);
  const { keys: configSecretRefKeys, environment: configSecretRefEnvironment } =
    collectConfigSecretRefServiceEnvSources({
      env: params.env,
      config: params.config,
      configContainsSecretRef: containsConfigSecretRef,
      stateDirDotEnvEnvironment,
      warn: params.warn,
    });
  const authStore = await resolveAuthProfileStoreForServiceEnv(params.authStore);
  const execSecretRefPassEnvEnvironment = collectExecSecretRefPassEnvServiceEnvVars({
    env: params.env,
    config: params.config,
    configContainsSecretRef: containsConfigSecretRef,
    authStore,
    durableEnvironment,
    warn: params.warn,
  });
  const authProfileEnvironment = collectAuthProfileServiceEnvVars({
    env: params.env,
    authStore,
    warn: params.warn,
  });
  const stateDirDotEnvRenderEnvironment = omitEnvironmentEntriesShadowedBy(
    stateDirDotEnvEnvironment,
    [
      configEnvironment,
      configSecretRefEnvironment,
      execSecretRefPassEnvEnvironment,
      authProfileEnvironment,
    ],
  );
  const preservedExistingEnvironment = collectPreservedExistingServiceEnvVars(
    params.existingEnvironment,
    readManagedServiceEnvKeysFromEnvironment(params.existingEnvironment),
  );
  const plan = createMutableServiceEnvPlan();
  addServiceEnvPlanEntries(plan, preservedExistingEnvironment, {
    valueSource: ({ normalizedKey }) =>
      readEnvironmentValueSource(params.existingEnvironmentValueSources, normalizedKey) ?? "inline",
  });
  addServiceEnvPlanEntries(plan, stateDirDotEnvEnvironment, {});
  addServiceEnvPlanEntries(plan, configEnvironment, {});
  addServiceEnvPlanEntries(plan, configSecretRefEnvironment, {});
  addServiceEnvPlanEntries(plan, execSecretRefPassEnvEnvironment, {});
  addServiceEnvPlanEntries(plan, authProfileEnvironment, {});
  const configSecretRefKeyEnvironment = Object.fromEntries(
    configSecretRefKeys.map((key) => [key, "1"]),
  );
  const managedServiceEnvKeys = formatManagedServiceEnvKeys(
    {
      ...durableEnvironment,
      ...configSecretRefKeyEnvironment,
      ...configSecretRefEnvironment,
    },
    { omitKeys: Object.keys(params.serviceEnvironment) },
  );
  const existingEnvironmentFileRenderEnvironment = omitEnvironmentEntriesShadowedBy(
    collectExistingEnvironmentFileManagedServiceEnvVars({
      existingEnvironment: params.existingEnvironment,
      existingEnvironmentValueSources: params.existingEnvironmentValueSources,
      configSecretRefKeys: new Set(configSecretRefKeys),
    }),
    [
      stateDirDotEnvRenderEnvironment,
      configSecretRefEnvironment,
      execSecretRefPassEnvEnvironment,
      authProfileEnvironment,
    ],
  );
  applyManagedServiceEnvRenderPolicy({
    plan,
    managedServiceEnvKeys,
    serviceEnvironment: params.serviceEnvironment,
    platform: params.platform,
    existingEnvironmentFileEnvironment: existingEnvironmentFileRenderEnvironment,
    stateDirDotEnvEnvironment: stateDirDotEnvRenderEnvironment,
    configSecretRefEnvironment,
  });
  addServiceEnvPlanEntries(plan, params.serviceEnvironment, {
    includeRawKeys: true,
  });
  const mergedPath = mergeServicePath(
    params.serviceEnvironment.PATH,
    params.existingEnvironment?.PATH,
    params.serviceEnvironment.TMPDIR,
    params.platform,
  );
  if (mergedPath) {
    plan.environment.PATH = mergedPath;
    plan.environmentValueSources.PATH = "inline";
  }
  compactServiceEnvPlanValueSources(plan);
  return {
    environment: plan.environment,
    environmentValueSources: plan.environmentValueSources,
  };
}

/** Build command, working directory, and environment for installing the Gateway service. */
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
  existingEnvironmentValueSources?: Record<
    string,
    GatewayServiceEnvironmentValueSource | undefined
  >;
}): Promise<GatewayInstallPlan> {
  const platform = params.platform ?? process.platform;
  const { devMode, nodePath } = await resolveDaemonInstallRuntimeInputs({
    env: params.env,
    runtime: params.runtime,
    devMode: params.devMode,
    nodePath: params.nodePath,
  });
  const wrapperInput = params.wrapperPath ?? params.env[OPENCLAW_WRAPPER_ENV_KEY];
  const wrapperPointsAtWindowsTaskScript =
    Boolean(wrapperInput?.trim()) &&
    platform === "win32" &&
    isSameServicePath(wrapperInput, resolveGatewayTaskScriptPath(params.env), platform);
  if (wrapperPointsAtWindowsTaskScript) {
    params.warn?.(
      `Ignoring ${OPENCLAW_WRAPPER_ENV_KEY} because it points to the Windows task script; using the OpenClaw gateway entrypoint directly to avoid a recursive gateway.cmd wrapper.`,
    );
  }
  const wrapperPath = wrapperPointsAtWindowsTaskScript
    ? undefined
    : await resolveOpenClawWrapperPath(wrapperInput);
  const serviceInputEnv: Record<string, string | undefined> = wrapperPath
    ? { ...params.env, [OPENCLAW_WRAPPER_ENV_KEY]: wrapperPath }
    : wrapperPointsAtWindowsTaskScript
      ? omitEnvKey(params.env, OPENCLAW_WRAPPER_ENV_KEY)
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
    existingNodeOptions: params.existingEnvironment?.NODE_OPTIONS,
    launchdLabel:
      platform === "darwin"
        ? resolveGatewayLaunchAgentLabel(serviceInputEnv.OPENCLAW_PROFILE)
        : undefined,
    platform,
    extraPathDirs: resolveDaemonServicePathDirs({
      nodePath,
      env: serviceInputEnv,
      platform,
    }),
  });

  const { environment, environmentValueSources } = await buildGatewayInstallEnvironment({
    env: serviceInputEnv,
    config: params.config,
    authStore: params.authStore,
    warn: params.warn,
    serviceEnvironment,
    existingEnvironment: params.existingEnvironment,
    existingEnvironmentValueSources: params.existingEnvironmentValueSources,
    platform,
  });

  // Lowest to highest: preserved custom vars, durable config, SecretRef env, generated service env.
  return {
    programArguments,
    workingDirectory: resolveGatewayInstallWorkingDirectory({
      env: serviceInputEnv,
      platform,
      workingDirectory,
    }),
    environment,
    ...(Object.keys(environmentValueSources).length > 0 ? { environmentValueSources } : {}),
  };
}

function normalizeServicePathForCompare(
  value: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return platform === "win32" ? path.win32.resolve(trimmed).toLowerCase() : path.resolve(trimmed);
}

function isSameServicePath(
  left: string | undefined,
  right: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  const normalizedLeft = normalizeServicePathForCompare(left, platform);
  const normalizedRight = normalizeServicePathForCompare(right, platform);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function omitEnvKey(
  env: Record<string, string | undefined>,
  key: string,
): Record<string, string | undefined> {
  const next = { ...env };
  delete next[key];
  return next;
}

/** Return the user-facing recovery hint for failed Gateway service installation. */
export function gatewayInstallErrorHint(platform = process.platform): string {
  return platform === "win32"
    ? "Tip: native Windows now falls back to a per-user Startup-folder login item when Scheduled Task creation is denied; if install still fails, rerun from an elevated PowerShell or skip service install."
    : `Tip: rerun \`${formatCliCommand("openclaw gateway install")}\` after fixing the error.`;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
