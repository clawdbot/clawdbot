// Verifies secret config type guards and normalization helpers.
import { describe, expect, it } from "vitest";
import { collectEnvSecretRefIds, parseEnvTemplateSecretRef } from "./types.secrets.js";

describe("parseEnvTemplateSecretRef", () => {
  it("parses ${VAR} template syntax", () => {
    expect(parseEnvTemplateSecretRef("${OPENAI_API_KEY}")).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
  });

  it("parses $VAR shorthand syntax", () => {
    expect(parseEnvTemplateSecretRef("$OPENAI_API_KEY")).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
  });

  it("trims whitespace before matching", () => {
    expect(parseEnvTemplateSecretRef("  $FOO_BAR  ")).toEqual({
      source: "env",
      provider: "default",
      id: "FOO_BAR",
    });
  });

  it("uses the provided provider alias", () => {
    expect(parseEnvTemplateSecretRef("$MY_KEY", "custom")).toEqual({
      source: "env",
      provider: "custom",
      id: "MY_KEY",
    });
  });

  it("rejects lowercase shorthand", () => {
    expect(parseEnvTemplateSecretRef("$openai_api_key")).toBeNull();
  });

  it("rejects partial shell-style strings", () => {
    expect(parseEnvTemplateSecretRef("prefix-$OPENAI_API_KEY")).toBeNull();
  });
});

describe("collectEnvSecretRefIds", () => {
  it("finds structured and shorthand refs throughout config values", () => {
    expect(
      collectEnvSecretRefIds({
        structured: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        providerless: { source: "env", id: "LEGACY_API_KEY" },
        nested: [{ token: "$DISCORD_BOT_TOKEN" }],
        ignored: { source: "file", provider: "default", id: "/run/secret" },
      }),
    ).toEqual(new Set(["OPENAI_API_KEY", "LEGACY_API_KEY", "DISCORD_BOT_TOKEN"]));
  });
});
