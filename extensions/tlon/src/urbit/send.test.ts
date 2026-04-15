import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@urbit/aura", () => ({
  scot: vi.fn(() => "mocked-ud"),
  da: {
    fromUnix: vi.fn(() => 123n),
  },
}));

describe("sendDm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses aura v3 helpers for the DM id", async () => {
    const { sendDm } = await import("./send.js");
    const aura = await import("@urbit/aura");
    const scot = vi.mocked(aura.scot);
    const fromUnix = vi.mocked(aura.da.fromUnix);

    const sentAt = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(sentAt);

    const poke = vi.fn(async () => ({}));

    const result = await sendDm({
      api: { poke },
      fromShip: "~zod",
      toShip: "~nec",
      text: "hi",
    });

    expect(fromUnix).toHaveBeenCalledWith(sentAt);
    expect(scot).toHaveBeenCalledWith("ud", 123n);
    expect(poke).toHaveBeenCalledTimes(1);
    expect(result.messageId).toBe("~zod/mocked-ud");
  });
});
