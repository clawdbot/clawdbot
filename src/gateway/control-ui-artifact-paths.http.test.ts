import fs from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { handleControlUiHttpRequest } from "./control-ui.js";

const files = {
  "hello world.js": 'export const label = "space";\n',
  "hello%20world.js": 'export const label = "literal percent";\n',
  "été.js": 'export const label = "unicode";\n',
  "100%.js": 'export const label = "percent";\n',
};
const scriptBody = 'console.log("contained alias");\n';

describe.each(["", "/dashboard"])("Control UI artifact names under %j", (basePath) => {
  const tempDirs = createTempDirTracker();
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    const root = tempDirs.make("openclaw-ui-artifact-paths-");
    await fs.mkdir(path.join(root, "assets"));
    for (const [name, body] of Object.entries(files)) {
      await fs.writeFile(path.join(root, "assets", name), body);
    }
    await fs.writeFile(path.join(root, "payload"), scriptBody);
    await fs.writeFile(path.join(root, "payload.gz"), gzipSync(scriptBody));
    await fs.symlink("../payload", path.join(root, "assets", "app.js"));
    await fs.writeFile(
      path.join(root, "document"),
      '<!doctype html><html><head><script src="./assets/app.js"></script></head><body>Ready</body></html>',
    );
    await fs.symlink("document", path.join(root, "index.html"));
    server = createServer((req, res) => {
      void handleControlUiHttpRequest(req, res, {
        basePath,
        root: { kind: "bundled", path: root },
      }).then(
        (handled) => {
          if (!handled) {
            res.statusCode = 404;
            res.end();
          }
        },
        (error: unknown) => {
          res.statusCode = 500;
          res.end(String(error));
        },
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP fixture listener");
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    } finally {
      tempDirs.cleanup();
    }
  });

  const read = (pathname: string, method = "GET", encoding = "identity") =>
    new Promise<{
      status: number | undefined;
      headers: import("node:http").IncomingHttpHeaders;
      body: Buffer;
    }>((resolve, reject) => {
      const req = request(
        `${origin}${basePath}${pathname}`,
        { method, headers: { "Accept-Encoding": encoding }, agent: false },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () =>
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });

  it.each(Object.entries(files))("decodes %s exactly once for GET and HEAD", async (name, body) => {
    for (const method of ["GET", "HEAD"]) {
      const result = await read(`/assets/${encodeURIComponent(name)}`, method);
      expect(result.status).toBe(200);
      expect(result.headers["content-type"]).toBe("application/javascript; charset=utf-8");
      expect(result.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
      expect(result.body.toString()).toBe(method === "HEAD" ? "" : body);
    }
  });

  it("preserves the logical script type and canonical sidecar for contained aliases", async () => {
    for (const method of ["GET", "HEAD"]) {
      const identity = await read("/assets/app.js", method);
      expect(identity.status).toBe(200);
      expect(identity.headers["content-type"]).toBe("application/javascript; charset=utf-8");
      expect(identity.body.toString()).toBe(method === "HEAD" ? "" : scriptBody);
      const compressed = await read("/assets/app.js", method, "gzip, identity;q=0");
      expect(compressed.status).toBe(200);
      expect(compressed.headers["content-encoding"]).toBe("gzip");
      expect(compressed.headers["content-type"]).toBe(identity.headers["content-type"]);
      expect(compressed.body).toEqual(method === "HEAD" ? Buffer.alloc(0) : gzipSync(scriptBody));
    }
  });

  it("prepares a symlinked index for direct and fallback documents", async () => {
    for (const route of ["/", "/chat"]) {
      const get = await read(route);
      expect(get.status).toBe(200);
      expect(get.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(get.body.toString()).toContain(`data-openclaw-control-ui-base-path="${basePath}"`);
      expect(get.body.toString()).toContain(`src="${basePath}/assets/app.js"`);
      const head = await read(route, "HEAD");
      expect(head.status).toBe(200);
      expect(head.headers["content-type"]).toBe(get.headers["content-type"]);
      expect(head.body.length).toBe(0);
    }
  });

  it.each([
    "/assets/%zz.js",
    "/assets/%FF.js",
    "/assets/%00.js",
    "/assets/%2e%2e%2f%2e%2e%2foutside.js",
  ])("rejects invalid or escaping artifact name %s", async (route) => {
    expect((await read(route)).status).toBe(404);
  });
});
