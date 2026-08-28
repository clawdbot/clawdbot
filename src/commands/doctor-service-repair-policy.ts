/** Doctor policy for native gateway service ownership and repair. */
import { isContainerEnvironment } from "../infra/container-environment.js";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type ServiceRepairPolicy = "auto" | "external";
const GATEWAY_SERVICE_MANAGER_TIMEOUT_MS = 5_000;

export const SERVICE_REPAIR_POLICY_ENV = "OPENCLAW_SERVICE_REPAIR_POLICY";

export const EXTERNAL_SERVICE_REPAIR_NOTE =
  "Gateway service is managed externally; skipped service install/start repair. Start or repair the gateway through your supervisor.";

export async function shouldManageGatewayService(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (
    isGatewayExternallySupervised(env) ||
    (env.KUBERNETES_SERVICE_HOST?.trim() && env.KUBERNETES_SERVICE_PORT?.trim())
  ) {
    return false;
  }
  if (!isContainerEnvironment()) {
    return true;
  }
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const { findInstalledSystemdGatewayScope } = await import("../daemon/systemd.js");
    // Container placement is not ownership; user Doctor can repair only its
    // installed user unit through a reachable systemd user manager.
    if ((await findInstalledSystemdGatewayScope(env))?.scope !== "user") {
      return false;
    }
    const { resolveGatewayService } = await import("../daemon/service.js");
    await resolveGatewayService().isLoaded({ env, timeoutMs: GATEWAY_SERVICE_MANAGER_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** Resolves whether doctor may repair managed services or must defer to an external supervisor. */
export function resolveServiceRepairPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ServiceRepairPolicy {
  return env[SERVICE_REPAIR_POLICY_ENV]?.trim().toLowerCase() === "external" ? "external" : "auto";
}

/** Returns true when Doctor service mutations must defer to an external supervisor. */
export function isServiceRepairExternallyManaged(
  policy: ServiceRepairPolicy = resolveServiceRepairPolicy(),
): boolean {
  return policy === "external" || isGatewayExternallySupervised();
}

/** Confirms a service repair unless Doctor mutations are externally managed. */
export async function confirmDoctorServiceRepair(
  prompter: DoctorPrompter,
  params: Parameters<DoctorPrompter["confirmRuntimeRepair"]>[0],
  policy: ServiceRepairPolicy = resolveServiceRepairPolicy(),
): Promise<boolean> {
  return !isServiceRepairExternallyManaged(policy) && (await prompter.confirmRuntimeRepair(params));
}
