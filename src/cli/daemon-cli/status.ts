// Gateway service status command entrypoint: gathers status, prints it, and handles probe failures.
import { colorize, isRich, theme } from "../../../packages/terminal-core/src/theme.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliJsonFailure } from "../failure-output.js";
import { gatherDaemonStatus } from "./status.gather.js";
import { printDaemonStatus } from "./status.print.js";
import type { DaemonStatusOptions } from "./types.js";

function failDaemonStatus(opts: DaemonStatusOptions, message: string): void {
  if (opts.json) {
    defaultRuntime.writeJson(formatCliJsonFailure(message));
  } else {
    defaultRuntime.error(colorize(isRich(), theme.error, message));
  }
  defaultRuntime.exit(1);
}

/** Run Gateway status diagnostics and apply --require-rpc exit behavior. */
export async function runDaemonStatus(opts: DaemonStatusOptions) {
  if (opts.requireRpc && !opts.probe) {
    failDaemonStatus(
      opts,
      "Gateway status failed: --require-rpc needs probing enabled. Remove --no-probe or drop --require-rpc.",
    );
    return;
  }

  let status: Awaited<ReturnType<typeof gatherDaemonStatus>>;
  try {
    status = await gatherDaemonStatus({
      rpc: opts.rpc,
      probe: opts.probe,
      requireRpc: opts.requireRpc,
      deep: opts.deep === true,
    });
    printDaemonStatus(status, { json: opts.json, deep: opts.deep === true });
  } catch (err) {
    failDaemonStatus(opts, `Gateway status failed: ${formatErrorMessage(err)}`);
    return;
  }

  if (opts.requireRpc && !status.rpc?.ok) {
    defaultRuntime.exit(1);
  }
}
