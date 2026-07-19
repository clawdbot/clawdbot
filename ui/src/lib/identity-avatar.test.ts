// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveAvatar } from "./identity-avatar.ts";

describe("resolveAvatar", () => {
  it("uses a normalized email id for the proxied avatar hash", async () => {
    await expect(
      resolveAvatar({ id: "  Alice@Example.com  ", avatarProxyBaseUrl: "/api/avatars/" }),
    ).resolves.toEqual({
      kind: "gravatar",
      url: "/api/avatars/ff8d9819fc0e12bf0d24892e45987e249a28dce836a85cad60e28eaaa8c6d976?s=64",
    });
  });

  it("never contacts a third-party avatar host without a proxy base", async () => {
    await expect(resolveAvatar({ id: "alice@example.com" })).resolves.toMatchObject({
      kind: "initials",
      initials: "A",
    });
  });

  it("falls back to initials for a non-email id", async () => {
    await expect(resolveAvatar({ id: "profile_123" })).resolves.toMatchObject({
      kind: "initials",
      initials: "P",
    });
  });

  it("derives up to two initials from a display name", async () => {
    await expect(resolveAvatar({ name: "Ada Lovelace Byron" })).resolves.toMatchObject({
      kind: "initials",
      initials: "AL",
    });
  });

  it("keeps the initials color deterministic", async () => {
    const first = await resolveAvatar({ id: "profile_123", name: "Ada Lovelace" });
    const second = await resolveAvatar({ id: "profile_123", name: "Renamed User" });
    expect(first.kind).toBe("initials");
    expect(second.kind).toBe("initials");
    if (first.kind === "initials" && second.kind === "initials") {
      expect(first.colorSeed).toBe(second.colorSeed);
    }
  });

  it("lets an already-resolved profile avatar win", async () => {
    await expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/avatars/alice.png" }),
    ).resolves.toEqual({ kind: "profile", url: "/avatars/alice.png" });
  });
});

describe("resolveAvatar profile URL origin restriction", () => {
  it("rejects absolute profile URLs from sender metadata", async () => {
    await expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "https://evil.example/a.png" }),
    ).resolves.toMatchObject({ kind: "initials" });
  });

  it("rejects protocol-relative profile URLs", async () => {
    await expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "//evil.example/a.png" }),
    ).resolves.toMatchObject({ kind: "initials" });
  });

  it("rejects backslash and control-character parser bypasses", async () => {
    for (const url of [
      "/\\evil.example/a.png",
      "\\/evil.example/a.png",
      "/\t/evil.example/a.png",
      "htt\nps://evil.example/a.png",
    ]) {
      await expect(
        resolveAvatar({ id: "alice@example.com", profileAvatarUrl: url }),
      ).resolves.toMatchObject({ kind: "initials" });
    }
  });

  it("accepts same-origin relative profile URLs", async () => {
    await expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/avatars/alice.png" }),
    ).resolves.toEqual({ kind: "profile", url: "/avatars/alice.png" });
  });
});
