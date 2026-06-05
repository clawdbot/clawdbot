// Discord tests cover provider.skill dedupe plugin behavior.
import { beforeAll, describe, expect, it } from "vitest";

let testing: typeof import("./provider.js").testing;

describe("resolveThreadBindingsEnabled", () => {
  beforeAll(async () => {
    ({ testing } = await import("./provider.js"));
  });

  it("defaults to enabled when unset", () => {
    expect(
      testing.resolveThreadBindingsEnabled({
        channelEnabledRaw: undefined,
        sessionEnabledRaw: undefined,
      }),
    ).toBe(true);
  });

  it("uses global session default when channel value is unset", () => {
    expect(
      testing.resolveThreadBindingsEnabled({
        channelEnabledRaw: undefined,
        sessionEnabledRaw: false,
      }),
    ).toBe(false);
  });

  it("uses channel value to override global session default", () => {
    expect(
      testing.resolveThreadBindingsEnabled({
        channelEnabledRaw: true,
        sessionEnabledRaw: false,
      }),
    ).toBe(true);
    expect(
      testing.resolveThreadBindingsEnabled({
        channelEnabledRaw: false,
        sessionEnabledRaw: true,
      }),
    ).toBe(false);
  });
});
