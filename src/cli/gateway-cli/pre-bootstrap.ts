import { resetPublishedConfigRuntimeEnv } from "../../config/config-env-vars.js";
// Gateway startup checks that must run before shared CLI bootstrap can migrate state.
import { ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV } from "../../config/future-version-guard.js";
import { GATEWAY_CONFIG_SELECTION_ENV_KEYS } from "../../config/gateway-env-selection.js";
import type { ConfigFileSnapshot } from "../../config/types.js";
import { ExitError, type RuntimeEnv } from "../../runtime.js";
import type { GatewayRunPreBootstrapOptions } from "./future-config-guard.js";
import { enforceGatewayRunFutureConfigGuard } from "./future-config-guard.js";
import { getGatewayRunRuntimeHooks } from "./runtime-hooks.js";

type GatewayRunGuardParams = {
  opts: GatewayRunPreBootstrapOptions;
  runtime: RuntimeEnv;
};

type GatewayRunEnvironmentSelection = {
  after: Record<string, string | undefined>;
  before: Record<string, string | undefined>;
};

type PreparedGatewayRunReset = {
  selectionEnvironment: Record<string, string | undefined>;
  selectionSignature: string;
  snapshot: ConfigFileSnapshot;
};

let selectedGatewayRunEnvironment: GatewayRunEnvironmentSelection | undefined;
let appliedGatewayRunConfigEnvironment: GatewayRunEnvironmentSelection | undefined;
let lastGuardedGatewayRunSnapshot: ConfigFileSnapshot | undefined;
let preparedGatewayRunBootstrapSnapshot: ConfigFileSnapshot | undefined;
let preparedGatewayRunStateWasPristine = false;
let preparedGatewayRunCoreStateWasPristine = false;
let preparedGatewayRunReset: PreparedGatewayRunReset | undefined;
let gatewayRunTargetSelectedByConfig = false;

async function pinGatewayRunRuntimePaths(): Promise<void> {
  const [{ pinRuntimePaths }, { pinConfigDir }] = await Promise.all([
    import("../../config/paths.js"),
    import("../../utils.js"),
  ]);
  pinRuntimePaths(process.env);
  pinConfigDir(process.env);
}

const GATEWAY_RESET_SELECTION_ENV_KEYS = new Set([
  ...GATEWAY_CONFIG_SELECTION_ENV_KEYS,
  "OPENCLAW_PROFILE",
  "OPENCLAW_WORKSPACE_DIR",
]);

function resolveGatewayConfigSelectionSignature(env: NodeJS.ProcessEnv): string {
  return JSON.stringify([...GATEWAY_CONFIG_SELECTION_ENV_KEYS].map((key) => [key, env[key]]));
}

function snapshotGatewayConfigSelectionEnvironment(
  env: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  return Object.fromEntries([...GATEWAY_CONFIG_SELECTION_ENV_KEYS].map((key) => [key, env[key]]));
}

function restoreGatewayConfigSelectionEnvironment(
  snapshot: Record<string, string | undefined>,
): void {
  for (const key of GATEWAY_CONFIG_SELECTION_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function resolveGatewayRunDotEnvPaths(params: {
  env: NodeJS.ProcessEnv;
  join: (...paths: string[]) => string;
  resolve: (path: string) => string;
  resolveConfigDir: (env: NodeJS.ProcessEnv) => string;
  resolveStateDir: (env: NodeJS.ProcessEnv) => string;
}): { additionalEnvPaths?: string[]; stateEnvPath: string } {
  const stateEnvPath = params.join(params.resolveStateDir(params.env), ".env");
  const configEnvPath = params.join(params.resolveConfigDir(params.env), ".env");
  return params.resolve(stateEnvPath) === params.resolve(configEnvPath)
    ? { stateEnvPath }
    : { additionalEnvPaths: [configEnvPath], stateEnvPath };
}

function resolveInvocationDestructiveOverride(): string | undefined {
  if (process.env.OPENCLAW_SERVICE_MARKER?.trim()) {
    delete process.env[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV];
    return undefined;
  }
  return process.env[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV];
}

function applyInvocationDestructiveOverride(value: string | undefined): void {
  if (process.env.OPENCLAW_SERVICE_MARKER?.trim() || value === undefined) {
    delete process.env[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV];
  } else {
    process.env[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV] = value;
  }
}

function restoreGatewayEnvChanges(params: {
  before: Record<string, string | undefined>;
  after: Record<string, string | undefined>;
  preservedKeys?: ReadonlySet<string>;
}): void {
  const keys = new Set([...Object.keys(params.before), ...Object.keys(params.after)]);
  for (const key of keys) {
    const preservedKey = process.platform === "win32" ? key.toUpperCase() : key;
    if (params.preservedKeys?.has(preservedKey)) {
      continue;
    }
    if (params.before[key] === params.after[key] || process.env[key] !== params.after[key]) {
      continue;
    }
    const previous = params.before[key];
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

function restoreSupersededGatewaySelectionEnv(params: {
  beforeCurrentPass: Record<string, string | undefined>;
  environmentSelection?: GatewayRunEnvironmentSelection;
}): void {
  restoreGatewayEnvChanges({
    before: params.beforeCurrentPass,
    after: { ...process.env },
    preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS,
  });
  if (params.environmentSelection) {
    // Remove only values introduced by the early selection phase. Later mutations such as
    // managed-proxy env differ from the recorded after-snapshot and remain intact.
    restoreGatewayEnvChanges({
      before: params.environmentSelection.before,
      after: params.environmentSelection.after,
      preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS,
    });
  }
}

function restoreAppliedGatewayRunConfigEnvironment(preserveSelection = true): void {
  const applied = appliedGatewayRunConfigEnvironment;
  appliedGatewayRunConfigEnvironment = undefined;
  if (!applied) {
    return;
  }
  restoreGatewayEnvChanges({
    before: applied.before,
    after: applied.after,
    ...(preserveSelection ? { preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS } : {}),
  });
}

async function readGuardedGatewayRunConfig(
  params: GatewayRunGuardParams,
): Promise<ConfigFileSnapshot | null> {
  const { readConfigFileSnapshot } = await import("../../config/config.js");
  const snapshot = await readConfigFileSnapshot({ isolateEnv: true, observe: false });
  return enforceGatewayRunFutureConfigGuard({
    opts: params.opts,
    runtime: params.runtime,
    snapshot,
  })
    ? snapshot
    : null;
}

async function isSameGatewayRunConfigSnapshot(
  expected: ConfigFileSnapshot,
  current: ConfigFileSnapshot,
  options: { allowPathChange?: boolean } = {},
): Promise<boolean> {
  const { hashRuntimeConfigValue } = await import("../../config/runtime-snapshot.js");
  return (
    (options.allowPathChange || current.path === expected.path) &&
    current.exists === expected.exists &&
    (current.hash ?? current.raw) === (expected.hash ?? expected.raw) &&
    hashRuntimeConfigValue(current.sourceConfig) === hashRuntimeConfigValue(expected.sourceConfig)
  );
}

function resolveGatewayConfigSelectionDeclarationSignature(
  entries: Record<string, string>,
): string {
  const normalized = new Map(
    Object.entries(entries).map(([key, value]) => [key.toUpperCase(), value]),
  );
  return JSON.stringify(
    [...GATEWAY_CONFIG_SELECTION_ENV_KEYS].map((key) => [key, normalized.get(key)]),
  );
}

async function recoverGuardedGatewayRunConfig(
  params: GatewayRunGuardParams & { restoreSuspicious: boolean },
): Promise<ConfigFileSnapshot | null> {
  const { readConfigFileSnapshot } = await import("../../config/config.js");
  let recoveryAllowed = true;
  const recoveredSnapshot = await readConfigFileSnapshot({
    isolateEnv: true,
    recoverSuspicious: true,
    allowSuspiciousRecovery: (config, current) => {
      recoveryAllowed = enforceGatewayRunFutureConfigGuard({
        opts: params.opts,
        runtime: params.runtime,
        config: current,
      });
      if (recoveryAllowed) {
        recoveryAllowed = enforceGatewayRunFutureConfigGuard({
          opts: params.opts,
          runtime: params.runtime,
          config,
        });
      }
      return params.restoreSuspicious && recoveryAllowed;
    },
  });
  if (!recoveryAllowed) {
    return null;
  }
  // Recovery can select a different config, so enforce the same guard again before migrations.
  return enforceGatewayRunFutureConfigGuard({
    opts: params.opts,
    runtime: params.runtime,
    snapshot: recoveredSnapshot,
  })
    ? recoveredSnapshot
    : null;
}

async function guardGatewayRunSelectedConfig(
  params: GatewayRunGuardParams & {
    environmentSelection?: GatewayRunEnvironmentSelection;
    recoverSuspicious: boolean;
    restoreSuspicious: boolean;
  },
): Promise<boolean> {
  lastGuardedGatewayRunSnapshot = undefined;
  const [
    path,
    { applyConfigEnvVars, isConfigRuntimeEnvVarAllowed },
    { loadGlobalRuntimeDotEnvFiles },
    { normalizeEnv },
    { normalizeStateDirEnv, resolveStateDir },
    { resolveConfigDir },
  ] = await Promise.all([
    import("node:path"),
    import("../../config/config-env-vars.js"),
    import("../../infra/dotenv-global.js"),
    import("../../infra/env.js"),
    import("../../config/paths.js"),
    import("../../utils.js"),
  ]);
  const invocationDestructiveOverride = resolveInvocationDestructiveOverride();
  if (params.environmentSelection) {
    restoreAppliedGatewayRunConfigEnvironment();
    restoreGatewayEnvChanges({
      before: params.environmentSelection.before,
      after: params.environmentSelection.after,
      preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS,
    });
  }
  const applyTrustedGatewayEnv = () => {
    normalizeStateDirEnv(process.env);
    const loaded = loadGlobalRuntimeDotEnvFiles({
      ...(gatewayRunTargetSelectedByConfig ? { entryFilter: isConfigRuntimeEnvVarAllowed } : {}),
      quiet: true,
      ...resolveGatewayRunDotEnvPaths({
        env: process.env,
        join: path.join,
        resolve: path.resolve,
        resolveConfigDir,
        resolveStateDir,
      }),
    });
    normalizeStateDirEnv(process.env);
    normalizeEnv();
    applyInvocationDestructiveOverride(invocationDestructiveOverride);
    return loaded;
  };
  const applySelectedConfigEnv = (snapshot: ConfigFileSnapshot) => {
    restoreAppliedGatewayRunConfigEnvironment(params.opts.reset !== true);
    if (snapshot.valid && params.opts.reset !== true) {
      const envBeforeApply = { ...process.env };
      applyConfigEnvVars(snapshot.sourceConfig, process.env);
      normalizeStateDirEnv(process.env);
      normalizeEnv();
      appliedGatewayRunConfigEnvironment = {
        before: envBeforeApply,
        after: { ...process.env },
      };
    }
    applyInvocationDestructiveOverride(invocationDestructiveOverride);
  };
  for (;;) {
    const envBeforeTrustedApply = { ...process.env };
    const trustedSelectionSignature = resolveGatewayConfigSelectionSignature(process.env);
    const trustedEnvLoad = applyTrustedGatewayEnv();
    if (resolveGatewayConfigSelectionSignature(process.env) !== trustedSelectionSignature) {
      const stateEnvSelectedTarget = trustedEnvLoad.stateEnvAppliedKeys.some((key) =>
        GATEWAY_CONFIG_SELECTION_ENV_KEYS.has(key.toUpperCase()),
      );
      if (stateEnvSelectedTarget) {
        const fallbackSelectorKeys = new Set(
          trustedEnvLoad.gatewayEnvAppliedKeys
            .map((key) => key.toUpperCase())
            .filter((key) => GATEWAY_CONFIG_SELECTION_ENV_KEYS.has(key)),
        );
        restoreGatewayEnvChanges({
          before: envBeforeTrustedApply,
          after: { ...process.env },
          preservedKeys: new Set(
            [...GATEWAY_CONFIG_SELECTION_ENV_KEYS].filter((key) => !fallbackSelectorKeys.has(key)),
          ),
        });
      }
      // A trusted dotenv selected another state/config target. Keep only its selectors so
      // credentials from the superseded dotenv cannot win over the selected target's dotenv.
      restoreSupersededGatewaySelectionEnv({
        beforeCurrentPass: envBeforeTrustedApply,
        environmentSelection: params.environmentSelection,
      });
      continue;
    }
    const snapshot = await readGuardedGatewayRunConfig(params);
    if (!snapshot) {
      return false;
    }
    if (!snapshot.valid) {
      // Invalid config source is untrusted. In particular, applying its env block could let an
      // off-root $include self-authorize OPENCLAW_INCLUDE_ROOTS on the next read. Only explicit dev
      // reset may proceed as the recovery path; ordinary startup skips mutation-capable bootstrap.
      if (params.opts.reset) {
        lastGuardedGatewayRunSnapshot = snapshot;
      }
      return params.opts.reset === true;
    }
    const selectionSignature = resolveGatewayConfigSelectionSignature(process.env);
    applySelectedConfigEnv(snapshot);
    // Only selection inputs survive a selection hop. Reload credentials once the final config and
    // state dotenv are stable so a superseded profile cannot contaminate the selected gateway.
    if (resolveGatewayConfigSelectionSignature(process.env) !== selectionSignature) {
      // Config-selected roots have only config-level trust. Their dotenv files must keep the same
      // blocked-key boundary instead of becoming operator-trusted sources on the next pass.
      gatewayRunTargetSelectedByConfig = true;
      restoreSupersededGatewaySelectionEnv({
        beforeCurrentPass: envBeforeTrustedApply,
        environmentSelection: params.environmentSelection,
      });
      continue;
    }
    if (!params.recoverSuspicious) {
      lastGuardedGatewayRunSnapshot = snapshot;
      return true;
    }
    // Recovery writes audit/config state, so run it only after config and state selection is stable.
    const recoveredSnapshot = await recoverGuardedGatewayRunConfig(params);
    if (!recoveredSnapshot) {
      return false;
    }
    if (recoveredSnapshot.path !== snapshot.path || recoveredSnapshot.hash !== snapshot.hash) {
      // Recovery replaced the selected config. Discard every env mutation from the old selection
      // chain before converging again so rejected credentials cannot survive into the backup.
      restoreSupersededGatewaySelectionEnv({
        beforeCurrentPass: envBeforeTrustedApply,
        environmentSelection: params.environmentSelection,
      });
      continue;
    }
    const envBeforeRecoveredApply = { ...process.env };
    const recoveredSelectionSignature = resolveGatewayConfigSelectionSignature(process.env);
    applySelectedConfigEnv(recoveredSnapshot);
    if (resolveGatewayConfigSelectionSignature(process.env) === recoveredSelectionSignature) {
      lastGuardedGatewayRunSnapshot = recoveredSnapshot;
      return true;
    }
    restoreSupersededGatewaySelectionEnv({
      beforeCurrentPass: envBeforeRecoveredApply,
      environmentSelection: params.environmentSelection,
    });
    gatewayRunTargetSelectedByConfig = true;
  }
}

async function guardGatewayRunReset(params: GatewayRunGuardParams): Promise<boolean> {
  gatewayRunTargetSelectedByConfig = false;
  const envBeforeGuard = { ...process.env };
  try {
    return await guardGatewayRunSelectedConfig({
      ...params,
      recoverSuspicious: true,
      restoreSuspicious: false,
    });
  } finally {
    // Config being deleted cannot authorize or retarget its own reset. Restore its env layer first,
    // then retain only invocation/trusted selectors through deletion and recreation.
    restoreAppliedGatewayRunConfigEnvironment(false);
    // Reset keeps only the selected config/state target. Credentials and other env from the
    // config being deleted must not survive into the replacement config or gateway runtime.
    restoreGatewayEnvChanges({
      before: envBeforeGuard,
      after: { ...process.env },
      preservedKeys: GATEWAY_RESET_SELECTION_ENV_KEYS,
    });
  }
}

export async function recheckGatewayRunReset(params: GatewayRunGuardParams): Promise<boolean> {
  const expected = preparedGatewayRunReset;
  preparedGatewayRunReset = undefined;
  const rejectDrift = async () => {
    if (expected) {
      restoreGatewayConfigSelectionEnvironment(expected.selectionEnvironment);
      await pinGatewayRunRuntimePaths();
    }
    params.runtime.error(
      "Refusing to reset the dev gateway state because the selected config or state target changed during startup. Retry the reset so the new target can be validated.",
    );
    params.runtime.exit(1);
    return false;
  };
  if (
    !expected ||
    resolveGatewayConfigSelectionSignature(process.env) !== expected.selectionSignature
  ) {
    return await rejectDrift();
  }
  if (!(await guardGatewayRunReset(params))) {
    return false;
  }
  const current = lastGuardedGatewayRunSnapshot;
  if (
    resolveGatewayConfigSelectionSignature(process.env) !== expected.selectionSignature ||
    !current ||
    !(await isSameGatewayRunConfigSnapshot(expected.snapshot, current))
  ) {
    return await rejectDrift();
  }
  return true;
}

export async function applyFinalGatewayRunConfigEnv(params: {
  lowerPrecedenceEnv?: Readonly<Record<string, string>>;
  runtime: RuntimeEnv;
  snapshot: ConfigFileSnapshot;
}): Promise<boolean> {
  const preparedSnapshot = preparedGatewayRunBootstrapSnapshot;
  preparedGatewayRunBootstrapSnapshot = undefined;
  if (!params.snapshot.valid) {
    restoreAppliedGatewayRunConfigEnvironment(false);
    if (preparedSnapshot) {
      params.runtime.error(
        "Refusing to start the gateway because the final config read became invalid. Retry startup after fixing the config.",
      );
      params.runtime.exit(1);
      return false;
    }
    await pinGatewayRunRuntimePaths();
    return true;
  }
  const invocationDestructiveOverride = resolveInvocationDestructiveOverride();
  const envBeforeApply = { ...process.env };
  const selectionSignature = resolveGatewayConfigSelectionSignature(process.env);
  const [
    {
      applyConfigEnvVars,
      collectConfigRuntimeEnvOwnership,
      collectConfigRuntimeEnvVars,
      initializePublishedConfigRuntimeEnv,
    },
    { normalizeEnv },
    { normalizeStateDirEnv },
    { clearShellEnvAppliedKeys },
  ] = await Promise.all([
    import("../../config/config-env-vars.js"),
    import("../../infra/env.js"),
    import("../../config/paths.js"),
    import("../../infra/shell-env.js"),
  ]);
  const finalConfigEnv = collectConfigRuntimeEnvVars(params.snapshot.sourceConfig);
  if (
    preparedSnapshot &&
    resolveGatewayConfigSelectionDeclarationSignature(
      collectConfigRuntimeEnvVars(preparedSnapshot.sourceConfig),
    ) !== resolveGatewayConfigSelectionDeclarationSignature(finalConfigEnv)
  ) {
    params.runtime.error(
      "Refusing to start the gateway because the final config read changed config or state selection. Retry startup so the selected target can be validated.",
    );
    params.runtime.exit(1);
    return false;
  }
  restoreAppliedGatewayRunConfigEnvironment();
  const envBeforeConfigApply = { ...process.env };
  const replacedLowerPrecedenceKeys: string[] = [];
  applyConfigEnvVars(params.snapshot.sourceConfig, process.env, {
    lowerPrecedenceEnv: params.lowerPrecedenceEnv,
    onLowerPrecedenceKeysReplaced: (keys) => {
      replacedLowerPrecedenceKeys.push(...keys);
      clearShellEnvAppliedKeys(keys);
    },
  });
  normalizeStateDirEnv(process.env);
  normalizeEnv();
  applyInvocationDestructiveOverride(invocationDestructiveOverride);
  appliedGatewayRunConfigEnvironment = {
    before: envBeforeApply,
    after: { ...process.env },
  };
  if (resolveGatewayConfigSelectionSignature(process.env) === selectionSignature) {
    initializePublishedConfigRuntimeEnv(params.snapshot.sourceConfig, {
      ownedEnv: collectConfigRuntimeEnvOwnership(
        params.snapshot.sourceConfig,
        envBeforeConfigApply,
        process.env,
        { replacedLowerPrecedenceKeys },
      ),
    });
    return true;
  }
  appliedGatewayRunConfigEnvironment = undefined;
  restoreGatewayEnvChanges({ before: envBeforeApply, after: { ...process.env } });
  params.runtime.error(
    "Refusing to start the gateway because the final config read changed config or state selection. Retry startup so the selected target can be validated.",
  );
  params.runtime.exit(1);
  return false;
}

export function clearGatewayRunConfigEnvironment(): void {
  restoreAppliedGatewayRunConfigEnvironment();
  resetPublishedConfigRuntimeEnv();
}

export async function reloadTrustedGatewayRunEnvironment(params: {
  runtime: RuntimeEnv;
}): Promise<boolean> {
  const [
    path,
    { isConfigRuntimeEnvVarAllowed },
    { loadGlobalRuntimeDotEnvFiles },
    { normalizeEnv },
    { normalizeStateDirEnv, resolveStateDir },
    { resolveConfigDir },
  ] = await Promise.all([
    import("node:path"),
    import("../../config/env-vars.js"),
    import("../../infra/dotenv-global.js"),
    import("../../infra/env.js"),
    import("../../config/paths.js"),
    import("../../utils.js"),
  ]);
  const envBeforeReload = { ...process.env };
  const selectionSignature = resolveGatewayConfigSelectionSignature(process.env);
  const invocationDestructiveOverride = resolveInvocationDestructiveOverride();
  normalizeStateDirEnv(process.env);
  loadGlobalRuntimeDotEnvFiles({
    ...(gatewayRunTargetSelectedByConfig ? { entryFilter: isConfigRuntimeEnvVarAllowed } : {}),
    quiet: true,
    ...resolveGatewayRunDotEnvPaths({
      env: process.env,
      join: path.join,
      resolve: path.resolve,
      resolveConfigDir,
      resolveStateDir,
    }),
  });
  normalizeStateDirEnv(process.env);
  normalizeEnv();
  applyInvocationDestructiveOverride(invocationDestructiveOverride);
  if (resolveGatewayConfigSelectionSignature(process.env) !== selectionSignature) {
    // Runtime modules already derived process-stable paths before startup mutations. A replacement
    // dotenv cannot select another target without splitting the running gateway across state dirs.
    restoreGatewayEnvChanges({ before: envBeforeReload, after: { ...process.env } });
    applyInvocationDestructiveOverride(invocationDestructiveOverride);
    await pinGatewayRunRuntimePaths();
    params.runtime.error(
      "Refusing to start the gateway because trusted dotenv reload after startup mutations changed config or state selection. Retry startup so the selected target can be validated.",
    );
    params.runtime.exit(1);
    return false;
  }
  await pinGatewayRunRuntimePaths();
  return true;
}

export async function selectGatewayRunEnvironment(params: GatewayRunGuardParams): Promise<boolean> {
  gatewayRunTargetSelectedByConfig = false;
  preparedGatewayRunBootstrapSnapshot = undefined;
  preparedGatewayRunReset = undefined;
  restoreAppliedGatewayRunConfigEnvironment(params.opts.reset !== true);
  const envBeforeGuard = { ...process.env };
  selectedGatewayRunEnvironment = undefined;
  let guarded: boolean;
  try {
    guarded = await guardGatewayRunSelectedConfig({
      ...params,
      recoverSuspicious: false,
      restoreSuspicious: false,
    });
  } finally {
    if (params.opts.reset) {
      restoreAppliedGatewayRunConfigEnvironment(false);
      restoreGatewayEnvChanges({
        before: envBeforeGuard,
        after: { ...process.env },
        preservedKeys: GATEWAY_RESET_SELECTION_ENV_KEYS,
      });
    }
  }
  selectedGatewayRunEnvironment = {
    before: envBeforeGuard,
    after: { ...process.env },
  };
  await pinGatewayRunRuntimePaths();
  return guarded;
}

export async function prepareGatewayRunBootstrap(params: GatewayRunGuardParams): Promise<boolean> {
  preparedGatewayRunReset = undefined;
  preparedGatewayRunStateWasPristine = false;
  preparedGatewayRunCoreStateWasPristine = false;
  const pristineSelectionSignature = resolveGatewayConfigSelectionSignature(process.env);
  const { planPristineStartupConfigMigrations, planPristineStartupStateMigrations } =
    await import("../../commands/doctor/shared/pristine-startup-state.js");
  const pristineStatePlan = planPristineStartupStateMigrations(process.env);
  // Stop the early proxy before recovery can select another config/state target. Its lifecycle
  // restores the underlying env snapshot so the selected target's trusted dotenv can replace it.
  await getGatewayRunRuntimeHooks().releaseManagedProxy?.();
  const environmentSelection = selectedGatewayRunEnvironment;
  selectedGatewayRunEnvironment = undefined;
  if (!environmentSelection) {
    gatewayRunTargetSelectedByConfig = false;
  }
  const guarded = params.opts.reset
    ? await guardGatewayRunReset(params)
    : await guardGatewayRunSelectedConfig({
        ...params,
        environmentSelection,
        recoverSuspicious: true,
        restoreSuspicious: true,
      });
  // Recovery can replace config without changing its selected path. Revalidate the final authored
  // file while retaining the pre-guard physical-state fact, or stateful backup config could skip.
  const guardedConfigPlan = planPristineStartupConfigMigrations(
    guarded ? lastGuardedGatewayRunSnapshot?.parsed : undefined,
    process.env,
  );
  preparedGatewayRunStateWasPristine =
    guarded &&
    !params.opts.reset &&
    pristineStatePlan.skipAllStateMigrations &&
    guardedConfigPlan.skipAllStateMigrations &&
    resolveGatewayConfigSelectionSignature(process.env) === pristineSelectionSignature;
  preparedGatewayRunCoreStateWasPristine =
    guarded &&
    !params.opts.reset &&
    pristineStatePlan.skipCoreStateMigrations &&
    guardedConfigPlan.skipCoreStateMigrations &&
    resolveGatewayConfigSelectionSignature(process.env) === pristineSelectionSignature;
  await pinGatewayRunRuntimePaths();
  // Dev reset deletes the state directory before recreating config. Migrating first would
  // archive legacy state and then delete its imported SQLite rows.
  const shouldBootstrap = guarded && !params.opts.reset;
  preparedGatewayRunBootstrapSnapshot = shouldBootstrap ? lastGuardedGatewayRunSnapshot : undefined;
  if (guarded && params.opts.reset && lastGuardedGatewayRunSnapshot) {
    preparedGatewayRunReset = {
      selectionEnvironment: snapshotGatewayConfigSelectionEnvironment(process.env),
      selectionSignature: resolveGatewayConfigSelectionSignature(process.env),
      snapshot: lastGuardedGatewayRunSnapshot,
    };
  }
  return shouldBootstrap;
}

/** Prepared fact captured before Gateway bootstrap can create runtime state. */
export function wasPreparedGatewayRunStatePristine(): boolean {
  return preparedGatewayRunStateWasPristine;
}

/** Prepared fact keeps plugin-only configs out of unrelated core migration discovery. */
export function wasPreparedGatewayRunCoreStatePristine(): boolean {
  return preparedGatewayRunCoreStateWasPristine;
}

export async function recheckGatewayRunBootstrap(
  params: GatewayRunGuardParams & { snapshot?: ConfigFileSnapshot },
): Promise<boolean> {
  // This callback can run while startup preflight owns the shared migration lease.
  // Throw a typed exit so its finally releases the lease before the CLI exits.
  const deferredExitRuntime: RuntimeEnv = {
    ...params.runtime,
    exit: (code) => {
      throw new ExitError(code);
    },
  };
  const expected = preparedGatewayRunBootstrapSnapshot;
  if (!expected) {
    params.runtime.error(
      "Refusing to run automatic gateway startup migrations without a prepared config snapshot. Retry startup.",
    );
    throw new ExitError(1);
  }
  const current = params.snapshot
    ? enforceGatewayRunFutureConfigGuard({
        opts: params.opts,
        runtime: deferredExitRuntime,
        snapshot: params.snapshot,
      })
      ? params.snapshot
      : null
    : await readGuardedGatewayRunConfig({ ...params, runtime: deferredExitRuntime });
  if (!current) {
    return false;
  }
  if (
    await isSameGatewayRunConfigSnapshot(expected, current, {
      allowPathChange: params.snapshot !== undefined,
    })
  ) {
    return true;
  }
  params.runtime.error(
    "Refusing to run automatic gateway startup migrations because the selected config changed during startup. Retry startup so the new config can be validated.",
  );
  throw new ExitError(1);
}
