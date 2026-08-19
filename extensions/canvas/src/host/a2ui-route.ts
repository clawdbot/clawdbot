import { detectMime } from "openclaw/plugin-sdk/media-mime";
import { lowercasePreservingWhitespace } from "openclaw/plugin-sdk/string-coerce-runtime";
import { A2UI_PATH, isA2uiPath } from "./a2ui-shared.js";
import { resolveFileWithinRoot } from "./file-resolver.js";

type A2uiRootResolver = () => Promise<string | null>;
type A2uiHttpRequest = { method?: string; url?: string };
type A2uiHttpResponse = {
  statusCode: number;
  setHeader(name: string, value: number | string | readonly string[]): void;
  end(chunk?: Buffer | string): void;
};

export async function handleA2uiHttpRequestWithRootResolver(
  req: A2uiHttpRequest,
  res: A2uiHttpResponse,
  resolveRootReal: A2uiRootResolver,
): Promise<boolean> {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath = isA2uiPath(url.pathname) ? A2UI_PATH : undefined;
  if (!basePath) {
    return false;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const a2uiRootReal = await resolveRootReal();
  if (!a2uiRootReal) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("A2UI assets not found");
    return true;
  }

  const rel = url.pathname.slice(basePath.length);
  const result = await resolveFileWithinRoot(a2uiRootReal, rel || "/");
  if (!result) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("not found");
    return true;
  }

  try {
    const lower = lowercasePreservingWhitespace(result.realPath);
    const mime =
      lower.endsWith(".html") || lower.endsWith(".htm")
        ? "text/html"
        : ((await detectMime({ filePath: result.realPath })) ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");

    if (mime === "text/html") {
      const buf = await result.handle.readFile({ encoding: "utf8" });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (req.method === "HEAD") {
        res.setHeader("Content-Length", String(Buffer.byteLength(buf)));
        res.end();
        return true;
      }
      res.end(buf);
      return true;
    }

    res.setHeader("Content-Type", mime);
    if (req.method === "HEAD") {
      res.setHeader("Content-Length", String(result.stat.size));
      res.end();
      return true;
    }
    res.end(await result.handle.readFile());
    return true;
  } finally {
    await result.handle.close().catch(() => {});
  }
}
