// Fixture HTTP server for browser CDP snapshot E2E scenarios.
import http from "node:http";
import { readTcpPortEnv } from "../env-limits.mjs";

const port = readTcpPortEnv("FIXTURE_PORT");

const html = `<!doctype html>
<html>
  <body>
    <main>
      <button>Save</button>
      <a href="https://docs.openclaw.ai/browser-cdp-live">Docs</a>
      <div id="card" onclick="window.__clicked = true" style="cursor: pointer">Clickable Card</div>
      <iframe title="Child" srcdoc='<button>Inside</button>'></iframe>
    </main>
  </body>
</html>`;

http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  })
  .listen(port, "127.0.0.1");
