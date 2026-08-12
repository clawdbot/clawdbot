import fs from "node:fs/promises";
// Workspace icon tests cover conventional-path resolution, process-stable
// caching, and the authenticated route's scoping, limits, and headers.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  resolveScopes: vi.fn(),
  authorizeScopes: vi.fn(),
  resolveIsOwner: vi.fn(),
  resolveLocalSessionWorkspaceRoot: vi.fn(),
}));

vi.mock("./http-utils.js", () => ({
  authorizeGatewayHttpRequestOrReply: (...args: unknown[]) => mocks.authorize(...args),
  resolveOpenAiCompatibleHttpOperatorScopes: (...args: unknown[]) => mocks.resolveScopes(...args),
  resolveOpenAiCompatibleHttpSenderIsOwner: (...args: unknown[]) => mocks.resolveIsOwner(...args),
}));

vi.mock("./method-scopes.js", () => ({
  authorizeOperatorScopesForMethod: (...args: unknown[]) => mocks.authorizeScopes(...args),
}));

vi.mock("./server-methods/sessions-files.js", () => ({
  resolveLocalSessionWorkspaceRoot: (...args: unknown[]) =>
    mocks.resolveLocalSessionWorkspaceRoot(...args),
}));

const {
  clearWorkspaceIconCacheForTest,
  handleWorkspaceIconHttpRequest,
  prepareSessionWorkspaceIcon,
  resolveWorkspaceIcon,
  SVG_ICON_MAX_BYTES,
  WORKSPACE_ICON_MAX_BYTES,
} = await import("./workspace-icon-http.js");

// 1x1 PNG, a 22-byte ICO header, and a minimal SVG document.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb0YAAAAASUVORK5CYII=",
  "base64",
);
const ICO_BYTES = Buffer.from([
  0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0,
]);
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>');

const roots: string[] = [];

async function makeWorkspace(files: Record<string, Buffer>): Promise<string> {
  // Canonicalize first: macOS tmp is a /var -> /private/var symlink and the
  // resolver returns realpaths, so a raw mkdtemp root would not compare equal.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ws-icon-")));
  roots.push(root);
  for (const [relative, body] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, body);
  }
  return root;
}

beforeEach(() => {
  clearWorkspaceIconCacheForTest();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("resolveWorkspaceIcon", () => {
  const conventions = [
    { relative: "favicon.svg", body: SVG_BYTES, contentType: "image/svg+xml" },
    { relative: "favicon.ico", body: ICO_BYTES, contentType: "image/x-icon" },
    { relative: "favicon.png", body: PNG_BYTES, contentType: "image/png" },
    { relative: "public/favicon.svg", body: SVG_BYTES, contentType: "image/svg+xml" },
    { relative: "public/favicon.ico", body: ICO_BYTES, contentType: "image/x-icon" },
    { relative: "public/favicon.png", body: PNG_BYTES, contentType: "image/png" },
    { relative: "public/favicon-32.png", body: PNG_BYTES, contentType: "image/png" },
    { relative: "public/apple-touch-icon.png", body: PNG_BYTES, contentType: "image/png" },
    { relative: "static/favicon.svg", body: SVG_BYTES, contentType: "image/svg+xml" },
    { relative: "static/favicon.ico", body: ICO_BYTES, contentType: "image/x-icon" },
    { relative: "static/favicon.png", body: PNG_BYTES, contentType: "image/png" },
    { relative: "ui/public/favicon-32.png", body: PNG_BYTES, contentType: "image/png" },
    { relative: "ui/public/favicon.svg", body: SVG_BYTES, contentType: "image/svg+xml" },
    { relative: "ui/public/favicon.ico", body: ICO_BYTES, contentType: "image/x-icon" },
    { relative: "ui/public/favicon.png", body: PNG_BYTES, contentType: "image/png" },
    { relative: "app/favicon.ico", body: ICO_BYTES, contentType: "image/x-icon" },
    { relative: "app/favicon.png", body: PNG_BYTES, contentType: "image/png" },
    { relative: "app/icon.svg", body: SVG_BYTES, contentType: "image/svg+xml" },
    { relative: "app/icon.png", body: PNG_BYTES, contentType: "image/png" },
    { relative: "app/icon.ico", body: ICO_BYTES, contentType: "image/x-icon" },
    { relative: "src/favicon.ico", body: ICO_BYTES, contentType: "image/x-icon" },
    { relative: "src/favicon.svg", body: SVG_BYTES, contentType: "image/svg+xml" },
    { relative: "src/app/favicon.ico", body: ICO_BYTES, contentType: "image/x-icon" },
    { relative: "src/app/icon.svg", body: SVG_BYTES, contentType: "image/svg+xml" },
    { relative: "src/app/icon.png", body: PNG_BYTES, contentType: "image/png" },
    { relative: "assets/icon.svg", body: SVG_BYTES, contentType: "image/svg+xml" },
    { relative: "assets/icon.png", body: PNG_BYTES, contentType: "image/png" },
    { relative: "assets/logo.svg", body: SVG_BYTES, contentType: "image/svg+xml" },
    { relative: "assets/logo.png", body: PNG_BYTES, contentType: "image/png" },
  ] as const;

  it.each(conventions)("resolves $relative as $contentType", async (convention) => {
    const root = await makeWorkspace({ [convention.relative]: Buffer.from(convention.body) });
    const icon = await resolveWorkspaceIcon(root);
    expect(icon?.contentType).toBe(convention.contentType);
    expect(icon?.body.equals(convention.body)).toBe(true);
    expect(icon?.etag).toMatch(/^"[\w-]+"$/u);
  });

  it("uses the first valid icon in the fixed precedence", async () => {
    const root = await makeWorkspace({
      "favicon.ico": ICO_BYTES,
      "public/favicon.svg": SVG_BYTES,
      "ui/public/favicon-32.png": PNG_BYTES,
    });
    expect((await resolveWorkspaceIcon(root))?.contentType).toBe("image/x-icon");
  });

  const rejected = [
    { label: "an unconventional location", files: { "vendor/favicon.png": PNG_BYTES } },
    { label: "an empty file", files: { "favicon.ico": Buffer.alloc(0) } },
    { label: "bytes that are not an image", files: { "favicon.ico": Buffer.from("#!/bin/sh\n") } },
    {
      label: "an SVG carrying a doctype",
      files: { "favicon.svg": Buffer.from('<!DOCTYPE svg><svg xmlns="x"></svg>') },
    },
    {
      label: "an SVG referencing an external resource",
      files: {
        "favicon.svg": Buffer.from('<svg xmlns="x"><image href="https://x.test/a.png"/></svg>'),
      },
    },
    {
      label: "an SVG embedding a script element",
      files: { "favicon.svg": Buffer.from('<svg xmlns="x"><script>alert(1)</script></svg>') },
    },
    {
      label: "an SVG past the vector cap",
      files: {
        "favicon.svg": Buffer.concat([
          Buffer.from('<svg xmlns="x"><path d="'),
          Buffer.alloc(SVG_ICON_MAX_BYTES, 0x31),
          Buffer.from('"/></svg>'),
        ]),
      },
    },
    {
      label: "an icon past the size cap",
      files: { "favicon.png": Buffer.alloc(WORKSPACE_ICON_MAX_BYTES + 1, 1) },
    },
  ] as const;

  it.each(rejected)("records no icon for $label", async ({ files }) => {
    const root = await makeWorkspace({ ...files });
    expect(await resolveWorkspaceIcon(root)).toBeNull();
  });

  it("does not follow an icon symlink out of the workspace", async () => {
    const outside = await makeWorkspace({ "secret.png": PNG_BYTES });
    const root = await makeWorkspace({});
    await fs.symlink(path.join(outside, "secret.png"), path.join(root, "favicon.png"));
    expect(await resolveWorkspaceIcon(root)).toBeNull();
  });

  it("keeps both hits and misses for the process lifetime", async () => {
    const empty = await makeWorkspace({});
    expect(await resolveWorkspaceIcon(empty)).toBeNull();
    await fs.writeFile(path.join(empty, "favicon.png"), PNG_BYTES);
    // Icons are process-stable metadata: a workspace that answered "no icon"
    // must not rescan on later requests, and picks the new file up on restart.
    expect(await resolveWorkspaceIcon(empty)).toBeNull();

    const filled = await makeWorkspace({ "favicon.png": PNG_BYTES });
    const first = await resolveWorkspaceIcon(filled);
    await fs.rm(path.join(filled, "favicon.png"));
    expect(await resolveWorkspaceIcon(filled)).toBe(first);
  });
});

describe("handleWorkspaceIconHttpRequest", () => {
  let port = 0;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    server = createServer((req, res) => {
      void handleWorkspaceIconHttpRequest(req, res, {
        auth: { mode: "token", token: "test-token", allowTailscale: false },
      }).then((handled) => {
        if (!handled) {
          res.statusCode = 418;
          res.end("unhandled");
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    mocks.authorize.mockReset().mockResolvedValue({ ok: true });
    mocks.resolveScopes.mockReset().mockReturnValue(["operator.read"]);
    mocks.authorizeScopes.mockReset().mockReturnValue({ allowed: true });
    mocks.resolveIsOwner.mockReset().mockReturnValue(true);
    mocks.resolveLocalSessionWorkspaceRoot.mockReset().mockReturnValue(undefined);
  });

  const iconRoute = (sessionKey: string) =>
    `http://127.0.0.1:${port}/__openclaw__/workspace-icon/${encodeURIComponent(sessionKey)}`;

  it("serves the session workspace icon with sandboxed asset headers", async () => {
    const root = await makeWorkspace({ "public/favicon.ico": ICO_BYTES });
    mocks.resolveLocalSessionWorkspaceRoot.mockReturnValue(root);
    await prepareSessionWorkspaceIcon({ sessionKey: "agent:main:one" });

    const response = await fetch(iconRoute("agent:main:one"));
    expect(mocks.resolveLocalSessionWorkspaceRoot).toHaveBeenCalledWith({
      sessionKey: "agent:main:one",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/x-icon");
    expect(response.headers.get("content-length")).toBe(String(ICO_BYTES.byteLength));
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="workspace-icon"',
    );
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await response.arrayBuffer()).equals(ICO_BYTES)).toBe(true);
  });

  it("revalidates an unchanged icon without resending its bytes", async () => {
    const root = await makeWorkspace({ "favicon.png": PNG_BYTES });
    mocks.resolveLocalSessionWorkspaceRoot.mockReturnValue(root);
    await prepareSessionWorkspaceIcon({ sessionKey: "agent:main:one" });

    const first = await fetch(iconRoute("agent:main:one"));
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    await first.arrayBuffer();

    const revalidated = await fetch(iconRoute("agent:main:one"), {
      headers: { "If-None-Match": etag ?? "" },
    });
    expect(revalidated.status).toBe(304);
    expect((await revalidated.arrayBuffer()).byteLength).toBe(0);
  });

  it("omits the body but keeps the representation headers on HEAD", async () => {
    const root = await makeWorkspace({ "favicon.png": PNG_BYTES });
    mocks.resolveLocalSessionWorkspaceRoot.mockReturnValue(root);
    await prepareSessionWorkspaceIcon({ sessionKey: "agent:main:one" });

    const response = await fetch(iconRoute("agent:main:one"), { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(PNG_BYTES.byteLength));
  });

  const absent = [
    { label: "a session with no workspace", hasWorkspace: false },
    { label: "a workspace with no icon", hasWorkspace: true },
  ] as const;

  it.each(absent)("answers an uncacheable 404 for $label", async ({ hasWorkspace }) => {
    mocks.resolveLocalSessionWorkspaceRoot.mockReturnValue(
      hasWorkspace ? await makeWorkspace({}) : undefined,
    );
    await prepareSessionWorkspaceIcon({ sessionKey: "agent:main:one" });
    const response = await fetch(iconRoute("agent:main:one"));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps a request made before chat startup retryable", async () => {
    const response = await fetch(iconRoute("agent:main:one"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("1");
    expect(mocks.resolveLocalSessionWorkspaceRoot).not.toHaveBeenCalled();
  });

  it("waits for preparation already started by chat startup", async () => {
    const root = await makeWorkspace({ "public/favicon.ico": ICO_BYTES });
    mocks.resolveLocalSessionWorkspaceRoot.mockReturnValue(root);

    const preparation = prepareSessionWorkspaceIcon({ sessionKey: "agent:main:pending" });
    const responsePromise = fetch(iconRoute("agent:main:pending"));

    await preparation;
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(ICO_BYTES)).toBe(true);
  });

  it("records the fallback when preparation fails", async () => {
    mocks.resolveLocalSessionWorkspaceRoot.mockImplementation(() => {
      throw new Error("broken workspace metadata");
    });
    await expect(prepareSessionWorkspaceIcon({ sessionKey: "agent:main:broken" })).rejects.toThrow(
      "broken workspace metadata",
    );

    const response = await fetch(iconRoute("agent:main:broken"));
    expect(response.status).toBe(404);
  });

  it("does no session-store or filesystem resolution in the HTTP request", async () => {
    const root = await makeWorkspace({ "ui/public/favicon-32.png": PNG_BYTES });
    mocks.resolveLocalSessionWorkspaceRoot.mockReturnValue(root);
    await prepareSessionWorkspaceIcon({ sessionKey: "agent:main:one" });
    mocks.resolveLocalSessionWorkspaceRoot.mockClear();
    await fs.rm(path.join(root, "ui/public/favicon-32.png"));

    const first = await fetch(iconRoute("agent:main:one"));
    const second = await fetch(iconRoute("agent:main:one"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(Buffer.from(await first.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
    expect(Buffer.from(await second.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
    expect(mocks.resolveLocalSessionWorkspaceRoot).not.toHaveBeenCalled();
  });

  it("keeps a recently served session snapshot across bounded-cache eviction", async () => {
    const root = await makeWorkspace({ "favicon.png": PNG_BYTES });
    mocks.resolveLocalSessionWorkspaceRoot.mockReturnValue(root);
    await prepareSessionWorkspaceIcon({ sessionKey: "agent:main:kept" });
    for (let index = 0; index < 127; index += 1) {
      await prepareSessionWorkspaceIcon({ sessionKey: `agent:main:filler-${index}` });
    }

    expect((await fetch(iconRoute("agent:main:kept"))).status).toBe(200);
    await prepareSessionWorkspaceIcon({ sessionKey: "agent:main:newest" });

    expect((await fetch(iconRoute("agent:main:kept"))).status).toBe(200);
    expect((await fetch(iconRoute("agent:main:filler-0"))).status).toBe(503);
  });

  const malformed = ["/__openclaw__/workspace-icon/", "/__openclaw__/workspace-icon/a/b"];

  it.each(malformed)("claims %s as a 404 instead of falling through", async (pathname) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
    expect(response.status).toBe(404);
    expect(mocks.resolveLocalSessionWorkspaceRoot).not.toHaveBeenCalled();
  });

  it("leaves unrelated paths to later stages", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/__openclaw__/plugin-icon/x`);
    expect(response.status).toBe(418);
  });

  it("rejects non-read methods", async () => {
    const response = await fetch(iconRoute("agent:main:one"), { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("never reads a workspace for an unauthenticated caller", async () => {
    mocks.authorize.mockImplementation(
      async (params: { res: { statusCode: number; end: () => void } }) => {
        params.res.statusCode = 401;
        params.res.end();
        return null;
      },
    );
    const response = await fetch(iconRoute("agent:main:one"));
    expect(response.status).toBe(401);
    expect(mocks.resolveLocalSessionWorkspaceRoot).not.toHaveBeenCalled();
  });

  it("never reads a workspace for a caller without owner access", async () => {
    // `sessions.list` hides incognito and non-owner draft sessions per client.
    // Without that filter here, the read scope alone would let a caller who
    // knows such a key pull bytes derived from a session it cannot list.
    mocks.resolveIsOwner.mockReturnValue(false);
    const response = await fetch(iconRoute("agent:main:hidden"));
    expect(response.status).toBe(403);
    expect(mocks.resolveLocalSessionWorkspaceRoot).not.toHaveBeenCalled();
  });

  it("falls back to the glyph for a session whose workspace is on another host", async () => {
    // resolveLocalSessionWorkspaceRoot withholds the root for exec-node sessions
    // so the route can never answer with this Gateway's own project icon.
    mocks.resolveLocalSessionWorkspaceRoot.mockReturnValue(undefined);
    await prepareSessionWorkspaceIcon({ sessionKey: "agent:main:remote" });
    const response = await fetch(iconRoute("agent:main:remote"));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("never reads a workspace for a caller missing the session read scope", async () => {
    mocks.authorizeScopes.mockReturnValue({ allowed: false, missingScope: "operator.read" });
    const response = await fetch(iconRoute("agent:main:one"));
    expect(response.status).toBe(403);
    expect(mocks.authorizeScopes).toHaveBeenCalledWith("sessions.list", ["operator.read"]);
    expect(mocks.resolveLocalSessionWorkspaceRoot).not.toHaveBeenCalled();
  });
});
