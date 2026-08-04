const USER_AVATAR_ROUTE = /^\/api\/users\/[^/]+\/avatar$/u;

export function gatewayHttpBaseUrl(gatewayUrl: string, documentHref?: string): URL | null {
  try {
    const url = new URL(gatewayUrl, documentHref);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    url.username = "";
    url.password = "";
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/`;
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

export function userAvatarRoute(profileId: string): string {
  return `/api/users/${encodeURIComponent(profileId)}/avatar`;
}

export function gatewayUserAvatarUrl(gatewayBase: URL, route: string): URL | null {
  if (!USER_AVATAR_ROUTE.test(route)) {
    return null;
  }
  return new URL(route.slice(1), gatewayBase);
}

export function gatewayUserAvatarRoute(gatewayBase: URL, pathname: string): string | null {
  const basePath = gatewayBase.pathname.replace(/\/$/u, "");
  if (!pathname.startsWith(`${basePath}/api/users/`)) {
    return null;
  }
  const route = pathname.slice(basePath.length);
  return USER_AVATAR_ROUTE.test(route) ? route : null;
}
