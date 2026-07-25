import { buildSandboxHostPath } from "../agents/sandbox-host.js";
import type { BoardWidgetDocument } from "../boards/board-store.js";

function grantedConnectOrigins(document: BoardWidgetDocument): string[] | undefined {
  if (!("html" in document) || document.grantState !== "granted") {
    return undefined;
  }
  const origins = document.declared?.netOrigins;
  return origins?.length ? origins : undefined;
}

export function buildBoardWidgetSandboxPath(document: BoardWidgetDocument): string {
  const connectDomains = grantedConnectOrigins(document);
  return buildSandboxHostPath({
    // Best-effort hardening for the documented WebRTC residual; the DOM guard
    // reduces fresh descendant realms but is not an authorization boundary.
    blockDescendantFrames: true,
    ...(connectDomains ? { connectDomains } : {}),
  });
}

/** Defense in depth for direct/legacy widget document loads outside the proxy host. */
export function buildBoardWidgetContentSecurityPolicy(document: BoardWidgetDocument): string {
  const connectSources = grantedConnectOrigins(document)?.join(" ") ?? "'none'";
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    `connect-src ${connectSources}`,
    "webrtc 'block'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "sandbox allow-scripts",
  ].join("; ");
}
