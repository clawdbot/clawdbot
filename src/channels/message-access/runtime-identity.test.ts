import { describe, expect, it } from "vitest";
import {
  defineStableChannelIngressIdentity,
  identityEntryAuthenticationClassifier,
} from "./runtime-identity.js";
import type { ChannelIngressIdentityDescriptor } from "./runtime-types.js";

describe("identityEntryAuthenticationClassifier", () => {
  const identity = defineStableChannelIngressIdentity({
    normalizeEntry: (raw) => (raw.startsWith("id:") ? raw.slice(3) : null),
    authentication: "verified",
    aliases: [
      {
        key: "name",
        normalizeEntry: (raw) => (raw.startsWith("name:") ? raw.slice(5) : null),
        authentication: "mutable",
      },
      {
        key: "tag",
        normalizeEntry: (raw) => (raw.startsWith("tag:") ? raw.slice(4) : null),
        dangerous: true,
      },
      { key: "legacy", normalizeEntry: (raw) => (raw.startsWith("legacy:") ? raw.slice(7) : null) },
    ],
  });

  it.each([
    ["id:123", "verified"],
    ["name:Alice", "mutable"],
    ["tag:alice#0001", "mutable"],
    ["legacy:123", "asserted"],
    ["rejected", undefined],
    ["id:   ", undefined],
    ["*", undefined],
  ] as const)("classifies %s as %s", (raw, expected) => {
    expect(identityEntryAuthenticationClassifier(identity)(raw)).toBe(expected);
  });

  it.each(["verified", "asserted", "unverified", "mutable"] as const)(
    "resolves predicate strength %s on the raw entry",
    (authentication) => {
      const classify = identityEntryAuthenticationClassifier({
        primary: {
          normalizeEntry: (raw) => raw.trim().toLowerCase(),
          authentication: (raw) => (raw === " RAW " ? authentication : "mutable"),
          dangerous: true,
        },
      });
      expect(classify(" RAW ")).toBe(authentication);
    },
  );

  it.each([false, true])("takes the strongest accepting field (reverse=%s)", (reverse) => {
    const fields = [
      { key: "name", authentication: "mutable" as const },
      { key: "id", authentication: "verified" as const },
      { key: "legacy" },
    ];
    if (reverse) {
      fields.reverse();
    }
    const descriptor: ChannelIngressIdentityDescriptor = {
      primary: { authentication: "unverified" },
      aliases: fields,
      isWildcardEntry: (raw) => raw === "everyone",
    };
    const classify = identityEntryAuthenticationClassifier(descriptor);
    expect(classify("123")).toBe("verified");
    expect(classify("everyone")).toBeUndefined();
  });

  it.each([
    [true, "mutable"],
    [false, "asserted"],
  ] as const)("resolves the legacy dangerous predicate (%s)", (dangerous, expected) => {
    const classify = identityEntryAuthenticationClassifier({
      primary: {
        authentication: () => undefined,
        dangerous: (raw) => raw === " RAW " && dangerous,
      },
    });
    expect(classify(" RAW ")).toBe(expected);
  });

  it("accepts the raw stable-identity input used by channel runtimes", () => {
    const classify = identityEntryAuthenticationClassifier({
      normalize: (raw) => raw.trim(),
      authentication: "asserted",
      aliases: [{ key: "name", authentication: "mutable" }],
    });
    expect(classify("id")).toBe("asserted");
  });
});
