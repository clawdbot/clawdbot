import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";

export async function discoverGatewayName(
  client: GatewayBrowserClient | null,
  methodAdvertised: boolean,
  signal: AbortSignal,
): Promise<string> {
  if (!client || !methodAdvertised) {
    return "";
  }
  try {
    const result = await client.request<SystemInfoResult>("system.info", {}, { signal });
    return (
      normalizeOptionalString(result.machineName) ??
      normalizeOptionalString(result.hostname)?.split(".", 1)[0] ??
      ""
    );
  } catch {
    return "";
  }
}
