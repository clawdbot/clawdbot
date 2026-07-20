// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { resolveAvatar, setAvatarGatewayOrigin } from "./identity-avatar.ts";

afterEach(() => {
  setAvatarGatewayOrigin(null);
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
