import { describe, expect, it } from "vitest";
import { resolveSessionAuthProfileOverrideSource } from "./auth-profile-override-provenance.js";

describe("resolveSessionAuthProfileOverrideSource", () => {
  it("returns undefined without a non-blank profile", () => {
    expect(resolveSessionAuthProfileOverrideSource(undefined)).toBeUndefined();
    expect(
      resolveSessionAuthProfileOverrideSource({
        authProfileOverride: " ",
        authProfileOverrideSource: "user",
      }),
    ).toBeUndefined();
  });

  it("prefers explicit provenance over legacy markers", () => {
    expect(
      resolveSessionAuthProfileOverrideSource({
        authProfileOverride: "openai:work",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 0,
      }),
    ).toBe("user");
    expect(
      resolveSessionAuthProfileOverrideSource({
        authProfileOverride: "openai:work",
        authProfileOverrideSource: "auto",
      }),
    ).toBe("auto");
  });

  it.each([0, 3])("treats numeric compaction marker %i as automatic", (marker) => {
    expect(
      resolveSessionAuthProfileOverrideSource({
        authProfileOverride: "openai:fallback",
        authProfileOverrideCompactionCount: marker,
      }),
    ).toBe("auto");
  });

  it("treats a source-less profile without a compaction marker as user-selected", () => {
    expect(
      resolveSessionAuthProfileOverrideSource({
        authProfileOverride: "openai:legacy-user",
      }),
    ).toBe("user");
  });
});
