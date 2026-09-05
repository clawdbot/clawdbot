import { createServer } from "node:http";
import { buildControlUiPublicSessionSharePath } from "@openclaw/session-url-contract/public-share";
import { describe, expect, it, vi } from "vitest";
import { handleControlUiHttpRequest } from "./control-ui.js";

const reader = vi.hoisted(() => vi.fn());
vi.mock("./control-ui-public-session-read.js", () => ({ readPublicSessionShare: reader }));

describe("anonymous public session HTTP boundary", () => {
  it.each(["", "/control"])(
    "serves only published text and keeps private APIs authenticated (%s)",
    async (basePath) => {
      reader.mockReset().mockResolvedValue({
        title: "Launch notes",
        messages: [
          { role: "user", content: "What changed?" },
          { role: "assistant", content: "The public viewer is ready." },
        ],
        totalMessages: 2,
        truncated: false,
      });
      const server = createServer((req, res) => {
        void handleControlUiHttpRequest(req, res, {
          basePath,
          config: { gateway: { publicOrigin: "https://gateway.example.test" } },
          auth: { mode: "token", token: "test-only-token", allowTailscale: false },
        }).then((handled) => {
          if (!handled) {
            res.writeHead(404).end();
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing server address");
      }
      const origin = `http://127.0.0.1:${address.port}`;
      const locator = {
        agentId: "demo",
        sessionKey: "agent:demo:topic:with space",
        sessionId: "séssion.123",
        shareId: "a".repeat(48),
      };
      const route = buildControlUiPublicSessionSharePath({ ...locator, basePath });
      try {
        const response = await fetch(`${origin}${route}&token=private-value&draft=private-draft`);
        expect(response.status).toBe(200);
        expect(reader).toHaveBeenCalledWith(expect.any(Object), locator, { offset: 0 });
        const html = await response.text();
        expect(html).toContain("Launch notes");
        expect(html).toContain("The public viewer is ready.");
        expect(html).not.toMatch(/private-value|private-draft|<script|openclaw-app/);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
        const head = await fetch(`${origin}${route}`, { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe("");
        expect(Number(head.headers.get("content-length"))).toBe(Buffer.byteLength(html));
        expect((await fetch(`${origin}${basePath}/control-ui-config.json`)).status).toBe(401);
        reader.mockResolvedValueOnce({
          title: "Earlier notes",
          messages: [],
          truncated: false,
          olderOffset: 200,
        });
        const older = await fetch(`${origin}${route}&offset=100`);
        const olderHtml = await older.text();
        expect(older.status).toBe(200);
        expect(reader).toHaveBeenLastCalledWith(expect.any(Object), locator, { offset: 100 });
        expect(olderHtml).toContain("&amp;offset=200");
        expect(olderHtml).toContain("Back to latest");
        expect(olderHtml).not.toContain('http-equiv="refresh"');
        const before = reader.mock.calls.length;
        for (const path of [
          route.replace(encodeURIComponent(locator.sessionId), "%FF"),
          route.replace(encodeURIComponent(locator.sessionId), "..%2Fx"),
          `${route}&key=duplicate`,
          `${route}&offset=-1`,
          `${route}&offset=0&offset=100`,
          route.replace("share=", "unknown="),
          `${basePath}/share/session/demo/session-123`,
        ]) {
          expect((await fetch(`${origin}${path}`)).status).toBe(404);
        }
        expect((await fetch(`${origin}${route}`, { method: "POST" })).status).toBe(404);
        expect(reader.mock.calls.length).toBe(before);
        reader.mockResolvedValue(null);
        const revoked = await fetch(`${origin}${route}`);
        expect(revoked.status).toBe(404);
        expect(await revoked.text()).toBe("This public session is unavailable.");
        expect(revoked.headers.get("cache-control")).toBe("no-store");
        reader.mockRejectedValue(new Error("private store location"));
        const unavailable = await fetch(`${origin}${route}`);
        expect(unavailable.status).toBe(503);
        expect(await unavailable.text()).not.toContain("private store location");
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
