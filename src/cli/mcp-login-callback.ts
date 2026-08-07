// Loopback callback server for `openclaw mcp login` browser redirects.
import type { Server } from "node:http";

/** Browser redirect payload captured on the loopback callback route. */
export type McpLoginCallback = {
  code: string;
  state: string;
};

export type McpLoginCallbackServer = {
  server: Server;
  cancelWait: () => void;
  waitForCallback: () => Promise<McpLoginCallback | null>;
};

/** Max time the CLI waits for the browser to return to the loopback redirect. */
const MCP_LOGIN_CALLBACK_WAIT_MS = 5 * 60 * 1000;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** True when the redirect URI targets the local machine over plain HTTP. */
export function isMcpLoginLoopbackRedirectUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.startsWith("[") ? parsed.hostname.slice(1, -1) : parsed.hostname;
  return parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.has(hostname);
}

function renderHtml(title: string, detail?: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem;">
<h1>${title}</h1>
${detail ? `<p>${detail}</p>` : ""}
</body>
</html>
`;
}

function renderSuccessHtml(serverName: string): string {
  return renderHtml(
    "OpenClaw MCP login complete",
    `OAuth credentials for MCP server &quot;${serverName}&quot; were saved. You can close this window.`,
  );
}

function renderErrorHtml(detail: string): string {
  return renderHtml("OpenClaw MCP login failed", detail);
}

/**
 * Starts an HTTP listener for a loopback OAuth redirect URI.
 *
 * Only loopback URIs are supported; callers must gate with
 * {@link isMcpLoginLoopbackRedirectUrl}. The server answers the browser on the
 * exact redirect path, then settles {@link waitForCallback} with the captured
 * `code`/`state`. The wait settles with `null` on timeout or {@link cancelWait}.
 */
export async function startMcpLoginCallbackServer(
  redirectUrl: string,
  options: { serverName?: string; waitMs?: number } = {},
): Promise<McpLoginCallbackServer> {
  const { createServer } = await import("node:http");
  const parsed = new URL(redirectUrl);
  const waitMs = options.waitMs ?? MCP_LOGIN_CALLBACK_WAIT_MS;
  const hostname = parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname;
  const port = Number(parsed.port);
  const callbackPath = parsed.pathname || "/";

  return await new Promise((resolve, reject) => {
    let settleWait: ((value: McpLoginCallback | null) => void) | undefined;
    const waitForCallbackPromise = new Promise<McpLoginCallback | null>((resolveWait) => {
      let settled = false;
      settleWait = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolveWait(value);
      };
    });
    const timeout = setTimeout(() => settleWait?.(null), waitMs);

    const server = createServer((req, res) => {
      const respond = (status: number, body: string) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(body);
      };
      try {
        const url = new URL(req.url ?? "", redirectUrl);
        if (url.pathname !== callbackPath) {
          respond(404, renderErrorHtml("Callback route not found."));
          return;
        }
        const error = url.searchParams.get("error");
        if (error) {
          respond(400, renderErrorHtml(`Authorization failed with error: ${error}`));
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) {
          respond(400, renderErrorHtml("Missing code or state parameter."));
          return;
        }
        respond(200, renderSuccessHtml(options.serverName ?? "MCP"));
        settleWait?.({ code, state });
      } catch {
        respond(500, renderErrorHtml("Internal error."));
      }
    });

    server.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    server.listen(port, hostname, () => {
      resolve({
        server,
        cancelWait: () => {
          clearTimeout(timeout);
          settleWait?.(null);
        },
        waitForCallback: () => waitForCallbackPromise,
      });
    });
  });
}
