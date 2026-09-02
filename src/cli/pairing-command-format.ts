import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatCliCommand } from "./command-format.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";
import { quoteCliArg } from "./quote-cli-arg.js";

/** Format an exact-request approval hint; callers keep token/password flags in reminders. */
export function formatPairingApproveCommand(
  group: "devices" | "nodes",
  requestId: string,
  opts: Pick<GatewayRpcOpts, "url" | "timeout" | "json"> = {},
): string {
  const args = ["openclaw", group, "approve", requestId];
  const url = normalizeOptionalString(opts.url);
  if (url) {
    args.push("--url", url);
  }
  const timeout = normalizeOptionalString(opts.timeout);
  // Both pairing commands default to a 10-second RPC timeout.
  if (timeout && timeout !== "10000") {
    args.push("--timeout", timeout);
  }
  if (opts.json === true) {
    args.push("--json");
  }
  return formatCliCommand(args.map(quoteCliArg).join(" "));
}
