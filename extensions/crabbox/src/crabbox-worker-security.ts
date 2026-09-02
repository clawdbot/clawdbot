import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { crabboxCommandError } from "./crabbox-worker-command-error.js";
import { runCrabboxCommand, type CrabboxCommandRunner } from "./crabbox-worker-command.js";
import { nonEmptyString } from "./crabbox-worker-profile.js";
import { CRABBOX_LIFECYCLE_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

async function loadCrabboxConfigShow(params: {
  assertAuthorized?: () => void;
  binary: string;
  runCommand: CrabboxCommandRunner;
  signal?: AbortSignal;
}): Promise<unknown> {
  params.signal?.throwIfAborted();
  params.assertAuthorized?.();
  const result = await runCrabboxCommand({
    action: "config show",
    args: ["config", "show", "--json"],
    binary: params.binary,
    runCommand: params.runCommand,
    signal: params.signal,
    timeoutMs: CRABBOX_LIFECYCLE_TIMEOUT_MS,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw crabboxCommandError("config show", result);
  }
  params.signal?.throwIfAborted();
  params.assertAuthorized?.();
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("Crabbox config show returned invalid JSON");
  }
}

export async function assertAwsWorkerHasNoInstanceProfile(params: {
  assertAuthorized?: () => void;
  binary: string;
  runCommand: CrabboxCommandRunner;
  signal?: AbortSignal;
}): Promise<void> {
  const config = await loadCrabboxConfigShow(params);
  const instanceProfile =
    isRecord(config) && isRecord(config.aws) ? config.aws.instanceProfile : undefined;
  if (typeof instanceProfile !== "string") {
    throw new WorkerProviderError("Crabbox config show returned an invalid AWS instance profile");
  }
  if (nonEmptyString(instanceProfile)) {
    throw new WorkerProviderError("Crabbox AWS instance profile must be empty for cloud workers");
  }
}

export async function assertHetznerDesktopHasManagedCoordinator(params: {
  assertAuthorized?: () => void;
  binary: string;
  runCommand: CrabboxCommandRunner;
  signal?: AbortSignal;
}): Promise<void> {
  const config = await loadCrabboxConfigShow(params);
  const view = isRecord(config) ? config : undefined;
  if (nonEmptyString(view?.coordinator) && view?.brokerMode === "managed") {
    return;
  }
  throw new Error("Crabbox Hetzner desktop profiles require a managed coordinator");
}
