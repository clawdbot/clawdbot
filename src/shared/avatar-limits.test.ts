// Avatar projection limits stay browser-safe and independent of persisted config validation.
import { describe, expect, it } from "vitest";
import { AVATAR_MAX_DATA_URL_CHARS, isRenderableAvatarImageDataUrl } from "./avatar-limits.js";

describe("isRenderableAvatarImageDataUrl", () => {
  it("accepts the exact encoded boundary and rejects larger or non-image data URLs", () => {
    const prefix = "data:image/svg+xml;base64,";
    const exact = `${prefix}${"A".repeat(AVATAR_MAX_DATA_URL_CHARS - prefix.length)}`;

    expect(exact).toHaveLength(AVATAR_MAX_DATA_URL_CHARS);
    expect(isRenderableAvatarImageDataUrl(exact)).toBe(true);
    expect(isRenderableAvatarImageDataUrl(`${exact}A`)).toBe(false);
    expect(isRenderableAvatarImageDataUrl("data:text/plain,avatar")).toBe(false);
  });
});
