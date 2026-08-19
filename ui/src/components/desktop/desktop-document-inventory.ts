import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { resolveDesktopDocumentTarget } from "./desktop-source.ts";

export async function resolveDesktopDocumentInventoryTarget(options: {
  client: Pick<GatewayBrowserClient, "request"> | null;
  source: string | null;
  sessionKey: string | null;
  environments: readonly Pick<EnvironmentSummary, "id">[];
}): Promise<string | null> {
  let session: GatewaySessionRow | undefined;
  if (options.source === null && options.sessionKey !== null) {
    // `sessions.describe` is the exact-key lookup; a paged list cannot rule out a later match.
    try {
      session =
        (
          await options.client?.request<{ session?: GatewaySessionRow | null }>(
            "sessions.describe",
            { key: options.sessionKey },
          )
        )?.session ?? undefined;
    } catch {}
  }
  const requestedSource = resolveDesktopDocumentTarget(
    { source: options.source, session: options.sessionKey },
    session,
  );
  return requestedSource !== null &&
    options.environments.some((environment) => environment.id === requestedSource)
    ? requestedSource
    : null;
}
