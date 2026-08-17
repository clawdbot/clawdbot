/** Prepares exec workdir and environment facts before policy and host dispatch. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatChannelId } from "../channels/ids.js";
import type { ExecHost } from "../infra/exec-approvals.js";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeHostOverrideEnvVarKey,
  sanitizeHostExecEnvWithDiagnostics,
} from "../infra/host-env-security.js";
import { OPENCLAW_CLI_ENV_VAR } from "../infra/openclaw-exec-env.js";
import {
  getShellPathFromLoginShell,
  resolveShellEnvFallbackTimeoutMs,
} from "../infra/shell-env.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginHookChannelContext } from "../plugins/hook-types.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import { stripMalformedXmlArgValueSuffixFromKeys } from "./agent-tools.params.js";
import { DEFAULT_PATH, applyPathPrepend, applyShellPath } from "./bash-tools.exec-runtime.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import { type ExecWorkdirResolution, resolveExecWorkdir } from "./bash-tools.exec-workdir.js";
import { buildSandboxEnv, coerceEnv } from "./bash-tools.shared.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import { sanitizeEnvVars } from "./sandbox/sanitize-env-vars.js";

export type ExecToolArgs = Record<string, unknown> & {
  command: string;
  workdir?: string;
  env?: Record<string, string>;
  yieldMs?: number;
  background?: boolean;
  timeoutSeconds?: number;
  pty?: boolean;
  elevated?: boolean;
  host?: string;
  security?: string;
  ask?: string;
  node?: string;
};

type ResolvedExecEnvPreparedState = {
  host?: ExecHost;
  pluginEnv?: Record<string, string>;
};
type DeferredResolveExecEnvPreparedState = {
  hookContext?: HookContext;
};
type ResolvedExecWorkdirPreparedState = {
  host: ExecHost;
  inputWorkdir?: string;
  resolution: ExecWorkdirResolution;
};

const CHANNEL_CONTEXT_ENV_KEY = "OPENCLAW_CHANNEL_CONTEXT";
const resolvedExecEnvPreparedStates = new WeakMap<ExecToolArgs, ResolvedExecEnvPreparedState>();
const deferredResolveExecEnvPreparedStates = new WeakMap<
  ExecToolArgs,
  DeferredResolveExecEnvPreparedState
>();
const resolvedExecWorkdirPreparedStates = new WeakMap<
  ExecToolArgs,
  ResolvedExecWorkdirPreparedState
>();
const XML_ARG_VALUE_EXEC_PARAM_KEYS = [
  "command",
  "workdir",
  "host",
  "security",
  "ask",
  "node",
] as const;

function buildSubprocessChannelContext(
  channelContext: PluginHookChannelContext | undefined,
): PluginHookChannelContext | undefined {
  const senderId = normalizeOptionalString(channelContext?.sender?.id);
  const chatId = normalizeOptionalString(channelContext?.chat?.id);
  const subprocessContext: PluginHookChannelContext = {
    ...(senderId ? { sender: { id: senderId } } : {}),
    ...(chatId ? { chat: { id: chatId } } : {}),
  };
  return subprocessContext.sender || subprocessContext.chat ? subprocessContext : undefined;
}

function buildChannelContextEnv(
  channelContext: PluginHookChannelContext | undefined,
): Record<string, string> | undefined {
  const subprocessContext = buildSubprocessChannelContext(channelContext);
  if (!subprocessContext) {
    return undefined;
  }
  const serialized = safeJsonStringify(subprocessContext);
  return serialized ? { [CHANNEL_CONTEXT_ENV_KEY]: serialized } : undefined;
}

function isExecToolArgsObject(value: unknown): value is ExecToolArgs {
  return isRecord(value);
}

function filterPluginExecEnv(rawEnv: Record<string, string>): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(rawEnv)) {
    const key = normalizeHostOverrideEnvVarKey(rawKey);
    if (!key) {
      continue;
    }
    const upperKey = key.toUpperCase();
    if (
      upperKey === "PATH" ||
      upperKey === OPENCLAW_CLI_ENV_VAR ||
      isDangerousHostEnvVarName(upperKey) ||
      isDangerousHostEnvOverrideVarName(upperKey)
    ) {
      continue;
    }
    env[key] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function markResolveExecEnvPrepared<T extends ExecToolArgs>(
  params: T,
  state: ResolvedExecEnvPreparedState = {},
): T {
  resolvedExecEnvPreparedStates.set(params, state);
  return params;
}

function getResolvedExecEnvPreparedState(
  params: ExecToolArgs,
): ResolvedExecEnvPreparedState | undefined {
  return resolvedExecEnvPreparedStates.get(params);
}

function isResolveExecEnvPrepared(params: ExecToolArgs): boolean {
  return Boolean(getResolvedExecEnvPreparedState(params));
}

function markDeferredResolveExecEnvPrepared<T extends ExecToolArgs>(
  params: T,
  state: DeferredResolveExecEnvPreparedState,
): T {
  deferredResolveExecEnvPreparedStates.set(params, state);
  return params;
}

function getDeferredResolveExecEnvPreparedState(
  params: ExecToolArgs,
): DeferredResolveExecEnvPreparedState | undefined {
  return deferredResolveExecEnvPreparedStates.get(params);
}

function markResolvedExecWorkdirPrepared<T extends ExecToolArgs>(
  params: T,
  state: ResolvedExecWorkdirPreparedState,
): T {
  resolvedExecWorkdirPreparedStates.set(params, state);
  return params;
}

function getResolvedExecWorkdirPreparedState(
  params: ExecToolArgs,
): ResolvedExecWorkdirPreparedState | undefined {
  return resolvedExecWorkdirPreparedStates.get(params);
}

export function resolveNotifyOnExitEmptySuccess(defaults?: ExecToolDefaults): boolean {
  if (typeof defaults?.notifyOnExitEmptySuccess === "boolean") {
    return defaults.notifyOnExitEmptySuccess;
  }
  return normalizeChatChannelId(defaults?.messageProvider) !== null;
}

export function createExecRequestPreparation(params: {
  defaults?: ExecToolDefaults;
  agentId?: string;
  resolveHostForParams: (params: ExecToolArgs) => ExecHost;
}) {
  const normalizeParams = (rawArgs: unknown): ExecToolArgs =>
    stripMalformedXmlArgValueSuffixFromKeys(rawArgs as ExecToolArgs, XML_ARG_VALUE_EXEC_PARAM_KEYS);

  const prepareParamsWithResolvedExecWorkdir = async (rawArgs: unknown): Promise<ExecToolArgs> => {
    if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
      return rawArgs as ExecToolArgs;
    }
    const execParams = normalizeParams(rawArgs);
    let host: ExecHost;
    try {
      host = params.resolveHostForParams(execParams);
    } catch {
      return execParams;
    }
    if (host === "sandbox" && !params.defaults?.sandbox) {
      return execParams;
    }
    if (host === "sandbox" && params.defaults?.sandbox?.workdirValidation === "backend") {
      return execParams;
    }
    const resolution = await resolveExecWorkdir({
      host,
      workdir: execParams.workdir,
      defaultCwd: params.defaults?.cwd,
      nodeCwd: params.defaults?.nodeCwd,
      sandbox: params.defaults?.sandbox,
    });
    return markResolvedExecWorkdirPrepared(execParams, {
      host,
      inputWorkdir: execParams.workdir,
      resolution,
    });
  };

  const shouldDeferResolveExecEnvUntilWorkdirValidated = (execParams: ExecToolArgs): boolean => {
    try {
      return (
        params.resolveHostForParams(execParams) === "sandbox" &&
        params.defaults?.sandbox?.workdirValidation === "backend"
      );
    } catch {
      return false;
    }
  };

  const prepareParamsWithResolvedExecEnv = async (
    rawArgs: unknown,
    context?: { hookContext?: HookContext },
  ): Promise<ExecToolArgs> => {
    const execParams = normalizeParams(rawArgs);
    if (!execParams.command) {
      return execParams;
    }
    if (isResolveExecEnvPrepared(execParams)) {
      return markResolveExecEnvPrepared(execParams);
    }
    const hookRunner = getGlobalHookRunner();
    if (
      !hookRunner?.hasHooks("resolve_exec_env") ||
      typeof hookRunner.runResolveExecEnv !== "function"
    ) {
      return markResolveExecEnvPrepared(execParams);
    }
    let host: ExecHost;
    try {
      host = params.resolveHostForParams(execParams);
    } catch {
      return execParams;
    }
    const rawPluginEnv = await hookRunner.runResolveExecEnv(
      {
        sessionKey: params.defaults?.sessionKey ?? context?.hookContext?.sessionKey,
        toolName: "exec",
        host,
      },
      {
        agentId: params.agentId ?? context?.hookContext?.agentId,
        sessionKey: params.defaults?.sessionKey ?? context?.hookContext?.sessionKey,
        messageProvider: params.defaults?.messageProvider,
        channelId: params.defaults?.currentChannelId ?? context?.hookContext?.channelId,
        ...(params.defaults?.channelContext
          ? { channelContext: params.defaults.channelContext }
          : {}),
      },
    );
    const pluginEnv = filterPluginExecEnv(rawPluginEnv);
    return markResolveExecEnvPrepared(execParams, {
      host,
      ...(pluginEnv ? { pluginEnv } : {}),
    });
  };

  const prepareBeforeToolCallParams = async (
    args: unknown,
    context: { hookContext?: unknown },
  ): Promise<ExecToolArgs> => {
    const execParams = await prepareParamsWithResolvedExecWorkdir(args);
    const workdirState = getResolvedExecWorkdirPreparedState(execParams);
    if (workdirState?.resolution.kind === "unavailable") {
      return execParams;
    }
    if (!isExecToolArgsObject(execParams)) {
      return execParams;
    }
    if (shouldDeferResolveExecEnvUntilWorkdirValidated(execParams)) {
      return markDeferredResolveExecEnvPrepared(execParams, {
        hookContext: context.hookContext as HookContext | undefined,
      });
    }
    return prepareParamsWithResolvedExecEnv(execParams, {
      hookContext: context.hookContext as HookContext | undefined,
    });
  };

  const finalizeBeforeToolCallParams = (rawParams: unknown, preparedParams: unknown) => {
    const envState = getResolvedExecEnvPreparedState(preparedParams as ExecToolArgs);
    const deferredEnvState = getDeferredResolveExecEnvPreparedState(preparedParams as ExecToolArgs);
    const workdirState = getResolvedExecWorkdirPreparedState(preparedParams as ExecToolArgs);
    if (!envState && !deferredEnvState && !workdirState) {
      return rawParams;
    }
    if (!isExecToolArgsObject(rawParams)) {
      return rawParams;
    }
    const execParams = rawParams;
    let host: ExecHost | undefined;
    const resolveFinalHost = () => {
      host ??= params.resolveHostForParams(execParams);
      return host;
    };
    try {
      if (envState?.host && execParams.command && resolveFinalHost() !== envState.host) {
        return { ...execParams };
      }
      if (
        workdirState &&
        (resolveFinalHost() !== workdirState.host ||
          execParams.workdir !== workdirState.inputWorkdir)
      ) {
        return { ...execParams };
      }
    } catch {
      return { ...execParams };
    }
    if (envState) {
      markResolveExecEnvPrepared(execParams, envState);
    }
    if (deferredEnvState) {
      markDeferredResolveExecEnvPrepared(execParams, deferredEnvState);
    }
    if (workdirState) {
      markResolvedExecWorkdirPrepared(execParams, workdirState);
    }
    return execParams;
  };

  return {
    normalizeParams,
    prepareBeforeToolCallParams,
    finalizeBeforeToolCallParams,
    prepareParamsWithResolvedExecEnv,
    isResolveExecEnvPrepared,
    getDeferredResolveExecEnvPreparedState,
    getResolvedExecWorkdirPreparedState,
    getResolvedExecEnvPreparedState,
  };
}

export function resolvePreparedExecEnvironment(params: {
  execParams: ExecToolArgs;
  host: ExecHost;
  sandbox?: BashSandboxConfig;
  containerWorkdir?: string | null;
  channelContext?: PluginHookChannelContext;
  defaultPathPrepend: string[];
  pluginEnv?: Record<string, string>;
  storeEnv?: Record<string, string>;
  storeSecretEnv?: Record<string, string>;
  secretEgressEnv?: Record<string, string>;
  credentialScrubEnv?: Readonly<Record<string, string>>;
  warnings: string[];
}): { env: Record<string, string>; requestedEnv?: Record<string, string> } {
  const inheritedBaseEnv = coerceEnv(process.env);
  if (params.secretEgressEnv) {
    Object.assign(inheritedBaseEnv, params.secretEgressEnv);
  }
  const channelContextEnv = buildChannelContextEnv(params.channelContext);
  const explicitEnv: Record<string, string> | undefined =
    params.execParams.env !== undefined ||
    params.pluginEnv !== undefined ||
    channelContextEnv !== undefined
      ? { ...params.execParams.env, ...params.pluginEnv, ...channelContextEnv }
      : undefined;
  const storeEnvResult = params.storeEnv
    ? sanitizeHostExecEnvWithDiagnostics({
        baseEnv: {},
        overrides: params.storeEnv,
        blockPathOverrides: true,
      })
    : undefined;
  const { [OPENCLAW_CLI_ENV_VAR]: _storeMarker, ...acceptedStoreEnv } = storeEnvResult?.env ?? {};
  let storeEnv = Object.keys(acceptedStoreEnv).length > 0 ? acceptedStoreEnv : undefined;
  const rejectedStoreKeys = new Set([
    ...(storeEnvResult?.rejectedOverrideBlockedKeys ?? []),
    ...(storeEnvResult?.rejectedOverrideInvalidKeys ?? []),
  ]);
  if (params.storeEnv && Object.hasOwn(params.storeEnv, OPENCLAW_CLI_ENV_VAR)) {
    rejectedStoreKeys.add(OPENCLAW_CLI_ENV_VAR);
  }
  if (params.host === "sandbox" && storeEnv) {
    const sandboxStoreEnvResult = sanitizeEnvVars(storeEnv);
    storeEnv = sandboxStoreEnvResult.allowed;
    for (const key of sandboxStoreEnvResult.blocked) {
      rejectedStoreKeys.add(key);
    }
    if (sandboxStoreEnvResult.warnings.length > 0) {
      params.warnings.push(
        `Warning: secret store environment entries need attention: ${sandboxStoreEnvResult.warnings.join("; ")}.`,
      );
    }
  }
  if (rejectedStoreKeys.size > 0) {
    params.warnings.push(
      `Warning: secret store environment entries were not applied for host=${params.host}: ${Array.from(rejectedStoreKeys).toSorted().join(", ")}.`,
    );
  }
  const hasStoreEnv = storeEnv && Object.keys(storeEnv).length > 0;
  const untrustedRequestedEnv: Record<string, string> | undefined = hasStoreEnv
    ? { ...storeEnv, ...explicitEnv }
    : explicitEnv;
  const requestedEnv: Record<string, string> | undefined = params.storeSecretEnv
    ? { ...storeEnv, ...params.storeSecretEnv, ...explicitEnv }
    : untrustedRequestedEnv;
  const hostEnvResult =
    params.host === "sandbox"
      ? null
      : sanitizeHostExecEnvWithDiagnostics({
          baseEnv: inheritedBaseEnv,
          overrides: untrustedRequestedEnv,
          blockPathOverrides: true,
        });
  if (
    hostEnvResult &&
    untrustedRequestedEnv &&
    (hostEnvResult.rejectedOverrideBlockedKeys.length > 0 ||
      hostEnvResult.rejectedOverrideInvalidKeys.length > 0)
  ) {
    const blockedKeys = hostEnvResult.rejectedOverrideBlockedKeys;
    const invalidKeys = hostEnvResult.rejectedOverrideInvalidKeys;
    const pathBlocked = blockedKeys.includes("PATH");
    if (pathBlocked && blockedKeys.length === 1 && invalidKeys.length === 0) {
      throw new Error(
        "Security Violation: Custom 'PATH' variable is forbidden during host execution.",
      );
    }
    if (blockedKeys.length === 1 && invalidKeys.length === 0) {
      throw new Error(
        `Security Violation: Environment variable '${blockedKeys[0]}' is forbidden during host execution.`,
      );
    }
    const details: string[] = [];
    if (blockedKeys.length > 0) {
      details.push(`blocked override keys: ${blockedKeys.join(", ")}`);
    }
    if (invalidKeys.length > 0) {
      details.push(`invalid non-portable override keys: ${invalidKeys.join(", ")}`);
    }
    const suffix = details.join("; ");
    if (pathBlocked) {
      throw new Error(
        `Security Violation: Custom 'PATH' variable is forbidden during host execution (${suffix}).`,
      );
    }
    throw new Error(`Security Violation: ${suffix}.`);
  }

  const env =
    params.sandbox && params.host === "sandbox"
      ? buildSandboxEnv({
          defaultPath: DEFAULT_PATH,
          paramsEnv: untrustedRequestedEnv,
          sandboxEnv: params.sandbox.env,
          containerWorkdir: params.containerWorkdir ?? params.sandbox.containerWorkdir,
        })
      : (hostEnvResult?.env ?? inheritedBaseEnv);

  if (!params.sandbox && params.host === "gateway" && !requestedEnv?.PATH) {
    const shellPath = getShellPathFromLoginShell({
      env: process.env,
      timeoutMs: resolveShellEnvFallbackTimeoutMs(process.env),
    });
    applyShellPath(env, shellPath);
  }

  // `tools.exec.pathPrepend` is only meaningful when exec runs locally (gateway) or in the sandbox.
  // Node hosts intentionally ignore request-scoped PATH overrides, so don't pretend this applies.
  if (params.host === "node" && params.defaultPathPrepend.length > 0) {
    params.warnings.push(
      "Warning: tools.exec.pathPrepend is ignored for host=node. Configure PATH on the node host/service instead.",
    );
  } else {
    applyPathPrepend(env, params.defaultPathPrepend);
  }

  if (params.storeSecretEnv) {
    // Secret-kind entries are authenticated ciphertext, not active credentials.
    // Inject them after ordinary env filtering so names such as GH_TOKEN remain usable.
    for (const [key, value] of Object.entries(params.storeSecretEnv)) {
      if (!explicitEnv || !Object.hasOwn(explicitEnv, key)) {
        env[key] = value;
      }
    }
  }
  if (params.secretEgressEnv) {
    Object.assign(env, params.secretEgressEnv);
  }
  const preparedEnv = { ...params.credentialScrubEnv };
  // Prepared host values are authoritative over ambient, model, plugin, and store projections.
  Object.assign(env, preparedEnv);

  return {
    env,
    ...(Object.keys(preparedEnv).length > 0
      ? { requestedEnv: { ...requestedEnv, ...preparedEnv } }
      : { requestedEnv }),
  };
}
