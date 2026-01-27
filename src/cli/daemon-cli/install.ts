import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  isGatewayDaemonRuntime,
} from "../../commands/daemon-runtime.js";
import { buildGatewayInstallPlan } from "../../commands/daemon-install-helpers.js";
import { loadConfig, resolveGatewayPort } from "../../config/config.js";
import { resolveIsNixMode } from "../../config/paths.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { buildDaemonServiceSnapshot, createNullWriter, emitDaemonActionJson } from "./response.js";
import { parsePort } from "./shared.js";
import type { DaemonInstallOptions } from "./types.js";

export async function runDaemonInstall(opts: DaemonInstallOptions) {
  const json = Boolean(opts.json);
  const warnings: string[] = [];
  const stdout = json ? createNullWriter() : process.stdout;
  const emit = (payload: {
    ok: boolean;
    result?: string;
    message?: string;
    error?: string;
    service?: {
      label: string;
      loaded: boolean;
      loadedText: string;
      notLoadedText: string;
    };
    hints?: string[];
    warnings?: string[];
  }) => {
    if (!json) return;
    emitDaemonActionJson({ action: "install", ...payload });
  };
  const fail = (message: string) => {
    if (json) {
      emit({ ok: false, error: message, warnings: warnings.length ? warnings : undefined });
    } else {
      defaultRuntime.error(message);
    }
    defaultRuntime.exit(1);
  };

  if (resolveIsNixMode(process.env)) {
    fail("Nix mode detected; service install is disabled.");
    return;
  }

  const cfg = loadConfig();
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
  const runtimeRaw = opts.runtime ? String(opts.runtime) : DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (!isGatewayDaemonRuntime(runtimeRaw)) {
    fail('Invalid --runtime (use "node" or "bun")');
    return;
  }

  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    fail(`Gateway service check failed: ${String(err)}`);
    return;
  }
  if (loaded) {
    if (!opts.force) {
      emit({
        ok: true,
        result: "already-installed",
        message: `Gateway service already ${service.loadedText}.`,
        service: buildDaemonServiceSnapshot(service, loaded),
        warnings: warnings.length ? warnings : undefined,
      });
      if (!json) {
        defaultRuntime.log(`Gateway service already ${service.loadedText}.`);
        defaultRuntime.log(
          `Reinstall with: ${formatCliCommand("moltbot gateway install --force")}`,
        );
      }
      return;
    }
  }

  const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
    env: process.env,
    port,
    token: opts.token || cfg.gateway?.auth?.token || process.env.CLAWDBOT_GATEWAY_TOKEN,
    runtime: runtimeRaw,
    warn: (message) => {
      if (json) warnings.push(message);
      else defaultRuntime.log(message);
    },
    config: cfg,
  });

  try {
    await service.install({
      env: process.env,
      stdout,
      programArguments,
      workingDirectory,
      environment,
    });
  } catch (err) {
    fail(`Gateway install failed: ${String(err)}`);
    return;
  }

  let installed = true;
  try {
    installed = await service.isLoaded({ env: process.env });
  } catch {
    installed = true;
  }
  emit({
    ok: true,
    result: "installed",
    service: buildDaemonServiceSnapshot(service, installed),
    warnings: warnings.length ? warnings : undefined,
  });
}
