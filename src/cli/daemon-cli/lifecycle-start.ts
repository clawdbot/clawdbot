import { resolveGatewayService } from "../../daemon/service.js";
import { assertGatewayServiceMutationAllowed } from "../../infra/gateway-supervision.js";
import { recoverInstalledLaunchAgent } from "./launchd-recovery.js";
import { appendGatewayLifecycleAudit } from "./lifecycle-audit.js";
import { resolveGatewayConfigPorts, resolveGatewayLifecycleContext } from "./lifecycle-context.js";
import { runServiceStart } from "./lifecycle-core.js";
import { renderGatewayServiceStartHints } from "./shared.js";
import { verifyGatewayStartReadiness } from "./start-health.js";
import { repairLoadedGatewayServiceForStart } from "./start-repair.js";
import type { DaemonLifecycleOptions } from "./types.js";

/** Start the managed Gateway service, repairing stale service definitions when possible. */
export async function runDaemonStart(opts: DaemonLifecycleOptions = {}) {
  assertGatewayServiceMutationAllowed("start the gateway");
  const service = resolveGatewayService();
  const expectedPort = (await resolveGatewayConfigPorts()).explicit;
  return await runServiceStart({
    serviceNoun: "Gateway",
    service,
    renderStartHints: renderGatewayServiceStartHints,
    onNotLoaded:
      process.platform === "darwin"
        ? async () => {
            const recovered = await recoverInstalledLaunchAgent({ result: "started" });
            if (recovered) {
              appendGatewayLifecycleAudit({
                action: "start",
                source: "cli",
                mode: "launchd-bootstrap",
              });
            }
            return recovered;
          }
        : undefined,
    repairLoadedService: async ({ json, stdout, warn, state, issues }) =>
      await repairLoadedGatewayServiceForStart({
        service,
        json,
        stdout,
        warn,
        state,
        issues,
      }),
    postStartCheck: ({ fail, warnings }) =>
      verifyGatewayStartReadiness({
        service,
        expectedPort,
        json: Boolean(opts.json),
        resolveContext: () => resolveGatewayLifecycleContext(service),
        fail,
        warnings,
      }),
    expectedPort,
    opts,
  });
}
