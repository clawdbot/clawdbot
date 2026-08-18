// Gateway-scoped port probe for lifecycle stop when no owning PID is found.
import { resolveGatewayServiceProbeHosts } from "../../daemon/gateway-service-probe-hosts.js";
import { probePortUsage } from "../../infra/ports-probe.js";
import { formatCliCommand } from "../command-format.js";

/**
 * Throws when the gateway-configured port is provably busy but no owning PID
 * was found. Probes only the interfaces the gateway is configured to bind,
 * preventing false positives from unrelated listeners on other addresses.
 */
export async function throwIfGatewayPortBusyWithoutOwner(port: number): Promise<void> {
  const probeHosts = await resolveGatewayServiceProbeHosts({});
  if ((await probePortUsage(port, probeHosts)) === "busy") {
    throw new Error(
      `Port ${port} is in use but the owning process could not be identified. Run ${formatCliCommand("openclaw gateway status --deep")} to diagnose.`,
    );
  }
}
