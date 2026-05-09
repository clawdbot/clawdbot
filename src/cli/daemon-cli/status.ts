import { defaultRuntime } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { gatherDaemonStatus } from "./status.gather.js";
import { printDaemonStatus } from "./status.print.js";
import type { DaemonStatusOptions } from "./types.js";

export async function runDaemonStatus(opts: DaemonStatusOptions) {
  try {
    if (opts.requireRpc && !opts.probe) {
      defaultRuntime.error(
        "Gateway status failed: --require-rpc needs probing enabled. Remove --no-probe or drop --require-rpc.",
      );
      defaultRuntime.exit(1);
      return;
    }
    const status = await gatherDaemonStatus({
      rpc: opts.rpc,
      probe: opts.probe,
      requireRpc: opts.requireRpc,
      deep: opts.deep === true,
    });
    printDaemonStatus(status, { json: opts.json });
    if (opts.requireRpc && !status.rpc?.ok) {
      defaultRuntime.exit(1);
    }
  } catch (err) {
    const rich = isRich();
    defaultRuntime.error(colorize(rich, theme.error, `Gateway status failed: ${String(err)}`));
    defaultRuntime.exit(1);
  }
}
