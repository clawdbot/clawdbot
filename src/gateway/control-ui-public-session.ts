import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildControlUiPublicSessionSharePath,
  parseControlUiPublicSessionShareUrl,
} from "@openclaw/session-url-contract/public-share";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isReadHttpMethod } from "./control-ui-http-utils.js";
import { resolveControlUiShareOrigin } from "./control-ui-share.js";

export async function serveControlUiPublicSession(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  basePath: string,
  cfg: OpenClawConfig | undefined,
  publicOrigin?: string,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  const unavailable = (status: number) => {
    const body =
      status === 404
        ? "This public session is unavailable."
        : "This public session is temporarily unavailable. Please retry.";
    res.statusCode = status;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    res.end(req.method === "HEAD" ? undefined : body);
  };
  const locator = parseControlUiPublicSessionShareUrl(url, basePath);
  const origin = resolveControlUiShareOrigin(req, publicOrigin);
  const offsetText = url.searchParams.get("offset") ?? "0";
  const offset = Number(offsetText);
  if (
    !isReadHttpMethod(req.method) ||
    !locator ||
    !origin ||
    !cfg ||
    url.searchParams.getAll("offset").length > 1 ||
    !/^(?:0|[1-9][0-9]{0,9})$/u.test(offsetText)
  ) {
    unavailable(404);
    return;
  }
  try {
    const [{ readPublicSessionShare }, { renderPublicSessionDocument }] = await Promise.all([
      import("./control-ui-public-session-read.js"),
      import("./control-ui-public-session-render.js"),
    ]);
    const session = await readPublicSessionShare(cfg, locator, { offset });
    if (!session) {
      unavailable(404);
      return;
    }
    const canonicalUrl = `${origin}${buildControlUiPublicSessionSharePath({ ...locator, basePath })}`;
    const body = renderPublicSessionDocument({
      ...session,
      canonicalUrl,
      isLatest: offset === 0,
      ...(session.olderOffset !== undefined
        ? { olderUrl: `${canonicalUrl}&offset=${session.olderOffset}` }
        : {}),
      cardUrl: `${origin}${basePath}/share/card.png`,
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    unavailable(503);
  }
}
