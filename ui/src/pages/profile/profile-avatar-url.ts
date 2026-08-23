import { normalizeRouteBasePath } from "@openclaw/uirouter";
import { buildControlUiUserAvatarPath } from "../../../../src/gateway/control-ui-user-avatar-route.js";

export function userProfileAvatarUrl(
  gatewayUrl: string,
  profileId: string,
  revision: string | number,
  resourceBasePath = "",
  documentHref?: string,
): string | null {
  const pageHref = documentHref ?? globalThis.location?.href;
  if (!pageHref) {
    return null;
  }
  try {
    const pageUrl = new URL(pageHref);
    const url = new URL(gatewayUrl, pageUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    // The shared avatar loader authenticates cross-origin Gateway requests and
    // turns their response into a local blob accepted by the Control UI CSP.
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    url.username = "";
    url.password = "";
    const sameOriginResourceBase =
      url.origin === pageUrl.origin ? normalizeRouteBasePath(resourceBasePath) : "";
    return new URL(
      buildControlUiUserAvatarPath(profileId, revision, sameOriginResourceBase),
      url.origin,
    ).href;
  } catch {
    return null;
  }
}
