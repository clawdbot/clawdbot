import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";

export function addGatewayPreflightCommand(gateway: Command): void {
  gateway
    .command("preflight")
    .description("Inspect deterministic startup prerequisites without changing state")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      const { gatewayPreflightCommand } = await import("../../commands/gateway-preflight.js");
      await gatewayPreflightCommand({ json: Boolean(opts.json) }, defaultRuntime);
    });
}
