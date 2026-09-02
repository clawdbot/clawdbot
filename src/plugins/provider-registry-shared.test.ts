// Verifies shared provider registry helper behavior.
import { describe, expect, it } from "vitest";
import { buildCapabilityProviderIndex } from "./provider-registry-shared.js";

describe("provider registry shared", () => {
  it("normalizes provider ids case-insensitively", () => {
    const canonical = buildCapabilityProviderIndex(
      [{ id: "  OpenAI  " }, { id: "   " }],
      "canonical",
    );
    expect([...canonical.keys()]).toEqual(["openai"]);
  });

  it("indexes providers by id and alias", () => {
    const microsoft = { id: "Microsoft", aliases: [" EDGE ", "ms"] };
    const openai = { id: "OpenAI" };
    const replacement = { id: " microsoft ", aliases: ["azure"] };
    const providers = [microsoft, openai, replacement];
    const canonical = buildCapabilityProviderIndex(providers, "canonical");
    const aliases = buildCapabilityProviderIndex(providers, "aliases");

    expect([...canonical.keys()]).toEqual(["microsoft", "openai"]);
    expect(canonical.get("microsoft")).toBe(replacement);
    expect(aliases.get("microsoft")).toBe(replacement);
    expect(aliases.get("edge")).toBe(microsoft);
    expect(aliases.get("ms")).toBe(microsoft);
    expect(aliases.get("azure")).toBe(replacement);
    expect(aliases.get("openai")).toBe(openai);
  });

  it("ignores prototype-like ids and aliases", () => {
    const providers = [
      { id: "__proto__", aliases: ["constructor", "prototype"] },
      { id: "safe", aliases: ["safe-alias", "constructor"] },
    ];
    const canonical = buildCapabilityProviderIndex(providers, "canonical");
    const aliases = buildCapabilityProviderIndex(providers, "aliases");

    expect([...canonical.keys()]).toEqual(["safe"]);
    expect(aliases.get("__proto__")).toBeUndefined();
    expect(aliases.get("constructor")).toBeUndefined();
    expect(aliases.get("safe-alias")?.id).toBe("safe");
  });
});
