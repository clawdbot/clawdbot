/**
 * Control UI auto-root HTTP routing tests.
 */
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { handleControlUiHttpRequest } = await import("./control-ui.js");
const { makeMockHttpResponse } = await import("./test-http-response.js");

async function withControlUiRoot<T>(fn: (tmp: string) => Promise<T>) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-auto-root-"));
  try {
    await fs.writeFile(path.join(tmp, "index.html"), "<html>fallback</html>\n");
    return await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function responseBody(end: ReturnType<typeof makeMockHttpResponse>["end"]) {
  return String(end.mock.calls[0]?.[0] ?? "");
}

describe("handleControlUiHttpRequest prepared root lifecycle", () => {
  it("serves hardlinked asset files for prepared bundled roots", async () => {
    await withControlUiRoot(async (tmp) => {
      const assetsDir = path.join(tmp, "assets");
      await fs.mkdir(assetsDir, { recursive: true });
      await fs.writeFile(path.join(assetsDir, "app.js"), "console.log('hi');");
      await fs.link(path.join(assetsDir, "app.js"), path.join(assetsDir, "app.hl.js"));
      const { res, end } = makeMockHttpResponse();
      const handled = await handleControlUiHttpRequest(
        { url: "/assets/app.hl.js", method: "GET" } as IncomingMessage,
        res,
        { root: { kind: "bundled", path: tmp, realPath: await fs.realpath(tmp) } },
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(responseBody(end)).toBe("console.log('hi');");
    });
  });

  it("serves hardlinked SPA fallback index.html for prepared bundled roots", async () => {
    await withControlUiRoot(async (tmp) => {
      const sourceIndex = path.join(tmp, "index.source.html");
      const indexPath = path.join(tmp, "index.html");
      await fs.writeFile(sourceIndex, "<html>fallback-hardlink</html>\n");
      await fs.rm(indexPath);
      await fs.link(sourceIndex, indexPath);
      const { res, end } = makeMockHttpResponse();
      const handled = await handleControlUiHttpRequest(
        {
          url: "/dashboard",
          method: "GET",
          headers: { host: "gateway.example.test" },
        } as IncomingMessage,
        res,
        { root: { kind: "bundled", path: tmp, realPath: await fs.realpath(tmp) } },
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(responseBody(end)).toBe(
        '<html data-openclaw-terminal-enabled="true">fallback-hardlink</html>\n',
      );
    });
  });

  it("rejects hardlinked assets for prepared roots without bundled provenance", async () => {
    await withControlUiRoot(async (tmp) => {
      const assetsDir = path.join(tmp, "assets");
      await fs.mkdir(assetsDir, { recursive: true });
      await fs.writeFile(path.join(assetsDir, "app.js"), "console.log('hi');");
      await fs.link(path.join(assetsDir, "app.js"), path.join(assetsDir, "app.hl.js"));
      const { res } = makeMockHttpResponse();
      const handled = await handleControlUiHttpRequest(
        { url: "/assets/app.hl.js", method: "GET" } as IncomingMessage,
        res,
        { root: { kind: "resolved", path: tmp, realPath: await fs.realpath(tmp) } },
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
    });
  });

  it("marks requests retryable while assets are preparing", async () => {
    const { res, end, setHeader } = makeMockHttpResponse();

    const handled = await handleControlUiHttpRequest(
      { url: "/", method: "GET" } as IncomingMessage,
      res,
      { root: { kind: "preparing" } },
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(setHeader).toHaveBeenCalledWith("Retry-After", "1");
    expect(responseBody(end)).toContain("being prepared");
  });

  it("keeps failed requests terminal without retry hints", async () => {
    const { res, end, setHeader } = makeMockHttpResponse();
    const privateBuildFailure =
      "Control UI build failed: private-credential in registry.invalid/package from /home/operator/private";
    const failedRoot = { kind: "failed" as const, message: privateBuildFailure };

    const handled = await handleControlUiHttpRequest(
      { url: "/", method: "GET" } as IncomingMessage,
      res,
      { root: failedRoot },
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(setHeader).not.toHaveBeenCalledWith("Retry-After", expect.anything());
    expect(responseBody(end)).toBe(
      "Control UI assets could not be prepared. Check the Gateway logs or run `openclaw doctor --fix`.",
    );
    expect(responseBody(end)).not.toContain("private-credential");
    expect(responseBody(end)).not.toContain("/home/operator/private");
  });

  it("keeps invalid configured roots terminal and preserves their repair guidance", async () => {
    const { res, end, setHeader } = makeMockHttpResponse();

    const handled = await handleControlUiHttpRequest(
      { url: "/", method: "GET" } as IncomingMessage,
      res,
      { root: { kind: "invalid", path: "/custom/missing" } },
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(setHeader).not.toHaveBeenCalledWith("Retry-After", expect.anything());
    expect(responseBody(end)).toContain("/custom/missing");
    expect(responseBody(end)).toContain("gateway.controlUi.root");
  });

  it("does not rediscover a root when the Gateway did not provide one", async () => {
    const { res, setHeader } = makeMockHttpResponse();

    const handled = await handleControlUiHttpRequest(
      { url: "/", method: "GET" } as IncomingMessage,
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(setHeader).not.toHaveBeenCalledWith("Retry-After", expect.anything());
  });
});
