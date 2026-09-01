import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleA2uiHttpRequestWithRootResolver } from "./a2ui-route.js";
import { A2UI_PATH } from "./a2ui-shared.js";

let fixtureRoot = "";
let fixtureRootReal = "";

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-canvas-a2ui-route-"),
  );
  const assetRoot = path.join(fixtureRoot, "canvas-host", "a2ui");
  await fs.mkdir(assetRoot, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(assetRoot, "a2ui.bundle.js"), "window.v08 = true;", "utf8"),
    fs.writeFile(path.join(assetRoot, "a2ui-v0.9.bundle.js"), "window.v09 = true;", "utf8"),
  ]);
  fixtureRootReal = await fs.realpath(assetRoot);
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

type CapturedResponse = {
  handled: boolean;
  status: number;
  headers: Record<string, number | string | string[]>;
  body: Buffer;
};

async function capture(
  url: string,
  method = "GET",
  resolveRootReal: () => Promise<string | null> = async () => fixtureRootReal,
): Promise<CapturedResponse> {
  const response: CapturedResponse = {
    handled: false,
    status: 200,
    headers: {},
    body: Buffer.alloc(0),
  };
  const res = {
    statusCode: 200,
    setHeader(name: string, value: number | string | readonly string[]) {
      response.headers[name.toLowerCase()] = typeof value === "object" ? [...value] : value;
    },
    end(chunk?: string | Buffer) {
      response.status = this.statusCode;
      response.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? "");
    },
  };
  response.handled = await handleA2uiHttpRequestWithRootResolver(
    { method, url },
    res,
    resolveRootReal,
  );
  response.status = res.statusCode;
  return response;
}

describe("Canvas A2UI renderer asset route", () => {
  it.each(["a2ui.bundle.js", "a2ui-v0.9.bundle.js"])(
    "serves %s for GET and HEAD",
    async (fileName) => {
      const get = await capture(`${A2UI_PATH}/${fileName}`);
      const head = await capture(`${A2UI_PATH}/${fileName}`, "HEAD");

      expect(get.status).toBe(200);
      expect(get.body.byteLength).toBeGreaterThan(0);
      expect(head.status).toBe(200);
      expect(head.body).toHaveLength(0);
      expect(head.headers["content-length"]).toBe(String(get.body.byteLength));
    },
  );

  it("rejects missing, malformed, and traversal paths", async () => {
    for (const url of [
      `${A2UI_PATH}/missing.js`,
      `${A2UI_PATH}/%E0%A4%A`,
      `${A2UI_PATH}/%2e%2e%2fpackage.json`,
    ]) {
      const response = await capture(url);
      expect(response.status).toBe(404);
      expect(response.body.toString("utf8")).toBe("not found");
    }
    expect((await capture(A2UI_PATH, "POST")).status).toBe(405);
  });

  it("returns unavailable when renderer assets cannot be resolved", async () => {
    const response = await capture(`${A2UI_PATH}/a2ui.bundle.js`, "GET", async () => null);

    expect(response.status).toBe(503);
    expect(response.body.toString("utf8")).toBe("A2UI assets not found");
  });
});
