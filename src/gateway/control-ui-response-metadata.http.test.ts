import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { respondNotFound, respondPlainText } from "./control-ui-http-utils.js";
import { respondControlUiNotAcceptable } from "./control-ui-static.js";
import { handleControlUiHttpRequest, type ControlUiRootState } from "./control-ui.js";

type HttpResult = {
  body: Buffer;
  headers: Headers;
  statusCode: number;
};

type RootResponseCase = {
  body: string;
  path: string;
  root?: ControlUiRootState;
  headers?: Record<string, string>;
  missingHeaders?: string[];
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/plain-not-found") {
      respondNotFound(res);
      return;
    }
    if (pathname === "/no-content") {
      respondPlainText(res, 204, "");
      return;
    }
    if (pathname === "/not-acceptable") {
      respondControlUiNotAcceptable(res);
      return;
    }

    const root = ROOT_RESPONSE_CASES.find((entry) => entry.path === pathname)?.root;
    void handleControlUiHttpRequest(req, res, root ? { root } : undefined).catch(
      (error: unknown) => {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function send(method: "GET" | "HEAD", path: string): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, { method });
  return {
    body: Buffer.from(await response.arrayBuffer()),
    headers: response.headers,
    statusCode: response.status,
  };
}

function expectRepresentationMetadata(
  response: HttpResult,
  expected: { body: string; headers?: Record<string, string>; missingHeaders?: string[] },
) {
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(expected.body)));
  for (const [name, value] of Object.entries(expected.headers ?? {})) {
    expect(response.headers.get(name)).toBe(value);
  }
  for (const name of expected.missingHeaders ?? []) {
    expect(response.headers.get(name)).toBeNull();
  }
}

const ROOT_RESPONSE_CASES: RootResponseCase[] = [
  {
    path: "/root-invalid",
    root: { kind: "invalid", path: "/missing/界" },
    body: "Control UI assets not found at /missing/界. Build them with `pnpm ui:build` (auto-installs UI deps), or update gateway.controlUi.root.",
    missingHeaders: ["retry-after"],
  },
  {
    path: "/root-preparing",
    root: { kind: "preparing" },
    body: "Control UI assets are being prepared. Try again shortly.",
    headers: { "cache-control": "no-store", "retry-after": "1" },
  },
  {
    path: "/root-failed",
    root: { kind: "failed" },
    body: "Control UI assets could not be prepared. Check the Gateway logs or run `openclaw doctor --fix`.",
    missingHeaders: ["retry-after"],
  },
  {
    path: "/root-missing",
    root: { kind: "missing" },
    body: "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.",
    missingHeaders: ["retry-after"],
  },
  {
    path: "/root-disappeared",
    root: { kind: "resolved", path: "/openclaw-test/missing-control-ui-root" },
    body: "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.",
    missingHeaders: ["retry-after"],
  },
];

describe("Control UI plain-text response metadata", () => {
  it("preserves byte length while Node suppresses the HEAD body", async () => {
    const body = "Not Found";
    const get = await send("GET", "/plain-not-found");
    const head = await send("HEAD", "/plain-not-found");

    expect(get.statusCode).toBe(404);
    expect(get.body.toString()).toBe(body);
    expectRepresentationMetadata(get, { body });
    expect(head.statusCode).toBe(404);
    expect(head.body).toHaveLength(0);
    expectRepresentationMetadata(head, { body });
  });

  it("keeps 406 cache negotiation headers on GET and HEAD", async () => {
    const body = "Not Acceptable";
    const expected = {
      body,
      headers: { "cache-control": "no-store", vary: "Accept-Encoding" },
    };
    const get = await send("GET", "/not-acceptable");
    const head = await send("HEAD", "/not-acceptable");

    expect(get.statusCode).toBe(406);
    expect(get.body.toString()).toBe(body);
    expectRepresentationMetadata(get, expected);
    expect(head.statusCode).toBe(406);
    expect(head.body).toHaveLength(0);
    expectRepresentationMetadata(head, expected);
  });

  it.each(ROOT_RESPONSE_CASES)(
    "keeps 503 metadata and HEAD suppression for $path",
    async ({ body, path, headers, missingHeaders }) => {
      const get = await send("GET", path);
      const head = await send("HEAD", path);
      const expected = { body, headers, missingHeaders };

      expect(get.statusCode).toBe(503);
      expect(get.body.toString()).toBe(body);
      expectRepresentationMetadata(get, expected);
      expect(head.statusCode).toBe(503);
      expect(head.body).toHaveLength(0);
      expectRepresentationMetadata(head, expected);
    },
  );

  it("omits Content-Length and bodies for 204", async () => {
    for (const method of ["GET", "HEAD"] as const) {
      const response = await send(method, "/no-content");
      expect(response.statusCode).toBe(204);
      expect(response.body).toHaveLength(0);
      expect(response.headers.get("content-length")).toBeNull();
    }
  });
});
