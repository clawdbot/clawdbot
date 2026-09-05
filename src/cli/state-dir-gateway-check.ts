import path from "node:path";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayService } from "../daemon/service.js";
import {
  buildGatewayConnectionDetails,
  callGateway,
  isGatewayCredentialsRequiredError,
} from "../gateway/call.js";
import type { GatewayClientOptions } from "../gateway/client.js";
import { projectGatewayUrlForDiagnostics } from "../gateway/connection-details.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";
import { isLoopbackGatewayUrl } from "../gateway/net.js";
import { probeGateway } from "../gateway/probe.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { quoteCliArg } from "./quote-cli-arg.js";

const STATE_DIR_CHECK_TIMEOUT_MS = 3_000;
export type GatewayHello = Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0];

export type CliGatewayStateDirOutcome =
  | { kind: "allow" }
  | { kind: "warn"; message: string }
  | { kind: "refuse"; message: string };

export const GATEWAY_SERVICE_PATHS_UNVERIFIED =
  "Installed Gateway service state and config paths could not be verified. Inspect the service environment with `openclaw gateway status --deep` before repairing plugin state.";

export async function inspectInstalledGatewayStatePaths(
  timeoutMs = STATE_DIR_CHECK_TIMEOUT_MS,
): Promise<
  { kind: "known"; stateDir: string; configPath: string } | { kind: "absent" | "unknown" }
> {
  try {
    const serviceEnv = { ...process.env };
    // CLI overrides select its store; only recorded service values describe the other store.
    delete serviceEnv.OPENCLAW_STATE_DIR;
    delete serviceEnv.OPENCLAW_CONFIG_PATH;
    delete serviceEnv.OPENCLAW_HOME;
    const command = await resolveGatewayService().readCommand(serviceEnv, {
      timeoutMs,
      requireEffective: true,
    });
    if (!command) {
      return { kind: "absent" };
    }
    const environment = command.environment;
    if (
      !environment ||
      !["OPENCLAW_STATE_DIR", "OPENCLAW_HOME", "HOME", "USERPROFILE"].some((key) =>
        environment[key]?.trim(),
      )
    ) {
      return { kind: "unknown" };
    }
    return {
      kind: "known",
      stateDir: resolveStateDir(environment),
      configPath: resolveConfigPath(environment),
    };
  } catch {
    return { kind: "unknown" };
  }
}

export function compareCliGatewayStateDirs(params: {
  cliStateDir: string;
  cliConfigPath: string;
  gatewayStateDir: string;
  gatewayConfigPath?: string;
  source: "live Gateway" | "installed Gateway service";
  mode: "refuse" | "warn";
  command?: string;
}): CliGatewayStateDirOutcome {
  const cliStateDir = resolveIdentityPathViaExistingAncestorSync(params.cliStateDir);
  const cliConfigPath = resolveIdentityPathViaExistingAncestorSync(params.cliConfigPath);
  const gatewayStateDir = resolveIdentityPathViaExistingAncestorSync(params.gatewayStateDir);
  const gatewayConfigPath = resolveIdentityPathViaExistingAncestorSync(
    params.gatewayConfigPath ?? path.join(gatewayStateDir, "openclaw.json"),
  );
  const differences = [
    cliStateDir !== gatewayStateDir &&
      `state directories (CLI: ${params.cliStateDir}; Gateway: ${gatewayStateDir})`,
    cliConfigPath !== gatewayConfigPath &&
      `config paths (CLI: ${params.cliConfigPath}; Gateway: ${gatewayConfigPath})`,
  ].filter((difference): difference is string => Boolean(difference));
  if (differences.length === 0) {
    return { kind: "allow" };
  }
  const detail = differences.join(" and ");
  if (params.mode === "warn") {
    return {
      kind: "warn",
      message: `CLI and ${params.source} use different ${detail}. Local commands may read or write state the Gateway does not use.`,
    };
  }
  return {
    kind: "refuse",
    message: [
      `No credentials or configuration were written. CLI and ${params.source} use different ${detail}.`,
      `Fix: run OPENCLAW_STATE_DIR=${quoteCliArg(gatewayStateDir)} OPENCLAW_CONFIG_PATH=${quoteCliArg(gatewayConfigPath)} ${params.command ?? "openclaw configure"}.`,
      params.source === "live Gateway"
        ? "To write another local store intentionally, stop the running Gateway first."
        : "To write another local store intentionally, uninstall or reconfigure the divergent Gateway service first.",
    ].join(" "),
  };
}

export async function checkCliGatewayStateDir(params: {
  command: string;
  config?: OpenClawConfig;
}): Promise<CliGatewayStateDirOutcome> {
  const cliStateDir = resolveStateDir(process.env);
  const cliConfigPath = resolveConfigPath(process.env);
  const details = buildGatewayConnectionDetails({ config: params.config });
  if (!isLoopbackGatewayUrl(details.url)) {
    return {
      kind: "warn",
      message: `Gateway target ${projectGatewayUrlForDiagnostics(details.url)} is remote. Local credentials and configuration do not reach that Gateway.`,
    };
  }

  let hello: GatewayHello | undefined;
  let connectionError: unknown;
  try {
    await callGateway({
      config: params.config,
      method: "status",
      params: { includeChannelSummary: false },
      scopes: [ADMIN_SCOPE],
      sharedStateMode: "read-only",
      timeoutMs: STATE_DIR_CHECK_TIMEOUT_MS,
      onHelloOk: (value) => {
        hello = value;
      },
    });
  } catch (error) {
    connectionError = error;
  }
  if (hello?.snapshot.stateDir) {
    return compareCliGatewayStateDirs({
      cliStateDir,
      cliConfigPath,
      gatewayStateDir: hello.snapshot.stateDir,
      gatewayConfigPath: hello.snapshot.configPath,
      source: "live Gateway",
      mode: "refuse",
      command: params.command,
    });
  }

  const servicePaths = await inspectInstalledGatewayStatePaths();
  if (servicePaths.kind === "unknown") {
    return { kind: "warn", message: GATEWAY_SERVICE_PATHS_UNVERIFIED };
  }
  if (servicePaths.kind === "known") {
    return compareCliGatewayStateDirs({
      cliStateDir,
      cliConfigPath,
      gatewayStateDir: servicePaths.stateDir,
      gatewayConfigPath: servicePaths.configPath,
      source: "installed Gateway service",
      mode: "refuse",
      command: params.command,
    });
  }

  if (isGatewayCredentialsRequiredError(connectionError)) {
    const probe = await probeGateway({
      url: details.url,
      config: params.config,
      timeoutMs: STATE_DIR_CHECK_TIMEOUT_MS,
      includeDetails: false,
      suppressStoredDeviceAuth: true,
    });
    if (probe.gatewayReached) {
      return {
        kind: "warn",
        message:
          "Gateway is reachable but requires credentials, so its state and config paths could not be verified. Local writes may not reach it.",
      };
    }
  }
  return { kind: "allow" };
}
