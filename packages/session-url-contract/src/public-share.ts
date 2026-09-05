import { normalizeControlUiBasePath } from "./grammar.js";

export type ControlUiPublicSessionShare = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  shareId: string;
};

export function buildControlUiPublicSessionSharePath(
  params: ControlUiPublicSessionShare & { basePath?: string },
): string {
  const query = new URLSearchParams({ key: params.sessionKey, share: params.shareId });
  return `${normalizeControlUiBasePath(params.basePath)}/share/session/${encodeURIComponent(params.agentId)}/${encodeURIComponent(params.sessionId)}?${query}`;
}

export function parseControlUiPublicSessionShareUrl(
  url: URL,
  basePath?: string,
): ControlUiPublicSessionShare | null {
  const prefix = `${normalizeControlUiBasePath(basePath)}/share/session/`;
  if (url.href.length > 8192 || !url.pathname.startsWith(prefix)) {
    return null;
  }
  const segments = url.pathname.slice(prefix.length).split("/");
  if (
    segments.length !== 2 ||
    url.searchParams.getAll("key").length !== 1 ||
    url.searchParams.getAll("share").length !== 1
  ) {
    return null;
  }
  try {
    const agentId = decodeURIComponent(segments[0] ?? "");
    const sessionId = decodeURIComponent(segments[1] ?? "");
    const sessionKey = url.searchParams.get("key") ?? "";
    const shareId = url.searchParams.get("share") ?? "";
    if (
      !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(agentId) ||
      !sessionId ||
      sessionId.length > 512 ||
      /[\/\\\s\u0000-\u001f\u007f-\u009f]/u.test(sessionId) ||
      !/^[0-9a-f]{48}$/u.test(shareId) ||
      !sessionKey ||
      sessionKey.length > 4096 ||
      /[\u0000-\u001f\u007f]/u.test(sessionKey)
    ) {
      return null;
    }
    return { agentId, sessionId, sessionKey, shareId };
  } catch {
    return null;
  }
}
