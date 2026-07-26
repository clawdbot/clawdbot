import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleUserProfileAvatarHttpRequest } from "./user-profiles-http.js";

const authorizeScopedGatewayHttpRequestOrReply = vi.hoisted(() => vi.fn());
const getRuntimeConfig = vi.hoisted(() => vi.fn());
const getProfileAvatar = vi.hoisted(() => vi.fn());
const getUserProfileListItem = vi.hoisted(() => vi.fn());

vi.mock("./http-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-utils.js")>()),
  authorizeScopedGatewayHttpRequestOrReply,
}));
vi.mock("../config/io.js", () => ({ getRuntimeConfig }));
vi.mock("../state/user-profiles.js", () => ({
  formatUserProfileAvatarEtag: (sha256: string, mime: string) =>
    `"${sha256}-${mime.slice("image/".length)}"`,
  getProfileAvatar,
  getUserProfileListItem,
  UserProfileNotFoundError: class UserProfileNotFoundError extends Error {},
}));

function emailHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function fetchUrl(input: URL | RequestInfo): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function response() {
  const end = vi.fn();
  const setHeader = vi.fn();
  const writeHead = vi.fn();
  return {
    end,
    response: { end, setHeader, writeHead } as unknown as ServerResponse,
    setHeader,
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
    getUserProfileListItem.mockReset();
    getRuntimeConfig.mockReset();
    authorizeScopedGatewayHttpRequestOrReply.mockResolvedValue({});
    getRuntimeConfig.mockReturnValue({
      gateway: { controlUi: { allowedOrigins: ["https://control.example"] } },
    });
  });

  it("answers allowed credentialed cross-origin preflights without avatar auth", async () => {
    const res = response();
    const req = {
      method: "OPTIONS",
      url: "/ignored-by-handler",
      headers: { origin: "https://control.example" },
    } as unknown as IncomingMessage;

    await handleUserProfileAvatarHttpRequest(req, res.response, "/api/users/profile-1/avatar", {
      auth: {} as never,
    });

    expect(authorizeScopedGatewayHttpRequestOrReply).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith(
      "Access-Control-Allow-Origin",
      "https://control.example",
    );
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Credentials", "true");
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Headers", "Authorization");
    expect(res.writeHead).toHaveBeenCalledWith(204);
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

    expect(res.writeHead).toHaveBeenCalledWith(304, {
      ETag: '"current-hash-png"',
      "Cache-Control": "private, max-age=0, must-revalidate",
    });
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

      expect(res.writeHead).toHaveBeenCalledWith(304, {
        ETag: '"current-hash-png"',
        "Cache-Control": "private, max-age=0, must-revalidate",
      });
    },
  );

  it("proxies and caches Gravatar by a profile's normalized email", async () => {
    const profileId = "profile-gravatar-cache";
    const hash = emailHash(" Ada@Example.com ");
    getProfileAvatar.mockReturnValue(undefined);
    getUserProfileListItem.mockReturnValue({
      id: profileId,
      emails: [" Ada@Example.com "],
      hasAvatar: false,
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const first = response();
    const second = response();
    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      first.response,
      `/api/users/${profileId}/avatar`,
      { auth: {} as never, fetchImpl },
    );
    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      second.response,
      `/api/users/${profileId}/avatar`,
      { auth: {} as never, fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://www.gravatar.com/avatar/${hash}?s=256&d=404`,
      expect.objectContaining({
        headers: { Accept: "image/webp,image/png,image/jpeg,image/gif" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(first.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=0, must-revalidate",
      }),
    );
    expect(first.end).toHaveBeenCalledWith(new Uint8Array([4, 5, 6]));
    expect(second.end).toHaveBeenCalledWith(new Uint8Array([4, 5, 6]));
  });

  it("negative-caches a Gravatar 404 so the UI can fall back to initials", async () => {
    const profileId = "profile-gravatar-miss";
    getProfileAvatar.mockReturnValue(undefined);
    getUserProfileListItem.mockReturnValue({
      id: profileId,
      emails: ["missing-avatar@example.com"],
      hasAvatar: false,
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    const first = response();
    const second = response();
    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      first.response,
      `/api/users/${profileId}/avatar`,
      { auth: {} as never, fetchImpl },
    );
    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      second.response,
      `/api/users/${profileId}/avatar`,
      { auth: {} as never, fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first.response.statusCode).toBe(404);
    expect(first.setHeader).toHaveBeenCalledWith("Content-Type", "application/json; charset=utf-8");
    // A cached 404 would hide a later uploaded avatar behind the stable route.
    expect(first.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(second.response.statusCode).toBe(404);
  });

  it("serves the primary email's Gravatar when several linked emails resolve", async () => {
    const profileId = "profile-multi-email-primary";
    const primaryHash = emailHash("primary@example.com");
    getProfileAvatar.mockReturnValue(undefined);
    getUserProfileListItem.mockReturnValue({
      id: profileId,
      emails: ["primary@example.com", "secondary@example.com"],
      hasAvatar: false,
    });
    const secondaryHash = emailHash("secondary@example.com");
    // The primary email has a Gravatar, so its lookup short-circuits — the
    // secondary email's hash must never be disclosed to Gravatar.
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) =>
      fetchUrl(input).includes(primaryHash)
        ? new Response(new Uint8Array([1, 1, 1]), {
            status: 200,
            headers: { "content-type": "image/png" },
          })
        : new Response(new Uint8Array([2, 2, 2]), {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
    );
    const res = response();

    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      res.response,
      `/api/users/${profileId}/avatar`,
      { auth: {} as never, fetchImpl },
    );

    expect(res.end).toHaveBeenCalledWith(new Uint8Array([1, 1, 1]));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalledWith(
      expect.stringContaining(secondaryHash),
      expect.anything(),
    );
  });

  it("falls through to a later linked email when the primary has no Gravatar", async () => {
    const profileId = "profile-multi-email-fallthrough";
    const primaryHash = emailHash("primary-miss@example.com");
    getProfileAvatar.mockReturnValue(undefined);
    getUserProfileListItem.mockReturnValue({
      id: profileId,
      emails: ["primary-miss@example.com", "secondary-hit@example.com"],
      hasAvatar: false,
    });
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) =>
      fetchUrl(input).includes(primaryHash)
        ? new Response(null, { status: 404 })
        : new Response(new Uint8Array([2, 2, 2]), {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
    );
    const res = response();

    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      res.response,
      `/api/users/${profileId}/avatar`,
      { auth: {} as never, fetchImpl },
    );

    // A definite miss on the primary lets the request fall through to the
    // secondary email under the shared deadline; the secondary hit is served.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res.end).toHaveBeenCalledWith(new Uint8Array([2, 2, 2]));
  });

  it("caps the Gravatar fan-out so a profile with many linked emails is bounded", async () => {
    const profileId = "profile-many-emails";
    const emails = Array.from({ length: 12 }, (_, index) => `many-${index}@example.com`);
    // Only the last email — beyond the fan-out cap — has a Gravatar.
    const reachableHash = emailHash(emails[emails.length - 1] ?? "");
    getProfileAvatar.mockReturnValue(undefined);
    getUserProfileListItem.mockReturnValue({ id: profileId, emails, hasAvatar: false });
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) =>
      fetchUrl(input).includes(reachableHash)
        ? new Response(new Uint8Array([9, 9, 9]), {
            status: 200,
            headers: { "content-type": "image/png" },
          })
        : new Response(null, { status: 404 }),
    );
    const res = response();

    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      res.response,
      `/api/users/${profileId}/avatar`,
      { auth: {} as never, fetchImpl },
    );

    // Only the first 8 emails are looked up, so the request never fans out to
    // all 12 and the beyond-cap avatar stays unreachable (404 fallback).
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(res.response.statusCode).toBe(404);
  });

  it("cancels a chunked Gravatar response as soon as it exceeds the byte cap", async () => {
    const profileId = "profile-gravatar-oversized";
    getProfileAvatar.mockReturnValue(undefined);
    getUserProfileListItem.mockReturnValue({
      id: profileId,
      emails: ["oversized-avatar@example.com"],
      hasAvatar: false,
    });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000));
        controller.enqueue(new Uint8Array(600_000));
      },
      cancel,
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const res = response();

    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      res.response,
      `/api/users/${profileId}/avatar`,
      { auth: {} as never, fetchImpl },
    );

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(res.response.statusCode).toBe(502);
  });

  it("cancels a Gravatar response rejected by its declared byte size", async () => {
    const profileId = "profile-gravatar-declared-oversized";
    getProfileAvatar.mockReturnValue(undefined);
    getUserProfileListItem.mockReturnValue({
      id: profileId,
      emails: ["declared-oversized-avatar@example.com"],
      hasAvatar: false,
    });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: {
          "content-length": "1000001",
          "content-type": "image/png",
        },
      }),
    );
    const res = response();

    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      res.response,
      `/api/users/${profileId}/avatar`,
      { auth: {} as never, fetchImpl },
    );

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(res.response.statusCode).toBe(502);
  });

  it("evicts older Gravatar images when the cache reaches its byte budget", async () => {
    getProfileAvatar.mockReturnValue(undefined);
    const imageBytes = new Uint8Array(1_000_000);
    const fetchImpl = vi.fn(
      async () =>
        new Response(imageBytes.slice(), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const emails = Array.from({ length: 17 }, (_, index) => `cache-${index}@example.com`);
    const profiles = emails.map((email, index) => ({
      id: `profile-cache-${index}`,
      emails: [email],
      hasAvatar: false,
    }));
    getUserProfileListItem.mockImplementation((profileId: string) =>
      profiles.find((profile) => profile.id === profileId),
    );

    for (const profile of profiles) {
      await handleUserProfileAvatarHttpRequest(
        request("/ignored-by-handler"),
        response().response,
        `/api/users/${profile.id}/avatar`,
        { auth: {} as never, fetchImpl },
      );
    }
    await handleUserProfileAvatarHttpRequest(
      request("/ignored-by-handler"),
      response().response,
      `/api/users/${profiles[0]?.id}/avatar`,
      { auth: {} as never, fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(18);
  });
});
