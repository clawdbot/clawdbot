import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleUserProfileAvatarHttpRequest } from "./user-profiles-http.js";

const authorizeScopedGatewayHttpRequestOrReply = vi.hoisted(() => vi.fn());
const getProfileAvatar = vi.hoisted(() => vi.fn());

vi.mock("./http-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-utils.js")>()),
  authorizeScopedGatewayHttpRequestOrReply,
}));
vi.mock("../state/user-profiles.js", () => ({
  formatUserProfileAvatarEtag: (sha256: string, mime: string) =>
    `"${sha256}-${mime.slice("image/".length)}"`,
  getProfileAvatar,
}));

function response() {
  const end = vi.fn();
  const setHeader = vi.fn();
  const writeHead = vi.fn();
  return {
    end,
    response: { end, setHeader, writeHead } as unknown as ServerResponse,
    writeHead,
  };
}

function request(path: string, headers: Record<string, string> = {}) {
  return { method: "GET", url: path, headers } as unknown as IncomingMessage;
}

describe("profile avatar HTTP endpoint", () => {
  beforeEach(() => {
    authorizeScopedGatewayHttpRequestOrReply.mockReset();
    getProfileAvatar.mockReset();
    authorizeScopedGatewayHttpRequestOrReply.mockResolvedValue({});
  });

  it("serves avatars with their stored MIME type and representation ETag", async () => {
    getProfileAvatar.mockReturnValue({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "image/webp",
      sha256: "first-hash",
      updatedAt: 42,
    });
    const res = response();

    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      res.response,
      "/api/users/profile-1/avatar",
      { auth: {} as never },
    );

    expect(authorizeScopedGatewayHttpRequestOrReply).toHaveBeenCalledWith(
      expect.objectContaining({ operatorMethod: "users.list" }),
    );
    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "Content-Type": "image/webp", ETag: '"first-hash-webp"' }),
    );
    expect(res.end).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  });

  it("answers a matching ETag without a body", async () => {
    getProfileAvatar.mockReturnValue({
      bytes: new Uint8Array([1]),
      mime: "image/png",
      sha256: "current-hash",
      updatedAt: 42,
    });
    const res = response();

    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler", { "if-none-match": '"current-hash-png"' }),
      res.response,
      "/api/users/profile-1/avatar",
      { auth: {} as never },
    );

    expect(res.writeHead).toHaveBeenCalledWith(304, { ETag: '"current-hash-png"' });
    expect(res.end).toHaveBeenCalledWith();
  });

  it("decodes profile IDs from the scoped pathname", async () => {
    getProfileAvatar.mockReturnValue({
      bytes: new Uint8Array([1]),
      mime: "image/png",
      sha256: "current-hash",
      updatedAt: 42,
    });

    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      response().response,
      "/api/users/profile%2D1/avatar",
      { auth: {} as never },
    );

    expect(getProfileAvatar).toHaveBeenCalledWith("profile-1");
  });

  it("serves HEAD as GET without a body", async () => {
    getProfileAvatar.mockReturnValue({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "image/png",
      sha256: "head-hash",
      updatedAt: 42,
    });
    const res = response();

    await handleUserProfileAvatarHttpRequest(
      { method: "HEAD", url: "/ignored-by-handler", headers: {} } as unknown as IncomingMessage,
      res.response,
      "/api/users/profile-1/avatar",
      { auth: {} as never },
    );

    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "Content-Type": "image/png", ETag: '"head-hash-png"' }),
    );
    expect(res.end).toHaveBeenCalledWith(undefined);
  });

  it.each(['W/"current-hash-png"', '"other", "current-hash-png"', "*"])(
    "revalidates If-None-Match form %s",
    async (header) => {
      getProfileAvatar.mockReturnValue({
        bytes: new Uint8Array([1]),
        mime: "image/png",
        sha256: "current-hash",
        updatedAt: 42,
      });
      const res = response();

      await handleUserProfileAvatarHttpRequest(
        request("/ignored-by-handler", { "if-none-match": header }),
        res.response,
        "/api/users/profile-1/avatar",
        { auth: {} as never },
      );

      expect(res.writeHead).toHaveBeenCalledWith(304, { ETag: '"current-hash-png"' });
    },
  );
});
