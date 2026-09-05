import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sleep } from "../utils/sleep.js";
import { callGatewayFromCli } from "./gateway-rpc.js";

const CLAW_AGENT_RELOAD_TIMEOUT_MS = 15_000;
const CLAW_AGENT_RELOAD_POLL_MS = 100;

export async function waitUntilGatewayAgentAvailable(agentId: string): Promise<void> {
  const deadline = Date.now() + CLAW_AGENT_RELOAD_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = (await callGatewayFromCli("config.get", { timeout: "5000" }, {})) as {
        config?: OpenClawConfig;
        configRevisionHash?: unknown;
        appliedConfigHash?: unknown;
      };
      // Matching tokens can describe a cached roster from before this agent was added.
      if (
        Object.hasOwn(response.config?.agents?.entries ?? {}, agentId) &&
        typeof response.configRevisionHash === "string" &&
        response.configRevisionHash === response.appliedConfigHash
      ) {
        return;
      }
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await sleep(CLAW_AGENT_RELOAD_POLL_MS);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Gateway did not apply the Claw agent configuration in time${suffix}`);
}
