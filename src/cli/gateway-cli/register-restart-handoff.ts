// Hidden machine-facing gateway restart-handoff commands for external supervisors.
import type { Command } from "commander";
import { parseStrictPositiveInteger } from "../../infra/parse-finite-number.js";
import {
  createGatewayRestartHandoffCapabilities,
  GATEWAY_RESTART_HANDOFF_PROTOCOL,
  GATEWAY_RESTART_HANDOFF_PROTOCOL_VERSION,
} from "../../infra/restart-handoff-contract.js";
import { defaultRuntime } from "../../runtime.js";

function writeRestartHandoffError(reason: "invalid-expected-pid" | "store-unavailable") {
  defaultRuntime.writeJson({
    ok: false,
    protocol: GATEWAY_RESTART_HANDOFF_PROTOCOL,
    protocolVersion: GATEWAY_RESTART_HANDOFF_PROTOCOL_VERSION,
    status: "error",
    reason,
  });
}

function collectExpectedPid(value: string, previous: unknown): unknown[] {
  return Array.isArray(previous) ? [...previous, value] : [previous, value];
}

export function addGatewayRestartHandoffCommands(gateway: Command): void {
  const restartHandoff = gateway.command("restart-handoff", { hidden: true });

  restartHandoff
    .command("capabilities")
    .description("Report the gateway restart-handoff machine contract")
    .option("--json", "Output JSON", false)
    .action(() => {
      defaultRuntime.writeJson({
        ok: true,
        ...createGatewayRestartHandoffCapabilities(),
      });
    });

  restartHandoff
    .command("consume")
    .description("Atomically consume a gateway restart handoff")
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .option("--expected-pid [pid]", "PID of the exited gateway process", collectExpectedPid, [])
    .option("--json", "Output JSON", false)
    .action(async (opts, command: Command) => {
      const expectedPidValues = Array.isArray(opts.expectedPid) ? opts.expectedPid : [];
      const expectedPid =
        command.args.length === 0 && expectedPidValues.length === 1
          ? parseStrictPositiveInteger(expectedPidValues[0])
          : undefined;
      if (expectedPid === undefined || !Number.isSafeInteger(expectedPid)) {
        writeRestartHandoffError("invalid-expected-pid");
        defaultRuntime.exit(2);
        return;
      }
      try {
        const { consumeGatewayRestartHandoffSync } = await import("../../infra/restart-handoff.js");
        const result = consumeGatewayRestartHandoffSync({ expectedPid });
        defaultRuntime.writeJson({
          ok: true,
          protocol: GATEWAY_RESTART_HANDOFF_PROTOCOL,
          protocolVersion: GATEWAY_RESTART_HANDOFF_PROTOCOL_VERSION,
          ...result,
        });
      } catch (err) {
        defaultRuntime.error(`Gateway restart handoff consume failed: ${String(err)}`);
        writeRestartHandoffError("store-unavailable");
        defaultRuntime.exit(1);
      }
    });
}
