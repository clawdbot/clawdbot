import { describe, expect, it, vi } from "vitest";

describe("config msteams", () => {
  it("accepts replyStyle at global/team/channel levels", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      channels: {
        msteams: {
          replyStyle: "top-level",
          teams: {
            team123: {
              replyStyle: "thread",
              channels: {
                chan456: { replyStyle: "top-level" },
              },
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.msteams?.replyStyle).toBe("top-level");
      expect(res.config.channels?.msteams?.teams?.team123?.replyStyle).toBe(
        "thread",
      );
      expect(
        res.config.channels?.msteams?.teams?.team123?.channels?.chan456
          ?.replyStyle,
      ).toBe("top-level");
    }
  });

  it("rejects invalid replyStyle", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      channels: { msteams: { replyStyle: "nope" } },
    });
    expect(res.ok).toBe(false);
  });
});
