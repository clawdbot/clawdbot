import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { handleControlUiHttpRequest } from "./control-ui.js";

describe("public Control UI previews", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  it.each(["", "/control"])("serves a private-data-free preview under %s", async (basePath) => {
    const root = tempDirs.make("openclaw-social-preview-");
    const cardBytes = fs.readFileSync(path.resolve("ui/public/apple-touch-icon.png"));
    fs.writeFileSync(path.join(root, "social-card.png"), cardBytes);
    const server = createServer((req, res) => {
      void handleControlUiHttpRequest(req, res, {
        basePath,
        root: { kind: "resolved", path: root },
        config: { gateway: { publicOrigin: "https://gateway.example.test" } },
        auth: { mode: "token", token: "test-only-token", allowTailscale: false },
      }).then((handled) => {
        if (!handled) {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing test server address");
    }
    const origin = `http://127.0.0.1:${address.port}${basePath}`;
    try {
      const route = "/share/dashboard/example/private-name";
      const response = await fetch(`${origin}${route}?token=secret-value&draft=private-draft`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      expect(html).toContain('<meta property="og:title" content="OpenClaw dashboard">');
      expect(html).toContain(`content="https://gateway.example.test${basePath}/share/card.png"`);
      expect(html).toContain(`href="${basePath}/dashboard/example/private-name"`);
      expect(html).not.toMatch(/secret-value|private-draft|<script|openclaw-app/);
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      const head = await fetch(`${origin}${route}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(Number(head.headers.get("content-length"))).toBe(Buffer.byteLength(html));
      const card = await fetch(`${origin}/share/card.png`);
      expect(card.status).toBe(200);
      expect(card.headers.get("content-type")).toContain("image/png");
      const png = Buffer.from(await card.arrayBuffer());
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png).toEqual(cardBytes);
      const catalog = await fetch(
        `${origin}/share/chat/example?catalog=example&host=dev%3Amac&thread=a%22%3E%3Cscript%3E&token=secret-value`,
      );
      expect(await catalog.text()).toContain(
        `href="${basePath}/chat/example?catalog=example&amp;host=dev%3Amac&amp;thread=a%22%3E%3Cscript%3E"`,
      );
      const bootstrap = await fetch(`${origin}/control-ui-config.json`);
      expect(bootstrap.status).toBe(401);
      const escaped = await fetch(`${origin}/share/chat/example/folder%2Ffile%20name`);
      expect(escaped.status).toBe(200);
      expect(await escaped.text()).toContain(
        `href="${basePath}/chat/example/folder%2Ffile%20name"`,
      );
      for (const invalid of [
        "/share",
        "/share/api/private",
        "/share/chat//session",
        "/share/chat/a/~key",
        "/share/chat/a/%FF",
        `/share/chat/a/${"x".repeat(8192)}`,
      ]) {
        expect((await fetch(`${origin}${invalid}`)).status, invalid).toBe(404);
      }
      expect((await fetch(`${origin}${route}`, { method: "POST" })).status).toBe(404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
