import { resolveNodeStartupTlsEnvironment } from "../../bootstrap/node-startup-env.js";
import { buildGatewayInstallPlan } from "../../commands/daemon-install-helpers.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  isGatewayDaemonRuntime,
  type GatewayDaemonRuntime,
} from "../../commands/daemon-runtime.js";
import { resolveGatewayInstallToken } from "../../commands/gateway-install-token.js";
import { resolveFutureConfigActionBlock } from "../../config/future-version-guard.js";
import { readConfigFileSnapshotForWrite } from "../../config/io.js";
import { resolveGatewayPort } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.js";
import { OPENCLAW_WRAPPER_ENV_KEY, resolveOpenClawWrapperPath } from "../../daemon/program-args.js";
import { readEmbeddedGatewayToken } from "../../daemon/service-audit.js";
import { resolveGatewayService } from "../../daemon/service.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service.js";
import { isNonFatalSystemdInstallProbeError } from "../../daemon/systemd.js";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "../../infra/host-env-security.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { formatCliCommand } from "../command-format.js";
import { buildDaemonServiceSnapshot, installDaemonServiceAndEmit } from "./response.js";
import {
  createDaemonInstallActionContext,
  failIfNixDaemonInstallMode,
  parsePort,
} from "./shared.js";
import type { DaemonInstallOptions } from "./types.js";

function mergeInstallInvocationEnv(params: {
  env: NodeJS.ProcessEnv;
  existingServiceEnv?: Record<string, string>;
}): NodeJS.ProcessEnv {
  if (!params.existingServiceEnv || Object.keys(params.existingServiceEnv).length === 0) {
    return params.env;
  }
  const preservedServiceEnv: NodeJS.ProcessEnv = {};
  for (const [rawKey, rawValue] of Object.entries(params.existingServiceEnv)) {
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key) {
      continue;
    }
    const upper = key.toUpperCase();
    if (upper === OPENCLAW_WRAPPER_ENV_KEY) {
      const value = rawValue.trim();
      if (value) {
        preservedServiceEnv[OPENCLAW_WRAPPER_ENV_KEY] = value;
      }
      continue;
    }
    if (
      upper === "HOME" ||
      upper === "PATH" ||
      upper === "TMPDIR" ||
      upper.startsWith("OPENCLAW_")
    ) {
      continue;
    }
    if (isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key)) {
      continue;
    }
    const value = rawValue.trim();
    if (!value) {
      continue;
    }
    preservedServiceEnv[key] = value;
  }
  return {
    ...preservedServiceEnv,
    ...params.env,
  };
}

export async function runDaemonInstall(opts: DaemonInstallOptions) {
  const { json, stdout, warnings, emit, fail } = createDaemonInstallActionContext(opts.json);
  if (failIfNixDaemonInstallMode(fail)) {
    return;
  }

  const { snapshot: configSnapshot, writeOptions: configWriteOptions } =
    await readConfigFileSnapshotForWrite();
  const futureBlock = resolveFutureConfigActionBlock({
    action: "install or rewrite the gateway service",
    snapshot: configSnapshot,
  });
  if (futureBlock) {
    fail(`Gateway install blocked: ${futureBlock.message}`, futureBlock.hints);
    return;
  }
  const cfg = configSnapshot.valid ? configSnapshot.sourceConfig : configSnapshot.config;
  const portOverride = parsePort(opts.port);
  if (opts.port !== undefined && portOverride === null) {
    fail("Invalid port");
    return;
  }
  const port = portOverride ?? resolveGatewayPort(cfg);
  if (!Number.isFinite(port) || port <= 0) {
    fail("Invalid port");
    return;
  }
  const runtimeRaw = opts.runtime ? opts.runtime : DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (!isGatewayDaemonRuntime(runtimeRaw)) {
    fail('Invalid --runtime (use "node" or "bun")');
    return;
  }
  let wrapperPath: string | undefined;
  if (opts.wrapper !== undefined) {
    try {
      wrapperPath = await resolveOpenClawWrapperPath(opts.wrapper);
      if (!wrapperPath) {
        fail("Invalid --wrapper");
        return;
      }
    } catch (err) {
      fail(`Invalid --wrapper: ${String(err)}`);
      return;
    }
  }

  const service = resolveGatewayService();
  let loaded = false;
  let existingServiceEnv: Record<string, string> | undefined;
  let existingServiceCommand: GatewayServiceCommandConfig | null = null;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    if (isNonFatalSystemdInstallProbeError(err)) {
      loaded = false;
    } else {
      fail(`Gateway service check failed: ${String(err)}`);
      return;
    }
  }
  existingServiceCommand = await service.readCommand(process.env).catch(() => null);
  existingServiceEnv = existingServiceCommand?.environment;
  const installEnv = mergeInstallInvocationEnv({
    env: process.env,
    existingServiceEnv,
  });
  if (!wrapperPath) {
    try {
      wrapperPath = await resolveOpenClawWrapperPath(installEnv[OPENCLAW_WRAPPER_ENV_KEY]);
    } catch (err) {
      fail(`Invalid ${OPENCLAW_WRAPPER_ENV_KEY}: ${String(err)}`);
      return;
    }
  }
  if (loaded) {
    if (!opts.force) {
      const autoRefreshMessage = await getGatewayServiceAutoRefreshMessage({
        currentCommand: existingServiceCommand,
        env: process.env,
        installEnv,
        port,
        runtime: runtimeRaw,
        wrapperPath,
        existingEnvironment: existingServiceEnv,
        config: cfg,
      });
      if (autoRefreshMessage) {
        if (json) {
          warnings.push(autoRefreshMessage);
        } else {
          defaultRuntime.log(autoRefreshMessage);
        }
      } else {
        emit({
          ok: true,
          result: "already-installed",
          message: `Gateway service already ${service.loadedText}.`,
          service: buildDaemonServiceSnapshot(service, loaded),
        });
        if (!json) {
          defaultRuntime.log(`Gateway service already ${service.loadedText}.`);
          defaultRuntime.log(
            `Reinstall with: ${formatCliCommand("openclaw gateway install --force")}`,
          );
        }
        return;
      }
    }
  }

  const tokenResolution = await resolveGatewayInstallToken({
    config: cfg,
    configSnapshot,
    configWriteOptions,
    env: installEnv,
    explicitToken: opts.token,
    autoGenerateWhenMissing: true,
    persistGeneratedToken: true,
  });
  if (tokenResolution.unavailableReason) {
    fail(`Gateway install blocked: ${tokenResolution.unavailableReason}`);
    return;
  }
  for (const warning of tokenResolution.warnings) {
    if (json) {
      warnings.push(warning);
    } else {
      defaultRuntime.log(warning);
    }
  }

  const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
    env: installEnv,
    port,
    runtime: runtimeRaw,
    wrapperPath,
    existingEnvironment: existingServiceEnv,
    warn: (message) => {
      if (json) {
        warnings.push(message);
      } else {
        defaultRuntime.log(message);
      }
    },
    config: cfg,
  });

  await installDaemonServiceAndEmit({
    serviceNoun: "Gateway",
    service,
    warnings,
    emit,
    fail,
    install: async () => {
      await service.install({
        env: installEnv,
        stdout,
        programArguments,
        workingDirectory,
        environment,
      });
    },
  });
}

async function getGatewayServiceAutoRefreshMessage(params: {
  currentCommand: GatewayServiceCommandConfig | null;
  env: Record<string, string | undefined>;
  installEnv: NodeJS.ProcessEnv;
  port: number;
  runtime: GatewayDaemonRuntime;
  wrapperPath?: string;
  existingEnvironment?: Record<string, string | undefined>;
  config: OpenClawConfig;
}): Promise<string | undefined> {
  try {
    const currentCommand = params.currentCommand;
    if (!currentCommand) {
      return undefined;
    }
    const currentEmbeddedToken = readEmbeddedGatewayToken(currentCommand);
    if (currentEmbeddedToken) {
      const plannedInstall = await buildGatewayInstallPlan({
        env: params.installEnv,
        port: params.port,
        runtime: params.runtime,
        wrapperPath: params.wrapperPath,
        existingEnvironment: params.existingEnvironment,
        warn: () => undefined,
        config: params.config,
      });
      const plannedEmbeddedToken = normalizeOptionalString(
        plannedInstall.environment.OPENCLAW_GATEWAY_TOKEN,
      );
      if (currentEmbeddedToken !== plannedEmbeddedToken) {
        return "Gateway service OPENCLAW_GATEWAY_TOKEN differs from the current install plan; refreshing the install.";
      }
    }
    const wrapperRequested = Boolean(
      params.wrapperPath || normalizeOptionalString(params.installEnv[OPENCLAW_WRAPPER_ENV_KEY]),
    );
    if (wrapperRequested) {
      const plannedInstall = await buildGatewayInstallPlan({
        env: params.installEnv,
        port: params.port,
        runtime: params.runtime,
        wrapperPath: params.wrapperPath,
        existingEnvironment: params.existingEnvironment,
        warn: () => undefined,
        config: params.config,
      });
      if (
        plannedInstall.programArguments.join("\u0000") !==
        currentCommand.programArguments.join("\u0000")
      ) {
        return "Gateway service command differs from the current wrapper install plan; refreshing the install.";
      }
      const plannedWrapperPath = normalizeOptionalString(
        plannedInstall.environment[OPENCLAW_WRAPPER_ENV_KEY],
      );
      const currentWrapperPath = normalizeOptionalString(
        currentCommand.environment?.[OPENCLAW_WRAPPER_ENV_KEY],
      );
      if (plannedWrapperPath !== currentWrapperPath) {
        return `Gateway service ${OPENCLAW_WRAPPER_ENV_KEY} differs from the current wrapper install plan; refreshing the install.`;
      }
    }
    const currentExecPath = currentCommand.programArguments[0]?.trim();
    if (!currentExecPath) {
      return undefined;
    }
    const currentEnvironment = currentCommand.environment ?? {};
    const currentNodeExtraCaCerts = currentEnvironment.NODE_EXTRA_CA_CERTS?.trim();
    const expectedNodeExtraCaCerts = resolveNodeStartupTlsEnvironment({
      env: {
        ...params.env,
        ...currentEnvironment,
        NODE_EXTRA_CA_CERTS: undefined,
      },
      execPath: currentExecPath,
      includeDarwinDefaults: false,
    }).NODE_EXTRA_CA_CERTS;
    if (!expectedNodeExtraCaCerts) {
      return undefined;
    }
    if (currentNodeExtraCaCerts !== expectedNodeExtraCaCerts) {
      return "Gateway service is missing the nvm TLS CA bundle; refreshing the install.";
    }
    return undefined;
  } catch {
    return undefined;
  }
}
