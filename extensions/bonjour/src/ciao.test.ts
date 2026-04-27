import { describe, expect, it } from "vitest";

const { classifyCiaoUnhandledRejection, ignoreCiaoUnhandledRejection } = await import("./ciao.js");

describe("bonjour-ciao", () => {
  it("classifies ciao cancellation rejections separately from side effects", () => {
    expect(classifyCiaoUnhandledRejection(new Error("CIAO PROBING CANCELLED"))).toEqual({
      kind: "cancellation",
      formatted: "CIAO PROBING CANCELLED",
    });
  });

  it("classifies ciao interface assertions separately from side effects", () => {
    expect(
      classifyCiaoUnhandledRejection(
        new Error("Reached illegal state! IPV4 address change from defined to undefined!"),
      ),
    ).toEqual({
      kind: "interface-assertion",
      formatted: "Reached illegal state! IPV4 address change from defined to undefined!",
    });
  });

  it("classifies ciao netmask assertions separately from side effects", () => {
    expect(
      classifyCiaoUnhandledRejection(
        Object.assign(
          new Error(
            "IP address version must match. Netmask cannot have a version different from the address!",
          ),
          { name: "AssertionError" },
        ),
      ),
    ).toEqual({
      kind: "netmask-assertion",
      formatted:
        "AssertionError: IP address version must match. Netmask cannot have a version different from the address!",
    });
  });

  it("suppresses ciao announcement cancellation rejections", () => {
    expect(ignoreCiaoUnhandledRejection(new Error("Ciao announcement cancelled by shutdown"))).toBe(
      true,
    );
  });

  it("suppresses ciao probing cancellation rejections", () => {
    expect(ignoreCiaoUnhandledRejection(new Error("CIAO PROBING CANCELLED"))).toBe(true);
  });

  it("suppresses wrapped ciao cancellation rejections", () => {
    expect(
      classifyCiaoUnhandledRejection({
        reason: new Error("CIAO ANNOUNCEMENT CANCELLED"),
      }),
    ).toEqual({
      kind: "cancellation",
      formatted: "CIAO ANNOUNCEMENT CANCELLED",
    });
  });

  it("suppresses aggregate ciao assertion rejections", () => {
    expect(
      classifyCiaoUnhandledRejection(
        new AggregateError([
          Object.assign(
            new Error("Reached illegal state! IPV4 address change from defined to undefined!"),
            { name: "AssertionError" },
          ),
        ]),
      ),
    ).toEqual({
      kind: "interface-assertion",
      formatted:
        "AssertionError: Reached illegal state! IPV4 address change from defined to undefined!",
    });
  });

  it("suppresses lower-case string cancellation reasons too", () => {
    expect(ignoreCiaoUnhandledRejection("ciao announcement cancelled during cleanup")).toBe(true);
  });

  it("suppresses ciao interface assertion rejections as non-fatal", () => {
    const error = Object.assign(
      new Error("Reached illegal state! IPV4 address change from defined to undefined!"),
      { name: "AssertionError" },
    );

    expect(ignoreCiaoUnhandledRejection(error)).toBe(true);
  });

  it("suppresses ciao netmask assertion errors as non-fatal", () => {
    const error = Object.assign(
      new Error(
        "IP address version must match. Netmask cannot have a version different from the address!",
      ),
      { name: "AssertionError" },
    );

    expect(ignoreCiaoUnhandledRejection(error)).toBe(true);
  });

  it("keeps unrelated rejections visible", () => {
    expect(ignoreCiaoUnhandledRejection(new Error("boom"))).toBe(false);
  });
});
