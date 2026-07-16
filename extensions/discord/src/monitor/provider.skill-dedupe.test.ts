import { beforeAll, describe, expect, it } from "vitest";

let __testing: typeof import("./provider.js").__testing;

describe("resolveThreadBindingsEnabled", () => {
  beforeAll(async () => {
    ({ __testing } = await import("./provider.js"));
  });

  it("defaults to enabled when unset", () => {
    expect(
      __testing.resolveThreadBindingsEnabled({
        channelEnabledRaw: undefined,
        sessionEnabledRaw: undefined,
      }),
    ).toBe(true);
  });

  it("uses global session default when channel value is unset", () => {
    expect(
      __testing.resolveThreadBindingsEnabled({
        channelEnabledRaw: undefined,
        sessionEnabledRaw: false,
      }),
    ).toBe(false);
  });

  it("uses channel value to override global session default", () => {
    expect(
      __testing.resolveThreadBindingsEnabled({
        channelEnabledRaw: true,
        sessionEnabledRaw: false,
      }),
    ).toBe(true);
    expect(
      __testing.resolveThreadBindingsEnabled({
        channelEnabledRaw: false,
        sessionEnabledRaw: true,
      }),
    ).toBe(false);
  });
});
