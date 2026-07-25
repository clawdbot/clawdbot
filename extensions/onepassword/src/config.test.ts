import { describe, expect, it } from "vitest";
import { MAX_REGISTERED_ITEMS, parseOnePasswordConfig } from "./config.js";

describe("parseOnePasswordConfig", () => {
  it("rejects invalid slug grammar", () => {
    expect(() =>
      parseOnePasswordConfig({ vault: "Automation", items: { Bad_Slug: { item: "Token" } } }),
    ).toThrow("Invalid 1Password item slug");
    expect(() =>
      parseOnePasswordConfig({ vault: "Automation", items: { token: { item: "--help" } } }),
    ).toThrow("must not start with a hyphen");
    expect(() =>
      parseOnePasswordConfig({ vault: "-Automation", items: { token: { item: "Token" } } }),
    ).toThrow("vault must not start with a hyphen");
    expect(() =>
      parseOnePasswordConfig({
        vault: "Automation",
        items: { token: { item: "Token", vault: "-Other" } },
      }),
    ).toThrow("token vault must not start with a hyphen");
    expect(() =>
      parseOnePasswordConfig({
        vault: "Automation",
        items: { token: { item: "Token", field: "username,password" } },
      }),
    ).toThrow("field must not contain commas");
  });

  it("applies defaults and item overrides", () => {
    expect(
      parseOnePasswordConfig({
        vault: "Automation",
        items: {
          token: { item: "Token" },
          denied: { item: "Denied", vault: "Other", field: "password", policy: "deny" },
        },
      }),
    ).toMatchObject({
      defaultPolicy: "approve",
      cacheTtlSeconds: 300,
      grantTtlHours: 720,
      opTimeoutMs: 15_000,
      items: {
        token: { vault: "Automation", field: "credential", policy: "approve" },
        denied: { vault: "Other", field: "password", policy: "deny" },
      },
    });
  });

  it("bounds listable registry metadata", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_REGISTERED_ITEMS + 1 }, (_, index) => [
        `token-${index}`,
        { item: `Token ${index}` },
      ]),
    );
    expect(() => parseOnePasswordConfig({ vault: "Automation", items: tooMany })).toThrow(
      `at most ${MAX_REGISTERED_ITEMS}`,
    );
    expect(() =>
      parseOnePasswordConfig({
        vault: "Automation",
        items: {
          token: { item: "Token", description: "x".repeat(201) },
        },
      }),
    ).toThrow("at most 200");
  });
});
