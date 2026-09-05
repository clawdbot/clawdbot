import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { runDaemonInstall } from "../daemon-cli/install.js";
import { resolveNodeRunner, type UpdateCommandOptions } from "./shared.js";
import { resolveUpdatedInstallCommandEnv } from "./update-command-service-env.js";
import { isPackageManagerUpdateMode } from "./update-command-service-recovery.js";

const SERVICE_REFRESH_TIMEOUT_MS = 60_000;
export const DEFINITION_DENIAL = /\bSERVICE_DEFINITION_(?:SEALED|UNKNOWN):[^\n]*/;

function formatCommandFailure(stdout: string, stderr: string): string {
  // Keep the stable denial even when JSON stdout accompanies unrelated stderr warnings.
  const error = safeParseJsonRecord(stdout)?.error;
  const detail =
    `${stderr}\n${stdout}`.match(DEFINITION_DENIAL)?.[0] ??
    (typeof error === "string" ? error : stderr || stdout).trim();
  return detail ? detail.split("\n").slice(-3).join("\n") : "command returned a non-zero exit code";
}

// Loaded before package replacement: activation dependencies must stay eager.
// Candidate version/preservation guards reject older targets before repair, without retry.
export async function runUpdatedInstallGatewayCommand(
  params: {
    result: { root?: string; mode?: UpdateRunResult["mode"] };
    opts: Pick<UpdateCommandOptions, "json">;
    invocationEnv: NodeJS.ProcessEnv;
    serviceEnv?: NodeJS.ProcessEnv;
    serviceInstallEnv?: NodeJS.ProcessEnv | null;
    nodeRunner?: string;
    timeoutMs?: number;
    invocationCwd?: string;
  },
  action: "install" | "restart",
  preserveDefinition = false,
): Promise<boolean> {
  const installing = action === "install";
  const entrypoint = await resolveGatewayInstallEntrypoint(params.result.root);
  if (!entrypoint) {
    if (installing) {
      if (!isPackageManagerUpdateMode(params.result.mode ?? "unknown")) {
        await runDaemonInstall({ force: true, json: params.opts.json || undefined });
        return true;
      }
    }
    throw new Error(
      `updated install entrypoint not found under ${params.result.root ?? "unknown"}`,
    );
  }
  const args = ["gateway", action];
  if (installing) {
    args.push("--force");
  } else if (preserveDefinition) {
    args.push("--preserve-definition");
  }
  if (params.opts.json) {
    args.push("--json");
  }
  const nodeRunner = params.nodeRunner ?? resolveNodeRunner();
  const res = await runCommandWithTimeout([nodeRunner, entrypoint, ...args], {
    // The complete owned env must not regain selectors removed during capture.
    baseEnv: {},
    cwd: params.result.root,
    env: resolveUpdatedInstallCommandEnv({
      processEnv: installing
        ? (params.serviceInstallEnv ?? params.invocationEnv)
        : params.invocationEnv,
      serviceEnv: installing ? undefined : params.serviceEnv,
      invocationCwd: params.invocationCwd,
    }),
    // Restart owns migration-aware readiness; only refresh has the fixed watchdog.
    timeoutMs: installing ? SERVICE_REFRESH_TIMEOUT_MS : params.timeoutMs,
  });
  if (res.code === 0) {
    return true;
  }
  const operation = installing ? "refresh" : "restart";
  throw new Error(
    `updated install ${operation} failed (${entrypoint}): ${formatCommandFailure(res.stdout, res.stderr)}`,
  );
}
