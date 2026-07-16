// Discord tests cover provider.skill dedupe plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveThreadBindingsEnabled } from "./provider-session.runtime.js";

describe("resolveThreadBindingsEnabled", () => {
  it("defaults to enabled when unset", () => {
    expect(
      resolveThreadBindingsEnabled({
        channelEnabledRaw: undefined,
        sessionEnabledRaw: undefined,
      }),
    ).toBe(true);
  });

  it("uses global session default when channel value is unset", () => {
    expect(
      resolveThreadBindingsEnabled({
        channelEnabledRaw: undefined,
        sessionEnabledRaw: false,
      }),
    ).toBe(false);
  });

  it("uses channel value to override global session default", () => {
    expect(
      resolveThreadBindingsEnabled({
        channelEnabledRaw: true,
        sessionEnabledRaw: false,
      }),
    ).toBe(true);
    expect(
      resolveThreadBindingsEnabled({
        channelEnabledRaw: false,
        sessionEnabledRaw: true,
      }),
    ).toBe(false);
  });
});
