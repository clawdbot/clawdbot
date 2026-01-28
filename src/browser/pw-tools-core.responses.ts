import { formatCliCommand } from "../cli/command-format.js";
import { ensurePageState, getPageForTargetId } from "./pw-session.js";
import { normalizeTimeoutMs } from "./pw-tools-core.shared.js";

function matchUrlPattern(pattern: string, url: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (p === url) return true;
  if (p.includes("*")) {
    const escaped = p.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    const regex = new RegExp(`^${escaped.replace(/\*\*/g, ".*").replace(/\*/g, ".*")}$`);
    return regex.test(url);
  }
  return url.includes(p);
}

export async function responseBodyViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  url: string;
  timeoutMs?: number;
  maxChars?: number;
}): Promise<{
  url: string;
  status?: number;
  headers?: Record<string, string>;
  body: string;
  truncated?: boolean;
}> {
  const pattern = String(opts.url ?? "").trim();
  if (!pattern) throw new Error("url is required");
  const maxChars =
    typeof opts.maxChars === "number" && Number.isFinite(opts.maxChars)
      ? Math.max(1, Math.min(5_000_000, Math.floor(opts.maxChars)))
      : 200_000;
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 20_000);

  const page = await getPageForTargetId(opts);
  ensurePageState(page);

  const promise = new Promise<unknown>((resolve, reject) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    let handler: ((resp: unknown) => void) | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (handler) page.off("response", handler as never);
    };

    handler = (resp: unknown) => {
      if (done) return;
      const r = resp as { url?: () => string };
      const u = r.url?.() || "";
      if (!matchUrlPattern(pattern, u)) return;
      done = true;
      cleanup();
      resolve(resp);
    };

    page.on("response", handler as never);
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(
        new Error(
          `Response not found for url pattern "${pattern}". Run '${formatCliCommand("moltbot browser requests")}' to inspect recent network activity.`,
        ),
      );
    }, timeout);
  });

  const resp = (await promise) as {
    url?: () => string;
    status?: () => number;
    headers?: () => Record<string, string>;
    body?: () => Promise<Buffer>;
    text?: () => Promise<string>;
  };

  const url = resp.url?.() || "";
  const status = resp.status?.();
  const headers = resp.headers?.();

  let bodyText = "";
  try {
    if (typeof resp.text === "function") {
      bodyText = await resp.text();
    } else if (typeof resp.body === "function") {
      const buf = await resp.body();
      bodyText = new TextDecoder("utf-8").decode(buf);
    }
  } catch (err) {
    throw new Error(`Failed to read response body for "${url}": ${String(err)}`);
  }

  const trimmed = bodyText.length > maxChars ? bodyText.slice(0, maxChars) : bodyText;
  return {
    url,
    status,
    headers,
    body: trimmed,
    truncated: bodyText.length > maxChars ? true : undefined,
  };
}
