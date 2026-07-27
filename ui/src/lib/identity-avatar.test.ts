// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveAvatar,
  resolveAvatarImageUrl,
  resolveIdentityHue,
  setAvatarGatewayOrigin,
  settleAvatarImageUrl,
} from "./identity-avatar.ts";

afterEach(() => {
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveAvatar", () => {
  it("falls back to initials for a non-email id", () => {
    expect(resolveAvatar({ id: "profile_123" })).toMatchObject({
      kind: "initials",
      initials: "P",
    });
  });

  it("derives up to two initials from a display name", () => {
    expect(resolveAvatar({ name: "Ada Lovelace Byron" })).toMatchObject({
      kind: "initials",
      initials: "AL",
    });
  });

  it("keeps the initials color deterministic", () => {
    const first = resolveAvatar({ id: "profile_123", name: "Ada Lovelace" });
    const second = resolveAvatar({ id: "profile_123", name: "Renamed User" });
    expect(first.kind).toBe("initials");
    expect(second.kind).toBe("initials");
    if (first.kind === "initials" && second.kind === "initials") {
      expect(first.colorSeed).toBe(second.colorSeed);
    }
  });

  it("derives a stable identity hue from the same seed as the initials color", () => {
    const first = resolveIdentityHue({ id: "profile_123", name: "Ada Lovelace" });
    const second = resolveIdentityHue({ id: "profile_123", name: "Renamed User" });
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(360);
    const resolved = resolveAvatar({ id: "profile_123" });
    if (resolved.kind === "initials") {
      expect(first).toBe(resolved.colorSeed % 360);
    }
  });

  it("lets an already-resolved profile avatar win", () => {
    expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/api/users/p1/avatar" }),
    ).toEqual({ kind: "profile", url: "/api/users/p1/avatar" });
  });
});

describe("resolveAvatar profile URL origin restriction", () => {
  it("rejects absolute profile URLs from sender metadata", () => {
    expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "https://evil.example/a.png" }),
    ).toMatchObject({ kind: "initials" });
  });

  it("rejects protocol-relative profile URLs", () => {
    expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "//evil.example/a.png" }),
    ).toMatchObject({ kind: "initials" });
  });

  it("rejects backslash and control-character parser bypasses", () => {
    for (const url of [
      "/\\evil.example/a.png",
      "\\/evil.example/a.png",
      "/\t/evil.example/a.png",
      "htt\nps://evil.example/a.png",
    ]) {
      expect(resolveAvatar({ id: "alice@example.com", profileAvatarUrl: url })).toMatchObject({
        kind: "initials",
      });
    }
  });

  it("accepts the canonical same-origin avatar route", () => {
    expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/api/users/p1/avatar" }),
    ).toEqual({ kind: "profile", url: "/api/users/p1/avatar" });
  });

  it("rejects a same-origin path that is not the avatar route", () => {
    expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/api/secrets" }),
    ).toMatchObject({ kind: "initials" });
  });

  it("preserves the version query but drops the fragment on the avatar route", () => {
    expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/api/users/p1/avatar?v=2#f" }),
    ).toEqual({ kind: "profile", url: "/api/users/p1/avatar?v=2" });
  });
});

describe("resolveAvatar gateway origin trust", () => {
  it("keeps relative avatar paths relative when no gateway origin is set", () => {
    expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/api/users/p1/avatar" }),
    ).toEqual({ kind: "profile", url: "/api/users/p1/avatar" });
  });

  it("resolves relative paths against the configured gateway origin", () => {
    setAvatarGatewayOrigin("wss://gw.example.com/ws");
    expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/api/users/p1/avatar" }),
    ).toEqual({ kind: "profile", url: "https://gw.example.com/api/users/p1/avatar" });
  });

  it("allows an absolute URL only when it matches the gateway origin", () => {
    setAvatarGatewayOrigin("https://gw.example.com");
    expect(
      resolveAvatar({
        id: "a@example.com",
        profileAvatarUrl: "https://gw.example.com/api/users/p1/avatar",
      }),
    ).toEqual({ kind: "profile", url: "https://gw.example.com/api/users/p1/avatar" });
  });

  it("rejects an absolute URL from a different origin than the gateway", () => {
    setAvatarGatewayOrigin("https://gw.example.com");
    expect(
      resolveAvatar({ id: "a@example.com", profileAvatarUrl: "https://evil.example/a.png" }),
    ).toMatchObject({ kind: "initials" });
  });

  // NOTE: the trusted origin can only come from setAvatarGatewayOrigin — the
  // IdentityAvatarInput type has no gatewayOrigin field, so sender metadata
  // cannot influence it (compile-time enforced; no runtime test needed).

  it("honors the app-wide gateway origin set via setAvatarGatewayOrigin", () => {
    setAvatarGatewayOrigin("wss://gw.example.com/ws");
    expect(
      resolveAvatar({ id: "a@example.com", profileAvatarUrl: "/api/users/p1/avatar" }),
    ).toEqual({ kind: "profile", url: "https://gw.example.com/api/users/p1/avatar" });
  });
});

describe("resolveAvatar profile-id senders", () => {
  it("derives the canonical avatar route from a UUID-shaped sender id", () => {
    expect(resolveAvatar({ id: "c3e32452-0467-47e5-aafa-233cd5dae29f", name: "steipete" })).toEqual(
      {
        kind: "profile",
        url: "/api/users/c3e32452-0467-47e5-aafa-233cd5dae29f/avatar",
      },
    );
  });

  it("resolves the derived route against the gateway origin", () => {
    setAvatarGatewayOrigin("wss://gw.example.com/ws");
    expect(resolveAvatar({ id: "c3e32452-0467-47e5-aafa-233cd5dae29f" })).toEqual({
      kind: "profile",
      url: "https://gw.example.com/api/users/c3e32452-0467-47e5-aafa-233cd5dae29f/avatar",
    });
  });

  it("keeps non-UUID sender ids on initials (no route probing)", () => {
    expect(resolveAvatar({ id: "alice@example.com" })).toMatchObject({ kind: "initials" });
    expect(resolveAvatar({ id: "+436641234567" })).toMatchObject({ kind: "initials" });
  });

  it("prefers an explicit trusted route over the derived one", () => {
    expect(
      resolveAvatar({
        id: "c3e32452-0467-47e5-aafa-233cd5dae29f",
        profileAvatarUrl: "/api/users/other-profile/avatar?v=9",
      }),
    ).toEqual({ kind: "profile", url: "/api/users/other-profile/avatar?v=9" });
  });
});

describe("authenticated profile avatar cache", () => {
  it("shares one authenticated image fetch and blob across avatar surfaces", async () => {
    setAvatarGatewayOrigin("wss://gateway.example.test/ws", "Bearer profile-token");
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      }),
    );
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:profile-ada");

    const first = resolveAvatarImageUrl("/api/users/profile-ada/avatar?v=7");
    const second = resolveAvatarImageUrl("/api/users/profile-ada/avatar?v=7");

    expect(first).toBe(second);
    await expect(first).resolves.toBe("blob:profile-ada");
    await expect(second).resolves.toBe("blob:profile-ada");
    expect(fetchAvatar).toHaveBeenCalledOnce();
    expect(fetchAvatar).toHaveBeenCalledWith(
      "https://gateway.example.test/api/users/profile-ada/avatar?v=7",
      expect.objectContaining({
        credentials: "include",
        headers: { Authorization: "Bearer profile-token" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it("refetches when the gateway publishes a newer avatar revision", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", "Bearer profile-token");
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        }),
    );
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:profile-v7")
      .mockReturnValueOnce("blob:profile-v8");

    await expect(resolveAvatarImageUrl("/api/users/profile-ada/avatar?v=7")).resolves.toBe(
      "blob:profile-v7",
    );
    await expect(resolveAvatarImageUrl("/api/users/profile-ada/avatar?v=8")).resolves.toBe(
      "blob:profile-v8",
    );

    expect(fetchAvatar).toHaveBeenCalledTimes(2);
  });

  it("does not cache a missing avatar or a transient image failure", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", "Bearer profile-token");
    const fetchAvatar = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        }),
      );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:profile-uploaded");

    await expect(resolveAvatarImageUrl("/api/users/profile-ada/avatar")).resolves.toBeNull();
    await expect(resolveAvatarImageUrl("/api/users/profile-ada/avatar")).resolves.toBe(
      "blob:profile-uploaded",
    );

    expect(fetchAvatar).toHaveBeenCalledTimes(2);
  });

  it("keeps active avatar requests valid when a roster exceeds the cache limit", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", "Bearer profile-token");
    const finishRequests: Array<(response: Response) => void> = [];
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        await new Promise<Response>((resolve) => {
          finishRequests.push(resolve);
        }),
    );
    let blobIndex = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:profile-${blobIndex++}`);
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");

    const pending = Array.from({ length: 130 }, (_, index) =>
      Promise.resolve(resolveAvatarImageUrl(`/api/users/profile-${index}/avatar?v=1`)),
    );
    expect(fetchAvatar).toHaveBeenCalledTimes(130);
    for (const finishRequest of finishRequests) {
      finishRequest(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        }),
      );
    }

    const imageUrls = await Promise.all(pending);
    expect(imageUrls).toHaveLength(130);
    expect(imageUrls.every((url) => url?.startsWith("blob:profile-"))).toBe(true);
    expect(new Set(imageUrls).size).toBe(130);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    settleAvatarImageUrl(imageUrls[0] ?? null);
    settleAvatarImageUrl(imageUrls[1] ?? null);

    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenNthCalledWith(1, imageUrls[0]);
    expect(revokeObjectURL).toHaveBeenNthCalledWith(2, imageUrls[1]);
  });

  it("rejects non-image responses from the authenticated avatar endpoint", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", "Bearer profile-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not an image", { headers: { "content-type": "text/html" } }),
    );
    const createObjectURL = vi.spyOn(URL, "createObjectURL");

    await expect(resolveAvatarImageUrl("/api/users/profile-ada/avatar?v=7")).resolves.toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("revokes cached blobs and refetches after a gateway credential changes", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", "Bearer first-token");
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        }),
    );
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first-profile")
      .mockReturnValueOnce("blob:second-profile");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");

    await expect(resolveAvatarImageUrl("/api/users/profile-ada/avatar?v=7")).resolves.toBe(
      "blob:first-profile",
    );
    setAvatarGatewayOrigin("https://gateway.example.test", "Bearer second-token");
    await expect(resolveAvatarImageUrl("/api/users/profile-ada/avatar?v=7")).resolves.toBe(
      "blob:second-profile",
    );

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first-profile");
    expect(fetchAvatar).toHaveBeenLastCalledWith(
      "https://gateway.example.test/api/users/profile-ada/avatar?v=7",
      expect.objectContaining({ headers: { Authorization: "Bearer second-token" } }),
    );
  });

  it("never forwards gateway credentials to a sender-controlled avatar origin", () => {
    setAvatarGatewayOrigin("https://gateway.example.test", "Bearer profile-token");
    const fetchAvatar = vi.spyOn(globalThis, "fetch");

    for (const avatarUrl of [
      "https://evil.example/api/users/profile-ada/avatar?v=7",
      "https://gateway.example.test.evil.example/api/users/profile-ada/avatar?v=7",
      "https://gateway.example.test@evil.example/api/users/profile-ada/avatar?v=7",
      "//evil.example/api/users/profile-ada/avatar?v=7",
      "/api/secrets",
    ]) {
      expect(resolveAvatarImageUrl(avatarUrl)).toBeNull();
      expect(resolveAvatar({ id: "profile-ada", profileAvatarUrl: avatarUrl })).toMatchObject({
        kind: "initials",
      });
    }
    expect(fetchAvatar).not.toHaveBeenCalled();
  });
});
