import { resolveGatewayCommandPath } from "../gateway-run-argv.js";

export function isGatewayMachineOutput(argv: readonly string[]): boolean {
  const [, command, action] = resolveGatewayCommandPath([...argv], 3) ?? [];
  return command === "restart-handoff" && (action === "capabilities" || action === "consume");
}
