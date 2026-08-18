import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, it } from "vitest";
import { A2UI_PATH } from "./a2ui-shared.js";
import { handleA2uiHttpRequest, setA2uiRootRealForTest } from "./a2ui.js";

type CapturedResponse = {
  handled: boolean;
  status: number;
  headers: Record<string, number | string | string[]>;
  body: Buffer;
};

async function capture(url: string, method = "GET"): Promise<CapturedResponse> {
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
  response.handled = await handleA2uiHttpRequest({ method, url }, res);
  response.status = res.statusCode;
  return response;
}

async function withAssetRoot(run: (root: string) => Promise<void>) {
  await withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-canvas-a2ui-" },
    async ({ dir }) => {
      await fs.writeFile(path.join(dir, "a2ui.bundle.js"), "window.v08 = true;", "utf8");
      await fs.writeFile(path.join(dir, "a2ui-v0.9.bundle.js"), "window.v09 = true;", "utf8");
      setA2uiRootRealForTest(await fs.realpath(dir));
      try {
        await run(dir);
      } finally {
        setA2uiRootRealForTest(undefined);
      }
    },
  );
}

describe("Canvas A2UI renderer asset route", () => {
  it.each([
    ["a2ui.bundle.js", "window.v08 = true;"],
    ["a2ui-v0.9.bundle.js", "window.v09 = true;"],
  ])("serves %s for GET and HEAD", async (fileName, expected) => {
    await withAssetRoot(async () => {
      const get = await capture(`${A2UI_PATH}/${fileName}`);
      const head = await capture(`${A2UI_PATH}/${fileName}`, "HEAD");

      expect(get.status).toBe(200);
      expect(get.body.toString("utf8")).toBe(expected);
      expect(head.status).toBe(200);
      expect(head.body).toHaveLength(0);
      expect(head.headers["content-length"]).toBe(String(get.body.byteLength));
    });
  });

  it("rejects missing, malformed, traversal, and symlink paths", async () => {
    await withAssetRoot(async (root) => {
      const linkName = "outside.js";
      await fs.symlink(path.join(process.cwd(), "package.json"), path.join(root, linkName));

      for (const url of [
        `${A2UI_PATH}/missing.js`,
        `${A2UI_PATH}/%E0%A4%A`,
        `${A2UI_PATH}/%2e%2e%2fpackage.json`,
        `${A2UI_PATH}/${linkName}`,
      ]) {
        const response = await capture(url);
        expect(response.status).toBe(404);
        expect(response.body.toString("utf8")).toBe("not found");
      }
      expect((await capture(A2UI_PATH, "POST")).status).toBe(405);
    });
  });
});
