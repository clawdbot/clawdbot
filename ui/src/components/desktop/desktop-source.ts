import type { DesktopSource, EnvironmentSummary } from "@openclaw/gateway-protocol";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { DesktopDocumentOptions } from "../../app/desktop-document-mode.ts";
import { resolveChatPaneDesktopTarget } from "../../pages/chat/chat-pane-placement.ts";

export function desktopSourceForEnvironment(
  environment: Pick<EnvironmentSummary, "id">,
): DesktopSource {
  if (environment.id === "gateway") {
    return { kind: "host" };
  }
  if (environment.id.startsWith("node:") && environment.id.length > "node:".length) {
    return { kind: "node", nodeId: environment.id.slice("node:".length) };
  }
  return { kind: "environment", environmentId: environment.id };
}

/**
 * Lives beside the lazily loaded panel rather than in the route module: the chat placement
 * owner pulls the chat page's dependency tree, which must stay out of the startup chunk.
 */
export function resolveDesktopDocumentTarget(
  options: DesktopDocumentOptions,
  session: GatewaySessionRow | undefined,
): string | null {
  return options.source ?? (options.session ? resolveChatPaneDesktopTarget(session) : null);
}
