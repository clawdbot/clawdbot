import { describe, expect, it } from "vitest";
import { parseEnvTemplateSecretRef } from "./types.secrets.js";

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
