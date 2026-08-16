import path from "node:path";
import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
} from "../../daemon/constants.js";

const SERVICE_REFRESH_PATH_ENV_KEYS = [
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
] as const;

export function isGatewayServiceEnv(env: Record<string, string | undefined>): boolean {
  if (env.OPENCLAW_SERVICE_MARKER?.trim() !== GATEWAY_SERVICE_MARKER) {
    return false;
  }
  const serviceKind = env.OPENCLAW_SERVICE_KIND?.trim();
  return !serviceKind || serviceKind === GATEWAY_SERVICE_KIND;
}

function applyManagedServiceSelectorEnv(params: {
  baseEnv: NodeJS.ProcessEnv;
  serviceEnv: NodeJS.ProcessEnv;
  selectorEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const resolved = { ...params.baseEnv };
  const selectorEnv = params.selectorEnv ?? params.serviceEnv;
  for (const key of GATEWAY_SERVICE_SELECTOR_ENV_KEYS) {
    if (selectorEnv[key]?.trim()) {
      resolved[key] = params.serviceEnv[key];
    } else {
      delete resolved[key];
    }
  }
  return resolved;
}

function resolveServiceRefreshEnv(
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
  if (!params?.serviceEnv) {
    return resolvedEnv;
  }
  const serviceEnv = resolveServiceRefreshEnv(params.serviceEnv, params.invocationCwd);
  return applyManagedServiceSelectorEnv({ baseEnv: resolvedEnv, serviceEnv });
}
