// Verifies shared provider registry helper behavior.
import { describe, expect, it } from "vitest";
import { buildCapabilityProviderMaps } from "./provider-registry-shared.js";

describe("provider registry shared", () => {
  it("normalizes provider ids case-insensitively", () => {
    const { canonical } = buildCapabilityProviderMaps([{ id: "  OpenAI  " }, { id: "   " }]);
    expect([...canonical.keys()]).toEqual(["openai"]);
  });

  it("indexes providers by id and alias", () => {
    const { canonical, aliases } = buildCapabilityProviderMaps([
      { id: "Microsoft", aliases: [" EDGE ", "ms"] },
      { id: "OpenAI" },
    ]);

    expect([...canonical.keys()]).toEqual(["microsoft", "openai"]);
    expect(aliases.get("edge")?.id).toBe("Microsoft");
    expect(aliases.get("ms")?.id).toBe("Microsoft");
    expect(aliases.get("openai")?.id).toBe("OpenAI");
  });

  it("ignores prototype-like ids and aliases", () => {
    const { canonical, aliases } = buildCapabilityProviderMaps([
      { id: "__proto__", aliases: ["constructor", "prototype"] },
      { id: "safe", aliases: ["safe-alias", "constructor"] },
    ]);

    expect([...canonical.keys()]).toEqual(["safe"]);
    expect(aliases.get("__proto__")).toBeUndefined();
    expect(aliases.get("constructor")).toBeUndefined();
    expect(aliases.get("safe-alias")?.id).toBe("safe");
  });
});
