import { normalizeControlUiBasePath } from "./grammar.js";

export const CONTROL_UI_PUBLIC_SESSION_SHARE_TOKEN_MAX_LENGTH = 7_000;

export type ControlUiPublicSessionShare = {
  token: string;
};

function isSyntacticallyValidPublicSessionToken(token: string): boolean {
  const encoded = token.startsWith("v1.") ? token.slice(3) : "";
  return (
    token.length <= CONTROL_UI_PUBLIC_SESSION_SHARE_TOKEN_MAX_LENGTH &&
    encoded.length > 0 &&
    encoded.length % 4 !== 1 &&
    /^[A-Za-z0-9_-]+$/u.test(encoded)
  );
}

export function buildControlUiPublicSessionSharePath(
  params: ControlUiPublicSessionShare & { basePath?: string },
): string {
  if (!isSyntacticallyValidPublicSessionToken(params.token)) {
    throw new Error("invalid public session token");
  }
  return `${normalizeControlUiBasePath(params.basePath)}/share/session?${new URLSearchParams({ token: params.token })}`;
}

export function parseControlUiPublicSessionShareUrl(
  url: URL,
  basePath?: string,
): ControlUiPublicSessionShare | null {
  if (
    url.href.length > 8192 ||
    url.pathname !== `${normalizeControlUiBasePath(basePath)}/share/session` ||
    url.searchParams.getAll("token").length !== 1 ||
    [...url.searchParams.keys()].some((key) => key !== "token" && key !== "offset")
  ) {
    return null;
  }
  const token = url.searchParams.get("token") ?? "";
  return isSyntacticallyValidPublicSessionToken(token) ? { token } : null;
}
