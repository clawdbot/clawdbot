import { describe, expect, it } from "vitest";
import { isEmptyUserTextOnlyMessage } from "../../lib/chat/message-extract.ts";

describe("chat history canonical media filtering", () => {
  it.each([
    ["facts-only", [{ path: "/media/fact.png", contentType: "image/png" }]],
    ["sparse", [{}, { path: "/media/sparse.png", contentType: "image/png" }]],
    ["type-only", [{ contentType: "image/png" }]],
    ["media-only", [{ url: "media://inbound/media-only.png", kind: "image" }]],
  ])("keeps an empty %s user row", (_name, media) => {
    expect(
      isEmptyUserTextOnlyMessage({
        role: "user",
        content: "",
        __openclaw: { media },
      }),
    ).toBe(false);
  });

  it("drops a truly empty user row", () => {
    expect(isEmptyUserTextOnlyMessage({ role: "user", content: "" })).toBe(true);
  });
});
