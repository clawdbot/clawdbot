// Channel avatar route tests cover authenticated session lookup, managed-media
// resolution, image validation, cache reuse, and conditional responses.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildControlUiChannelAvatarUrl } from "./control-ui-contract.js";
import { HTTP_IMAGE_MAX_BYTES } from "./http-image-response.js";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  loadEntry: vi.fn(),
  resolveReference: vi.fn(),
  readMedia: vi.fn(),
}));

vi.mock("./http-utils.js", () => ({
  authorizeControlUiSessionOwnerReadRequestOrReply: (...args: unknown[]) =>
    mocks.authorize(...args),
}));

vi.mock("./session-utils-store.js", () => ({
  loadGatewaySessionEntryReadOnly: (...args: unknown[]) => mocks.loadEntry(...args),
}));

vi.mock("../media/media-reference.js", () => ({
  resolveInboundMediaReference: (...args: unknown[]) => mocks.resolveReference(...args),
}));

vi.mock("../media/store.js", () => ({
  readMediaBuffer: (...args: unknown[]) => mocks.readMedia(...args),
}));

const { handleChannelAvatarHttpRequest } = await import("./channel-avatar-http.js");

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb0YAAAAASUVORK5CYII=",
  "base64",
);
const AVATAR_REFERENCE = "/state/media/inbound/channel-avatar.png";

function avatarEntry(reference = AVATAR_REFERENCE) {
  return {
    delivery: {
      kind: "external",
      route: { channel: "discord", target: { to: "user:1" } },
      context: { channel: "discord", to: "user:1" },
      origin: { provider: "discord", to: "user:1", avatar: reference },
    },
  };
}

describe("handleChannelAvatarHttpRequest", () => {
  let port = 0;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    server = createServer((req, res) => {
      void handleChannelAvatarHttpRequest(req, res, {
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
    mocks.authorize.mockReset().mockResolvedValue({
      authMethod: "token",
      operatorScopes: ["operator.admin", "operator.read"],
    });
    mocks.loadEntry.mockReset().mockReturnValue({ entry: avatarEntry() });
    mocks.resolveReference.mockReset().mockResolvedValue({
      id: "channel-avatar.png",
      normalizedSource: AVATAR_REFERENCE,
      physicalPath: AVATAR_REFERENCE,
      sourceType: "path",
    });
    mocks.readMedia.mockReset().mockResolvedValue({
      id: "channel-avatar.png",
      path: AVATAR_REFERENCE,
      buffer: PNG_BYTES,
      size: PNG_BYTES.byteLength,
    });
  });

  const avatarRoute = (sessionKey: string) =>
    `http://127.0.0.1:${port}${buildControlUiChannelAvatarUrl("", sessionKey, "test-revision")}`;

  it("serves managed conversation bytes with sandboxed image headers", async () => {
    const response = await fetch(avatarRoute("agent:main:discord:direct:user-1"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(PNG_BYTES.byteLength));
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="channel-avatar"',
    );
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
    expect(mocks.resolveReference).toHaveBeenCalledWith(AVATAR_REFERENCE);
    expect(mocks.readMedia).toHaveBeenCalledWith(
      "channel-avatar.png",
      "inbound",
      HTTP_IMAGE_MAX_BYTES,
    );
  });

  it("reuses cached bytes and supports ETag revalidation", async () => {
    const first = await fetch(avatarRoute("agent:main:cached"));
    const etag = first.headers.get("etag");
    await first.arrayBuffer();
    const second = await fetch(avatarRoute("agent:main:cached"), {
      headers: { "If-None-Match": etag ?? "" },
    });

    expect(etag).toBeTruthy();
    expect(second.status).toBe(304);
    expect((await second.arrayBuffer()).byteLength).toBe(0);
    expect(mocks.readMedia).toHaveBeenCalledTimes(1);
  });

  it("keeps representation headers but omits bytes on HEAD", async () => {
    const response = await fetch(avatarRoute("agent:main:head"), { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(PNG_BYTES.byteLength));
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it.each([
    { label: "missing session", entry: undefined },
    { label: "session without an avatar", entry: avatarEntry("") },
  ])("returns an uncacheable 404 for a $label", async ({ entry }) => {
    mocks.loadEntry.mockReturnValue({ entry });

    const response = await fetch(avatarRoute("agent:main:missing"));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.resolveReference).not.toHaveBeenCalled();
  });

  it("returns 404 when the stored reference no longer resolves", async () => {
    mocks.resolveReference.mockResolvedValue(null);

    const response = await fetch(avatarRoute("agent:main:pruned"));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("never resolves session or media state for an unauthenticated caller", async () => {
    mocks.authorize.mockImplementation(
      async (params: { res: { statusCode: number; end: () => void } }) => {
        params.res.statusCode = 401;
        params.res.end();
        return null;
      },
    );

    const response = await fetch(avatarRoute("agent:main:hidden"));

    expect(response.status).toBe(401);
    expect(mocks.loadEntry).not.toHaveBeenCalled();
    expect(mocks.resolveReference).not.toHaveBeenCalled();
  });

  it("does not resolve the session when the owner-read authorizer denies access", async () => {
    mocks.authorize.mockImplementation(
      async (params: { res: { statusCode: number; end: () => void } }) => {
        params.res.statusCode = 403;
        params.res.end();
        return null;
      },
    );

    const response = await fetch(avatarRoute("agent:main:hidden"));

    expect(response.status).toBe(403);
    expect(mocks.loadEntry).not.toHaveBeenCalled();
  });

  it.each(["/__openclaw__/channel-avatar/", "/__openclaw__/channel-avatar/a/b"])(
    "claims malformed route %s as a 404",
    async (pathname) => {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`);

      expect(response.status).toBe(404);
      expect(mocks.loadEntry).not.toHaveBeenCalled();
    },
  );

  it("rejects non-read methods and leaves unrelated paths unhandled", async () => {
    const rejected = await fetch(avatarRoute("agent:main:one"), { method: "POST" });
    const unhandled = await fetch(`http://127.0.0.1:${port}/__openclaw__/workspace-icon/one`);

    expect(rejected.status).toBe(405);
    expect(rejected.headers.get("allow")).toBe("GET, HEAD");
    expect(unhandled.status).toBe(418);
  });
});
