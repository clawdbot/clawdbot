import path from "node:path";

const SERVICE_REFRESH_PATH_ENV_KEYS = [
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
] as const;

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

export function resolveUpdatedServicePathEnv(
  env: NodeJS.ProcessEnv,
  invocationCwd?: string,
): NodeJS.ProcessEnv {
  return resolveServiceRefreshEnv(env, invocationCwd);
}
