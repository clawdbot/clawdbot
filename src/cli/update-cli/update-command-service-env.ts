import path from "node:path";
import {
  GATEWAY_SERVICE_RUNTIME_PID_ENV,
  GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
} from "../../daemon/constants.js";

const SERVICE_REFRESH_PATH_ENV_KEYS = [
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_WORKSPACE_DIR",
] as const;
const MANAGED_UPDATE_SELECTOR_ENV_KEYS = [
  "OPENCLAW_HOME",
  ...GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
] as const;

function applyManagedServiceSelectorEnv(params: {
  baseEnv: NodeJS.ProcessEnv;
  serviceEnv: NodeJS.ProcessEnv;
  selectorEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const resolved = { ...params.baseEnv };
  const selectorEnv = params.selectorEnv ?? params.serviceEnv;
  for (const key of MANAGED_UPDATE_SELECTOR_ENV_KEYS) {
    if (selectorEnv[key]?.trim()) {
      resolved[key] = params.serviceEnv[key];
    } else {
      delete resolved[key];
    }
  }
  return resolved;
}

export function resolveServiceRefreshEnv(
  env: NodeJS.ProcessEnv,
  invocationCwd?: string,
): NodeJS.ProcessEnv {
  const resolvedEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of SERVICE_REFRESH_PATH_ENV_KEYS) {
    const rawValue = resolvedEnv[key]?.trim();
    if (!rawValue) {
      continue;
    }
    if (rawValue.startsWith("~") || path.isAbsolute(rawValue) || path.win32.isAbsolute(rawValue)) {
      resolvedEnv[key] = rawValue;
      continue;
    }
    if (!invocationCwd) {
      resolvedEnv[key] = rawValue;
      continue;
    }
    resolvedEnv[key] = path.resolve(invocationCwd, rawValue);
  }
  return resolvedEnv;
}

export async function withUpdateInProgressEnv<T>(
  invocationCwd: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const env = resolveServiceRefreshEnv(process.env, invocationCwd);
  env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
  const scopedKeys = Object.keys(env).filter(
    (key) => key === "OPENCLAW_UPDATE_IN_PROGRESS" || env[key] !== process.env[key],
  );
  const previousValues = scopedKeys.map((key) => [key, process.env[key]] as const);
  // Package replacement can remove cwd. All phase owners must share the
  // invocation's resolved selectors until cleanup finishes.
  for (const key of scopedKeys) {
    process.env[key] = env[key];
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previousValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export function stripGatewayServiceMarkerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolvedEnv = { ...env };
  delete resolvedEnv.OPENCLAW_SERVICE_MARKER;
  delete resolvedEnv.OPENCLAW_SERVICE_KIND;
  delete resolvedEnv[GATEWAY_SERVICE_RUNTIME_PID_ENV];
  return resolvedEnv;
}

export function disableUpdatedPackageCompileCacheEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
}

export function resolveUpdatedInstallCommandEnv(params?: {
  processEnv?: NodeJS.ProcessEnv;
  serviceEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
}): NodeJS.ProcessEnv {
  const processEnv = resolveServiceRefreshEnv(
    params?.processEnv ?? process.env,
    params?.invocationCwd,
  );
  const serviceEnv = params?.serviceEnv
    ? resolveServiceRefreshEnv(params.serviceEnv, params.invocationCwd)
    : undefined;
  // SecretRefs may resolve from the updater's runtime env even when the
  // managed service intentionally omits resolved secrets from its definition.
  return disableUpdatedPackageCompileCacheEnv({
    ...processEnv,
    ...serviceEnv,
  });
}

export function resolveOwnedManagedUpdateEnv(params: {
  processEnv?: NodeJS.ProcessEnv;
  serviceEnv: NodeJS.ProcessEnv;
  serviceDefinitionEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
}): NodeJS.ProcessEnv {
  const resolved = resolveUpdatedInstallCommandEnv(params);
  const definitionEnv = params.serviceDefinitionEnv ?? params.serviceEnv;
  return applyManagedServiceSelectorEnv({
    baseEnv: resolved,
    serviceEnv: resolved,
    selectorEnv: definitionEnv,
  });
}

export function resolvePostInstallDoctorEnv(params?: {
  baseEnv?: NodeJS.ProcessEnv;
  serviceEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
}): NodeJS.ProcessEnv {
  const resolvedEnv = disableUpdatedPackageCompileCacheEnv(params?.baseEnv ?? process.env);
  delete resolvedEnv.OPENCLAW_SERVICE_REPAIR_POLICY;
  if (!params?.serviceEnv) {
    return resolvedEnv;
  }
  const serviceEnv = resolveServiceRefreshEnv(params.serviceEnv, params.invocationCwd);
  return applyManagedServiceSelectorEnv({ baseEnv: resolvedEnv, serviceEnv });
}
