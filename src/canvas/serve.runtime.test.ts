// Core Canvas document HTTP response coverage.
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCanvasDocument } from "./documents.js";
import { handleCanvasDocumentHttpRequest } from "./serve.runtime.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createStateDir(): Promise<string> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-canvas-serve-"));
  tempDirs.push(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return stateDir;
}

async function capture(url: string, method = "GET") {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, number | string | string[]>,
    body: Buffer.alloc(0) as Buffer,
    setHeader(name: string, value: number | string | readonly string[]) {
      this.headers[name.toLowerCase()] = typeof value === "object" ? [...value] : value;
      return this;
    },
    end(chunk?: string | Buffer) {
      this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? "");
      return this;
    },
  };
  const handled = await handleCanvasDocumentHttpRequest(
    { method, url } as IncomingMessage,
    response as unknown as ServerResponse,
  );
  return { handled, ...response, text: response.body.toString("utf8") };
}

describe("core canvas document host", () => {
  it("serves sandbox-marked HTML with the stable CSP header and no mutation", async () => {
    const stateDir = await createStateDir();
    const html = "<html><body>widget</body></html>";
    const document = await createCanvasDocument(
      {
        id: "widget-1",
        kind: "html_bundle",
        entrypoint: { type: "html", value: html },
        cspSandbox: "scripts",
      },
      { stateDir },
    );

    const response = await capture(document.entryUrl);
    expect(response.handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toBe("sandbox allow-scripts");
    expect(response.text).toBe(html);
  });

  it("omits the sandbox response header for unmarked documents", async () => {
    const stateDir = await createStateDir();
    const document = await createCanvasDocument(
      {
        id: "plain-1",
        kind: "html_bundle",
        entrypoint: { type: "html", value: "<html><body>plain</body></html>" },
      },
      { stateDir },
    );

    const response = await capture(document.entryUrl);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toBeUndefined();
  });

  it("rejects unsupported methods and traversal paths", async () => {
    await createStateDir();
    const methodResponse = await capture(
      "/__openclaw__/canvas/documents/widget-1/index.html",
      "POST",
    );
    expect(methodResponse.statusCode).toBe(405);
    expect(methodResponse.text).toBe("Method Not Allowed");

    const traversalResponse = await capture(
      "/__openclaw__/canvas/documents/../widget-1/index.html",
    );
    expect(traversalResponse.handled).toBe(false);

    const missingResponse = await capture("/__openclaw__/canvas/documents/widget-1/index.html");
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.text).toBe("not found");
  });
});
