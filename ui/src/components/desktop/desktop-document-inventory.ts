import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { resolveDesktopDocumentSessionTarget } from "./desktop-session-controller.ts";

export async function resolveDesktopDocumentInventoryTarget(options: {
  client: Pick<GatewayBrowserClient, "request"> | null;
  source: string | null;
  sessionKey: string | null;
  environments: readonly Pick<EnvironmentSummary, "id">[];
  resolvedSessionTarget?: string | null;
}): Promise<string | null> {
  const requestedSource =
    options.source ??
    (options.resolvedSessionTarget !== undefined
      ? options.resolvedSessionTarget
      : options.sessionKey !== null
        ? await resolveDesktopDocumentSessionTarget(options.client, options.sessionKey)
        : null);
  return requestedSource !== null &&
    options.environments.some((environment) => environment.id === requestedSource)
    ? requestedSource
    : null;
}
