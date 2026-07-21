import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";

function shortHostname(value: unknown): string {
  return normalizeOptionalString(value)?.split(".", 1)[0] ?? "";
}

export class GatewayNameDiscovery {
  private requestToken = 0;

  constructor(
    private readonly snapshot: () => ApplicationContext["gateway"]["snapshot"] | undefined,
    private readonly update: (name: string) => void,
  ) {}

  invalidate() {
    this.requestToken += 1;
    this.update("");
  }

  async load() {
    const requestId = ++this.requestToken;
    const snapshot = this.snapshot();
    const client = snapshot?.client;
    if (
      !snapshot?.connected ||
      !client ||
      isGatewayMethodAdvertised(snapshot, "system.info") !== true
    ) {
      this.update("");
      return;
    }
    try {
      const result = await client.request<SystemInfoResult>("system.info", {});
      if (requestId === this.requestToken) {
        this.update(normalizeOptionalString(result.machineName) ?? shortHostname(result.hostname));
      }
    } catch {
      if (requestId === this.requestToken) {
        this.update("");
      }
    }
  }
}
