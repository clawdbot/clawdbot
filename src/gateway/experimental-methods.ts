import { isExperimentalClawsEnabled } from "../claws/experimental.js";

export function isGatewayMethodAvailableForEnv(
  method: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !method.startsWith("claws.") || isExperimentalClawsEnabled(env);
}
