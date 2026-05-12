import { describe, expect, it } from "vitest";
import {
  PROTECTED_PLUGIN_ROUTE_PREFIXES,
  buildCanonicalPathCandidates,
  canonicalizePathForSecurity,
  isPathProtectedByPrefixes,
  isProtectedPluginRoutePath,
} from "./security-path.js";

function buildRepeatedEncodedSlashPath(depth: number): string {
  let encodedSlash = "%2f";
  for (let i = 1; i < depth; i++) {
    encodedSlash = encodedSlash.replace(/%/g, "%25");
  }
  return `/api${encodedSlash}channels${encodedSlash}nostr${encodedSlash}default${encodedSlash}profile`;
}

describe("security-path canonicalization", () => {
  it("canonicalizes decoded case/slash variants", () => {
    expect(canonicalizePathForSecurity("/API/channels//nostr/default/profile/")).toEqual({
      canonicalPath: "/api/channels/nostr/default/profile",
      candidates: ["/api/channels/nostr/default/profile"],
      malformedEncoding: false,
      decodePasses: 0,
      decodePassLimitReached: false,
      rawNormalizedPath: "/api/channels/nostr/default/profile",
    });
    const encoded = canonicalizePathForSecurity("/api/%63hannels%2Fnostr%2Fdefault%2Fprofile");
    expect(encoded.canonicalPath).toBe("/api/channels/nostr/default/profile");
    expect(encoded.candidates).toContain("/api/%63hannels%2fnostr%2fdefault%2fprofile");
    expect(encoded.candidates).toContain("/api/channels/nostr/default/profile");
    expect(encoded.decodePasses).toBeGreaterThan(0);
    expect(encoded.decodePassLimitReached).toBe(false);
  });

  it("resolves traversal after repeated decoding", () => {
    expect(
      canonicalizePathForSecurity("/api/foo/..%2fchannels/nostr/default/profile").canonicalPath,
    ).toBe("/api/channels/nostr/default/profile");
    expect(
      canonicalizePathForSecurity("/api/foo/%252e%252e%252fchannels/nostr/default/profile")
        .canonicalPath,
    ).toBe("/api/channels/nostr/default/profile");
  });

  it("marks malformed encoding", () => {
    expect(canonicalizePathForSecurity("/api/channels%2").malformedEncoding).toBe(true);
    expect(canonicalizePathForSecurity("/api/channels%zz").malformedEncoding).toBe(true);
  });

  it("resolves 4x encoded slash path variants to protected channel routes", () => {
    const deeplyEncoded = "/api%2525252fchannels%2525252fnostr%2525252fdefault%2525252fprofile";
    const canonical = canonicalizePathForSecurity(deeplyEncoded);
    expect(canonical.canonicalPath).toBe("/api/channels/nostr/default/profile");
    expect(canonical.decodePasses).toBeGreaterThanOrEqual(4);
    expect(isProtectedPluginRoutePath(deeplyEncoded)).toBe(true);
  });

  it("flags decode depth overflow and fails closed for protected prefix checks", () => {
    const excessiveDepthPath = buildRepeatedEncodedSlashPath(40);
    const candidates = buildCanonicalPathCandidates(excessiveDepthPath, 32);
    expect(candidates.decodePassLimitReached).toBe(true);
    expect(candidates.malformedEncoding).toBe(false);
    expect(isProtectedPluginRoutePath(excessiveDepthPath)).toBe(true);
  });
});

describe("security-path protected-prefix matching", () => {
  const channelVariants = [
    "/API/channels/nostr/default/profile",
    "/api/channels%2Fnostr%2Fdefault%2Fprofile",
    "/api/%63hannels/nostr/default/profile",
    "/api/foo/..%2fchannels/nostr/default/profile",
    "/api/foo/%2e%2e%2fchannels/nostr/default/profile",
    "/api/foo/%252e%252e%252fchannels/nostr/default/profile",
    "/api%2525252fchannels%2525252fnostr%2525252fdefault%2525252fprofile",
    "/api/channels%2",
    "/api/channels%zz",
  ];

  for (const path of channelVariants) {
    it(`protects plugin channel path variant: ${path}`, () => {
      expect(isProtectedPluginRoutePath(path)).toBe(true);
      expect(isPathProtectedByPrefixes(path, PROTECTED_PLUGIN_ROUTE_PREFIXES)).toBe(true);
    });
  }

  it("does not protect unrelated paths", () => {
    expect(isProtectedPluginRoutePath("/plugin/public")).toBe(false);
    expect(isProtectedPluginRoutePath("/api/channels-public")).toBe(false);
    expect(isProtectedPluginRoutePath("/api/foo/..%2fchannels-public")).toBe(false);
    expect(isProtectedPluginRoutePath("/api/channel")).toBe(false);
  });
});
